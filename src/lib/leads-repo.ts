import { getSql, ensureSchema } from "./db";
import { dedupeKey } from "./dedupe";
import { displayName } from "./session";
import { computeScore } from "./scoring";
import { geocodePlace } from "./osm";
import {
  denueAreaForPlace,
  denueMatch,
  denueReady,
  denueToBusiness,
  type DenueMatch,
} from "./denue";
import { LEAD_STATUSES, hasCoords, isGoogleOnly, placeIdOf, sourceOf } from "./types";
import type {
  Business,
  DataSource,
  Lead,
  LeadMatch,
  LeadStatus,
  LeadsPage,
  OwnerFilter,
} from "./types";

type Row = Record<string, unknown>;
type Sql = ReturnType<typeof getSql>;

const DAY_MS = 24 * 60 * 60 * 1000;
// Términos de Google: lat/lng de Places se pueden guardar máx. 30 días.
const GOOGLE_COORDS_TTL_MS = 30 * DAY_MS;
const SOURCES: DataSource[] = ["denue", "osm", "google", "web"];

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);
// NULL -> NaN (Number(null) daría 0 = coordenada falsa en el Golfo de Guinea).
const coord = (v: unknown) => (v == null || v === "" ? NaN : Number(v));

// Score por resta (src/lib/scoring.ts) con los datos guardados.
function scoreOf(b: Business, checkedAt?: unknown) {
  return computeScore({
    phone: b.phone,
    email: b.email,
    emailIsGuess: b.emailIsGuess,
    website: b.website,
    address: b.address,
    businessStatus: b.status,
    lastActivityAt: b.lastReviewTime,
    dataCheckedAt: iso(checkedAt),
  });
}

function rowToLead(r: Row): Lead {
  const id = String(r.id);
  const src = SOURCES.includes(r.source as DataSource) ? (r.source as DataSource) : undefined;
  const lead: Lead = {
    id,
    name: String(r.name),
    category: (r.category as string) ?? "",
    city: (r.city as string) ?? undefined,
    phone: (r.phone as string) ?? undefined,
    website: (r.website as string) ?? undefined,
    email: (r.email as string) ?? undefined,
    address: (r.address as string) ?? undefined,
    lat: coord(r.lat),
    lon: coord(r.lon),
    rating: r.rating != null ? Number(r.rating) : undefined,
    reviewCount: r.review_count != null ? Number(r.review_count) : undefined,
    lastReviewTime: iso(r.last_review),
    source: src,
    denueId: (r.denue_id as string) ?? undefined,
    placeId: (r.place_id as string) ?? (id.startsWith("place/") ? id.slice(6) : undefined),
    status: (r.status as LeadStatus) ?? "nuevo",
    note: (r.note as string) ?? undefined,
    savedAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
    ownerEmail: (r.owner_email as string) ?? undefined,
    contactedBy: (r.contacted_by as string) ?? undefined,
    contactedAt: iso(r.contacted_at),
  };
  // Se calcula al leer (depende de la fecha): datos revisados = checked_at o alta.
  const s = scoreOf(lead, r.checked_at ?? r.created_at);
  lead.score = s.score;
  lead.scoreDeductions = s.deductions;
  return lead;
}

// Convierte la fila y guarda el score en la columna (para métricas) si cambió.
async function syncScore(sql: Sql, r: Row): Promise<Lead> {
  const lead = rowToLead(r);
  if (r.score == null || Number(r.score) !== lead.score) {
    await sql`UPDATE leads SET score = ${lead.score ?? null} WHERE id = ${lead.id}`.catch((e) =>
      console.error("leads score", e)
    );
  }
  return lead;
}

