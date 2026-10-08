import type { Business } from "./types";
import type { Category } from "./categories";
import { coalesce, getCached, normalizeKeyPart, setCached } from "./search-cache";

// Fuente gratis: OpenStreetMap (Nominatim para geocodificar + Overpass para negocios).
// Datos ODbL: se pueden guardar/cachear (con atribución "© OpenStreetMap contributors").
// La política de Nominatim exige cachear del lado del cliente y máx. 1 req/s:
// https://operations.osmfoundation.org/policies/nominatim/

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// Varios espejos de Overpass; se satura seguido, así que rotamos.
// Kumi suele ser el más rápido, así que va primero.
const OVERPASS_MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
// Nominatim y Overpass piden un User-Agent identificable.
export const OSM_USER_AGENT = "Prospector/1.0 (lead research tool)";

const DAY_MS = 24 * 60 * 60 * 1000;
const RESULTS_TTL_MS = 7 * DAY_MS; // negocios: cambian poco, una semana basta
const GEO_TTL_MS = 30 * DAY_MS; // ciudades -> bbox: casi nunca cambian

// Error con mensaje listo para el usuario + status HTTP.
export class OsmError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "OsmError";
    this.status = status;
  }
}

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface GeoPlace {
  displayName: string;
  bbox: [number, number, number, number]; // [south, north, west, east]
  lat?: number; // centro del lugar
  lon?: number;
  kind?: string; // addresstype de Nominatim: city, town, suburb, state…
  stateIso?: string; // ISO 3166-2, p. ej. "MX-QUE"
  state?: string;
  county?: string; // en México, el municipio
  borough?: string; // en CDMX, la alcaldía
}

export interface OsmSearch {
  city: string; // display_name de Nominatim
  results: Business[];
  cached: boolean;
  cachedAt?: string; // ISO
}

// Corta cada intento a los N ms: si un espejo tarda, saltamos al siguiente
// en vez de quedarnos esperando (que es lo que hacía que se sintiera trabado).
function withTimeout(ms: number): { signal: AbortSignal; cancel: () => void } {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  return { signal: c.signal, cancel: () => clearTimeout(t) };
}

// Un intento contra un espejo. Lanza si no devuelve JSON válido
// (algunos regresan una página HTML de error cuando están saturados).
async function hitMirror(
  url: string,
  query: string,
  signal: AbortSignal
): Promise<OverpassElement[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "User-Agent": OSM_USER_AGENT,
    },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const txt = await res.text();
  const data = JSON.parse(txt) as { elements?: OverpassElement[] }; // lanza si es HTML
  if (!Array.isArray(data.elements)) throw new Error("respuesta inválida");
  return data.elements;
}

// Dispara TODOS los espejos a la vez y se queda con el primero que responda
// bien. Así el tiempo es el del más rápido, no la suma de los lentos.
async function queryOverpass(query: string): Promise<OverpassElement[]> {
  const controllers = OVERPASS_MIRRORS.map(() => new AbortController());
  const timers = controllers.map((c) => setTimeout(() => c.abort(), 9000));
  try {
    return await Promise.any(
      OVERPASS_MIRRORS.map((url, i) => hitMirror(url, query, controllers[i].signal))
    );
  } catch {
    throw new OsmError(
      "Los servidores de mapas están saturados. Intenta de nuevo en unos segundos.",
      502
    );
  } finally {
    // Cancela los que sigan corriendo y limpia timers.
    controllers.forEach((c) => c.abort());
    timers.forEach(clearTimeout);
  }
}

