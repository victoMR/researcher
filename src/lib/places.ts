import type { Business } from "./types";
import type { Category } from "./categories";

// Google Places API (New) — Text Search.
// Docs: https://developers.google.com/maps/documentation/places/web-service/text-search
const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

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

const FIELD_MASK = [
  "places.id",
  "places.displayName",
  "places.formattedAddress",
  "places.nationalPhoneNumber",
  "places.internationalPhoneNumber",
  "places.websiteUri",
  "places.location",
  "places.rating",
  "places.userRatingCount",
  "places.businessStatus",
  "places.reviews",
  "nextPageToken",
].join(",");

// Devuelve la reseña más reciente (por publishTime) de un lugar.
function latestReview(reviews?: PlaceReview[]): PlaceReview | undefined {
  if (!reviews?.length) return undefined;
  return reviews
    .filter((r) => r.publishTime)
    .sort((a, b) => (a.publishTime! < b.publishTime! ? 1 : -1))[0];
}

/**
 * Busca negocios en Google Places por giro + ciudad.
 * Pagina hasta `maxPages` (20 resultados por página).
 */
export async function searchPlaces(
  city: string,
  cat: Category,
  apiKey: string,
  maxPages = 3
): Promise<Business[]> {
  const textQuery = `${cat.googleQuery} en ${city}, México`;
  const out: Business[] = [];
  const seen = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < maxPages; page++) {
    const body: Record<string, unknown> = {
      textQuery,
      languageCode: "es",
      regionCode: "MX",
    };
    if (pageToken) body.pageToken = pageToken;

    // Google a veces regresa 503/500/429 temporalmente -> reintentamos.
    let res: Response | null = null;
    let lastStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      res = await fetch(ENDPOINT, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Goog-Api-Key": apiKey,
          "X-Goog-FieldMask": FIELD_MASK,
        },
        body: JSON.stringify(body),
      });
      if (res.ok) break;
      lastStatus = res.status;
      // 5xx/429 = temporal -> espera y reintenta; otros (401/403) no.
      if (![500, 502, 503, 504, 429].includes(res.status)) break;
      await new Promise((r) => setTimeout(r, 600 * (attempt + 1)));
    }

    if (!res || !res.ok) {
      const errText = res ? await res.text() : "";
      // Si falla la PRIMERA página es un problema real -> lanzamos con el status.
      // Si falla una página extra, devolvemos lo que ya juntamos.
      if (page === 0) {
        throw new Error(`Google Places ${lastStatus}: ${errText.slice(0, 200)}`);
      }
      break;
    }

    const data = (await res.json()) as SearchTextResponse;
    for (const p of data.places || []) {
      if (!p.displayName?.text || !p.location) continue;
      if (seen.has(p.id)) continue;
      // Descarta negocios cerrados permanentemente (no sirven como prospecto).
      if (p.businessStatus === "CLOSED_PERMANENTLY") continue;
      seen.add(p.id);
      const review = latestReview(p.reviews);
      out.push({
        id: `place/${p.id}`,
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

    if (!data.nextPageToken) break;
    pageToken = data.nextPageToken;
  }

  // Ordena por actividad: primero los que tienen reseña más reciente,
  // luego los que traen web (más fácil sacarles correo).
  out.sort((a, b) => {
    const ta = a.lastReviewTime ? Date.parse(a.lastReviewTime) : 0;
    const tb = b.lastReviewTime ? Date.parse(b.lastReviewTime) : 0;
    if (tb !== ta) return tb - ta;
    return (b.website ? 1 : 0) - (a.website ? 1 : 0);
  });
  return out;
}
