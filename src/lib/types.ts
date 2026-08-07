export type LeadStatus = "nuevo" | "contactado" | "respondio" | "descartado";

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
}

export interface SearchResponse {
  city: string;
  count: number;
  results: Business[];
}
