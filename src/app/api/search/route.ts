import { NextRequest, NextResponse } from "next/server";
import { getCategory, matchesScian, type Category } from "@/lib/categories";
import {
  PLACES_API,
  cleanCity,
  resolvePageToken,
  searchPlacesPage,
  type PlacesPage,
} from "@/lib/places";
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
import { decodeMixedCursor, encodeMixedCursor, mergeMixed, parseKnown } from "@/lib/mixed-search";
import type { Business, KnownResult, SearchResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface SearchBody {
  city?: unknown;
  category?: unknown;
  // "denue" = México con DENUE (base), "google" = consulta en vivo, "osm" = gratis/mundial,
  // "mixta" = DENUE + Google en paralelo, unidos (src/lib/mixed-search.ts).
  // Sin source: Google si hay key, si no OSM (comportamiento anterior).
  source?: "denue" | "google" | "osm" | "mixta";
  global?: boolean; // true = búsqueda mundial (sin límite de país)
  refresh?: boolean; // true = ignora la caché y la renueva
  pageToken?: unknown; // siguiente página (Google, DENUE o mixta; viene de nextPageToken)
  known?: unknown; // mixta + pageToken: tarjetas ya mostradas (KnownResult[]) para no duplicar
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
function googleError(
  e: unknown,
  paging: boolean
): { message: string; status: number; transient: boolean } {
  console.error("places error", e);
  const msg = (e as Error)?.message || "";
  // Distingue fallo temporal de Google vs problema real de key/permisos.
  const transient = /\b(500|502|503|504|429)\b/.test(msg);
  const keyIssue = /\b(401|403)\b/.test(msg) || /REQUEST_DENIED|PERMISSION/i.test(msg);
  const badToken = paging && /\b400\b|INVALID_ARGUMENT/i.test(msg);
  return {
    message: transient
      ? "Google está saturado ahora mismo. Intenta de nuevo en unos segundos."
      : keyIssue
        ? "Google rechazó la API key (revisa permisos/facturación en Google Cloud)."
        : badToken
          ? "La página siguiente ya expiró. Vuelve a buscar."
          : "No se pudo completar la búsqueda con Google. Intenta de nuevo.",
    status: badToken ? 400 : 502,
    transient,
  };
}

function googleErrorResponse(e: unknown, paging: boolean) {
  const g = googleError(e, paging);
  return NextResponse.json({ error: g.message }, { status: g.status });
}

// Tope diario de gasto (sin BD no hay conteo -> sin tope; 0 = nunca usar Google).
async function googleCap(): Promise<{ cap: number; capped: boolean }> {
  const cap = googlePlacesDailyCap();
  if (cap === 0) return { cap, capped: true };
  const used = await usedToday(PLACES_API);
  return { cap, capped: used !== null && used >= cap };
}

// Una página de Google (= 1 solicitud cobrada). Búsquedas idénticas simultáneas
// -> una sola llamada (y un solo cobro).
function googlePage(
  queryCity: string,
  cat: Category,
  apiKey: string,
  googleToken?: string
): Promise<PlacesPage> {
  const key = ["google", cat.slug, normalizeKeyPart(queryCity), googleToken ?? ""].join("|");
  return coalesce(key, async () => {
    const r = await searchPlacesPage(queryCity, cat, apiKey, googleToken);
    await trackCall(PLACES_API); // sólo se cobran las exitosas
    return r;
  });
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

/* ---------- Mixta: DENUE + Google en paralelo ---------- */

// null = esa fuente no se consultó (sin configurar, tope o sin más páginas).
type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown } | null;

// Engancha el manejo de error de inmediato (sin rechazos "sueltos" mientras esperamos la otra).
function settle<T>(p: Promise<T> | null): Promise<Settled<T>> {
  return p
    ? p.then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error })
      )
    : Promise.resolve(null);
}

const BAD_TOKEN = "El token de página no corresponde a esta búsqueda. Vuelve a buscar.";

interface MixedOutcome {
  payload?: SearchResponse;
  error?: { message: string; status: number };
  fallback?: string; // ninguna fuente respondió (1a página): aviso y seguimos con OSM
}

/**
 * DENUE + Google para la misma ciudad y giro (solo México, sin OSM). Si una fuente
 * no está configurada, llegó a su tope o falla, se usa la otra con un aviso.
 * "Cargar más" pide la siguiente página de cada fuente que tenga más (token
 * combinado) y empareja lo nuevo también contra `known` (lo ya mostrado):
 * responde `updates` (señales de Google para tarjetas DENUE ya mostradas) y
 * `mergedIds` (tarjetas solo-Google que se quitan porque ahora llegan unidas a
 * un DENUE nuevo); el cliente las aplica con applyPage (src/lib/types.ts).
 */