function buildAddress(t: Record<string, string>): string | undefined {
  const parts = [
    [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "),
    t["addr:neighbourhood"] || t["addr:suburb"],
    t["addr:city"],
    t["addr:postcode"],
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

// Ciudad -> bounding box con Nominatim (cacheado 30 días).
// Pedimos varios resultados y elegimos el que sea CIUDAD/municipio; así evitamos
// que "Querétaro" se interprete como el ESTADO completo (bbox gigante = lento).
// En modo general (global) no restringimos país; si no, sólo México.
// También se usa para DENUE (centro, estado y municipio): ver geocodePlace().
async function geocodeCity(city: string, global: boolean): Promise<GeoPlace> {
  const key = ["geo2", normalizeKeyPart(city), global ? "global" : "mx"].join("|");
  const hit = await getCached<GeoPlace>(key, GEO_TTL_MS);
  if (hit && Array.isArray(hit.data?.bbox) && hit.data.bbox.length === 4) {
    return hit.data;
  }

  return coalesce(key, async () => {
    const countryParam = global ? "" : "&countrycodes=mx";
    const geoUrl = `${NOMINATIM}?q=${encodeURIComponent(
      city
    )}&format=json&limit=10&addressdetails=1${countryParam}`;
    const geoTimeout = withTimeout(6000);
    let geoRes: Response;
    try {
      geoRes = await fetch(geoUrl, {
        headers: { "User-Agent": OSM_USER_AGENT },
        signal: geoTimeout.signal,
      });
    } catch {
      throw new OsmError("Error geocodificando la ciudad.", 502);
    } finally {
      geoTimeout.cancel();
    }
    if (!geoRes.ok) throw new OsmError("Error geocodificando la ciudad.", 502);

    const geo = (await geoRes.json()) as Array<{
      boundingbox: [string, string, string, string];
      display_name: string;
      lat?: string;
      lon?: string;
      class?: string;
      type?: string;
      addresstype?: string;
      importance?: number;
      address?: Record<string, string>;
    }>;
    if (!geo.length) {
      throw new OsmError(
        global
          ? `No encontré "${city}". Prueba con el nombre de la ciudad y el país.`
          : `No encontré "${city}" en México. Prueba con el nombre de la ciudad.`,
        404
      );
    }

    // Área aproximada del bbox (en grados²) para comparar tamaños.
    const bboxArea = (bb: [string, string, string, string]) => {
      const [s, n, w, e] = bb.map(Number);
      return Math.abs(n - s) * Math.abs(e - w);
    };
    const CITY_TYPES = new Set(["city", "town", "village", "municipality", "suburb"]);
    // Candidatos tipo ciudad (excluye estado/país); si no hay, usamos todos.
    const cityLike = geo.filter(
      (g) => CITY_TYPES.has(g.addresstype || "") || CITY_TYPES.has(g.type || "")
    );
    const pool = cityLike.length ? cityLike : geo;
    // Elegimos por PROMINENCIA (importance de Nominatim): así "Madrid" es
    // Madrid España y no Madrid, Iowa. Empate -> bbox más chico.
    const best = pool.reduce((a, b) => {
      const ia = a.importance ?? 0;
      const ib = b.importance ?? 0;
      if (ib !== ia) return ib > ia ? b : a;
      return bboxArea(a.boundingbox) <= bboxArea(b.boundingbox) ? a : b;
    });

    // boundingbox = [south, north, west, east]
    const [south, north, west, east] = best.boundingbox.map(Number);
    const a = best.address ?? {};
    const lat = Number(best.lat);
    const lon = Number(best.lon);
    const place: GeoPlace = {
      displayName: best.display_name,
      bbox: [south, north, west, east],
      lat: Number.isFinite(lat) ? lat : (south + north) / 2,
      lon: Number.isFinite(lon) ? lon : (west + east) / 2,
      kind: best.addresstype || best.type,
      stateIso: a["ISO3166-2-lvl4"],
      state: a.state,
      county: a.county,
      borough: a.borough,
    };
    await setCached(key, { source: "nominatim", city: place.displayName, data: place });
    return place;
  });
}

/**
 * Geocodifica un lugar con Nominatim (solo México salvo `global`), con caché de
 * 30 días: bbox, centro, estado (ISO) y municipio. Lanza OsmError.
 */
export function geocodePlace(city: string, opts: { global?: boolean } = {}): Promise<GeoPlace> {
  return geocodeCity(city, !!opts.global);
}

function buildOverpassQuery(cat: Category, place: GeoPlace): string {
  const [south, north, west, east] = place.bbox;
  const bbox = `${south},${west},${north},${east}`;
  const clauses = cat.filters
    .flatMap((f) => [`node[${f}](${bbox});`, `way[${f}](${bbox});`])
    .join("\n  ");
  return `[out:json][timeout:20];
(
  ${clauses}
);
out center tags;`;
}

function toBusinesses(elements: OverpassElement[], cat: Category): Business[] {
  const seen = new Set<string>();
  const results: Business[] = [];

  for (const el of elements) {
    const t = el.tags || {};
    const name = t.name || t["operator"] || t["brand"];
    if (!name) continue; // sin nombre no sirve como prospecto

    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (lat == null || lon == null) continue;

    const dedupeKey = name.toLowerCase().trim();
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);

    results.push({
      id: `${el.type}/${el.id}`,
      name,
      category: cat.label,
      phone: t.phone || t["contact:phone"] || t["contact:mobile"],
      website: t.website || t["contact:website"] || t.url,
      email: t.email || t["contact:email"],
      address: buildAddress(t),
      lat,
      lon,
      source: "osm",
    });
  }

  // Ordena: primero los que ya traen web o correo (más accionables).
  const score = (x: Business) => (x.email ? 2 : 0) + (x.website ? 1 : 0);
  results.sort((a, b) => score(b) - score(a));
  return results;
}

/**
 * Busca negocios en OpenStreetMap por giro + ciudad, con caché de 7 días
 * (llave "osm|giro|ciudad normalizada|global|mx"). `refresh` salta la caché y la
 * renueva. Búsquedas idénticas simultáneas comparten la misma petición.
 * Lanza OsmError con mensaje para el usuario.
 */
export async function searchOsm(
  city: string,
  cat: Category,
  opts: { global: boolean; refresh?: boolean }
): Promise<OsmSearch> {
  const key = ["osm", cat.slug, normalizeKeyPart(city), opts.global ? "global" : "mx"].join("|");

  if (!opts.refresh) {
    const hit = await getCached<Business[]>(key, RESULTS_TTL_MS);
    if (hit && Array.isArray(hit.data)) {
      return {
        city: hit.city ?? city,
        results: hit.data,
        cached: true,
        cachedAt: hit.createdAt,
      };
    }
  }

  const fresh = await coalesce(key, async () => {
    const place = await geocodeCity(city, opts.global);
    const elements = await queryOverpass(buildOverpassQuery(cat, place));
    const results = toBusinesses(elements, cat);
    // No cacheamos vacíos: si alguien agrega negocios a OSM, que se vean pronto.
    if (results.length) {
      await setCached(key, {
        source: "osm",
        category: cat.slug,
        city: place.displayName,
        data: results,
      });
    }
    return { city: place.displayName, results };
  });

  return { ...fresh, cached: false };
}
