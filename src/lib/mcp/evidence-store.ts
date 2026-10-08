// "Sesión" de investigación MCP por vendedor (tabla mcp_evidence).
// En la app, el agente junta en memoria todo lo que devolvieron sus
// herramientas (Evidence) y con eso valida el reporte. Por MCP cada llamada es
// una petición HTTP sin estado, así que lo visto se guarda aquí entre llamadas
// y guardar_investigacion lo usa con el MISMO post-proceso (postprocess.ts).
// Lo de Google se guarda solo de forma transitoria (expira con la sesión),
// como referencia para empatar y calificar; nunca se exporta.
import type { SiteContacts } from "../email-extract";
import { ensureSchema, getSql, hasDb } from "../db";
import { Evidence, type SeenBusiness, type ZoneInfo } from "../agent/evidence";
import { hostOf } from "../agent/normalize";

// Una sesión se reinicia tras 6 h sin actividad.
export const SESSION_IDLE_HOURS = 6;
// Si la sesión acumula demasiados negocios, se reinicia con lo nuevo.
const MAX_SESSION_BUSINESSES = 3000;

type Row = Record<string, unknown>;

interface SessionMeta {
  zone?: ZoneInfo;
  keywords?: string[];
  scianCodes?: string[];
  radiusM?: number;
}

/** Evidence que además registra lo agregado desde startRecording(). */
export class SessionEvidence extends Evidence {
  private recording = false;
  readonly newBusinesses = new Map<string, SeenBusiness>();
  readonly newSites = new Map<string, SiteContacts>();

  startRecording(): void {
    this.recording = true;
  }

  override addBusiness(b: SeenBusiness): void {
    super.addBusiness(b);
    if (this.recording) this.newBusinesses.set(b.id, this.businesses.get(b.id) ?? b);
  }

  override addSite(site: SiteContacts): void {
    super.addSite(site);
    const h = hostOf(site.url);
    if (this.recording && h) this.newSites.set(h, site);
  }
}

const isObj = (v: unknown): v is Row => !!v && typeof v === "object" && !Array.isArray(v);

/** Rehidrata una Evidence con una fila guardada (puro; sin BD). */
export function hydrateSession(ev: SessionEvidence, r: Row): SessionEvidence {
  if (isObj(r.businesses)) {
    for (const b of Object.values(r.businesses)) {
      if (isObj(b) && typeof b.id === "string" && typeof b.name === "string" && typeof b.source === "string") {
        ev.addBusiness(b as unknown as SeenBusiness);
      }
    }
  }
  if (isObj(r.sites)) {
    for (const s of Object.values(r.sites)) {
      if (isObj(s) && typeof s.url === "string" && Array.isArray(s.emails)) ev.addSite(s as unknown as SiteContacts);
    }
  }
  const meta = (isObj(r.meta) ? r.meta : {}) as SessionMeta;
  if (meta.zone && typeof meta.zone.lat === "number") ev.zone = meta.zone;
  meta.keywords?.forEach((k) => typeof k === "string" && ev.keywords.add(k));
  meta.scianCodes?.forEach((k) => typeof k === "string" && ev.scianCodes.add(k));
  if (typeof meta.radiusM === "number") ev.radiusM = meta.radiusM;
  ev.googleCalls = Number(r.google_calls ?? 0) || 0;
  return ev;
}

/** Lo que se escribe tras una herramienta: solo lo nuevo + meta vigente (puro). */
export function sessionPayload(ev: SessionEvidence): { businesses: string; sites: string; meta: string } {
  const meta: SessionMeta = {
    ...(ev.zone ? { zone: ev.zone } : {}),
    keywords: [...ev.keywords].slice(0, 20),
    scianCodes: [...ev.scianCodes].slice(0, 20),
    ...(ev.radiusM ? { radiusM: ev.radiusM } : {}),
  };
  return {
    businesses: JSON.stringify(Object.fromEntries(ev.newBusinesses)),
    sites: JSON.stringify(Object.fromEntries(ev.newSites)),
    meta: JSON.stringify(meta),
  };
}

/** Carga la sesión vigente del vendedor (vacía si no hay BD o expiró). */
export async function loadSessionEvidence(email: string): Promise<SessionEvidence> {
  const ev = new SessionEvidence();
  if (!hasDb()) return ev;
  await ensureSchema();
  const sql = getSql();
  // Purga las sesiones vencidas de todos y lee la vigente de este vendedor.
  const rows = (await sql`
    WITH purge AS (
      DELETE FROM mcp_evidence
      WHERE updated_at < now() - (${SESSION_IDLE_HOURS}::int * interval '1 hour')
      RETURNING 1
    )
    SELECT businesses, sites, meta, google_calls FROM mcp_evidence
    WHERE user_email = ${email}
      AND updated_at >= now() - (${SESSION_IDLE_HOURS}::int * interval '1 hour')
  `) as Row[];
  return rows[0] ? hydrateSession(ev, rows[0]) : ev;
}

/**
 * Guarda lo que agregó la última herramienta (se fusiona con lo que ya había,
 * así dos llamadas en paralelo no se pisan). `googleDelta` suma consultas a
 * Google; `resetGoogle` reinicia ese contador (zona nueva = investigación nueva).
 */
export async function saveSessionEvidence(
  email: string,
  ev: SessionEvidence,
  o: { googleDelta: number; resetGoogle: boolean }
): Promise<void> {
  if (!hasDb()) return;
  const { businesses, sites, meta } = sessionPayload(ev);
  const delta = Math.max(0, o.googleDelta);
  await ensureSchema();
  const sql = getSql();
  await sql`
    INSERT INTO mcp_evidence (user_email, businesses, sites, meta, google_calls)
    VALUES (${email}, ${businesses}::jsonb, ${sites}::jsonb, ${meta}::jsonb, ${delta}::int)
    ON CONFLICT (user_email) DO UPDATE SET
      businesses = CASE
        WHEN (SELECT count(*) FROM jsonb_object_keys(mcp_evidence.businesses)) > ${MAX_SESSION_BUSINESSES}::int
          THEN EXCLUDED.businesses
        ELSE mcp_evidence.businesses || EXCLUDED.businesses
      END,
      sites = mcp_evidence.sites || EXCLUDED.sites,
      meta = mcp_evidence.meta || EXCLUDED.meta,
      google_calls = CASE WHEN ${o.resetGoogle}::boolean THEN EXCLUDED.google_calls
                          ELSE mcp_evidence.google_calls + EXCLUDED.google_calls END,
      updated_at = now()
  `;
}