// Borra las coordenadas de Google vencidas (> 30 días). Devuelve cuántas.
export async function purgeExpiredCoords(): Promise<number> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    UPDATE leads SET lat = NULL, lon = NULL, coords_expire_at = NULL
    WHERE coords_expire_at IS NOT NULL AND coords_expire_at < now()
    RETURNING id
  `) as Row[];
  return rows.length;
}

// Purga "de vez en cuando": a lo más cada 6 h por instancia (barata: pocas filas).
const PURGE_EVERY_MS = 6 * 60 * 60 * 1000;
let lastPurge = 0;
async function maybePurge(): Promise<void> {
  if (Date.now() - lastPurge < PURGE_EVERY_MS) return;
  lastPurge = Date.now();
  try {
    await purgeExpiredCoords();
  } catch (e) {
    console.error("leads purge coords", e);
  }
}

// Empareja un negocio con DENUE: por cercanía (≤ 250 m) o, sin coordenadas,
// por nombre en el municipio de su ciudad. Nunca lanza.
async function matchDenueSafe(
  b: Pick<Business, "name" | "lat" | "lon">,
  city?: string
): Promise<DenueMatch | null> {
  if (!denueReady()) return null;
  try {
    if (hasCoords(b)) {
      return await denueMatch({ name: b.name, lat: b.lat, lon: b.lon, maxDistanceM: 250 });
    }
    if (city) {
      const area = denueAreaForPlace(await geocodePlace(city), city);
      if (area) {
        return await denueMatch({
          name: b.name,
          area: { entidad: area.entidad, municipio: area.municipio },
        });
      }
    }
  } catch (e) {
    console.error("denue match", (e as Error).message);
  }
  return null;
}

// Escapa los comodines de LIKE para buscar el texto tal cual.
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, (m) => "\\" + m);
}

// Filtro de texto: nombre, correo, teléfono (también por dígitos) o ciudad.
function textCond(sql: Sql, q: string) {
  if (!q) return sql`TRUE`;
  const like = `%${escapeLike(q)}%`;
  const digits = q.replace(/\D/g, "");
  if (digits.length >= 3) {
    return sql`(
      name ILIKE ${like} OR email ILIKE ${like} OR phone ILIKE ${like} OR city ILIKE ${like}
      OR regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g') LIKE ${`%${digits}%`}
    )`;
  }
  return sql`(name ILIKE ${like} OR email ILIKE ${like} OR phone ILIKE ${like} OR city ILIKE ${like})`;
}

// Filtro de dueño: míos, todos o sin asignar.
function ownerCond(sql: Sql, owner: OwnerFilter, me: string | null) {
  if (owner === "all") return sql`TRUE`;
  if (owner === "unassigned") return sql`owner_email IS NULL`;
  return me ? sql`owner_email = ${me}` : sql`FALSE`;
}

export interface ListOptions {
  q?: string;
  status?: LeadStatus | null;
  owner?: OwnerFilter;
  me?: string | null;
  page?: number; // 1..n
  pageSize?: number; // 0 = solo conteos
}

// Lista paginada con filtros + conteos para los chips.
export async function listLeads(opts: ListOptions = {}): Promise<LeadsPage> {
  await ensureSchema();
  await maybePurge();
  const sql = getSql();
  const q = (opts.q ?? "").trim().slice(0, 100);
  const status = opts.status && LEAD_STATUSES.includes(opts.status) ? opts.status : null;
  const owner: OwnerFilter = opts.owner ?? "mine";
  const me = opts.me?.toLowerCase() ?? null;
  const pageSize = Math.max(0, Math.min(200, Math.floor(opts.pageSize ?? 30)));
  const page = Math.max(1, Math.floor(opts.page ?? 1));
  const offset = (page - 1) * pageSize;

  const rowsQuery =
    pageSize > 0
      ? sql`
          SELECT * FROM leads
          WHERE ${textCond(sql, q)}
            AND ${ownerCond(sql, owner, me)}
            AND ${status ? sql`status = ${status}` : sql`TRUE`}
          ORDER BY created_at DESC, id
          LIMIT ${pageSize} OFFSET ${offset}
        `
      : Promise.resolve([]);

  // Conteos: respetan q; byStatus además respeta owner (no status).
  const countsQuery = sql`
    SELECT status,
      count(*) FILTER (WHERE ${ownerCond(sql, owner, me)}) AS n,
      count(*) FILTER (WHERE ${ownerCond(sql, "mine", me)}) AS mine,
      count(*) FILTER (WHERE owner_email IS NULL) AS unassigned,
      count(*) AS all_count
    FROM leads
    WHERE ${textCond(sql, q)}
    GROUP BY status
  `;

  const [rows, countRows] = (await Promise.all([rowsQuery, countsQuery])) as [Row[], Row[]];

  const byStatus = Object.fromEntries(LEAD_STATUSES.map((s) => [s, 0])) as Record<
    LeadStatus,
    number
  >;
  let mine = 0;
  let unassigned = 0;
  let all = 0;
  let inOwner = 0;
  for (const r of countRows) {
    const n = Number(r.n ?? 0);
    if (LEAD_STATUSES.includes(r.status as LeadStatus)) byStatus[r.status as LeadStatus] = n;
    inOwner += n;
    mine += Number(r.mine ?? 0);
    unassigned += Number(r.unassigned ?? 0);
    all += Number(r.all_count ?? 0);
  }

  return {
    leads: rows.map(rowToLead),
    total: status ? byStatus[status] : inOwner,
    page,
    pageSize,
    counts: { byStatus, mine, unassigned, all },
  };
}

export async function getLead(id: string): Promise<Lead | null> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM leads WHERE id = ${id}`) as Row[];
  return rows[0] ? rowToLead(rows[0]) : null;
}

