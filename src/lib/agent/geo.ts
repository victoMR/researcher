// Geocodificación (Nominatim) y búsqueda libre en OpenStreetMap (Overpass)
// para el agente. Datos ODbL: se pueden cachear y exportar (atribución
// "© OpenStreetMap contributors"). Nominatim pide máx. 1 req/s y cachear.
// Nota: osm.ts no exporta geocodeCity/queryOverpass (son por giro fijo), por
// eso aquí hay versiones por punto/radio y etiquetas libres.
import { OSM_USER_AGENT } from "../osm";
import { coalesce, getCached, normalizeKeyPart, setCached } from "../search-cache";
import { clampNum, distanceM } from "./normalize";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const OVERPASS_MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
const DAY_MS = 24 * 60 * 60 * 1000;

export class GeoError extends Error {}

export interface GeoZone {
  name: string; // display_name
  shortName: string; // nombre + municipio/estado
  lat: number;
  lon: number;
  bbox: { south: number; north: number; west: number; east: number };
  type?: string; // suburb, city, neighbourhood...
  radiusM: number; // radio sugerido (cubre la zona, máx. 5 km)
  alternatives: string[];
}

interface NominatimHit {
  lat: string;
  lon: string;
  boundingbox: [string, string, string, string];
  display_name: string;
  name?: string;
  addresstype?: string;
  type?: string;
  importance?: number;
  address?: Record<string, string>;
}

// Respeta 1 req/s a Nominatim dentro de esta instancia.
let nextNominatimAt = 0;
async function nominatimSlot(): Promise<void> {
  const now = Date.now();
  const wait = Math.max(0, nextNominatimAt - now);
  nextNominatimAt = Math.max(now, nextNominatimAt) + 1100;
  if (wait) await new Promise((r) => setTimeout(r, wait));
}

function shortNameOf(h: NominatimHit): string {
  const a = h.address ?? {};
  const first = h.name || h.display_name.split(",")[0];
  const city = a.city || a.town || a.village || a.municipality || a.county;
  const state = a.state;
  return [first, city !== first ? city : undefined, state !== city ? state : undefined]
    .filter(Boolean)
    .join(", ");
}

/** Zona de México (colonia, municipio, ciudad...) -> centro, caja y radio. */
export async function geocodeZone(query: string): Promise<GeoZone> {
  const q = query.trim().slice(0, 160);
  if (!q) throw new GeoError("Falta la zona.");
  const key = `agentgeo|${normalizeKeyPart(q)}`;
  const hit = await getCached<GeoZone>(key, 30 * DAY_MS);
  if (hit?.data && typeof hit.data.lat === "number") return hit.data;

  return coalesce(key, async () => {
    await nominatimSlot();
    const url = `${NOMINATIM}?q=${encodeURIComponent(
      q
    )}&format=jsonv2&limit=5&addressdetails=1&countrycodes=mx&accept-language=es`;
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    let hits: NominatimHit[];
    try {
      const res = await fetch(url, { headers: { "User-Agent": OSM_USER_AGENT }, signal: ctrl.signal });
      if (!res.ok) throw new GeoError("El servicio de mapas no respondió; intenta de nuevo.");
      hits = (await res.json()) as NominatimHit[];
    } catch (e) {
      if (e instanceof GeoError) throw e;
      throw new GeoError("El servicio de mapas no respondió; intenta de nuevo.");
    } finally {
      clearTimeout(t);
    }
    if (!hits.length) {
      throw new GeoError(`No encontré "${q}" en México. Prueba con "colonia, municipio, estado".`);
    }
    // Lo más específico que no sea el país o el estado completo.
    const best = hits.find((h) => !["country", "state"].includes(h.addresstype ?? "")) ?? hits[0];
    const [s, n, w, e] = best.boundingbox.map(Number);
    const lat = Number(best.lat);
    const lon = Number(best.lon);
    // Radio = media diagonal de la caja, entre 800 m y 5 km.
    const half = distanceM({ lat: s, lon: w }, { lat: n, lon: e }) / 2;
    const zone: GeoZone = {
      name: best.display_name,
      shortName: shortNameOf(best),
      lat,
      lon,
      bbox: { south: s, north: n, west: w, east: e },
      type: best.addresstype || best.type,
      radiusM: Math.round(clampNum(half, 800, 5000, 1500) / 100) * 100,
      alternatives: hits
        .filter((h) => h !== best)
        .slice(0, 3)
        .map((h) => h.display_name),
    };
    await setCached(key, { source: "nominatim", city: zone.name, data: zone });
    return zone;
  });
}

// ---------- Overpass ----------

interface OverpassElement {
  type: "node" | "way" | "relation";
  id: number;
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
}

