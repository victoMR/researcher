import type { Business } from "./types";
import type { Category } from "./categories";
import { normalizeKeyPart } from "./search-cache";

// Google Places API (New) — Text Search.
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

// Nombre del contador en api_usage (tope diario de gasto).
export const PLACES_API = "google_places";

// --- Costo ---
// Google cobra CADA solicitud (cada página de hasta 20 lugares) al SKU MÁS CARO de los
// campos del FIELD_MASK. Precio de lista USD por 1,000 solicitudes (tramo 0–100k):
//   places.id, nextPageToken ............................. Essentials (IDs Only): gratis
//   displayName, formattedAddress, location, businessStatus  Pro: $32 (5,000 gratis/mes)
//   nationalPhoneNumber, internationalPhoneNumber,
//   websiteUri, rating, userRatingCount .................. Enterprise: $35 (1,000 gratis/mes)
//   reviews .............................................. Enterprise + Atmosphere: $40 (1,000 gratis/mes)
// https://developers.google.com/maps/billing-and-pricing/sku-details
// https://developers.google.com/maps/billing-and-pricing/pricing
// Teléfono y web son el corazón del prospecto -> Enterprise es el mínimo útil.
// places.reviews sólo sirve para la fecha de la reseña más reciente (filtro "Solo activos"
// y score) y encarece +$5 por 1,000 (+14 %). PLACES_ACTIVITY_SIGNAL=off la quita.
//
// --- Caché ---
// NO cacheamos resultados de Google. Los términos sólo permiten guardar el place_id
// (indefinido) y lat/lng hasta 30 días; nombre, dirección, teléfono, web, rating y
// reseñas no se pueden pre-cargar, cachear ni almacenar:
// https://cloud.google.com/maps-platform/terms (3.2.3 a y b)
// https://cloud.google.com/maps-platform/terms/maps-service-terms (14.3)
// https://developers.google.com/maps/documentation/places/web-service/policies
// Guardar sólo place_id tampoco ahorra: rehidratar 20 lugares con Place Details
// Enterprise ($20/1,000 c/u) cuesta ~10x más que repetir la búsqueda.
// Lo único que hacemos es compartir una petición EN VUELO entre búsquedas idénticas
// simultáneas (coalescing en la ruta), que no guarda nada.

const PAGE_SIZE = 20; // máximo de Text Search por página

interface PlaceReview {
  publishTime?: string;
  relativePublishTimeDescription?: string;
}

interface PlaceResult {
  id: string;
  displayName?: { text: string };
  formattedAddress?: string;
  nationalPhoneNumber?: string;
  internationalPhoneNumber?: string;
  websiteUri?: string;
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  reviews?: PlaceReview[];
}

interface SearchTextResponse {
  places?: PlaceResult[];
  nextPageToken?: string;
}

const BASE_FIELDS = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber", // respaldo si no viene el nacional (mismo SKU)
  "places.websiteUri",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus", // para descartar cerrados permanentemente
  "nextPageToken",
];

// Señal de actividad (reseña más reciente). Por defecto encendida; "off" ahorra ~12.5 %.
export function activitySignalEnabled(): boolean {
  const v = (process.env.PLACES_ACTIVITY_SIGNAL ?? "on").trim().toLowerCase();
  return !["off", "0", "false", "no"].includes(v);
}

function fieldMask(): string {
  return (activitySignalEnabled() ? [...BASE_FIELDS, "places.reviews"] : BASE_FIELDS).join(",");
}

// Devuelve la reseña más reciente (por publishTime) de un lugar.
function latestReview(reviews?: PlaceReview[]): PlaceReview | undefined {
  if (!reviews?.length) return undefined;
  return reviews
    .filter((r) => r.publishTime)
    .sort((a, b) => (a.publishTime! < b.publishTime! ? 1 : -1))[0];
}

// Ciudad "limpia" para la consulta (sin espacios de más).
export function cleanCity(city: string): string {
  return city.trim().replace(/\s+/g, " ");
}

// --- Token de página propio ---
// Google exige que la página siguiente repita EXACTAMENTE la misma consulta
// (textQuery, idioma, región). Por eso envolvemos su nextPageToken junto con el
// giro y la ciudad que se usaron: al pedir más, validamos que sean los mismos y
// reconstruimos el textQuery con la ciudad original.
interface Cursor {
  g: string; // nextPageToken de Google
  c: string; // slug del giro
  q: string; // ciudad tal cual se usó en la primera página
}

function encodeCursor(cur: Cursor): string {
  return Buffer.from(JSON.stringify({ v: 1, ...cur })).toString("base64url");
}