// Lo mínimo que se puede guardar de un resultado de Google (sus términos solo
// permiten place_id y lat/lng por 30 días): nombre para que el vendedor lo
// identifique, el correo que sacamos de SU web y el giro de nuestra búsqueda.
// Nada de teléfono, dirección, web, rating ni reseñas.
function minimalGoogle(b: Business): Business {
  return {
    id: b.id,
    name: b.name,
    category: b.category,
    email: b.email || undefined,
    emailIsGuess: b.emailIsGuess,
    lat: b.lat,
    lon: b.lon,
    source: "google",
    placeId: placeIdOf(b),
  };
}

// Reemplaza los datos de un prospecto solo-Google por los de DENUE (conserva
// dueño, estatus, notas y el correo hallado). No cambia id ni dedupe_key.
async function upgradeToDenue(
  sql: Sql,
  id: string,
  d: Business,
  placeId: string | null
): Promise<Lead | null> {
  const rows = (await sql`
    UPDATE leads SET
      name = ${d.name},
      phone = ${d.phone || null},
      website = ${d.website || null},
      address = ${d.address || null},
      email = COALESCE(email, ${d.email || null}),
      lat = ${hasCoords(d) ? d.lat : null},
      lon = ${hasCoords(d) ? d.lon : null},
      coords_expire_at = NULL,
      rating = NULL, review_count = NULL, last_review = NULL,
      source = 'denue',
      denue_id = ${d.denueId ?? null},
      place_id = COALESCE(place_id, ${placeId}),
      checked_at = now(),
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `) as Row[];
  return rows[0] ? syncScore(sql, rows[0]) : null;
}

// Quita de un prospecto solo-Google todo lo que no se puede guardar.
async function stripGoogle(sql: Sql, id: string): Promise<Lead | null> {
  const rows = (await sql`
    UPDATE leads SET
      phone = NULL, website = NULL, address = NULL,
      rating = NULL, review_count = NULL, last_review = NULL,
      source = 'google',
      place_id = COALESCE(place_id, CASE WHEN id LIKE 'place/%' THEN substr(id, 7) END),
      coords_expire_at = CASE
        WHEN lat IS NULL THEN NULL
        ELSE COALESCE(coords_expire_at, created_at + interval '30 days')
      END,
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `) as Row[];
  return rows[0] ? syncScore(sql, rows[0]) : null;
}