async function searchMixed(
  city: string,
  cat: Category,
  opts: { refresh: boolean; pageToken?: string; known: KnownResult[] }
): Promise<MixedOutcome> {
  const paging = !!opts.pageToken;
  const q = normalizeKeyPart(city);
  let dToken: string | undefined;
  let gCursor: string | undefined;
  let gPage: { city: string; googleToken: string } | undefined;
  if (opts.pageToken) {
    const cur = decodeMixedCursor(opts.pageToken);
    if (!cur || cur.c !== cat.slug || cur.q !== q) {
      return { error: { message: BAD_TOKEN, status: 400 } };
    }
    dToken = cur.d;
    if (cur.g) {
      gPage = resolvePageToken(cur.g, city, cat) ?? undefined;
      if (!gPage) return { error: { message: BAD_TOKEN, status: 400 } };
      gCursor = cur.g;
    }
  }

  const notes: string[] = [];
  const denueOn = denueReady();
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;

  // DENUE arranca ya; el tope de Google se revisa mientras tanto.
  let denueTask: Promise<SearchResponse> | null = null;
  if (!paging || dToken) {
    if (denueOn) {
      denueTask = searchDenue(city, cat, { refresh: opts.refresh && !paging, pageToken: dToken });
    } else {
      notes.push("DENUE no está configurado (falta DENUE_TOKEN; es gratis en inegi.org.mx).");
    }
  }
  const denueP = settle(denueTask);

  let googleTask: Promise<PlacesPage> | null = null;
  if (!paging || gPage) {
    if (!apiKey) {
      notes.push("Google no está configurado (falta GOOGLE_PLACES_API_KEY).");
    } else {
      const { cap, capped } = await googleCap();
      if (capped) {
        notes.push(
          cap === 0
            ? "Google está desactivado (GOOGLE_PLACES_DAILY_CAP=0)."
            : `Se alcanzó el tope diario de Google (${cap} búsquedas).`
        );
      }
      else googleTask = googlePage(gPage?.city ?? city, cat, apiKey, gPage?.googleToken);
    }
  }
  const [d, g] = await Promise.all([denueP, settle(googleTask)]);

  // Errores de una fuente no tumban la otra: se avisan y, si es temporal, el
  // token de esa fuente se conserva para reintentar en el siguiente "Cargar más".
  let nextD: string | undefined;
  let nextG: string | undefined;
  let denueErr: { message: string; status: number } | undefined;
  let googleErr: { message: string; status: number } | undefined;
  if (d?.ok) {
    nextD = d.value.nextPageToken;
    if (d.value.notice) notes.push(d.value.notice);
  } else if (d) {
    const e = d.error;
    const known = e instanceof DenueError || e instanceof OsmError;
    console.error("mixta denue", known ? e.message : e);
    denueErr = known
      ? { message: e.message, status: e.status }
      : { message: "No se pudo consultar el DENUE (INEGI).", status: 502 };
    notes.push(/denue/i.test(denueErr.message) ? denueErr.message : `DENUE: ${denueErr.message}`);
    if (paging && denueErr.status >= 500) nextD = dToken;
  }
  if (g?.ok) {
    nextG = g.value.nextPageToken;
  } else if (g) {
    const ge = googleError(g.error, paging);
    googleErr = { message: ge.message, status: ge.status };
    notes.push(ge.message);
    if (paging && ge.transient) nextG = gCursor;
  }

  if (!d?.ok && !g?.ok) {
    // Error del usuario (ciudad fuera de México, token): se muestra tal cual.
    if (denueErr && denueErr.status < 500) return { error: denueErr };
    if (paging) {
      return {
        error: denueErr ??
          googleErr ?? { message: "No se pudieron cargar más resultados.", status: 502 },
      };
    }
    return { fallback: `${notes.join(" ")} Mostrando resultados gratis de OpenStreetMap.` };
  }

  const both = !!d?.ok && !!g?.ok;
  if (!both && notes.length) {
    notes.push(
      d?.ok ? "Mostrando solo DENUE." : "Mostrando solo Google (solo consulta: no se exporta)."
    );
  }
  const mix = mergeMixed(
    d?.ok ? d.value.results : [],
    g?.ok ? g.value.results : [],
    paging ? opts.known : []
  );
  const payload: SearchResponse = {
    city: d?.ok ? d.value.city : city,
    count: mix.results.length,
    results: mix.results,
    source: both ? "mixta" : d?.ok ? "denue" : "google",
    denueAvailable: denueOn,
    mix: mix.stats,
    ...(paging ? { mergedIds: mix.mergedIds, updates: mix.updates } : {}),
    // "En caché" solo si todo vino de DENUE (Google siempre es en vivo y gasta cuota).
    ...(d?.ok && !g?.ok && d.value.cached ? { cached: true, cachedAt: d.value.cachedAt } : {}),
    ...(notes.length ? { notice: notes.join(" ") } : {}),
    ...(nextD || nextG
      ? { nextPageToken: encodeMixedCursor({ d: nextD, g: nextG, c: cat.slug, q }) }
      : {}),
  };
  return { payload };
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

    // Mixta: DENUE + Google en paralelo, unidos (ver searchMixed).
    if (source === "mixta") {
      const r = await searchMixed(city, cat, {
        refresh: !!refresh,
        pageToken,
        known: pageToken ? parseKnown(body.known) : [],
      });
      if (r.payload) return NextResponse.json(r.payload);
      if (r.error) {
        return NextResponse.json(
          { error: r.error.message, denueAvailable },
          { status: r.error.status }
        );
      }
      notice = r.fallback; // ninguna fuente respondió: OSM (México) con aviso
    }

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
      !!apiKey &&
      source !== "osm" &&
      source !== "mixta" &&
      !(source === "denue" && denueAvailable);

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

      // Tope diario de gasto (sin BD -> sin tope).
      const { cap, capped } = await googleCap();

      if (!capped) {
        try {
          const page = await googlePage(queryCity, cat, apiKey, googleToken);
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
        global: !!global && !notice && source !== "denue" && source !== "mixta",
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
