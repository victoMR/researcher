import { NextRequest, NextResponse } from "next/server";
import { getCategory, matchesScian, type Category } from "@/lib/categories";
import { PLACES_API, cleanCity, resolvePageToken, searchPlacesPage } from "@/lib/places";
import { OsmError, geocodePlace, searchOsm } from "@/lib/osm";
import {
  DenueError,
  denueAreaForPlace,
  denueAreaPage,
  denueNearResult,
  denueReady,
  denueToBusiness,
  distanceM,
  municipioCode,
  type DenueEstablishment,
  type DenueResult,
} from "@/lib/denue";
import { googlePlacesDailyCap, trackCall, usedToday } from "@/lib/api-usage";
import { coalesce, normalizeKeyPart } from "@/lib/search-cache";
import { sessionEmail } from "@/lib/session";
import type { Business, SearchResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface SearchBody {
  city?: unknown;
  category?: unknown;
  // "denue" = México con DENUE (base), "google" = consulta en vivo, "osm" = gratis/mundial.
  // Sin source: Google si hay key, si no OSM (comportamiento anterior).
  source?: "denue" | "google" | "osm";
  global?: boolean; // true = búsqueda mundial (sin límite de país)
  refresh?: boolean; // true = ignora la caché y la renueva
  pageToken?: unknown; // siguiente página (Google o DENUE; viene de nextPageToken)
}

// Qué fuentes tiene configuradas el servidor (para el selector de modo).
export async function GET(req: NextRequest) {
  // Lee la sesión: además de proteger, hace la ruta dinámica (lee env en cada request).
  if (!(await sessionEmail(req))) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  return NextResponse.json({
    denueAvailable: denueReady(),
    googleAvailable: !!process.env.GOOGLE_PLACES_API_KEY,
  });
}

// Traduce el error de Google a un mensaje para el usuario.
function googleErrorResponse(e: unknown, paging: boolean) {
  console.error("places error", e);
  const msg = (e as Error)?.message || "";
  // Distingue fallo temporal de Google vs problema real de key/permisos.
  const transient = /\b(500|502|503|504|429)\b/.test(msg);
  const keyIssue = /\b(401|403)\b/.test(msg) || /REQUEST_DENIED|PERMISSION/i.test(msg);
  const badToken = paging && /\b400\b|INVALID_ARGUMENT/i.test(msg);
  return NextResponse.json(
    {
      error: transient
        ? "Google está saturado ahora mismo. Intenta de nuevo en unos segundos."
        : keyIssue
          ? "Google rechazó la API key (revisa permisos/facturación en Google Cloud)."
          : badToken
            ? "La página siguiente ya expiró. Vuelve a buscar."
            : "No se pudo completar la búsqueda con Google. Intenta de nuevo.",
    },
    { status: badToken ? 400 : 502 }
  );
}

/* ---------- DENUE ---------- */

const DENUE_PAGE = 100; // registros por clase SCIAN en cada página
const DENUE_MAX_RESULTS = 400;

// Cursor propio de DENUE: siguiente registro por cada clase SCIAN del giro (0 = agotada).
interface DenueCursor {
  s: "denue";
  c: string; // slug del giro
  q: string; // ciudad normalizada
  e: string; // entidad
  m: string; // municipio ("0" = toda la entidad)
  o: number[]; // offsets por clase (cat.scian)
}

function encodeDenueCursor(cur: DenueCursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cur })).toString("base64url");
}

function decodeDenueCursor(token: string): DenueCursor | null {
  try {
    const o = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<
      DenueCursor & { v: number }
    >;
    if (o.v !== 1 || o.s !== "denue" || !o.c || !o.q || !o.e || !o.m || !Array.isArray(o.o)) {
      return null;
    }
    return { s: "denue", c: o.c, q: o.q, e: o.e, m: o.m, o: o.o.map(Number) };
  } catch {
    return null;
  }
}

// Más accionables primero: correo, web, teléfono; luego más empleados.
function contactRank(e: DenueEstablishment): number {
  const size = Number(/^(\d+)/.exec(e.employees ?? "")?.[1] ?? 0);
  return (e.email ? 4 : 0) + (e.website ? 2 : 0) + (e.phone ? 1 : 0) + Math.min(size, 251) / 1000;
}

