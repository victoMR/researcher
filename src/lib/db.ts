import { neon, type NeonQueryFunction } from "@neondatabase/serverless";
export { dedupeKey } from "./dedupe";

// Cliente Neon con init perezosa: no truena en build si aún no hay DATABASE_URL.
let _sql: NeonQueryFunction<false, false> | null = null;

export function getSql(): NeonQueryFunction<false, false> {
  if (!_sql) {
    const url = process.env.DATABASE_URL;
    if (!url) throw new Error("Falta DATABASE_URL (provisiona Neon).");
    _sql = neon(url);
  }
  return _sql;
}

export function hasDb(): boolean {
  return !!process.env.DATABASE_URL;
}

let schemaReady = false;

// Crea las tablas si no existen. Se llama antes de operar.
export async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  const sql = getSql();

  // Prospectos guardados (persistencia + dedupe).
  // dedupe_key = nombre normalizado + ciudad -> índice único para no duplicar.
  await sql`
    CREATE TABLE IF NOT EXISTS leads (
      id            TEXT PRIMARY KEY,
      dedupe_key    TEXT UNIQUE NOT NULL,
      name          TEXT NOT NULL,
      category      TEXT,
      city          TEXT,
      phone         TEXT,
      website       TEXT,
      email         TEXT,
      address       TEXT,
      lat           DOUBLE PRECISION,
      lon           DOUBLE PRECISION,
      rating        DOUBLE PRECISION,
      review_count  INTEGER,
      last_review   TIMESTAMPTZ,
      score         INTEGER,
      source        TEXT,
      status        TEXT NOT NULL DEFAULT 'nuevo',
      note          TEXT,
      created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Campañas de correo.
  await sql`
    CREATE TABLE IF NOT EXISTS campaigns (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      from_email  TEXT NOT NULL,
      subject     TEXT NOT NULL,
      body        TEXT NOT NULL,
      steps       JSONB NOT NULL DEFAULT '[]',   -- seguimientos [{delayDays, subject, body}]
      schedule    JSONB NOT NULL DEFAULT '{}',   -- {days:[1..5], startHour, endHour, perDayCap}
      status      TEXT NOT NULL DEFAULT 'draft', -- draft|active|paused|done
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Destinatarios de cada campaña (la cola de envío).
  await sql`
    CREATE TABLE IF NOT EXISTS campaign_recipients (
      id            TEXT PRIMARY KEY,
      campaign_id   TEXT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
      lead_id       TEXT,
      name          TEXT NOT NULL,
      email         TEXT NOT NULL,
      vars          JSONB NOT NULL DEFAULT '{}',
      step          INTEGER NOT NULL DEFAULT 0,
      status        TEXT NOT NULL DEFAULT 'pending', -- pending|sent|replied|bounced|unsubscribed|failed|done
      next_send_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      unsub_token   TEXT NOT NULL,
      last_event_at TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_recipients_due ON campaign_recipients (status, next_send_at)`;

  // Lista de baja / supresión (opt-out, rebotes duros, quejas). Nunca reenviar.
  await sql`
    CREATE TABLE IF NOT EXISTS suppression (
      email      TEXT PRIMARY KEY,
      reason     TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Plantillas de mensaje (mail / whatsapp / ambos).
  await sql`
    CREATE TABLE IF NOT EXISTS templates (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      channel     TEXT NOT NULL DEFAULT 'ambos', -- email | whatsapp | ambos
      subject     TEXT,
      body        TEXT NOT NULL,
      version     INTEGER NOT NULL DEFAULT 1,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  // Historial de versiones de cada plantilla (para el changelog en MD).
  await sql`
    CREATE TABLE IF NOT EXISTS template_versions (
      id           BIGSERIAL PRIMARY KEY,
      template_id  TEXT NOT NULL REFERENCES templates(id) ON DELETE CASCADE,
      version      INTEGER NOT NULL,
      name         TEXT NOT NULL,
      channel      TEXT NOT NULL,
      subject      TEXT,
      body         TEXT NOT NULL,
      note         TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Bitácora de eventos para el dashboard (enviado, entregado, rebote, abierto, respondió...).
  await sql`
    CREATE TABLE IF NOT EXISTS events (
      id           BIGSERIAL PRIMARY KEY,
      campaign_id  TEXT,
      recipient_id TEXT,
      type         TEXT NOT NULL,
      meta         JSONB,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  schemaReady = true;
}
