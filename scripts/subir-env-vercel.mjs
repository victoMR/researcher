#!/usr/bin/env node
// Sube a Vercel (entorno Production) todas las variables de .env.production.local
// del proyecto enlazado (.vercel/project.json). Los valores van por stdin y se
// guardan como "sensitive"; nunca se imprimen.
//
// Uso (desde la raíz del repo, con `vercel` instalado y sesión iniciada):
//   node scripts/subir-env-vercel.mjs            -> sube todas
//   node scripts/subir-env-vercel.mjs GHL_PIT    -> sube solo las indicadas

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

const only = new Set(process.argv.slice(2));
const vars = [];
for (const line of readFileSync(".env.production.local", "utf8").split(/\r?\n/)) {
  const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
  if (!m || !m[2].trim()) continue;
  if (only.size && !only.has(m[1])) continue;
  // Las que maneja Vercel (p. ej. la integración de Neon) no se tocan.
  if (/^(DATABASE_URL|POSTGRES_|PG|NEON_|VERCEL_)/.test(m[1])) continue;
  vars.push([m[1], m[2].trim().replace(/^["']|["']$/g, "")]);
}
if (!vars.length) {
  console.error("No hay variables para subir.");
  process.exit(1);
}

let ok = 0;
for (const [key, value] of vars) {
  const r = spawnSync(
    "vercel",
    ["env", "add", key, "production", "--force", "--sensitive"],
    { input: value, encoding: "utf8", shell: process.platform === "win32" }
  );
  if (r.status === 0) {
    ok++;
    console.log(`✓ ${key}`);
  } else {
    // stderr de Vercel no incluye el valor (va por stdin).
    console.error(`✗ ${key}: ${(r.stderr || r.stdout || "").trim().split("\n").pop()}`);
  }
}
console.log(`\n${ok}/${vars.length} variables subidas a Production. Vuelve a desplegar para que tomen efecto.`);
