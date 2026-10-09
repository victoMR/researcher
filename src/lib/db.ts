import postgres from "postgres";
export { dedupeKey } from "./dedupe";

// Postgres de Supabase vía postgres.js. Init perezosa: no truena en build si
// aún no hay URL. Usa la cadena del "Transaction pooler" de Supabase (puerto
// 6543): DATABASE_URL, o POSTGRES_URL si se conectó con la integración de
// Supabase en Vercel.
type Sql = postgres.Sql;
let _sql: Sql | null = null;

function dbUrl(): string | undefined {
  return process.env.DATABASE_URL || process.env.POSTGRES_URL;
}

// Esquema propio (p. ej. "prospector" en el proyecto de Supabase de Finanzas,
// con un usuario que no ve las tablas de Finanzas). Ver
// scripts/supabase-usuario-aislado.sql. Sin DB_SCHEMA se usa el del usuario.
function dbSchema(): string | undefined {
  return process.env.DB_SCHEMA?.trim() || undefined;
}

export function getSql(): Sql {
  if (!_sql) {
    const url = dbUrl();
    if (!url) throw new Error("Falta DATABASE_URL (cadena de conexión de Supabase).");
    _sql = postgres(url, {
      prepare: false, // el pooler en modo transacción no admite prepared statements
      max: Number(process.env.DB_POOL_MAX) || 3, // pocas por instancia: el pooler reparte
      idle_timeout: 20,
      connect_timeout: 10,
      ssl: /localhost|127\.0\.0\.1/.test(url) ? false : "require",
      transform: { undefined: null }, // como el driver anterior: undefined -> NULL
      types: {
        // El código ya manda JSON serializado (JSON.stringify(...)::jsonb). El
        // serializador por defecto lo volvería a convertir y quedaría guardado
        // como texto: solo convertimos lo que no sea string.
        json: {
          to: 114,
          from: [114, 3802],
          serialize: (x: unknown) => (typeof x === "string" ? x : JSON.stringify(x)),
          parse: (x: string) => JSON.parse(x),
        },
      },
      onnotice: () => {}, // sin ruido por "ya existe" en los CREATE IF NOT EXISTS
      // Refuerzo del search_path del usuario (si el pooler acepta el parámetro).
      ...(dbSchema() ? { connection: { search_path: dbSchema()! } } : {}),
    });
  }
  return _sql;
}

export function hasDb(): boolean {
  return !!dbUrl();
}

// Tablas de esta app y una columna que solo tienen las nuestras. Si en la base
// ya existe una tabla con ese nombre SIN esa columna (p. ej. de Finanzas en el
// mismo proyecto de Supabase), no tocamos nada.
const OWN_TABLES: Record<string, string> = {
  leads: "dedupe_key",
  campaigns: "from_email",
  campaign_recipients: "unsub_token",
  suppression: "reason",
  templates: "channel",
  template_versions: "template_id",
  events: "recipient_id",
  search_cache: "results",
  api_usage: "calls",
  login_attempts: "ok",
  research_runs: "prompt",
  mcp_evidence: "businesses",
  // Firma: mcp_token_hash (un "app_users" ajeno bien podría tener password_hash).
  app_users: "mcp_token_hash",
};

async function assertNoForeignTables(sql: Sql): Promise<void> {
  const rows = await sql<{ table_name: string; cols: string[] }[]>`
    SELECT table_name, array_agg(column_name::text) AS cols
    FROM information_schema.columns
    WHERE table_schema = current_schema() AND table_name = ANY(${Object.keys(OWN_TABLES)}::text[])
    GROUP BY table_name
  `;
  const foreign = rows.filter((r) => !r.cols.includes(OWN_TABLES[r.table_name]));
  if (foreign.length) {
    throw new Error(
      `La base ya tiene tablas que no son de esta app: ${foreign
        .map((r) => r.table_name)
        .join(", ")}. Usa un proyecto de Supabase dedicado (no se modificó nada).`
    );
  }
}

let schemaPromise: Promise<void> | null = null;

// Crea/actualiza las tablas una vez por instancia (llamadas simultáneas
// comparten la misma promesa). Se llama antes de operar.
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = migrate(getSql()).catch((e) => {
      schemaPromise = null; // reintenta en la siguiente llamada
      throw e;
    });
  }
  return schemaPromise;
}

async function migrate(sql: Sql): Promise<void> {
  // Con DB_SCHEMA, nada se crea si la conexión no está de verdad en ese
  // esquema (así nunca se tocan las tablas de Finanzas en "public").
  const schema = dbSchema();
  if (schema) {
    const [{ s }] = await sql<{ s: string | null }[]>`SELECT current_schema() AS s`;
    if (s !== schema) {
      throw new Error(
        `La conexión usa el esquema "${s ?? "ninguno"}" y no "${schema}". Revisa el usuario de la base (scripts/supabase-usuario-aislado.sql); no se creó nada.`
      );
    }
  }
  await assertNoForeignTables(sql);

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

  // Usuarios dados de alta desde la app (pestaña Equipo). Los de APP_USERS /
  // APP_LOGIN_* siguen en variables de entorno (respaldo) y no van aquí.
  // password_hash: "scrypt:<salt>:<hash>" (src/lib/auth.ts). session_version:
  // subirlo invalida todas las sesiones abiertas del usuario. Del token MCP
  // solo se guarda su sha256 (hex), nunca el token.
  await sql`
    CREATE TABLE IF NOT EXISTS app_users (
      email                 TEXT PRIMARY KEY CHECK (email = lower(email)),
      name                  TEXT NOT NULL DEFAULT '',
      role                  TEXT NOT NULL DEFAULT 'vendedor' CHECK (role IN ('admin', 'vendedor')),
      password_hash         TEXT NOT NULL,
      active                BOOLEAN NOT NULL DEFAULT true,
      must_change_password  BOOLEAN NOT NULL DEFAULT true,
      session_version       INTEGER NOT NULL DEFAULT 1,
      mcp_token_hash        TEXT UNIQUE,
      mcp_token_created_at  TIMESTAMPTZ,
      created_by            TEXT,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
      last_login_at         TIMESTAMPTZ
    )
  `;

  // Supabase publica el esquema por su API REST: con RLS activo y sin
  // políticas, esa API no ve nada; la app (dueña de las tablas) sí.
  for (const t of Object.keys(OWN_TABLES)) {
    await sql`ALTER TABLE ${sql(t)} ENABLE ROW LEVEL SECURITY`;
  }
}