export interface OsmPlace {
  osmId: string; // "node/123"
  name: string;
  kind?: string; // "amenity=dentist"
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  lat: number;
  lon: number;
  distanceM?: number;
}

async function hitMirror(url: string, query: string, signal: AbortSignal): Promise<OverpassElement[]> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", "User-Agent": OSM_USER_AGENT },
    body: `data=${encodeURIComponent(query)}`,
    signal,
  });
  if (!res.ok) throw new Error(`${res.status}`);
  const data = JSON.parse(await res.text()) as { elements?: OverpassElement[] };
  if (!Array.isArray(data.elements)) throw new Error("respuesta inválida");
  return data.elements;
}

// Todos los espejos a la vez; gana el primero que responda bien.
async function queryOverpass(query: string): Promise<OverpassElement[]> {
  const ctrls = OVERPASS_MIRRORS.map(() => new AbortController());
  const timers = ctrls.map((c) => setTimeout(() => c.abort(), 12000));
  try {
    return await Promise.any(OVERPASS_MIRRORS.map((u, i) => hitMirror(u, query, ctrls[i].signal)));
  } catch {
    throw new GeoError("Los servidores de OpenStreetMap están saturados; intenta más tarde o usa otra fuente.");
  } finally {
    ctrls.forEach((c) => c.abort());
    timers.forEach(clearTimeout);
  }
}

// "amenity=dentist" -> ["amenity","dentist"] (solo caracteres seguros, sin comillas).
export function parseOsmTag(tag: string): [string, string] | null {
  const m = tag.trim().match(/^([a-z][a-z0-9_:]{0,40})\s*=\s*([A-Za-z0-9_ .:;-]{1,60})$/);
  return m ? [m[1], m[2].trim()] : null;
}

// Palabra para buscar en el nombre: letras, números y espacios; regex escapada.
export function safeWord(word: string): string | null {
  const w = word
    .normalize("NFC")
    .replace(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 40);
  return w.length >= 3 ? w : null;
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

const KIND_KEYS = ["amenity", "healthcare", "shop", "office", "craft", "leisure", "tourism"];

/** Negocios de OSM alrededor de un punto por etiquetas y/o palabras del nombre. */
export async function searchOsmAround(o: {
  lat: number;
  lon: number;
  radiusM: number;
  tags: [string, string][];
  words: string[];
  limit: number;
}): Promise<OsmPlace[]> {
  const r = Math.round(clampNum(o.radiusM, 100, 10000, 1500));
  const around = `(around:${r},${o.lat.toFixed(6)},${o.lon.toFixed(6)})`;
  const clauses: string[] = [];
  for (const [k, v] of o.tags) {
    clauses.push(`node["${k}"="${v}"]${around};`, `way["${k}"="${v}"]${around};`);
  }
  for (const w of o.words) {
    const re = w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    clauses.push(`node["name"~"${re}",i]${around};`, `way["name"~"${re}",i]${around};`);
  }
  if (!clauses.length) return [];
  const query = `[out:json][timeout:20];\n(\n  ${clauses.join("\n  ")}\n);\nout center tags 300;`;

  const key = `agentosm|${normalizeKeyPart(query)}`;
  let elements: OverpassElement[];
  const hit = await getCached<OverpassElement[]>(key, 7 * DAY_MS);
  if (hit && Array.isArray(hit.data)) {
    elements = hit.data;
  } else {
    elements = await coalesce(key, () => queryOverpass(query));
    if (elements.length) await setCached(key, { source: "osm", data: elements });
  }

  const seen = new Set<string>();
  const out: OsmPlace[] = [];
  for (const el of elements) {
    const t = el.tags || {};
    const name = t.name || t.brand || t.operator;
    const lat = el.lat ?? el.center?.lat;
    const lon = el.lon ?? el.center?.lon;
    if (!name || lat == null || lon == null) continue;
    const dk = name.toLowerCase().trim();
    if (seen.has(dk)) continue;
    seen.add(dk);
    const kindKey = KIND_KEYS.find((k) => t[k]);
    out.push({
      osmId: `${el.type}/${el.id}`,
      name,
      kind: kindKey ? `${kindKey}=${t[kindKey]}` : undefined,
      phone: t.phone || t["contact:phone"] || t["contact:mobile"] || t["contact:whatsapp"],
      email: t.email || t["contact:email"],
      website: t.website || t["contact:website"] || t.url,
      address: buildAddress(t),
      lat,
      lon,
      distanceM: Math.round(distanceM({ lat, lon }, { lat: o.lat, lon: o.lon })),
    });
  }
  out.sort((a, b) => (a.distanceM ?? 0) - (b.distanceM ?? 0));
  return out.slice(0, o.limit);
}
