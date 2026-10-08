#!/usr/bin/env node
// Sube a Vercel (entorno Production) todas las variables de .env.production.local
// del proyecto enlazado (.vercel/project.json). Los valores van por stdin y se
// guardan como "sensitive"; nunca se imprimen.
//
// Uso (desde la raíz del repo, con `vercel` instalado y sesión iniciada):
//   node scripts/subir-env-vercel.mjs            -> sube todas
//   node scripts/subir-env-vercel.mjs GHL_PIT    -> sube solo las indicadas
// Lee .env.production.local y, para las llaves de servicios que no estén ahí
// (p. ej. ANTHROPIC_API_KEY), también .env.local.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

if (!existsSync(".vercel/project.json")) {
  console.error("Este directorio no está enlazado a un proyecto de Vercel (falta .vercel/project.json).");
  process.exit(1);
}
if (!existsSync(".env.production.local")) {
  console.error("No existe .env.production.local (genéralo con scripts/generar-credenciales.mjs).");
  process.exit(1);
}

// Llaves de servicios que el equipo suele mantener en .env.local.
const SERVICE_KEYS = new Set([
  "DATABASE_URL",
  "DB_SCHEMA",
  "ANTHROPIC_API_KEY",
  "DENUE_TOKEN",
  "GOOGLE_PLACES_API_KEY",
  "GHL_PIT",
  "GHL_LOCATION_ID",
  "AGENT_MODEL",
  "APP_URL",
]);

function readEnv(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2].trim()) out.set(m[1], m[2].trim().replace(/^["']|["']$/g, ""));
  }
  return out;
}

const env = readEnv(".env.production.local");
for (const [k, v] of readEnv(".env.local")) {
  if (SERVICE_KEYS.has(k) && !env.has(k)) env.set(k, v);
}

const only = new Set(process.argv.slice(2));
const vars = [];
for (const [key, value] of env) {
  if (only.size && !only.has(key)) continue;
  // Las que maneja Vercel o una integración (Supabase/Neon) no se tocan.
  if (/^(POSTGRES_|PG|NEON_|SUPABASE_|VERCEL_)/.test(key)) continue;
  vars.push([key, value]);
}
if (!vars.length) {
  console.error("No hay variables para subir.");
  process.exit(1);
}

let ok = 0;
for (const [key, value] of vars) {
  // Comando en un solo string (en Windows `vercel` es un .cmd y requiere shell).
  // Seguro: `key` solo puede ser [A-Z0-9_] y el valor va por stdin.
  const r = spawnSync(`vercel env add ${key} production --force --sensitive`, {
    input: value,
    encoding: "utf8",
    shell: true,
  });
  if (r.status === 0) {
    ok++;
    console.log(`✓ ${key}`);
  } else {
    // stderr de Vercel no incluye el valor (va por stdin).
    console.error(`✗ ${key}: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  }
}
console.log(`\n${ok}/${vars.length} variables subidas a Production. Vuelve a desplegar para que tomen efecto.`);