interface SaveCtx {
  owner: string | null;
  source: DataSource;
  placeId: string | null;
  denueId: string | null;
}

// Fusiona `rec` sobre un prospecto que ya existía (mismo id, CLEE, place_id o
// nombre+ciudad). No pisa el dueño ni mete contenido de Google.
async function mergeInto(sql: Sql, row: Row, rec: Business, x: SaveCtx): Promise<Lead> {
  const current = rowToLead(row);
  const id = current.id;
  // Era solo-Google y ahora tenemos DENUE: se sustituye por completo.
  if (isGoogleOnly(current) && x.source === "denue") {
    const up = await upgradeToDenue(sql, id, rec, x.placeId);
    if (up) return up;
  }
  // Era solo-Google (quizá de antes, con datos completos): se limpia de paso.
  if (isGoogleOnly(current) && x.source === "google") {
    await stripGoogle(sql, id);
  }
  const contact = !!(rec.email || rec.phone);
  const rows = (await sql`
    UPDATE leads SET
      email   = COALESCE(${rec.email || null}, email),
      phone   = COALESCE(${rec.phone || null}, phone),
      website = COALESCE(${rec.website || null}, website),
      address = COALESCE(${rec.address || null}, address),
      denue_id = COALESCE(denue_id, ${x.denueId}),
      place_id = COALESCE(place_id, ${x.placeId}),
      owner_email = COALESCE(owner_email, ${x.owner}),
      checked_at = CASE WHEN ${contact}::boolean THEN now() ELSE checked_at END,
      updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `) as Row[];
  return rows[0] ? syncScore(sql, rows[0]) : current;
}

/**
 * Guarda (o fusiona) un prospecto. ownerEmail = vendedor que lo guarda; si ya
 * existía, NO se pisa el dueño que tenía. Persiste source, denue_id y place_id.
 *
 * Resultados de Google ("place/…" o source "google"): primero se intenta el
 * mismo negocio en DENUE (≤ 250 m y nombre parecido) y se guardan los datos de
 * DENUE con el place_id enlazado. Si no hay match, se guarda lo mínimo (ver
 * minimalGoogle) con coordenadas que vencen a los 30 días.
 */
