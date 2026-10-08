import { getSql, ensureSchema } from "./db";
import { dedupeKey } from "./dedupe";
import { displayName } from "./session";
import { LEAD_STATUSES } from "./types";
import type { Business, Lead, LeadMatch, LeadStatus, LeadsPage, OwnerFilter } from "./types";

type Row = Record<string, unknown>;
type Sql = ReturnType<typeof getSql>;

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

function rowToLead(r: Row): Lead {
  return {
    id: String(r.id),
    name: String(r.name),
    category: (r.category as string) ?? "",
    city: (r.city as string) ?? undefined,
    phone: (r.phone as string) ?? undefined,
    website: (r.website as string) ?? undefined,
    email: (r.email as string) ?? undefined,
    address: (r.address as string) ?? undefined,
    lat: Number(r.lat),
    lon: Number(r.lon),
    rating: r.rating != null ? Number(r.rating) : undefined,
    reviewCount: r.review_count != null ? Number(r.review_count) : undefined,
    lastReviewTime: iso(r.last_review),
    score: r.score != null ? Number(r.score) : undefined,
    status: (r.status as LeadStatus) ?? "nuevo",
    note: (r.note as string) ?? undefined,
    savedAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
    ownerEmail: (r.owner_email as string) ?? undefined,
    contactedBy: (r.contacted_by as string) ?? undefined,
    contactedAt: iso(r.contacted_at),
  };
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

// Guarda (o fusiona) un prospecto. ownerEmail = vendedor que lo guarda; si ya
// existía, NO se pisa el dueño que tenía.
export async function saveLead(
  b: Business,
  city?: string,
  ownerEmail?: string | null
): Promise<Lead> {
  await ensureSchema();
  const sql = getSql();
  const key = dedupeKey(b.name, city);
  const owner = ownerEmail ? ownerEmail.toLowerCase() : null;
  const lastReview = b.lastReviewTime ? new Date(b.lastReviewTime) : null;
  // Origen del dato: Google Places ("place/...") u OpenStreetMap.
  const source = b.id.startsWith("place/") ? "google" : "osm";
  try {
    const rows = (await sql`
      INSERT INTO leads (
        id, dedupe_key, name, category, city, phone, website, email, address,
        lat, lon, rating, review_count, last_review, score, source, status, owner_email
      ) VALUES (
        ${b.id}, ${key}, ${b.name}, ${b.category}, ${city || null}, ${b.phone || null},
        ${b.website || null}, ${b.email || null}, ${b.address || null},
        ${b.lat}, ${b.lon}, ${b.rating ?? null}, ${b.reviewCount ?? null},
        ${lastReview}, ${b.score ?? null}, ${source}, 'nuevo', ${owner}
      )
      ON CONFLICT (dedupe_key) DO UPDATE SET
        email  = COALESCE(EXCLUDED.email, leads.email),
        phone  = COALESCE(EXCLUDED.phone, leads.phone),
        website = COALESCE(EXCLUDED.website, leads.website),
        rating = COALESCE(EXCLUDED.rating, leads.rating),
        review_count = COALESCE(EXCLUDED.review_count, leads.review_count),
        last_review  = COALESCE(EXCLUDED.last_review, leads.last_review),
        score  = COALESCE(EXCLUDED.score, leads.score),
        owner_email = COALESCE(leads.owner_email, EXCLUDED.owner_email),
        updated_at = now()
      RETURNING *
    `) as Row[];
    return rowToLead(rows[0]);
  } catch (e) {
    // Mismo negocio (mismo id) guardado antes con otra ciudad: choca la llave
    // primaria, así que fusionamos sobre ese registro.
    if ((e as { code?: string }).code !== "23505") throw e;
    const rows = (await sql`
      UPDATE leads SET
        email  = COALESCE(${b.email || null}, email),
        phone  = COALESCE(${b.phone || null}, phone),
        website = COALESCE(${b.website || null}, website),
        owner_email = COALESCE(owner_email, ${owner}),
        updated_at = now()
      WHERE id = ${b.id}
      RETURNING *
    `) as Row[];
    if (!rows[0]) throw e;
    return rowToLead(rows[0]);
  }
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
  if (patch.email !== undefined) sets.push(sql`email = ${patch.email || null}`);
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
  return rows[0] ? rowToLead(rows[0]) : null;
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
// dedupe_key o por id (para marcar "Guardado · Aldo" / "Contactado por...").
export async function findMatches(keys: string[], ids: string[] = []): Promise<LeadMatch[]> {
  if (!keys.length && !ids.length) return [];
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT id, dedupe_key, owner_email, status, contacted_by, contacted_at
    FROM leads
    WHERE dedupe_key = ANY(${keys}::text[]) OR id = ANY(${ids}::text[])
  `) as Row[];
  return rows.map((r) => ({
    key: String(r.dedupe_key),
    id: String(r.id),
    ownerEmail: (r.owner_email as string) ?? null,
    status: ((r.status as LeadStatus) ?? "nuevo") as LeadStatus,
    contactedBy: (r.contacted_by as string) ?? null,
    contactedAt: iso(r.contacted_at) ?? null,
  }));
}
