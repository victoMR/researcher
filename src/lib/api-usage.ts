import { ensureSchema, getSql, hasDb } from "./db";

// Contador diario de llamadas a APIs de pago (tabla api_usage) para el tope de gasto.
// El "día" se corta a medianoche de Ciudad de México.

const TZ = "America/Mexico_City";

// Tope por defecto de llamadas diarias a Google Places. 300 llamadas/día ≈ 9,000/mes
// ≈ USD $320/mes a precio de lista Enterprise + Atmosphere (ver src/lib/places.ts).
const DEFAULT_GOOGLE_PLACES_CAP = 300;

// Fecha de hoy (YYYY-MM-DD) en Ciudad de México.
export function mxDay(d: Date = new Date()): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

// Tope diario de Google Places (env GOOGLE_PLACES_DAILY_CAP; 0 = nunca usar Google).
export function googlePlacesDailyCap(): number {
  const n = Number.parseInt(process.env.GOOGLE_PLACES_DAILY_CAP ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GOOGLE_PLACES_CAP;
}

// Respaldo en memoria (por instancia): si la BD falla a media operación, el tope
// sigue funcionando "a medias" en vez de quedar abierto del todo.
let memDay = "";
const memCalls = new Map<string, number>();

function memCount(api: string, day: string): number {
  return memDay === day ? memCalls.get(api) ?? 0 : 0;
}

function memBump(api: string, day: string) {
  if (memDay !== day) {
    memDay = day;
    memCalls.clear();
  }
  memCalls.set(api, (memCalls.get(api) ?? 0) + 1);
}

let warnedNoDb = false;
function dbReady(): boolean {
  if (hasDb()) return true;
  if (!warnedNoDb) {
    warnedNoDb = true;
    console.warn(
      "api-usage: no hay DATABASE_URL; el tope diario de Google Places está desactivado."
    );
  }
  return false;
}

// Llamadas de hoy a `api`. null = no hay BD (sin tope). Nunca lanza.
export async function usedToday(api: string): Promise<number | null> {
  if (!dbReady()) return null;
  const day = mxDay();
  try {
    await ensureSchema();
    const sql = getSql();
    const rows = (await sql`
      SELECT calls FROM api_usage WHERE day = ${day}::date AND api = ${api}
    `) as { calls: number | string }[];
    const db = Number(rows[0]?.calls ?? 0);
    return Math.max(Number.isFinite(db) ? db : 0, memCount(api, day));
  } catch (e) {
    console.error("api-usage: no se pudo leer el consumo; uso el contador en memoria", e);
    return memCount(api, day);
  }
}

// Suma 1 llamada de hoy a `api` (UPSERT incremental). Nunca lanza.
export async function trackCall(api: string): Promise<void> {
  const day = mxDay();
  memBump(api, day);
  if (!dbReady()) return;
  try {
    await ensureSchema();
    const sql = getSql();
    await sql`
      INSERT INTO api_usage (day, api, calls) VALUES (${day}::date, ${api}, 1)
      ON CONFLICT (day, api) DO UPDATE SET calls = api_usage.calls + 1
    `;
  } catch (e) {
    console.error("api-usage: no se pudo registrar la llamada", e);
  }
}