function mergeDenue(lists: DenueEstablishment[][], cat: Category): DenueEstablishment[] {
  const seen = new Set<string>();
  const out: DenueEstablishment[] = [];
  for (const e of lists.flat()) {
    if (seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  // Solo el giro (por si la API devolviera clases vecinas).
  return out.filter((e) => !e.scianCode || matchesScian(cat, e.scianCode));
}

function cacheInfo(rs: DenueResult[]): Pick<SearchResponse, "cached" | "cachedAt"> {
  if (!rs.length || rs.some((r) => !r.cachedAt)) return {};
  const oldest = rs.map((r) => r.cachedAt!).sort()[0];
  return { cached: true, cachedAt: oldest };
}

// Una página por área (entidad / municipio), una consulta por clase SCIAN.
async function denueAreaSearch(
  cat: Category,
  ent: string,
  mun: string,
  offsets: number[],
  refresh: boolean
): Promise<{ list: DenueEstablishment[]; rs: DenueResult[]; next: number[] }> {
  const next = cat.scian.map(() => 0);
  const rs = await Promise.all(
    cat.scian.map(async (code, i) => {
      const start = offsets[i] ?? 0;
      if (start <= 0) return null;
      const r = await denueAreaPage(
        { ent, mun: mun === "0" ? null : mun, scianCode: code },
        start,
        start + DENUE_PAGE - 1,
        { refresh }
      );
      next[i] = r.data.length >= DENUE_PAGE ? start + DENUE_PAGE : 0;
      return r;
    })
  );
  const ok = rs.filter((r): r is DenueResult => !!r);
  return { list: mergeDenue(ok.map((r) => r.data), cat), rs: ok, next };
}

// Cercanía a un punto (radio ≤ 5 km) con las palabras del giro, filtrado por SCIAN.
async function denueNearSearch(
  cat: Category,
  lat: number,
  lon: number,
  radiusM: number,
  refresh: boolean
): Promise<{ list: DenueEstablishment[]; rs: DenueResult[] }> {
  const rs = await Promise.all(
    cat.keywords.map((keyword) => denueNearResult({ keyword, lat, lon, radiusM }, { refresh }))
  );
  const list = mergeDenue(rs.map((r) => r.data), cat).sort(
    (a, b) => distanceM(lat, lon, a.lat, a.lon) - distanceM(lat, lon, b.lat, b.lon)
  );
  return { list, rs };
}

// Radio para buscar por cercanía según el tamaño del lugar (1.5 a 5 km).
function radiusFor(bbox: [number, number, number, number]): number {
  const [s, n, w, e] = bbox;
  const half = distanceM(s, w, n, e) / 2;
  return Math.max(1500, Math.min(5000, Math.round(half)));
}

function toBusinesses(list: DenueEstablishment[], cat: Category): Business[] {
  return list.slice(0, DENUE_MAX_RESULTS).map((e) => denueToBusiness(e, cat.label));
}

async function searchDenue(
  city: string,
  cat: Category,
  opts: { refresh: boolean; pageToken?: string }
): Promise<SearchResponse> {
  // Página siguiente: el cursor ya trae entidad/municipio y offsets.
  if (opts.pageToken) {
    const cur = decodeDenueCursor(opts.pageToken);
    if (!cur || cur.c !== cat.slug || cur.q !== normalizeKeyPart(city)) {
      throw new DenueError("El token de página no corresponde a esta búsqueda. Vuelve a buscar.", 400);
    }
    const { list, rs, next } = await denueAreaSearch(cat, cur.e, cur.m, cur.o, false);
    const more = next.some((n) => n > 0);
    return {
      city,
      count: list.length,
      results: toBusinesses(list.sort((a, b) => contactRank(b) - contactRank(a)), cat),
      source: "denue",
      denueAvailable: true,
      ...cacheInfo(rs),
      ...(more ? { nextPageToken: encodeDenueCursor({ ...cur, o: next }) } : {}),
    };
  }

  const place = await geocodePlace(city);
  const area = denueAreaForPlace(place, city);
  if (!area) {
    throw new DenueError(`No ubiqué "${city}" en un estado de México.`, 404);
  }
  const lat = place.lat ?? (place.bbox[0] + place.bbox[1]) / 2;
  const lon = place.lon ?? (place.bbox[2] + place.bbox[3]) / 2;
  const base = { city: place.displayName, source: "denue", denueAvailable: true } as const;

  // Colonia / localidad: por cercanía al punto.
  if (area.scope === "punto") {
    const near = await denueNearSearch(cat, lat, lon, radiusFor(place.bbox), opts.refresh);
    if (near.list.length || !area.municipio) {
      return {
        ...base,
        count: near.list.length,
        results: toBusinesses(near.list, cat),
        ...cacheInfo(near.rs),
      };
    }
    // Sin resultados por palabra: todo el municipio, del más cercano al más lejano.
  }

  let mun = "0";
  if (area.municipio) {
    const code = await municipioCode(area.entidad, area.municipio).catch(() => null);
    if (!code) {
      // No se pudo resolver la clave: cercanía al centro (5 km).
      const near = await denueNearSearch(cat, lat, lon, 5000, opts.refresh);
      return {
        ...base,
        count: near.list.length,
        results: toBusinesses(near.list, cat),
        ...cacheInfo(near.rs),
        notice: `Búsqueda por cercanía: hasta 5 km del centro de ${city}.`,
      };
    }
    mun = code;
  }

  const first = cat.scian.map(() => 1);
  const { list, rs, next } = await denueAreaSearch(cat, area.entidad, mun, first, opts.refresh);
  const sorted =
    area.scope === "punto"
      ? list.sort(
          (a, b) => distanceM(lat, lon, a.lat, a.lon) - distanceM(lat, lon, b.lat, b.lon)
        )
      : list.sort((a, b) => contactRank(b) - contactRank(a));
  const more = next.some((n) => n > 0);
  return {
    ...base,
    count: sorted.length,
    results: toBusinesses(sorted, cat),
    ...cacheInfo(rs),
    ...(more
      ? {
          nextPageToken: encodeDenueCursor({
            s: "denue",
            c: cat.slug,
            q: normalizeKeyPart(city),
            e: area.entidad,
            m: mun,
            o: next,
          }),
        }
      : {}),
  };
}

export async function POST(req: NextRequest) {
  try {
    let body: SearchBody;
    try {
      body = (await req.json()) as SearchBody;
    } catch {
      return NextResponse.json({ error: "Solicitud inválida." }, { status: 400 });
    }
    const { source, global, refresh } = body;
    const city = typeof body.city === "string" ? cleanCity(body.city) : "";
    const category = typeof body.category === "string" ? body.category : "";
    const pageToken =
      typeof body.pageToken === "string" && body.pageToken ? body.pageToken : undefined;

    if (!city || !category) {
      return NextResponse.json(
        { error: "Faltan 'city' o 'category'." },
        { status: 400 }
      );
    }
    if (city.length > 120) {
      return NextResponse.json({ error: "Ciudad demasiado larga." }, { status: 400 });
    }

    const cat = getCategory(category);
    if (!cat) {
      return NextResponse.json(
        { error: `Giro desconocido: ${category}` },
        { status: 400 }
      );
    }

    const denueAvailable = denueReady();
    let notice: string | undefined;

    // Fuente base en México: DENUE (INEGI, datos abiertos: se guarda y exporta).
    if (source === "denue") {
      if (denueAvailable) {
        try {
          const payload = await searchDenue(city, cat, { refresh: !!refresh, pageToken });
          return NextResponse.json(payload);
        } catch (e) {
          if (e instanceof OsmError) {
            return NextResponse.json({ error: e.message, denueAvailable }, { status: e.status });
          }
          if (!(e instanceof DenueError)) throw e;
          // Errores del usuario (ciudad, token de página): se muestran tal cual.
          if (e.status < 500 || pageToken) {
            return NextResponse.json({ error: e.message, denueAvailable }, { status: e.status });
          }
          // DENUE caído o token inválido: seguimos con OSM (México) avisando.
          console.error("denue search", e.message);
          notice = `${e.message} Mostrando resultados gratis de OpenStreetMap.`;
        }
      } else {
        notice =
          "DENUE no está configurado (falta DENUE_TOKEN). Mostrando otra fuente; el token es gratis en inegi.org.mx.";
      }
    }

    // Google Places: consulta en vivo (no se guarda ni se exporta su contenido).
    // "osm" fuerza modo gratis; si DENUE falló caemos directo a OSM.
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    const useGoogle =
      !!apiKey && source !== "osm" && !(source === "denue" && denueAvailable);

    if (pageToken && !useGoogle) {
      return NextResponse.json(
        { error: "La paginación de esta búsqueda ya no aplica. Vuelve a buscar." },
        { status: 400 }
      );
    }

    if (apiKey && useGoogle) {
      // pageToken: validamos que sea de este mismo giro + ciudad y recuperamos la
      // ciudad exacta de la primera página (Google exige repetir la misma consulta).
      let queryCity = city;
      let googleToken: string | undefined;
      if (pageToken) {
        const resolved = resolvePageToken(pageToken, city, cat);
        if (!resolved) {
          return NextResponse.json(
            { error: "El token de página no corresponde a esta búsqueda. Vuelve a buscar." },
            { status: 400 }
          );
        }
        queryCity = resolved.city;
        googleToken = resolved.googleToken;
      }

      // Tope diario de gasto (null = sin BD -> sin tope).
      const cap = googlePlacesDailyCap();
      const used = await usedToday(PLACES_API);
      const capped = used !== null && used >= cap;

      if (!capped) {
        try {
          // Búsquedas idénticas simultáneas -> una sola llamada (y un solo cobro).
          const key = [
            "google",
            cat.slug,
            normalizeKeyPart(queryCity),
            googleToken ?? "",
          ].join("|");
          const page = await coalesce(key, async () => {
            const r = await searchPlacesPage(queryCity, cat, apiKey, googleToken);
            await trackCall(PLACES_API); // sólo se cobran las exitosas
            return r;
          });
          const payload: SearchResponse = {
            city,
            count: page.results.length,
            results: page.results,
            source: "google",
            nextPageToken: page.nextPageToken,
            denueAvailable,
            ...(notice ? { notice } : {}),
          };
          return NextResponse.json(payload);
        } catch (e) {
          return googleErrorResponse(e, !!googleToken);
        }
      }

      // Tope alcanzado.
      if (pageToken) {
        // "Cargar más" no puede mezclar OSM a media lista: avisamos y ya.
        const payload: SearchResponse = {
          city,
          count: 0,
          results: [],
          source: "google",
          denueAvailable,
          notice: `Se alcanzó el tope diario de Google (${cap} búsquedas). Vuelve a buscar para ver resultados gratis de OpenStreetMap.`,
        };
        return NextResponse.json(payload);
      }
      notice = `Se alcanzó el tope diario de Google (${cap} búsquedas). Mostrando resultados gratis de OpenStreetMap.`;
    }

    // Fuente gratis: OpenStreetMap (con caché de 7 días).
    // Si caímos aquí por un aviso (tope de Google, DENUE), buscamos sólo en México.
    try {
      const osm = await searchOsm(city, cat, {
        global: !!global && !notice && source !== "denue",
        refresh: !!refresh,
      });
      const payload: SearchResponse = {
        city: osm.city,
        count: osm.results.length,
        results: osm.results,
        source: "osm",
        denueAvailable,
        ...(osm.cached ? { cached: true, cachedAt: osm.cachedAt } : {}),
        ...(notice ? { notice } : {}),
      };
      return NextResponse.json(payload);
    } catch (e) {
      if (e instanceof OsmError) {
        return NextResponse.json(
          { error: e.message, denueAvailable, ...(notice ? { notice } : {}) },
          { status: e.status }
        );
      }
      throw e;
    }
  } catch (err) {
    console.error("search error", err);
    return NextResponse.json(
      { error: "Error inesperado en la búsqueda." },
      { status: 500 }
    );
  }
}
