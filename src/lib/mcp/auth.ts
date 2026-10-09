// Autenticación y límites del servidor MCP (/api/mcp).
// Cada vendedor tiene su propio token, de dos fuentes:
//  - Tabla app_users: el admin lo genera en la pestaña Equipo; solo se guarda
//    su sha256 (mcp_token_hash) y solo vale si el usuario está activo.
//  - MCP_TOKENS = "correo1:token1,correo2:token2" (respaldo en Vercel; un
//    correo puede tener varios tokens para rotarlos sin cortar el servicio).
// El token identifica al usuario: created_by de las investigaciones, dueño de
// los prospectos guardados y bitácora. Tokens de 32+ caracteres (p. ej.
// `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`).
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { getSql, hasDb } from "../db";

const MIN_TOKEN_LEN = 32;
const DEFAULT_DAILY_CALLS = 500;

// Llave aleatoria por proceso: se compara el HMAC de ambos tokens (digests de
// igual longitud) con timingSafeEqual, igual que en src/lib/auth.ts.
const CMP_KEY = randomBytes(32);
const digest = (s: string) => createHmac("sha256", CMP_KEY).update(s, "utf8").digest();

interface TokenEntry {
  email: string;
  digest: Buffer;
}

let cache: { raw: string; entries: TokenEntry[] } | null = null;
let warnedShort = false;

function entries(): TokenEntry[] {
  const raw = process.env.MCP_TOKENS ?? "";
  if (cache?.raw === raw) return cache.entries;
  const list: TokenEntry[] = [];
  for (const pair of raw.split(",")) {
    const idx = pair.indexOf(":");
    if (idx === -1) continue;
    const email = pair.slice(0, idx).trim().toLowerCase();
    const token = pair.slice(idx + 1).trim();
    if (!email.includes("@") || !token) continue;
    if (token.length < MIN_TOKEN_LEN) {
      if (!warnedShort) {
        warnedShort = true;
        console.error(`[mcp] Hay tokens de MCP_TOKENS con menos de ${MIN_TOKEN_LEN} caracteres; se ignoran.`);
      }
      continue;
    }
    list.push({ email, digest: digest(token) });
  }
  cache = { raw, entries: list };
  return list;
}

/** ¿Puede haber tokens válidos? (MCP_TOKENS o la tabla app_users en la BD). */
export function mcpConfigured(): boolean {
  return entries().length > 0 || hasDb();
}

/** Correos con token en MCP_TOKENS (para mostrarlo en Equipo). */
export function envMcpTokenEmails(): Set<string> {
  return new Set(entries().map((e) => e.email));
}

/** Lo que se guarda de un token de la tabla: sha256 en hex (nunca el token). */
export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Token nuevo: 32 bytes aleatorios en base64url (43 caracteres). */
export function newMcpToken(): string {
  return randomBytes(32).toString("base64url");
}

/** "Authorization: Bearer <token>" -> token (o null). */
export function bearerToken(header: string | null | undefined): string | null {
  const m = /^Bearer[ \t]+([^\s]+)[ \t]*$/i.exec(header ?? "");
  return m ? m[1] : null;
}

/**
 * Correo del dueño de un token de MCP_TOKENS, o null. Recorre TODOS los tokens
 * sin cortar en el primero que coincide (tiempo constante respecto a cuál coincidió).
 */
export function emailForEnvToken(token: string): string | null {
  const d = digest(token);
  let found: string | null = null;
  for (const e of entries()) {
    const ok = timingSafeEqual(d, e.digest);
    if (ok && found === null) found = e.email;
  }
  return found;
}

/**
 * Correo del dueño del token (MCP_TOKENS primero; luego la tabla, buscando por
 * sha256 y solo usuarios activos), o null. Si la BD falla lanza el error (la
 * ruta responde 503): no se puede saber si el token sigue vigente.
 */
export async function emailForToken(token: string): Promise<string | null> {
  const env = emailForEnvToken(token);
  if (env) return env;
  if (!hasDb() || token.length < MIN_TOKEN_LEN || token.length > 512) return null;
  try {
    const rows = await getSql()`
      SELECT email FROM app_users WHERE mcp_token_hash = ${hashMcpToken(token)} AND active
    `;
    return rows.length ? String(rows[0].email) : null;
  } catch (e) {
    // La tabla aún no existe (nadie ha generado tokens desde la app).
    if ((e as { code?: string }).code === "42P01") return null;
    throw e;
  }
}

// ---------- Límites ----------

/** Tope diario de llamadas a herramientas MCP por vendedor (MCP_DAILY_CALLS, 500). */
export function mcpDailyCalls(): number {
  const n = Number.parseInt(process.env.MCP_DAILY_CALLS ?? "", 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_CALLS;
}

/** Contador en api_usage (uno por vendedor y día). */
export function mcpUsageKey(email: string): string {
  return `mcp:${email.toLowerCase()}`;
}

// ---------- Origen ----------

/**
 * Orígenes de navegador permitidos (defensa contra DNS rebinding / páginas
 * maliciosas). Los clientes MCP de escritorio y de servidor no mandan Origin;
 * si llega uno, debe ser el de APP_URL o estar en MCP_ALLOWED_ORIGINS.
 */
export function originAllowed(origin: string | null, selfOrigin: string): boolean {
  if (!origin) return true;
  const allowed = new Set<string>([selfOrigin]);
  const app = process.env.APP_URL?.trim();
  if (app) {
    try {
      allowed.add(new URL(app).origin);
    } catch {
      /* APP_URL inválida: se ignora */
    }
  }
  for (const o of (process.env.MCP_ALLOWED_ORIGINS ?? "").split(",")) {
    const v = o.trim().replace(/\/$/, "");
    if (v) allowed.add(v);
  }
  return allowed.has(origin.replace(/\/$/, ""));
}