function decodeCursor(token: string): Cursor | null {
  try {
    const o = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Partial<
      Cursor & { v: number }
    >;
    if (o.v !== 1 || typeof o.g !== "string" || typeof o.c !== "string" || typeof o.q !== "string") {
      return null;
    }
    if (!o.g || !o.q) return null;
    return { g: o.g, c: o.c, q: o.q };
  } catch {
    return null;
  }
}

// Valida un pageToken del cliente contra el giro/ciudad de la petición.
// Devuelve la ciudad original + token de Google, o null si no corresponde.
export function resolvePageToken(
  token: string,
  city: string,
  cat: Category
): { city: string; googleToken: string } | null {
  const cur = decodeCursor(token);
  if (!cur || cur.c !== cat.slug) return null;
  if (normalizeKeyPart(cur.q) !== normalizeKeyPart(city)) return null;
  return { city: cur.q, googleToken: cur.g };
}

export interface PlacesPage {
  results: Business[];
  nextPageToken?: string; // token propio (ver Cursor) para pedir la siguiente página
}

/**
 * Busca UNA página (hasta 20) de negocios en Google Places por giro + ciudad.
 * = 1 solicitud facturable. La siguiente página se pide bajo demanda con
 * `googleToken` (de resolvePageToken) y la MISMA ciudad.
 */
export async function searchPlacesPage(
  city: string,
  cat: Category,
  apiKey: string,
  googleToken?: string
): Promise<PlacesPage> {
  const queryCity = cleanCity(city);
  const body: Record<string, unknown> = {
    textQuery: `${cat.googleQuery} en ${queryCity}, México`,
    languageCode: "es",
    regionCode: "MX",
    pageSize: PAGE_SIZE,
  };
  if (googleToken) body.pageToken = googleToken;

  // Google a veces regresa 503/500/429 temporalmente -> reintentamos.
  // (Sólo se cobran las solicitudes exitosas.)
  let res: Response | null = null;
  let lastStatus = 0;
  for (let attempt = 0; attempt < 3; attempt++) {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Goog-Api-Key": apiKey,
        "X-Goog-FieldMask": fieldMask(),
      },
      body: JSON.stringify(body),
    });
    if (res.ok) break;
    lastStatus = res.status;
    // 5xx/429 = temporal -> espera y reintenta; otros (400/401/403) no.
    if (![500, 502, 503, 504, 429].includes(res.status)) break;
    await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
  }

  if (!res || !res.ok) {
    const errText = res ? await res.text() : "";
    throw new Error(`Google Places ${lastStatus}: ${errText.slice(0, 200)}`);
  }

  const data = (await res.json()) as SearchTextResponse;
  const out: Business[] = [];
  const seen = new Set<string>();
  for (const p of data.places || []) {
    if (!p.displayName?.text || !p.location) continue;
    if (seen.has(p.id)) continue;
    // Descarta negocios cerrados permanentemente (no sirven como prospecto).
    if (p.businessStatus === "CLOSED_PERMANENTLY") continue;
    seen.add(p.id);
    const review = latestReview(p.reviews);
    // Solo para mostrar en vivo: al guardar, leads-repo se queda con place_id
    // (o lo vincula con DENUE). No se exporta ni se pinta en mapas que no son de Google.
    out.push({
      id: `place/${p.id}`,
      source: "google",
      placeId: p.id,
      name: p.displayName.text,
      category: cat.label,
      phone: p.nationalPhoneNumber || p.internationalPhoneNumber,
      website: p.websiteUri,
      address: p.formattedAddress,
      lat: p.location.latitude,
      lon: p.location.longitude,
      rating: p.rating,
      reviewCount: p.userRatingCount,
      lastReviewTime: review?.publishTime,
      lastReviewAgo: review?.relativePublishTimeDescription,
      status: p.businessStatus,
    });
  }

  // Ordena por actividad: primero los que tienen reseña más reciente,
  // luego los que traen web (más fácil sacarles correo).
  out.sort((a, b) => {
    const ta = a.lastReviewTime ? Date.parse(a.lastReviewTime) : 0;
    const tb = b.lastReviewTime ? Date.parse(b.lastReviewTime) : 0;
    if (tb !== ta) return tb - ta;
    return (b.website ? 1 : 0) - (a.website ? 1 : 0);
  });

  return {
    results: out,
    nextPageToken: data.nextPageToken
      ? encodeCursor({ g: data.nextPageToken, c: cat.slug, q: queryCity })
      : undefined,
  };
}
