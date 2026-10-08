// Google Places Text Search para el agente: SOLO señal de actividad.
// De Google solo se guarda el place_id; nombre/rating/reseñas se muestran en
// el reporte (campo `google`) y nunca se exportan. Por eso aquí NO se piden
// teléfono, web ni dirección (field mask mínimo -> SKU Enterprise por rating).
// https://developers.google.com/maps/documentation/places/web-service/text-search
import { PLACES_API, activitySignalEnabled } from "../places";
import { googlePlacesDailyCap, trackCall, usedToday } from "../api-usage";
import { clampNum } from "./normalize";

const ENDPOINT = "https://places.googleapis.com/v1/places:searchText";

export class GoogleUnavailable extends Error {}

export interface GooglePlace {
  placeId: string;
  name: string;
  lat: number; // solo para empatar con DENUE/OSM; no se guarda
  lon: number;
  rating?: number;
  reviewCount?: number;
  lastReviewAgo?: string;
  lastReviewAt?: string; // ISO de la reseña más reciente (señal de actividad)
  status?: string;
}

interface PlaceResult {
  id: string;
  displayName?: { text: string };
  location?: { latitude: number; longitude: number };
  rating?: number;
  userRatingCount?: number;
  businessStatus?: string;
  reviews?: { publishTime?: string; relativePublishTimeDescription?: string }[];
}

export function googleReady(): boolean {
  return !!process.env.GOOGLE_PLACES_API_KEY && googlePlacesDailyCap() > 0;
}

/** Una página (hasta 20) de lugares dentro de un rectángulo alrededor del punto. */
export async function googleNearby(o: {
  query: string;
  lat: number;
  lon: number;
  radiusM: number;
}): Promise<GooglePlace[]> {
  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) throw new GoogleUnavailable("Google Places no está configurado en el servidor.");
  const cap = googlePlacesDailyCap();
  const used = await usedToday(PLACES_API);
  if (cap <= 0 || (used !== null && used >= cap)) {
    throw new GoogleUnavailable(`Se alcanzó el tope diario de Google (${cap} búsquedas).`);
  }

  const r = clampNum(o.radiusM, 200, 10000, 2000);
  const dLat = r / 111320;
  const dLon = r / (111320 * Math.max(0.2, Math.cos((o.lat * Math.PI) / 180)));
  const fields = [
    "places.id",
    "places.displayName",
    "places.location",
    "places.rating",
    "places.userRatingCount",
    "places.businessStatus",
    ...(activitySignalEnabled() ? ["places.reviews"] : []),
  ].join(",");

  const body = {
    textQuery: o.query.slice(0, 120),
    languageCode: "es",
    regionCode: "MX",
    pageSize: 20,
    locationRestriction: {
      rectangle: {
        low: { latitude: o.lat - dLat, longitude: o.lon - dLon },
        high: { latitude: o.lat + dLat, longitude: o.lon + dLon },
      },
    },
  };

  let res: Response | null = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    res = await fetch(ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": apiKey, "X-Goog-FieldMask": fields },
      body: JSON.stringify(body),
    });
    if (res.ok || ![429, 500, 502, 503, 504].includes(res.status)) break;
    await new Promise((ok) => setTimeout(ok, 700));
  }
  if (!res || !res.ok) {
    const status = res?.status ?? 0;
    throw new GoogleUnavailable(
      status === 401 || status === 403
        ? "Google rechazó la API key."
        : `Google no respondió (HTTP ${status}).`
    );
  }
  await trackCall(PLACES_API); // solo se cobran las exitosas

  const data = (await res.json()) as { places?: PlaceResult[] };
  const out: GooglePlace[] = [];
  for (const p of data.places ?? []) {
    if (!p.id || !p.displayName?.text || !p.location) continue;
    if (p.businessStatus === "CLOSED_PERMANENTLY") continue;
    const last = (p.reviews ?? [])
      .filter((x) => x.publishTime)
      .sort((a, b) => (a.publishTime! < b.publishTime! ? 1 : -1))[0];
    out.push({
      placeId: p.id,
      name: p.displayName.text,
      lat: p.location.latitude,
      lon: p.location.longitude,
      rating: p.rating,
      reviewCount: p.userRatingCount,
      lastReviewAgo: last?.relativePublishTimeDescription,
      lastReviewAt: last?.publishTime,
      status: p.businessStatus,
    });
  }
  return out;
}