export async function saveLead(
  b: Business,
  city?: string,
  ownerEmail?: string | null
): Promise<Lead> {
  await ensureSchema();
  const sql = getSql();
  const owner = ownerEmail ? ownerEmail.toLowerCase() : null;
  const placeId = placeIdOf(b) ?? null;

  let rec: Business = b;
  let source: DataSource = sourceOf(b);
  let coordsExpire: Date | null = null;

  if (source === "google") {
    if (b.denueId) {
      // Ya viene vinculado con DENUE (p. ej. del agente): sin señales de Google.
      source = "denue";
      rec = { ...b, rating: undefined, reviewCount: undefined, lastReviewTime: undefined };
    } else {
      const m = await matchDenueSafe(b, city);
      if (m) {
        source = "denue";
        rec = {
          ...denueToBusiness(m.e, b.category),
          email: b.email || m.e.email,
          emailIsGuess: b.email ? b.emailIsGuess : false,
        };
      } else {
        rec = minimalGoogle(b);
        coordsExpire = hasCoords(b) ? new Date(Date.now() + GOOGLE_COORDS_TTL_MS) : null;
      }
    }
  }

  const x: SaveCtx = { owner, source, placeId, denueId: rec.denueId ?? null };
  const key = dedupeKey(rec.name, city);
  const lastReview = rec.lastReviewTime ? new Date(rec.lastReviewTime) : null;
  const score = scoreOf(rec, new Date()).score;
  const lat = hasCoords(rec) ? rec.lat : null;
  const lon = hasCoords(rec) ? rec.lon : null;

  // ¿Ya existe por id, CLEE o place_id? (el nombre de DENUE puede diferir del de Google).
  const existing = (await sql`
    SELECT * FROM leads
    WHERE id = ${rec.id}
       OR (${x.denueId}::text IS NOT NULL AND denue_id = ${x.denueId})
       OR (${x.placeId}::text IS NOT NULL AND place_id = ${x.placeId})
    ORDER BY (id = ${rec.id}) DESC, (denue_id IS NOT NULL) DESC
    LIMIT 1
  `) as Row[];
  if (existing[0]) return mergeInto(sql, existing[0], rec, x);

  const inserted = (await sql`
    INSERT INTO leads (
      id, dedupe_key, name, category, city, phone, website, email, address,
      lat, lon, rating, review_count, last_review, score, source, status, owner_email,
      place_id, denue_id, coords_expire_at, checked_at
    ) VALUES (
      ${rec.id}, ${key}, ${rec.name}, ${rec.category}, ${city || null}, ${rec.phone || null},
      ${rec.website || null}, ${rec.email || null}, ${rec.address || null},
      ${lat}, ${lon}, ${rec.rating ?? null}, ${rec.reviewCount ?? null},
      ${lastReview}, ${score}, ${source}, 'nuevo', ${owner},
      ${x.placeId}, ${x.denueId}, ${lat == null ? null : coordsExpire}, now()
    )
    ON CONFLICT DO NOTHING
    RETURNING *
  `) as Row[];
  if (inserted[0]) return rowToLead(inserted[0]);

  // Chocó con otro guardado (mismo nombre + ciudad, o el mismo id en otra ciudad).
  const clash = (await sql`
    SELECT * FROM leads WHERE dedupe_key = ${key} OR id = ${rec.id}
    ORDER BY (id = ${rec.id}) DESC LIMIT 1
  `) as Row[];
  if (!clash[0]) throw new Error("No se pudo guardar el prospecto.");
  return mergeInto(sql, clash[0], rec, x);
}

export interface LinkResult {
  lead: Lead | null;
  matched: boolean;
  message?: string;
}

/**
 * "Vincular con DENUE": busca el negocio solo-Google en DENUE y, si aparece,
 * completa el prospecto con los datos de DENUE (abiertos, exportables).
 */
