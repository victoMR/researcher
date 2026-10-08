#!/usr/bin/env node
// Genera (o regenera) las credenciales de acceso de la app SIN imprimirlas:
//  - AUTH_SECRET nuevo (cierra todas las sesiones al cambiarlo)
//  - una contraseña aleatoria por vendedor -> APP_USERS con hash scrypt
//  - un token MCP por vendedor -> MCP_TOKENS
//
// Uso:
//   node scripts/generar-credenciales.mjs correo1@x.com correo2@x.com [--admins correo1@x.com]
//
// Escribe (ambos ignorados por git por el patrón .env*):
//   .env.production.local  -> variables para Vercel (se conservan las demás que ya tenga)
//   .env.vendedores.local  -> contraseña y token MCP de cada vendedor, para repartirlos
// También copia de .env.local las llaves de servicios (GHL, Google, DENUE, Anthropic…).

import { randomBytes, scryptSync } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const args = process.argv.slice(2);
const adminIdx = args.indexOf("--admins");
const admins =
  adminIdx >= 0 ? (args[adminIdx + 1] ?? "").split(",").map((s) => s.trim().toLowerCase()) : [];
const emails = args
  .filter((a, i) => !a.startsWith("--") && i !== adminIdx + 1)
  .map((e) => e.trim().toLowerCase());

const EMAIL_RE = /^[^\s@,:;]+@[^\s@,:;]+\.[^\s@,:;]+$/;
if (!emails.length || emails.some((e) => !EMAIL_RE.test(e))) {
  console.error("Uso: node scripts/generar-credenciales.mjs correo1@x.com correo2@x.com [--admins correo1@x.com]");
  process.exit(1);
}
if (admins.some((a) => a && !emails.includes(a))) {
  console.error("Cada admin debe estar también en la lista de correos.");
  process.exit(1);
}

// Contraseña legible: 4 bloques de 5 caracteres sin ambiguos (0/O, 1/l/I).
const ALPHABET = "abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function password() {
  const bytes = randomBytes(20);
  let s = "";
  for (let i = 0; i < 20; i++) s += ALPHABET[bytes[i] % ALPHABET.length];
  return s.match(/.{5}/g).join("-");
}

// Mismo formato que verifica src/lib/auth.ts: scrypt:<salt hex>:<hash hex>
function scryptHash(pw) {
  const salt = randomBytes(16);
  return `scrypt:${salt.toString("hex")}:${scryptSync(pw, salt, 32).toString("hex")}`;
}

// Lee un .env sencillo (KEY=valor por línea) conservando el orden.
function readEnv(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out.set(m[1], m[2]);
  }
  return out;
}

const users = emails.map((email) => {
  const pw = password();
  return { email, pw, hash: scryptHash(pw), mcp: randomBytes(32).toString("base64url") };
});

const env = readEnv(".env.production.local");
env.set("AUTH_SECRET", randomBytes(32).toString("base64url"));
env.set("APP_USERS", users.map((u) => `${u.email}:${u.hash}`).join(","));
env.set("APP_ADMINS", (admins.filter(Boolean).length ? admins : [emails[0]]).join(","));
env.set("MCP_TOKENS", users.map((u) => `${u.email}:${u.mcp}`).join(","));
// Llaves de servicios: .env.local es la fuente (ahí las mantiene el equipo).
const SERVICE_KEYS = [
  "DATABASE_URL",
  "DB_SCHEMA",
  "DENUE_TOKEN",
  "GOOGLE_PLACES_API_KEY",
  "GHL_PIT",
  "GHL_LOCATION_ID",
  "ANTHROPIC_API_KEY",
  "AGENT_MODEL",
  "APP_URL",
];
const local = readEnv(".env.local");
const copied = SERVICE_KEYS.filter((k) => local.get(k)?.trim());
for (const k of copied) env.set(k, local.get(k).trim());
// Ya no se usan (sustituidas por APP_USERS).
env.delete("APP_LOGIN_EMAIL");
env.delete("APP_LOGIN_PASSWORD");
for (const k of ["GHL_EMAIL_FROM", "EMAIL_SENDER_MODE", "EMAIL_PROVIDER", "RESEND_API_KEY", "RESEND_FROM"]) env.delete(k);

writeFileSync(
  ".env.production.local",
  [...env].map(([k, v]) => `${k}=${v}`).join("\n") + "\n",
  { mode: 0o600 }
);

const fecha = new Date().toISOString().slice(0, 10);
writeFileSync(
  ".env.vendedores.local",
  [
    `# Credenciales generadas el ${fecha}. Reparte cada una por un canal privado y borra este archivo después.`,
    ...users.map(
      (u) => `\n# ${u.email}\nCORREO=${u.email}\nCONTRASENA=${u.pw}\nTOKEN_MCP=${u.mcp}`
    ),
  ].join("\n") + "\n",
  { mode: 0o600 }
);

// Solo se imprime lo que NO es secreto.
console.log(`Listo: ${users.length} usuario(s): ${emails.join(", ")}`);
console.log(`Admin: ${env.get("APP_ADMINS")}`);
console.log("Variables -> .env.production.local · Contraseñas y tokens -> .env.vendedores.local");
if (copied.length) console.log(`Copiadas de .env.local: ${copied.join(", ")}`);
const missing = ["DATABASE_URL", "GHL_PIT", "GHL_LOCATION_ID", "ANTHROPIC_API_KEY", "DENUE_TOKEN"].filter(
  (k) => !env.get(k)
);
if (missing.length) console.log(`Faltan: ${missing.join(", ")} (agrégalas a .env.local y vuelve a correr, o directo en .env.production.local)`);
