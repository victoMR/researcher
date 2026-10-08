export type LeadStatus = "nuevo" | "contactado" | "respondio" | "descartado";

export const LEAD_STATUSES: LeadStatus[] = ["nuevo", "contactado", "respondio", "descartado"];

export interface Business {
  id: string; // osm type+id, stable
  name: string;
  category: string;
  phone?: string;
  website?: string;
  email?: string;
  address?: string;
  city?: string; // ciudad de la búsqueda (para dedupe y guardado)
  lat: number;
  lon: number;
  // Señales de actividad (Google Places).
  rating?: number; // 1..5
  reviewCount?: number; // total de reseñas
  lastReviewTime?: string; // ISO de la reseña más reciente
  lastReviewAgo?: string; // "hace 2 semanas" (localizado por Google)
  status?: string; // businessStatus: OPERATIONAL, etc.
  distanceKm?: number; // distancia a la ubicación del usuario (se calcula en cliente)
  score?: number; // calificación de prospecto 1..10 (se calcula en cliente)
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
  source?: string;
  nextPageToken?: string; // hay más resultados (Google)
  cached?: boolean; // vino de la caché de búsquedas
  cachedAt?: string; // ISO de cuándo se guardó en caché
  notice?: string; // aviso para mostrar (p. ej. tope de gasto)
}