export async function linkLeadToDenue(id: string): Promise<LinkResult> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM leads WHERE id = ${id}`) as Row[];
  if (!rows[0]) return { lead: null, matched: false, message: "Prospecto no encontrado." };
  const lead = rowToLead(rows[0]);
  if (lead.denueId) return { lead, matched: true, message: "Ya está vinculado con DENUE." };
  if (!denueReady()) {
    return { lead, matched: false, message: "DENUE no está configurado (falta DENUE_TOKEN)." };
  }
  const m = await matchDenueSafe(lead, lead.city);
  if (!m) {
    return {
      lead,
      matched: false,
      message: hasCoords(lead)
        ? "No encontré este negocio en DENUE a menos de 250 m con un nombre parecido."
        : "No encontré este negocio en DENUE con ese nombre en su ciudad.",
    };
  }
  // Ese establecimiento ya está guardado como otro prospecto.
  const dup = (await sql`
    SELECT id, name FROM leads WHERE denue_id = ${m.e.id} AND id <> ${id} LIMIT 1
  `) as Row[];
  if (dup[0]) {
    return {
      lead,
      matched: false,
      message: `Ya está guardado desde DENUE como “${String(dup[0].name)}”. Quita este y trabaja ese.`,
    };
  }
  const up = await upgradeToDenue(sql, id, denueToBusiness(m.e, lead.category), placeIdOf(lead) ?? null);
  return { lead: up, matched: !!up, message: up ? `Vinculado con DENUE: ${m.e.name}.` : undefined };
}

export interface CleanupReport {
  dryRun: boolean;
  candidates: number; // prospectos de Google con datos que no se pueden guardar
  processed: number;
  linked: number; // emparejados con DENUE (datos sustituidos)
  stripped: number; // sin match: se borraron teléfono, dirección, web, rating y reseñas
  duplicates: number; // su match DENUE ya era otro prospecto (se limpian igual)
  coordsExpired: number; // coordenadas de Google de más de 30 días
  remaining: number; // pendientes por el límite de tiempo/lote (vuelve a llamar)
}

/**
 * Limpieza de prospectos guardados antes desde Google con contenido completo.
 * Para cada uno intenta DENUE; si no, quita los campos de Google no permitidos
 * (conserva place_id, nombre, correo, dueño, estatus y notas). dryRun = solo cuenta.
 */
export async function googleCleanup(
  opts: { dryRun?: boolean; limit?: number; budgetMs?: number } = {}
): Promise<CleanupReport> {
  await ensureSchema();
  const sql = getSql();
  const dryRun = opts.dryRun !== false;
  const limit = Math.max(1, Math.min(500, Math.floor(opts.limit ?? 100)));
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);

  const dirty = sql`
    denue_id IS NULL
    AND (source = 'google' OR (source IS NULL AND id LIKE 'place/%'))
    AND (phone IS NOT NULL OR website IS NOT NULL OR address IS NOT NULL
         OR rating IS NOT NULL OR review_count IS NOT NULL OR last_review IS NOT NULL
         OR place_id IS NULL
         OR (lat IS NOT NULL AND coords_expire_at IS NULL))
  `;
  const [{ n }] = (await sql`SELECT count(*)::int AS n FROM leads WHERE ${dirty}`) as {
    n: number;
  }[];
  const [{ n: expired }] = (await sql`
    SELECT count(*)::int AS n FROM leads
    WHERE lat IS NOT NULL
      AND (source = 'google' OR (source IS NULL AND id LIKE 'place/%')) AND denue_id IS NULL
      AND COALESCE(coords_expire_at, created_at + interval '30 days') < now()
  `) as { n: number }[];
  const rows = (await sql`
    SELECT * FROM leads WHERE ${dirty} ORDER BY created_at LIMIT ${limit}
  `) as Row[];

  const report: CleanupReport = {
    dryRun,
    candidates: n,
    processed: 0,
    linked: 0,
    stripped: 0,
    duplicates: 0,
    coordsExpired: expired,
    remaining: n,
  };

  // Hasta 3 a la vez y con presupuesto de tiempo (la función tiene tope de duración).
  const queue = [...rows];
  const worker = async () => {
    for (;;) {
      if (Date.now() > deadline) return;
      const r = queue.shift();
      if (!r) return;
      const lead = rowToLead(r);
      const m = await matchDenueSafe(lead, lead.city);
      let dup = false;
      if (m) {
        const d = (await sql`
          SELECT 1 FROM leads WHERE denue_id = ${m.e.id} AND id <> ${lead.id} LIMIT 1
        `) as Row[];
        dup = !!d[0];
      }
      if (m && !dup) {
        report.linked++;
        if (!dryRun) {
          await upgradeToDenue(sql, lead.id, denueToBusiness(m.e, lead.category), placeIdOf(lead) ?? null);
        }
      } else {
        if (dup) report.duplicates++;
        report.stripped++;
        if (!dryRun) await stripGoogle(sql, lead.id);
      }
      report.processed++;
    }
  };
  await Promise.all([worker(), worker(), worker()]);

  if (!dryRun) await purgeExpiredCoords();
  report.remaining = Math.max(0, n - report.processed);
  return report;
}

export interface LeadPatch {
  status?: LeadStatus;
  note?: string;
  email?: string;
  owner?: string | null; // reasignar (solo admin)
}

// Actualiza un prospecto. Si no es admin, solo aplica cuando el actor es el
// dueño o el prospecto no tiene dueño (candado atómico contra carreras).
// Devuelve null si no existe o si el candado no se cumplió.
export async function updateLead(
  id: string,
  patch: LeadPatch,
  opts: { actor?: string | null; admin?: boolean } = {}
): Promise<Lead | null> {
  await ensureSchema();
  const sql = getSql();
  const actor = opts.actor?.toLowerCase() ?? null;

  const sets = [sql`updated_at = now()`];
  if (patch.status !== undefined) {
    sets.push(sql`status = ${patch.status}`);
    if (patch.status === "contactado") {
      sets.push(sql`contacted_by = COALESCE(contacted_by, ${actor})`);
      sets.push(sql`contacted_at = COALESCE(contacted_at, now())`);
      // Quien lo contacta se queda con él si no tenía dueño (igual que al enviar correo).
      if (actor && patch.owner === undefined)
        sets.push(sql`owner_email = COALESCE(owner_email, ${actor})`);
    }
  }
  if (patch.note !== undefined) sets.push(sql`note = ${patch.note || null}`);
  if (patch.email !== undefined) {
    sets.push(sql`email = ${patch.email || null}`);
    sets.push(sql`checked_at = now()`); // datos de contacto revisados (score)
  }
  if (patch.owner !== undefined) sets.push(sql`owner_email = ${patch.owner || null}`);

  const setClause = sets.reduce((acc, s) => sql`${acc}, ${s}`);
  const guard =
    opts.admin || !actor
      ? sql`TRUE`
      : sql`(owner_email IS NULL OR owner_email = ${actor})`;

  const rows = (await sql`
    UPDATE leads SET ${setClause}
    WHERE id = ${id} AND ${guard}
    RETURNING *
  `) as Row[];
  return rows[0] ? syncScore(sql, rows[0]) : null;
}

// Varios prospectos por id (p. ej. para exportar con los datos de la BD).
export async function getLeadsByIds(ids: string[]): Promise<Lead[]> {
  if (!ids.length) return [];
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM leads WHERE id = ANY(${ids}::text[])`) as Row[];
  return rows.map(rowToLead);
}

