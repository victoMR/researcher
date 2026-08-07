import { NextRequest, NextResponse } from "next/server";
import { getCategory } from "@/lib/categories";
import { searchPlaces } from "@/lib/places";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
// Varios espejos de Overpass; se satura seguido, así que rotamos.
// Kumi suele ser el más rápido, así que va primero.
const OVERPASS_MIRRORS = [
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass-api.de/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
];
// Nominatim y Overpass piden un User-Agent identificable.
const UA = "Prospector/1.0 (lead research tool)";

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
      "User-Agent": UA,
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
  const timers = controllers.map((c) =>
    setTimeout(() => c.abort(), 9000)
  );
  try {
    const winner = await Promise.any(
      OVERPASS_MIRRORS.map((url, i) =>
        hitMirror(url, query, controllers[i].signal)
      )
    );
    return winner;
  } catch {
    throw new Error("Overpass no disponible");
  } finally {
    // Cancela los que sigan corriendo y limpia timers.
    controllers.forEach((c) => c.abort());
    timers.forEach(clearTimeout);
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

function buildAddress(t: Record<string, string>): string | undefined {
  const parts = [
    [t["addr:street"], t["addr:housenumber"]].filter(Boolean).join(" "),
    t["addr:neighbourhood"] || t["addr:suburb"],
    t["addr:city"],
    t["addr:postcode"],
  ].filter(Boolean);
  return parts.length ? parts.join(", ") : undefined;
}

export async function POST(req: NextRequest) {
  try {
    const { city, category, source, global } = (await req.json()) as {
      city?: string;
      category?: string;
      source?: "google" | "osm"; // "osm" fuerza modo gratis (sin llamar a Google)
      global?: boolean; // true = búsqueda mundial (sin límite de país)
    };

    if (!city || !category) {
      return NextResponse.json(
        { error: "Faltan 'city' o 'category'." },
        { status: 400 }
      );
    }

    const cat = getCategory(category);
    if (!cat) {
      return NextResponse.json(
        { error: `Giro desconocido: ${category}` },
        { status: 400 }
      );
    }

    // Fuente principal: Google Places (mejor cobertura en México). Pero el
    // "modo general" fuerza OSM (source="osm") para NO gastar cuota de Google.
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    if (apiKey && source !== "osm") {
      try {
        const results = await searchPlaces(city, cat, apiKey);
        return NextResponse.json({
          city,
          count: results.length,
          results,
          source: "google",
        });
      } catch (e) {
        console.error("places error", e);
        const msg = (e as Error).message || "";
        // Distingue fallo temporal de Google vs problema real de key/permisos.
        const transient = /\b(500|502|503|504|429)\b/.test(msg);
        const keyIssue = /\b(401|403)\b/.test(msg) || /REQUEST_DENIED|PERMISSION/i.test(msg);
        return NextResponse.json(
          {
            error: transient
              ? "Google está saturado ahora mismo. Intenta de nuevo en unos segundos."
              : keyIssue
                ? "Google rechazó la API key (revisa permisos/facturación en Google Cloud)."
                : "No se pudo completar la búsqueda con Google. Intenta de nuevo.",
          },
          { status: 502 }
        );
      }
    }

    // 1) Geocodificar -> bounding box. Pedimos varios resultados y elegimos
    //    el que sea CIUDAD/municipio con el área más chica; así evitamos que
    //    "Querétaro" se interprete como el ESTADO completo (bbox gigante = lento).
    // En modo general (global) no restringimos país; si no, sólo México.
    const countryParam = global ? "" : "&countrycodes=mx";
    const geoUrl = `${NOMINATIM}?q=${encodeURIComponent(
      city
    )}&format=json&limit=10&addressdetails=1${countryParam}`;
    const geoTimeout = withTimeout(6000);
    const geoRes = await fetch(geoUrl, {
      headers: { "User-Agent": UA },
      signal: geoTimeout.signal,
    }).finally(geoTimeout.cancel);
    if (!geoRes.ok) {
      return NextResponse.json(
        { error: "Error geocodificando la ciudad." },
        { status: 502 }
      );
    }
    const geo = (await geoRes.json()) as Array<{
      boundingbox: [string, string, string, string];
      display_name: string;
      class?: string;
      type?: string;
      addresstype?: string;
      importance?: number;
    }>;
    if (!geo.length) {
      return NextResponse.json(
        { error: `No encontré "${city}" en México. Prueba con el nombre de la ciudad.` },
        { status: 404 }
      );
    }

    // Área aproximada del bbox (en grados²) para comparar tamaños.
    const bboxArea = (bb: [string, string, string, string]) => {
      const [s, n, w, e] = bb.map(Number);
      return Math.abs(n - s) * Math.abs(e - w);
    };
    const CITY_TYPES = new Set([
      "city",
      "town",
      "village",
      "municipality",
      "suburb",
    ]);
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
    const bbox = `${south},${west},${north},${east}`;

    // 2) Construir la consulta Overpass.
    const clauses = cat.filters
      .flatMap((f) => [
        `node[${f}](${bbox});`,
        `way[${f}](${bbox});`,
      ])
      .join("\n  ");

    const query = `[out:json][timeout:20];
(
  ${clauses}
);
out center tags;`;

    let elements: OverpassElement[];
    try {
      elements = await queryOverpass(query);
    } catch {
      return NextResponse.json(
        { error: "Los servidores de mapas están saturados. Intenta de nuevo en unos segundos." },
        { status: 502 }
      );
    }

    const seen = new Set<string>();
    const results: Business[] = [];

    for (const el of elements) {
      const t = el.tags || {};
      const name = t.name || t["operator"] || t["brand"];
      if (!name) continue; // sin nombre no sirve como prospecto

      const lat = el.lat ?? el.center?.lat;
      const lon = el.lon ?? el.center?.lon;
      if (lat == null || lon == null) continue;

      const id = `${el.type}/${el.id}`;
      const dedupeKey = name.toLowerCase().trim();
      if (seen.has(dedupeKey)) continue;
      seen.add(dedupeKey);

      results.push({
        id,
        name,
        category: cat.label,
        phone: t.phone || t["contact:phone"] || t["contact:mobile"],
        website: t.website || t["contact:website"] || t.url,
        email: t.email || t["contact:email"],
        address: buildAddress(t),
        lat,
        lon,
      });
    }

    // Ordena: primero los que ya traen web o correo (más accionables).
    results.sort((a, b) => {
      const score = (x: Business) =>
        (x.email ? 2 : 0) + (x.website ? 1 : 0);
      return score(b) - score(a);
    });

    return NextResponse.json({
      city: best.display_name,
      count: results.length,
      results,
      source: "osm",
    });
  } catch (err) {
    console.error("search error", err);
    return NextResponse.json(
      { error: "Error inesperado en la búsqueda." },
      { status: 500 }
    );
  }
}
