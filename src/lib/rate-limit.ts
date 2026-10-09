// Límite de intentos de login por correo y por IP.
// Con BD usa la tabla login_attempts (key, ok, created_at); sin BD cae a un Map
// en memoria (en serverless es POR INSTANCIA: cada instancia lleva su cuenta).
// Si la BD falla al contar, NO se bloquea el login (fail-open).
import { ensureSchema, getSql, hasDb } from "./db";

const WINDOW_MIN = 15;
const WINDOW_MS = WINDOW_MIN * 60_000;
const MAX_EMAIL_FAILS = 5; // fallos por correo en la ventana
const MAX_IP_FAILS = 20; // fallos por IP en la ventana
const CLEANUP_PROB = 0.02; // probabilidad de limpiar filas viejas en cada intento

export type LimitResult = { blocked: false } | { blocked: true; retryAfterSec: number };

// IP del cliente: primer valor de x-forwarded-for, luego x-real-ip.
// Ojo: estos encabezados solo son confiables detrás de un proxy que los
// reescriba (p. ej. Vercel); si no, el cliente puede falsearlos. El límite
// por correo sigue aplicando aunque la IP sea falsa.
export function clientIp(req: Request): string {
  const xff = req.headers.get("x-forwarded-for");
  const first = xff?.split(",")[0]?.trim();
  if (first) return first.slice(0, 64);
  const real = req.headers.get("x-real-ip")?.trim();
  if (real) return real.slice(0, 64);
  return "desconocida";
}

const emailKey = (email: string) => `email:${email.trim().toLowerCase()}`;
const ipKey = (ip: string) => `ip:${ip}`;

// ---------- Respaldo en memoria ----------
type Attempt = { t: number; ok: boolean };
const mem = new Map<string, Attempt[]>();

function memPrune(now: number) {
  for (const [k, list] of mem) {
    const fresh = list.filter((a) => now - a.t < WINDOW_MS);
    if (fresh.length) mem.set(k, fresh);
    else mem.delete(k);
  }
}

// Segundos de espera si hay >= max fallos (opcionalmente solo tras el último éxito).
function memWait(key: string, max: number, sinceLastOk: boolean, now: number): number {
  const list = mem.get(key) ?? [];
  let from = 0;
  if (sinceLastOk) {
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].ok) {
        from = i + 1;
        break;
      }
    }
  }
  const fails = list
    .slice(from)
    .filter((a) => !a.ok && now - a.t < WINDOW_MS)
    .map((a) => a.t)
    .sort((a, b) => b - a);
  if (fails.length < max) return 0;
  // Se desbloquea cuando el max-ésimo fallo más reciente sale de la ventana.
  return Math.ceil((fails[max - 1] + WINDOW_MS - now) / 1000);
}

function memRecord(key: string, ok: boolean, now: number) {
  const list = mem.get(key) ?? [];
  list.push({ t: now, ok });
  // Conserva solo lo necesario para contar.
  mem.set(key, list.slice(-50));
  if (mem.size > 5000 || Math.random() < CLEANUP_PROB) memPrune(now);
}

// ---------- BD ----------
async function dbWait(key: string, max: number, sinceLastOk: boolean): Promise<number> {
  const sql = getSql();
  const rows = sinceLastOk
    ? await sql`
        SELECT EXTRACT(EPOCH FROM (created_at + ${WINDOW_MIN}::int * interval '1 minute' - now()))::float8 AS wait
        FROM login_attempts
        WHERE key = ${key}
          AND ok = false
          AND created_at > now() - ${WINDOW_MIN}::int * interval '1 minute'
          AND created_at > COALESCE(
            (SELECT max(created_at) FROM login_attempts WHERE key = ${key} AND ok = true),
            '-infinity'::timestamptz
          )
        ORDER BY created_at DESC
        LIMIT ${max}::int
      `
    : await sql`
        SELECT EXTRACT(EPOCH FROM (created_at + ${WINDOW_MIN}::int * interval '1 minute' - now()))::float8 AS wait
        FROM login_attempts
        WHERE key = ${key}
          AND ok = false
          AND created_at > now() - ${WINDOW_MIN}::int * interval '1 minute'
        ORDER BY created_at DESC
        LIMIT ${max}::int
      `;
  if (rows.length < max) return 0;
  return Math.max(1, Math.ceil(Number(rows[max - 1].wait) || 0));
}

// ¿Está bloqueado este correo o esta IP? Devuelve cuánto esperar.
export async function checkLoginLimit(email: string, ip: string): Promise<LimitResult> {
  let wait = 0;
  try {
    if (hasDb()) {
      await ensureSchema();
      const [we, wi] = await Promise.all([
        dbWait(emailKey(email), MAX_EMAIL_FAILS, true),
        dbWait(ipKey(ip), MAX_IP_FAILS, false),
      ]);
      wait = Math.max(we, wi);
    } else {
      const now = Date.now();
      wait = Math.max(
        memWait(emailKey(email), MAX_EMAIL_FAILS, true, now),
        memWait(ipKey(ip), MAX_IP_FAILS, false, now)
      );
    }
  } catch (err) {
    // Fail-open: si no se puede contar, no se bloquea el login.
    console.error("[rate-limit] no se pudieron contar intentos de login", err);
    return { blocked: false };
  }
  return wait > 0 ? { blocked: true, retryAfterSec: wait } : { blocked: false };
}

// Registra un intento (éxito o fallo) para el correo y la IP.
export async function recordLoginAttempt(email: string, ip: string, ok: boolean): Promise<void> {
  const ek = emailKey(email);
  const ik = ipKey(ip);
  try {
    if (hasDb()) {
      await ensureSchema();
      const sql = getSql();
      await sql`INSERT INTO login_attempts (key, ok) VALUES (${ek}, ${ok}), (${ik}, ${ok})`;
      // Limpieza ocasional de filas de más de 1 día.
      if (Math.random() < CLEANUP_PROB) {
        await sql`DELETE FROM login_attempts WHERE created_at < now() - interval '1 day'`;
      }
    } else {
      const now = Date.now();
      memRecord(ek, ok, now);
      memRecord(ik, ok, now);
    }
  } catch (err) {
    console.error("[rate-limit] no se pudo registrar el intento de login", err);
  }
}

// Quita el bloqueo por correo (p. ej. al restablecer la contraseña): registra
// un éxito, y el límite por correo solo cuenta los fallos posteriores.
export async function clearLoginFailures(email: string): Promise<void> {
  const ek = emailKey(email);
  try {
    if (hasDb()) {
      await ensureSchema();
      await getSql()`INSERT INTO login_attempts (key, ok) VALUES (${ek}, true)`;
    } else {
      memRecord(ek, true, Date.now());
    }
  } catch (err) {
    console.error("[rate-limit] no se pudo limpiar el bloqueo", err);
  }
}

// Mensaje para el 429.
export function tooManyAttemptsMessage(retryAfterSec: number): string {
  const min = Math.max(1, Math.ceil(retryAfterSec / 60));
  return `Demasiados intentos fallidos. Espera ${min} minuto${min === 1 ? "" : "s"} e intenta de nuevo.`;
}