// Tomar un prospecto sin dueño. null si ya lo tiene alguien (o no existe).
export async function claimLead(id: string, me: string): Promise<Lead | null> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    UPDATE leads SET owner_email = ${me.toLowerCase()}, updated_at = now()
    WHERE id = ${id} AND owner_email IS NULL
    RETURNING *
  `) as Row[];
  return rows[0] ? rowToLead(rows[0]) : null;
}

// Bitácora: quién hizo qué sobre qué prospecto.
export async function logLeadEvent(
  type: string,
  e: { leadId?: string; actor?: string | null; target?: string | null; meta?: unknown }
): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  await sql`
    INSERT INTO events (type, lead_id, actor_email, target_email, meta)
    VALUES (
      ${type}, ${e.leadId ?? null}, ${e.actor ?? null}, ${e.target ?? null},
      ${e.meta === undefined ? null : JSON.stringify(e.meta)}::jsonb
    )
  `;
}

export async function removeLead(id: string): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM leads WHERE id = ${id}`;
}

export async function clearLeads(): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM leads`;
}

export interface OwnerStat {
  email: string;
  name: string;
  owned: number; // prospectos que trabaja
  contacted: number; // prospectos que contactó
}

export interface Stats {
  total: number;
  withEmail: number;
  withPhone: number;
  avgScore: number;
  unassigned: number;
  byStatus: { key: string; count: number }[];
  byCategory: { key: string; count: number }[];
  byCity: { key: string; count: number }[];
  byScore: { score: number; count: number }[];
  byOwner: OwnerStat[];
}

export async function getStats(): Promise<Stats> {
  await ensureSchema();
  const sql = getSql();
  const num = (v: unknown) => (v == null ? 0 : Number(v));

  const totals = (await sql`
    SELECT
      count(*) AS total,
      count(*) FILTER (WHERE email IS NOT NULL AND email <> '') AS with_email,
      count(*) FILTER (WHERE phone IS NOT NULL AND phone <> '') AS with_phone,
      count(*) FILTER (WHERE owner_email IS NULL) AS unassigned,
      COALESCE(ROUND(AVG(score)::numeric, 1), 0) AS avg_score
    FROM leads
  `) as Row[];
  const t = totals[0] || {};

  const byStatus = (await sql`
    SELECT status AS key, count(*) AS count FROM leads GROUP BY status
  `) as Row[];
  const byCategory = (await sql`
    SELECT COALESCE(category, 'Sin giro') AS key, count(*) AS count
    FROM leads GROUP BY category ORDER BY count DESC
  `) as Row[];
  const byCity = (await sql`
    SELECT city AS key, count(*) AS count
    FROM leads WHERE city IS NOT NULL AND city <> ''
    GROUP BY city ORDER BY count DESC LIMIT 8
  `) as Row[];
  const byScore = (await sql`
    SELECT score, count(*) AS count
    FROM leads WHERE score IS NOT NULL GROUP BY score ORDER BY score
  `) as Row[];
  // Por vendedor: cuántos trabaja y cuántos contactó.
  const byOwner = (await sql`
    WITH o AS (
      SELECT owner_email AS email, count(*) AS owned
      FROM leads WHERE owner_email IS NOT NULL GROUP BY owner_email
    ), c AS (
      SELECT contacted_by AS email, count(*) AS contacted
      FROM leads WHERE contacted_by IS NOT NULL GROUP BY contacted_by
    )
    SELECT COALESCE(o.email, c.email) AS email,
      COALESCE(o.owned, 0) AS owned,
      COALESCE(c.contacted, 0) AS contacted
    FROM o FULL OUTER JOIN c ON o.email = c.email
    ORDER BY owned DESC, contacted DESC
    LIMIT 20
  `) as Row[];

  return {
    total: num(t.total),
    withEmail: num(t.with_email),
    withPhone: num(t.with_phone),
    avgScore: num(t.avg_score),
    unassigned: num(t.unassigned),
    byStatus: byStatus.map((r) => ({ key: String(r.key), count: num(r.count) })),
    byCategory: byCategory.map((r) => ({ key: String(r.key), count: num(r.count) })),
    byCity: byCity.map((r) => ({ key: String(r.key), count: num(r.count) })),
    byScore: byScore.map((r) => ({ score: num(r.score), count: num(r.count) })),
    byOwner: byOwner.map((r) => ({
      email: String(r.email),
      name: displayName(String(r.email)),
      owned: num(r.owned),
      contacted: num(r.contacted),
    })),
  };
}

// Prospectos guardados que coinciden con resultados de búsqueda, por
// dedupe_key, id, place_id ("place/…") o CLEE ("denue/…") (para marcar
// "Guardado · Aldo" / "Contactado por..." aunque el nombre guardado sea el de DENUE).
export async function findMatches(keys: string[], ids: string[] = []): Promise<LeadMatch[]> {
  if (!keys.length && !ids.length) return [];
  await ensureSchema();
  const sql = getSql();
  const placeIds = ids.filter((i) => i.startsWith("place/")).map((i) => i.slice(6));
  const denueIds = ids.filter((i) => i.startsWith("denue/")).map((i) => i.slice(6));
  const rows = (await sql`
    SELECT id, dedupe_key, owner_email, status, contacted_by, contacted_at, place_id, denue_id
    FROM leads
    WHERE dedupe_key = ANY(${keys}::text[]) OR id = ANY(${ids}::text[])
       OR place_id = ANY(${placeIds}::text[]) OR denue_id = ANY(${denueIds}::text[])
  `) as Row[];
  return rows.map((r) => ({
    key: String(r.dedupe_key),
    id: String(r.id),
    ownerEmail: (r.owner_email as string) ?? null,
    status: ((r.status as LeadStatus) ?? "nuevo") as LeadStatus,
    contactedBy: (r.contacted_by as string) ?? null,
    contactedAt: iso(r.contacted_at) ?? null,
    placeId: (r.place_id as string) ?? null,
    denueId: (r.denue_id as string) ?? null,
  }));
}
