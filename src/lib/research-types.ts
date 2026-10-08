// Tipos compartidos del agente "Investigar con IA" (backend y UI).
// Regla de datos: CSV y GHL solo llevan datos de DENUE, OSM o la web del
// negocio. Lo de Google (campo `google`) es solo para ver en el reporte.

export type ResearchSource = "denue" | "osm" | "google" | "web";

export interface ResearchProspect {
  id: string; // "denue/<CLEE>" | "osm/node/123" | "place/<place_id>" | "web/<dominio>"
  source: ResearchSource; // fuente principal de los datos exportables
  name: string;
  category?: string; // nicho o clase SCIAN
  address?: string;
  lat?: number;
  lon?: number;
  phone?: string;
  whatsapp?: string; // número que acepta WhatsApp si se detectó
  email?: string; // el mejor correo
  emailIsGuess?: boolean; // el correo es sugerido (no lo publica el negocio)
  emails?: string[];
  lastActivityAt?: string; // ISO de la señal de actividad más reciente (reseña, publicación…)
  websiteOk?: boolean; // su sitio respondió al revisarlo
  website?: string;
  socials?: string[];
  employees?: string; // estrato de personal ocupado (DENUE)
  denueId?: string;
  osmId?: string;
  placeId?: string; // lo único de Google que se puede guardar
  google?: {
    rating?: number;
    reviewCount?: number;
    lastReviewAgo?: string;
  }; // solo para ver; nunca se exporta
  score: number; // 1..10 — SIEMPRE de computeScore() (src/lib/scoring.ts), no del modelo
  scoreDeductions?: { points: number; reason: string }[]; // desglose de la resta
  reasons: string[]; // por qué es buen prospecto
  signals: string[]; // señales detectadas ("Sin WhatsApp en su web", "Anuncios activos"...)
  opener?: string; // primer mensaje sugerido
  existing?: {
    leadId?: string;
    ownerEmail?: string;
    status?: string;
    contactedBy?: string;
    contactedAt?: string;
    suppressed?: boolean;
  };
}

export interface ResearchSummary {
  title: string; // "Clínicas dentales en El Refugio, Querétaro"
  niche: string;
  zone: string;
  overview: string; // Markdown corto (párrafos, **negritas**, listas con "- ")
  insights: string[];
  nextSteps: string[];
  sources: { name: string; count: number }[];
  stats: {
    total: number;
    withEmail: number;
    withPhone: number;
    withWhatsapp: number;
  };
}

export interface ResearchParams {
  niche?: string;
  zone?: string;
  lat?: number;
  lon?: number;
  radiusM?: number;
  keywords?: string[];
  scianCodes?: string[];
  maxResults?: number;
}

export interface ResearchProgress {
  at: string; // ISO
  kind: "think" | "tool" | "info" | "warn";
  message: string; // "Buscando en DENUE «dentista» a 1.5 km de El Refugio…"
}

export type ResearchStatus = "running" | "done" | "error";

export interface ResearchRun {
  id: string;
  prompt: string;
  status: ResearchStatus;
  params?: ResearchParams;
  progress: ResearchProgress[];
  results?: ResearchProspect[];
  summary?: ResearchSummary;
  error?: string;
  createdBy?: string | null;
  createdAt: string;
  finishedAt?: string;
}

export interface ResearchRunListItem {
  id: string;
  prompt: string;
  title?: string;
  status: ResearchStatus;
  count?: number;
  createdBy?: string | null;
  createdAt: string;
}
