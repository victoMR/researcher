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

  // --- Migraciones aditivas (idempotentes) ---

  // Dueño del prospecto y quién lo contactó (para no pisarse entre vendedores).
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS owner_email TEXT`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacted_by TEXT`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS contacted_at TIMESTAMPTZ`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`;
  await sql`CREATE INDEX IF NOT EXISTS idx_leads_owner ON leads (owner_email)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_leads_status ON leads (status)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_leads_email ON leads (lower(email))`;

  // Bitácora de contacto: quién (actor), a quién (target) y sobre qué prospecto.
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS lead_id TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS actor_email TEXT`;
  await sql`ALTER TABLE events ADD COLUMN IF NOT EXISTS target_email TEXT`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_target ON events (target_email, created_at DESC)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_events_lead ON events (lead_id, created_at DESC)`;

  // Quién registró la baja.
  await sql`ALTER TABLE suppression ADD COLUMN IF NOT EXISTS created_by TEXT`;

  // Caché de búsquedas (Google / OSM) para no pagar dos veces la misma consulta.
  await sql`
    CREATE TABLE IF NOT EXISTS search_cache (
      key         TEXT PRIMARY KEY,               -- fuente|giro|ciudad normalizada
      source      TEXT NOT NULL,                  -- google | osm
      category    TEXT,
      city        TEXT,
      results     JSONB NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  // Consumo diario por API externa (tope de gasto).
  await sql`
    CREATE TABLE IF NOT EXISTS api_usage (
      day    DATE NOT NULL,
      api    TEXT NOT NULL,
      calls  INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (day, api)
    )
  `;

  // Intentos de login (límite contra fuerza bruta). key = correo o IP.
  await sql`
    CREATE TABLE IF NOT EXISTS login_attempts (
      id          BIGSERIAL PRIMARY KEY,
      key         TEXT NOT NULL,
      ok          BOOLEAN NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_login_attempts ON login_attempts (key, created_at DESC)`;

  // Ids externos del prospecto. De Google solo se puede guardar el place_id
  // (y lat/lng por máx. 30 días -> coords_expire_at); DENUE y OSM son abiertos.
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS place_id TEXT`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS denue_id TEXT`;
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS coords_expire_at TIMESTAMPTZ`;
  // Cuándo se revisaron por última vez sus datos de contacto (para el score).
  await sql`ALTER TABLE leads ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ`;
  await sql`CREATE INDEX IF NOT EXISTS idx_leads_place ON leads (place_id)`;
  await sql`CREATE INDEX IF NOT EXISTS idx_leads_denue ON leads (denue_id)`;

  // Investigaciones con IA ("busca clientes en El Refugio, Querétaro, nicho X").
  // results/summary NUNCA llevan contenido de Google salvo place_id.
  await sql`
    CREATE TABLE IF NOT EXISTS research_runs (
      id           TEXT PRIMARY KEY,
      created_by   TEXT,
      prompt       TEXT NOT NULL,
      params       JSONB,                          -- nicho, zona, radio, filtros (interpretado)
      status       TEXT NOT NULL DEFAULT 'running', -- running | done | error
      progress     JSONB,
      results      JSONB,                          -- prospectos (DENUE/OSM + correos)
      summary      JSONB,                          -- análisis de la IA
      error        TEXT,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
      finished_at  TIMESTAMPTZ
    )
  `;
  await sql`CREATE INDEX IF NOT EXISTS idx_research_runs_created ON research_runs (created_at DESC)`;

  // Evidencia de la "sesión" MCP de cada vendedor: lo que devolvieron las
  // herramientas de investigación (DENUE, OSM, sitios, Google solo como señal)
  // para validar guardar_investigacion igual que el agente interno. Expira
  // por inactividad (ver src/lib/mcp/evidence-store.ts).
  await sql`
    CREATE TABLE IF NOT EXISTS mcp_evidence (
      user_email    TEXT PRIMARY KEY,
      businesses    JSONB NOT NULL DEFAULT '{}'::jsonb,  -- id -> negocio visto
      sites         JSONB NOT NULL DEFAULT '{}'::jsonb,  -- host -> sitio revisado
      meta          JSONB NOT NULL DEFAULT '{}'::jsonb,  -- zona, palabras, SCIAN, radio
      google_calls  INTEGER NOT NULL DEFAULT 0,
      started_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `;

  schemaReady = true;
}
