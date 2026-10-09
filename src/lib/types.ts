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
    // Chips de contacto: cuántos quedarían al prender cada uno (respeta q,
    // owner, status y los demás chips). Falta con pageSize=0.
    contact?: Record<"email" | "phone" | "website" | "whatsapp" | "score", number>;
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
  role?: "admin" | "vendedor";
  source?: "env" | "db"; // env = definido en Vercel (APP_USERS); db = dado de alta en Equipo
  mustChangePassword?: boolean; // entró con contraseña temporal
}

// Integrante del equipo (GET /api/users, solo admins).
export interface TeamMember {
  email: string;
  name: string;
  role: "admin" | "vendedor"; // rol efectivo (incluye APP_ADMINS)
  envAdmin: boolean; // admin por APP_ADMINS / APP_LOGIN_EMAIL (no se quita desde la app)
  active: boolean;
  source: "env" | "db"; // env = definido en Vercel, solo lectura
  mustChangePassword: boolean;
  lastLoginAt: string | null; // ISO
  createdAt: string | null; // ISO
  createdBy: string | null;
  hasMcpToken: boolean;
  mcpTokenCreatedAt: string | null; // ISO (solo tokens generados en la app)
}

export interface SearchResponse {
  city: string;
  count: number;
  results: Business[];
  source?: string; // denue | google | osm | mixta (DENUE + Google)
  nextPageToken?: string; // hay más resultados (Google / DENUE / mixta)
  cached?: boolean; // vino de la caché de búsquedas
  cachedAt?: string; // ISO de cuándo se guardó en caché
  notice?: string; // aviso para mostrar (p. ej. tope de gasto)
  denueAvailable?: boolean; // el servidor tiene DENUE_TOKEN
  // Solo "Cargar más" en modo mixta (ver src/lib/mixed-search.ts y applyPage):
  mergedIds?: string[]; // tarjetas solo-Google ya mostradas que ahora vienen unidas a un DENUE nuevo (o repetidas): se quitan
  updates?: GoogleLivePatch[]; // señales de Google para tarjetas DENUE ya mostradas
  mix?: { denue: number; google: number; merged: number; duplicates: number }; // conteos de la fusión
}

// --- Señales de Google (solo para ver en vivo) ---

// Campos que vienen de Google: se muestran en vivo, NUNCA se guardan ni se exportan.
export const GOOGLE_LIVE_FIELDS = [
  "rating",
  "reviewCount",
  "lastReviewTime",
  "lastReviewAgo",
  "status",
] as const;
export type GoogleLiveField = (typeof GOOGLE_LIVE_FIELDS)[number];
export type GoogleLivePatch = Pick<Business, "id" | "placeId" | GoogleLiveField>;

// Solo los campos de Google que traiga el negocio (sin undefined).
export function googleLive(b: Business): Partial<Pick<Business, GoogleLiveField>> {
  const out: Partial<Pick<Business, GoogleLiveField>> = {};
  if (b.rating != null) out.rating = b.rating;
  if (b.reviewCount != null) out.reviewCount = b.reviewCount;
  if (b.lastReviewTime) out.lastReviewTime = b.lastReviewTime;
  if (b.lastReviewAgo) out.lastReviewAgo = b.lastReviewAgo;
  if (b.status) out.status = b.status;
  return out;
}

// Copia del negocio sin los campos de Google (lo que sí se puede guardar/exportar).
export function withoutGoogleLive(b: Business): Business {
  const out: Business = { ...b };
  for (const k of GOOGLE_LIVE_FIELDS) delete out[k];
  return out;
}

// --- "Cargar más" en modo mixta (cliente) ---

// Lo mínimo de cada tarjeta ya mostrada para que el servidor empareje la página nueva.
export interface KnownResult {
  id: string;
  name: string;
  lat: number | null;
  lon: number | null;
  phone?: string;
  placeId?: string;
}

export function knownOf(list: Business[]): KnownResult[] {
  return list.map((b) => ({
    id: b.id,
    name: b.name,
    lat: hasCoords(b) ? b.lat : null,
    lon: hasCoords(b) ? b.lon : null,
    ...(b.phone ? { phone: b.phone } : {}),
    ...(placeIdOf(b) ? { placeId: placeIdOf(b) } : {}),
  }));
}

/**
 * Aplica una página nueva sobre la lista mostrada: quita `mergedIds`, agrega las
 * señales de Google de `updates` a tarjetas DENUE ya mostradas y añade `fresh`
 * sin repetir id. Si una tarjeta quitada era solo-Google y su place_id llega
 * unido a un DENUE nuevo, éste conserva sus señales en vivo y el correo hallado.
 */
export function applyPage(
  prev: Business[],
  fresh: Business[],
  page: Pick<SearchResponse, "mergedIds" | "updates"> = {}
): Business[] {
  const drop = new Set(page.mergedIds ?? []);
  const upd = new Map((page.updates ?? []).map((u) => [u.id, u]));
  const removed = new Map<string, Business>(); // place_id -> tarjeta quitada
  const out: Business[] = [];
  for (const b of prev) {
    if (drop.has(b.id)) {
      const p = placeIdOf(b);
      if (p) removed.set(p, b);
      continue;
    }
    const u = upd.get(b.id);
    out.push(u ? { ...b, ...u } : b);
  }
  const ids = new Set(out.map((b) => b.id));
  for (const f of fresh) {
    if (ids.has(f.id)) continue;
    ids.add(f.id);
    const old = f.placeId ? removed.get(f.placeId) : undefined;
    if (!old) {
      out.push(f);
      continue;
    }
    const carry = !f.email && old.email ? { email: old.email, emailIsGuess: old.emailIsGuess } : {};
    out.push({ ...googleLive(old), ...f, ...googleLive(f), ...carry });
  }
  return out;
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

// DENUE + Google (búsqueda mixta): datos de DENUE con place_id enlazado.
export function isDenueWithGoogle(b: Pick<Business, "id" | "source" | "placeId">): boolean {
  return sourceOf(b) === "denue" && !!b.placeId;
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
