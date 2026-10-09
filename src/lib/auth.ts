// Sesión firmada con HMAC-SHA256 usando Web Crypto (funciona en el proxy y en
// route handlers). Token = base64url(payload).base64url(firma).
// Nota: en Next 16 el proxy corre en runtime Node.js, por eso aquí se puede
// usar node:crypto (comparación en tiempo constante y scrypt).
import { createHmac, randomBytes, scrypt, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE = "als_session";
const enc = new TextEncoder();
const dec = new TextDecoder();

// Longitud mínima del secreto en producción.
const MIN_SECRET_LEN = 32;
const DEV_SECRET = "dev-insecure-secret-solo-para-desarrollo-local";
export const AUTH_SECRET_ERROR =
  "Falta configurar AUTH_SECRET (mín. 32 caracteres) en el servidor.";

let warnedDev = false;
let warnedProd = false;

// Secreto para firmar sesiones, o null si en producción falta o es muy corto
// (en ese caso no se firma ni se verifica ninguna sesión).
function secret(): string | null {
  const s = process.env.AUTH_SECRET;
  if (s && s.length >= MIN_SECRET_LEN) return s;
  if (process.env.NODE_ENV === "production") {
    if (!warnedProd) {
      warnedProd = true;
      console.error(`[auth] ${AUTH_SECRET_ERROR} Se rechazan todas las sesiones.`);
    }
    return null;
  }
  if (!warnedDev) {
    warnedDev = true;
    console.warn(
      "[auth] AUTH_SECRET no está definida o mide menos de 32 caracteres; usando un secreto de desarrollo INSEGURO."
    );
  }
  return s || DEV_SECRET;
}

// ¿Está configurado el secreto de sesión? (en desarrollo siempre hay respaldo).
export function authConfigured(): boolean {
  return secret() !== null;
}

function toB64url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// Llave HMAC en caché (se reimporta solo si cambia el secreto).
let keyCache: { secret: string; key: Promise<CryptoKey> } | null = null;

function hmacKey(s: string): Promise<CryptoKey> {
  if (keyCache?.secret !== s) {
    keyCache = {
      secret: s,
      key: crypto.subtle.importKey(
        "raw",
        enc.encode(s),
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["sign", "verify"]
      ),
    };
  }
  return keyCache.key;
}

export type Role = "admin" | "vendedor";

// Origen del usuario: variables de entorno (APP_USERS / APP_LOGIN_*) o tabla app_users.
export type UserSource = "env" | "db";

export interface Session {
  email: string;
  exp: number; // epoch ms
  // Sin `src` = cookie anterior a la tabla de usuarios (solo había usuarios de env).
  src?: UserSource;
  v?: number; // session_version del usuario de BD al firmar (si sube, la sesión deja de valer)
  role?: Role; // rol al firmar (informativo: el vigente sale de la BD, ver session.ts)
}

export const SESSION_DAYS = 7;

// Atributos de la cookie de sesión (iguales al crearla y al borrarla).
export function sessionCookieOptions(maxAgeSec = SESSION_DAYS * 86400) {
  return {
    httpOnly: true,
    sameSite: "lax" as const,
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: maxAgeSec,
  };
}

export async function signSession(
  claims: { email: string; src: UserSource; v?: number; role?: Role },
  days = SESSION_DAYS
): Promise<string> {
  const s = secret();
  if (!s) throw new Error(AUTH_SECRET_ERROR);
  const payload: Session = {
    email: claims.email,
    exp: Date.now() + days * 86400000,
    src: claims.src,
    ...(claims.v != null ? { v: claims.v } : {}),
    ...(claims.role ? { role: claims.role } : {}),
  };
  const body = toB64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(s), enc.encode(body));
  return `${body}.${toB64url(new Uint8Array(sig))}`;
}

export async function verifySession(token?: string | null): Promise<Session | null> {
  if (!token) return null;
  const s = secret();
  if (!s) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(s),
      fromB64url(sig) as BufferSource,
      enc.encode(body)
    );
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(fromB64url(body))) as Session;
    if (!payload.exp || Date.now() > payload.exp) return null;
    return payload;
  } catch {
    return null;
  }
}

// Usuarios de variables de entorno (respaldo / arranque; siempre activos).
// Los demás se dan de alta desde la app (tabla app_users, ver users.ts). Soporta:
//  - APP_LOGIN_EMAIL + APP_LOGIN_PASSWORD (un usuario)
//  - APP_USERS = "correo1:clave1,correo2:clave2" (varios usuarios)
// La clave puede ir en texto plano o como hash scrypt: "scrypt$<salt>$<hash>"
// (hex). También se acepta ":" como separador ("scrypt:<salt>:<hash>"), útil en
// archivos .env, donde Next expande "$VAR" (ahí hay que escribir "\$").
function envUsers(): { email: string; password: string }[] {
  const users: { email: string; password: string }[] = [];
  if (process.env.APP_LOGIN_EMAIL && process.env.APP_LOGIN_PASSWORD) {
    users.push({
      email: process.env.APP_LOGIN_EMAIL.trim().toLowerCase(),
      password: process.env.APP_LOGIN_PASSWORD,
    });
  }
  const raw = process.env.APP_USERS;
  if (raw) {
    for (const pair of raw.split(",")) {
      const idx = pair.indexOf(":");
      if (idx === -1) continue;
      const email = pair.slice(0, idx).trim().toLowerCase();
      const password = pair.slice(idx + 1).trim();
      if (email && password) users.push({ email, password });
    }
  }
  return users;
}

