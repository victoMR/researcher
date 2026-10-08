#!/usr/bin/env node
// Prepara la conexión del prospector a Supabase con un usuario aislado
// (prospector_app, esquema "prospector"), SIN imprimir la contraseña.
//
// Uso:
//   node scripts/preparar-supabase.mjs "<cadena del Transaction pooler>"
//
// La cadena se copia de Supabase → botón "Connect" → "Transaction pooler"
// (trae [YOUR-PASSWORD] como marcador; no hace falta la contraseña real), p. ej.
//   postgresql://postgres.abcd:[YOUR-PASSWORD]@aws-0-us-east-1.pooler.supabase.com:6543/postgres
//
// Hace:
//   - genera una contraseña nueva para prospector_app
//   - escribe .env.supabase.sql: el SQL listo para pegar en Supabase → SQL Editor
//   - escribe en .env.local DATABASE_URL (usuario prospector_app) y DB_SCHEMA=prospector
// Ambos archivos los ignora git (.env*).

import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const raw = process.argv[2];
if (!raw) {
  console.error('Uso: node scripts/preparar-supabase.mjs "postgresql://postgres.<ref>:[YOUR-PASSWORD]@<host>.pooler.supabase.com:6543/postgres"');
  process.exit(1);
}

let url;
try {
  url = new URL(raw.trim());
} catch {
  console.error("La cadena no es una URL válida.");
  process.exit(1);
}
const m = decodeURIComponent(url.username).match(/^[^.]+\.([a-z0-9]{20})$/);
if (!/pooler\.supabase\.com$/.test(url.hostname) || !m) {
  console.error('Usa la cadena del "Transaction pooler" (host *.pooler.supabase.com, usuario postgres.<ref>).');
  process.exit(1);
}
const ref = m[1];
if (url.port !== "6543") {
  console.error(`Ojo: el puerto es ${url.port || "(ninguno)"}; el Transaction pooler usa 6543. Revisa que copiaste esa opción.`);
  process.exit(1);
}

// Contraseña solo con letras y números (sin problemas en URL ni en SQL).
const password = randomBytes(24).toString("base64url").replace(/[-_]/g, "x");

const sql = readFileSync(new URL("./supabase-usuario-aislado.sql", import.meta.url), "utf8")
  .replaceAll("__PASSWORD__", password);
writeFileSync(".env.supabase.sql", sql, { mode: 0o600 });

url.username = `prospector_app.${ref}`;
url.password = password;
url.pathname = "/postgres";
const dbUrl = url.toString();

// Actualiza (o agrega) DATABASE_URL y DB_SCHEMA en .env.local sin tocar lo demás.
const lines = existsSync(".env.local") ? readFileSync(".env.local", "utf8").split(/\r?\n/) : [];
const set = (key, value) => {
  const i = lines.findIndex((l) => l.startsWith(`${key}=`));
  if (i >= 0) lines[i] = `${key}=${value}`;
  else lines.push(`${key}=${value}`);
};
while (lines.length && lines[lines.length - 1] === "") lines.pop();
set("DATABASE_URL", dbUrl);
set("DB_SCHEMA", "prospector");
writeFileSync(".env.local", lines.join("\n") + "\n");

console.log(`Proyecto ${ref} · host ${url.hostname}:6543`);
console.log("1) Abre .env.supabase.sql, copia TODO y ejecútalo en Supabase → SQL Editor.");
console.log("   La última consulta debe mostrar search_path=prospector y ve_tablas_de_finanzas = false.");
console.log("2) DATABASE_URL (usuario prospector_app) y DB_SCHEMA=prospector quedaron en .env.local.");
console.log("3) Borra .env.supabase.sql después de ejecutarlo (contiene la contraseña).");
