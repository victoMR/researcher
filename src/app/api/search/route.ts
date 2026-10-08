import { NextRequest, NextResponse } from "next/server";
import { getCategory } from "@/lib/categories";
import { PLACES_API, cleanCity, resolvePageToken, searchPlacesPage } from "@/lib/places";
import { OsmError, searchOsm } from "@/lib/osm";
import { googlePlacesDailyCap, trackCall, usedToday } from "@/lib/api-usage";
import { coalesce, normalizeKeyPart } from "@/lib/search-cache";
import type { SearchResponse } from "@/lib/types";

export const runtime = "nodejs";
export const maxDuration = 60;

interface SearchBody {
  city?: unknown;
  category?: unknown;
  source?: "google" | "osm"; // "osm" fuerza modo gratis (sin llamar a Google)
  global?: boolean; // true = búsqueda mundial (sin límite de país)
  refresh?: boolean; // true = ignora la caché y la renueva
  pageToken?: unknown; // siguiente página de Google (viene de nextPageToken)
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

    // Fuente principal: Google Places (mejor cobertura en México). Pero el
    // "modo general" fuerza OSM (source="osm") para NO gastar cuota de Google.
    const apiKey = process.env.GOOGLE_PLACES_API_KEY;
    const useGoogle = !!apiKey && source !== "osm";
    let notice: string | undefined;

    if (pageToken && !useGoogle) {
      return NextResponse.json(
        { error: "La paginación sólo aplica a búsquedas con Google." },
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
          notice: `Se alcanzó el tope diario de Google (${cap} búsquedas). Vuelve a buscar para ver resultados gratis de OpenStreetMap.`,
        };
        return NextResponse.json(payload);
      }
      notice = `Se alcanzó el tope diario de Google (${cap} búsquedas). Mostrando resultados gratis de OpenStreetMap.`;
    }

    // Fuente gratis: OpenStreetMap (con caché de 7 días).
    // Si caímos aquí por el tope de Google, buscamos sólo en México.
    try {
      const osm = await searchOsm(city, cat, {
        global: !!global && !notice,
        refresh: !!refresh,
      });
      const payload: SearchResponse = {
        city: osm.city,
        count: osm.results.length,
        results: osm.results,
        source: "osm",
        ...(osm.cached ? { cached: true, cachedAt: osm.cachedAt } : {}),
        ...(notice ? { notice } : {}),
      };
      return NextResponse.json(payload);
    } catch (e) {
      if (e instanceof OsmError) {
        return NextResponse.json(
          { error: e.message, ...(notice ? { notice } : {}) },
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
