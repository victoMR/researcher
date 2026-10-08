export type LeadStatus = "nuevo" | "contactado" | "respondio" | "descartado";

export const LEAD_STATUSES: LeadStatus[] = ["nuevo", "contactado", "respondio", "descartado"];

// Origen del dato. DENUE (INEGI) y OSM son abiertos: se guardan y exportan.
// De Google solo se puede guardar place_id (y lat/lng máx. 30 días).
export type DataSource = "denue" | "osm" | "google" | "web";

export interface Business {
  id: string; // estable: "denue/<CLEE>" | "node/123" (OSM) | "place/<place_id>" (Google)
  name: string;
  category: string;
  phone?: string;
  website?: string;
  email?: string;
  address?: string;
  city?: string; // ciudad de la búsqueda (para dedupe y guardado)
  // Sin coordenadas = NaN (o null tras pasar por JSON): p. ej. venció el plazo
  // de 30 días de las coordenadas de Google. Usa hasCoords() antes de pintar.
  lat: number;
  lon: number;
  source?: DataSource; // origen de los datos (si falta, se deduce del id)
  denueId?: string; // CLEE del DENUE
  placeId?: string; // place_id de Google (lo único de Google que se guarda)
  employees?: string; // estrato de personal ocupado (DENUE): "6 a 10 personas"
  // Señales de actividad (Google Places).
  rating?: number; // 1..5
  reviewCount?: number; // total de reseñas
  lastReviewTime?: string; // ISO de la reseña más reciente
  lastReviewAgo?: string; // "hace 2 semanas" (localizado por Google)
  status?: string; // businessStatus: OPERATIONAL, etc.
  distanceKm?: number; // distancia a la ubicación del usuario (se calcula en cliente)
  score?: number; // calificación de prospecto 1..10 por resta (src/lib/scoring.ts)
  scoreDeductions?: { points: number; reason: string }[]; // desglose del score
  emailIsGuess?: boolean; // el correo es sugerido (no publicado por el negocio)
}

export interface Lead extends Business {
  status: LeadStatus;
  note?: string;
  savedAt: number;
  ownerEmail?: string; // vendedor que trabaja el prospecto (vacío = sin asignar)
  contactedBy?: string; // vendedor que lo contactó primero
  contactedAt?: string; // ISO del primer contacto
}

// Filtro de dueño en la lista de prospectos.
export type OwnerFilter = "mine" | "all" | "unassigned";

// Respuesta de GET /api/leads (lista paginada del lado del servidor).
export interface LeadsPage {
  leads: Lead[];
  total: number; // total con todos los filtros (para la paginación)
  page: number;
  pageSize: number;
  counts: {
    byStatus: Record<LeadStatus, number>; // respeta q y owner, no status
    mine: number; // respetan q, no owner ni status
    unassigned: number;
    all: number;
  };
}

// Coincidencia de un resultado de búsqueda con un prospecto ya guardado.
export interface LeadMatch {
  key: string; // dedupe_key
  id: string;
  ownerEmail: string | null;
  status: LeadStatus;
  contactedBy: string | null;
  contactedAt: string | null; // ISO
  placeId?: string | null; // para reconocer un resultado de Google ya guardado
  denueId?: string | null;
}

// Usuario logueado (GET /api/auth/me).
export interface Me {
  email: string;
  name: string;
  isAdmin: boolean;
}

export interface SearchResponse {
  city: string;
  count: number;
  results: Business[];
  source?: string; // denue | google | osm
  nextPageToken?: string; // hay más resultados (Google / DENUE)
  cached?: boolean; // vino de la caché de búsquedas
  cachedAt?: string; // ISO de cuándo se guardó en caché
  notice?: string; // aviso para mostrar (p. ej. tope de gasto)
  denueAvailable?: boolean; // el servidor tiene DENUE_TOKEN
}

// --- Reglas de fuente (cliente y servidor) ---

// Fuente de un negocio: la declarada o, si falta, la que dice su id.
export function sourceOf(b: Pick<Business, "id" | "source">): DataSource {
  if (b.source) return b.source;
  if (b.id.startsWith("place/")) return "google";
  if (b.id.startsWith("denue/")) return "denue";
  if (b.id.startsWith("web/")) return "web";
  return "osm";
}

// Solo-Google: viene de Google y no está vinculado con DENUE. No se exporta
// (CSV / GHL) ni se pinta sobre mapas que no son de Google.
export function isGoogleOnly(b: Pick<Business, "id" | "source" | "denueId">): boolean {
  return sourceOf(b) === "google" && !b.denueId;
}

// place_id de Google del negocio (campo propio o el id "place/<id>").
export function placeIdOf(b: Pick<Business, "id" | "placeId">): string | undefined {
  return b.placeId || (b.id.startsWith("place/") ? b.id.slice(6) : undefined);
}

// ¿Tiene coordenadas usables? (las de Google se borran a los 30 días).
export function hasCoords(b: { lat?: unknown; lon?: unknown }): boolean {
  return (
    typeof b.lat === "number" &&
    typeof b.lon === "number" &&
    Number.isFinite(b.lat) &&
    Number.isFinite(b.lon)
  );
}

// Ficha del lugar en Google Maps (permitido: enlazar por place_id).
export function googleMapsUrl(placeId: string): string {
  return `https://www.google.com/maps/place/?q=place_id:${encodeURIComponent(placeId)}`;
}
