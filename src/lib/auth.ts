// Sesión firmada con HMAC-SHA256 usando Web Crypto (funciona en middleware
// edge y en route handlers). Token = base64url(payload).base64url(firma).

export const SESSION_COOKIE = "als_session";
const enc = new TextEncoder();
const dec = new TextDecoder();

function secret(): string {
  return process.env.AUTH_SECRET || "dev-insecure-secret-change-me";
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

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    enc.encode(secret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export interface Session {
  email: string;
  exp: number; // epoch ms
}

export async function signSession(email: string, days = 7): Promise<string> {
  const payload: Session = { email, exp: Date.now() + days * 86400000 };
  const body = toB64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(), enc.encode(body));
  return `${body}.${toB64url(new Uint8Array(sig))}`;
}

export async function verifySession(token?: string | null): Promise<Session | null> {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  try {
    const ok = await crypto.subtle.verify(
      "HMAC",
      await hmacKey(),
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

// Usuarios permitidos. Soporta:
//  - APP_LOGIN_EMAIL + APP_LOGIN_PASSWORD (un usuario)
//  - APP_USERS = "correo1:clave1,correo2:clave2" (varios usuarios)
function allowedUsers(): { email: string; password: string }[] {
  const users: { email: string; password: string }[] = [];
  if (process.env.APP_LOGIN_EMAIL && process.env.APP_LOGIN_PASSWORD) {
    users.push({
      email: process.env.APP_LOGIN_EMAIL.toLowerCase(),
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

// Compara credenciales contra los usuarios permitidos.
export function checkCredentials(email: string, password: string): boolean {
  const e = email.trim().toLowerCase();
  return allowedUsers().some((u) => u.email === e && u.password === password);
}
