// Configuración del agente "Investigar con IA" (variables de entorno y límites).

// Modelo por defecto: Claude Opus 5.5, el recomendado para agentes con
// herramientas (a esfuerzo "medium" rinde como Opus 5 en "high" con menos
// tokens, y es más confiable al citar datos). AGENT_MODEL lo cambia, p. ej.
// "claude-sonnet-5-5" para ir más rápido y a la mitad de costo.
export const DEFAULT_AGENT_MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high" | "xhigh" | "max";

export function agentModel(): string {
  return process.env.AGENT_MODEL?.trim() || DEFAULT_AGENT_MODEL;
}

// AGENT_EFFORT: low | medium (por defecto) | high | xhigh | max.
export function agentEffort(): Effort {
  const v = process.env.AGENT_EFFORT?.trim().toLowerCase();
  return v === "low" || v === "high" || v === "xhigh" || v === "max" ? v : "medium";
}

// Tope diario de investigaciones por vendedor (AGENT_DAILY_RUNS, por defecto 15).
export function agentDailyRuns(): number {
  const n = Number.parseInt(process.env.AGENT_DAILY_RUNS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : 15;
}

export function agentReady(): boolean {
  return !!process.env.ANTHROPIC_API_KEY?.trim();
}

export const AGENT_MISSING_KEY = "Falta configurar ANTHROPIC_API_KEY en el servidor.";

// Contador en api_usage (uno por vendedor y día).
export function agentUsageKey(email: string): string {
  return `agent:${email.toLowerCase()}`;
}

// ---- Presupuestos de una investigación ----
// La función vive máx. 300 s (maxDuration de POST /api/research; Vercel con
// Fluid compute: 300 s por defecto en todos los planes, 800 s máx. en Pro).
export const MAX_ITERATIONS = 25; // llamadas a la API de Claude
export const SOFT_DEADLINE_MS = 185_000; // a partir de aquí se pide entregar
export const SOFT_DEADLINE_BIG_MS = 150_000; // si piden más de 30 prospectos
export const HARD_DEADLINE_MS = 280_000; // se corta y se arma el reporte de respaldo
export const MAX_OUTPUT_TOKENS = 32_000;
export const WEB_SEARCH_MAX_USES = 8; // por llamada a la API
export const WEB_FETCH_MAX_USES = 10;

// Capacidades por modelo (para no mandar parámetros que un modelo rechaza).
const WEB_2026 = new Set([
  "claude-opus-5-5", "claude-opus-5", "claude-opus-4-8", "claude-opus-4-7", "claude-opus-4-6",
  "claude-sonnet-5-5", "claude-sonnet-5", "claude-sonnet-4-6",
]);
const ADAPTIVE = new Set([
  ...WEB_2026, "claude-fable-5-1", "claude-fable-5", "claude-haiku-5-5",
]);
// Respaldo del lado del servidor ante rechazos de seguridad (fallbacks: "default").
const FALLBACK_DEFAULT = new Set(["claude-opus-5-5", "claude-opus-5", "claude-fable-5-1", "claude-sonnet-5-5"]);

export interface ModelFeatures {
  web2026: boolean; // web_search_20260209 / web_fetch_20260209 (filtrado dinámico)
  adaptive: boolean; // thinking adaptive + effort
  fallbacks: boolean;
}

export function modelFeatures(model: string): ModelFeatures {
  const m = model.toLowerCase();
  return { web2026: WEB_2026.has(m), adaptive: ADAPTIVE.has(m), fallbacks: FALLBACK_DEFAULT.has(m) };
}

// Precio US$ por millón de tokens: [entrada, salida, escritura caché 5 min, lectura caché].
const PRICES: Record<string, [number, number, number, number]> = {
  "claude-opus-5-5": [4, 20, 5, 0.2],
  "claude-opus-5": [5, 25, 6.25, 0.5],
  "claude-sonnet-5-5": [2, 10, 2.5, 0.2],
  "claude-sonnet-5": [2, 10, 2.5, 0.2],
  "claude-haiku-5-5": [0.1, 0.5, 0.125, 0.01],
};
export const WEB_SEARCH_USD = 10 / 1000;

export function modelPrices(model: string): [number, number, number, number] {
  return PRICES[model.toLowerCase()] ?? PRICES[DEFAULT_AGENT_MODEL];
}