// Correos de los usuarios de env.
export function envUserEmails(): Set<string> {
  return new Set(envUsers().map((u) => u.email));
}

// Administradores por env: APP_ADMINS = "a@x.com,b@x.com". Si no está
// definida, el usuario de APP_LOGIN_EMAIL es el admin. (También son admins
// los usuarios con role 'admin' en la tabla app_users; ver session.ts.)
export function envAdminEmails(): Set<string> {
  const raw = process.env.APP_ADMINS ?? process.env.APP_LOGIN_EMAIL ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean)
  );
}

export function isEnvAdmin(email: string | null | undefined): boolean {
  return !!email && envAdminEmails().has(email.trim().toLowerCase());
}

// Llave aleatoria por proceso: se usa para comparar cadenas en tiempo
// constante (HMAC de ambas y timingSafeEqual sobre digests de igual longitud).
const CMP_KEY = randomBytes(32);

function safeEqual(a: string, b: string): boolean {
  const ha = createHmac("sha256", CMP_KEY).update(a, "utf8").digest();
  const hb = createHmac("sha256", CMP_KEY).update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

const SCRYPT_RE = /^scrypt[$:]([0-9a-f]{16,})[$:]([0-9a-f]{32,})$/i;
// Parámetros de scrypt (los de Node por defecto): N=16384, r=8, p=1.
const SCRYPT_OPTS = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scryptAsync(password: string, salt: Buffer, keylen: number): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scrypt(password, salt, keylen, SCRYPT_OPTS, (err, key) =>
      err ? reject(err) : resolve(key)
    )
  );
}

let warnedBadHash = false;

// Hash para guardar (mismo formato que acepta verifyPassword): scrypt:<salt hex>:<hash hex>.
export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await scryptAsync(password, salt, 32);
  return `scrypt:${salt.toString("hex")}:${key.toString("hex")}`;
}

// Hash de una clave al azar: se verifica contra él cuando el correo no existe,
// para que la respuesta tarde lo mismo exista o no el usuario.
let dummy: Promise<string> | null = null;
export function dummyPasswordHash(): Promise<string> {
  dummy ??= hashPassword(randomBytes(16).toString("hex"));
  return dummy;
}

// Contraseña aleatoria legible: 4 bloques de 5 caracteres sin ambiguos
// (0/O, 1/l/I), p. ej. "kT7mp-Qa2Xw-..." (~115 bits). Muestreo por rechazo
// para que todos los caracteres sean igual de probables.
const PW_ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export function generatePassword(): string {
  const limit = 256 - (256 % PW_ALPHABET.length);
  let out = "";
  while (out.length < 20) {
    for (const b of randomBytes(32)) {
      if (b < limit && out.length < 20) out += PW_ALPHABET[b % PW_ALPHABET.length];
    }
  }
  return out.match(/.{5}/g)!.join("-");
}

// Verifica una clave contra lo guardado (texto plano o hash scrypt).
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  // Todo lo que empiece con "scrypt" se trata como hash. Si está mal formado
  // (p. ej. Next expandió los "$" del .env) NUNCA coincide, para no aceptar
  // como clave el texto que haya sobrado (como "scrypt").
  if (/^scrypt/i.test(stored)) {
    const m = SCRYPT_RE.exec(stored);
    if (!m) {
      if (!warnedBadHash) {
        warnedBadHash = true;
        console.error(
          '[auth] Hay una clave "scrypt..." mal formada en APP_USERS/APP_LOGIN_PASSWORD (en .env escapa "$" como "\\$" o usa ":" como separador).'
        );
      }
      return false;
    }
    try {
      const expected = Buffer.from(m[2], "hex");
      const actual = await scryptAsync(password, Buffer.from(m[1], "hex"), expected.length);
      return timingSafeEqual(actual, expected);
    } catch (err) {
      console.error("[auth] error al verificar hash scrypt", err);
      return false;
    }
  }
  return safeEqual(password, stored);
}

// Compara credenciales contra los usuarios de env. Recorre TODOS los usuarios
// (sin cortar en el primer match) y compara en tiempo constante, para no
// filtrar por tiempo de respuesta qué correos existen. El login completo (env
// + tabla app_users) está en users.ts: checkCredentials.
export async function checkEnvCredentials(email: string, password: string): Promise<boolean> {
  const e = email.trim().toLowerCase();
  const results = await Promise.all(
    envUsers().map(async (u) => {
      const emailOk = safeEqual(u.email, e);
      const passOk = await verifyPassword(password, u.password);
      return emailOk && passOk;
    })
  );
  return results.includes(true);
}
