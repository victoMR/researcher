import { getSql, ensureSchema } from "./db";
import { dedupeKey } from "./dedupe";
import type { Business, Lead, LeadStatus } from "./types";

type Row = Record<string, unknown>;

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
    lastReviewTime: r.last_review ? new Date(r.last_review as string).toISOString() : undefined,
    score: r.score != null ? Number(r.score) : undefined,
    status: (r.status as LeadStatus) ?? "nuevo",
    note: (r.note as string) ?? undefined,
    savedAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
  };
}

export async function listLeads(): Promise<Lead[]> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM leads ORDER BY created_at DESC`) as Row[];
  return rows.map(rowToLead);
}

export async function saveLead(b: Business, city?: string): Promise<Lead> {
  await ensureSchema();
  const sql = getSql();
  const key = dedupeKey(b.name, city);
  const lastReview = b.lastReviewTime ? new Date(b.lastReviewTime) : null;
  const rows = (await sql`
    INSERT INTO leads (
      id, dedupe_key, name, category, city, phone, website, email, address,
      lat, lon, rating, review_count, last_review, score, source, status
    ) VALUES (
      ${b.id}, ${key}, ${b.name}, ${b.category}, ${city ?? null}, ${b.phone ?? null},
      ${b.website ?? null}, ${b.email ?? null}, ${b.address ?? null},
      ${b.lat}, ${b.lon}, ${b.rating ?? null}, ${b.reviewCount ?? null},
      ${lastReview}, ${b.score ?? null}, ${b.status ?? null}, 'nuevo'
    )
    ON CONFLICT (dedupe_key) DO UPDATE SET
      email  = COALESCE(EXCLUDED.email, leads.email),
      phone  = COALESCE(EXCLUDED.phone, leads.phone),
      website = COALESCE(EXCLUDED.website, leads.website),
      rating = COALESCE(EXCLUDED.rating, leads.rating),
      review_count = COALESCE(EXCLUDED.review_count, leads.review_count),
      last_review  = COALESCE(EXCLUDED.last_review, leads.last_review),
      score  = COALESCE(EXCLUDED.score, leads.score)
    RETURNING *
  `) as Row[];
  return rowToLead(rows[0]);
}

export async function updateLead(
  id: string,
  patch: { status?: LeadStatus; note?: string; email?: string }
): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  if (patch.status !== undefined)
    await sql`UPDATE leads SET status = ${patch.status} WHERE id = ${id}`;
  if (patch.note !== undefined)
    await sql`UPDATE leads SET note = ${patch.note} WHERE id = ${id}`;
  if (patch.email !== undefined)
    await sql`UPDATE leads SET email = ${patch.email} WHERE id = ${id}`;
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

export interface Stats {
  total: number;
  withEmail: number;
  withPhone: number;
  avgScore: number;
  byStatus: { key: string; count: number }[];
  byCategory: { key: string; count: number }[];
  byCity: { key: string; count: number }[];
  byScore: { score: number; count: number }[];
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

  return {
    total: num(t.total),
    withEmail: num(t.with_email),
    withPhone: num(t.with_phone),
    avgScore: num(t.avg_score),
    byStatus: byStatus.map((r) => ({ key: String(r.key), count: num(r.count) })),
    byCategory: byCategory.map((r) => ({ key: String(r.key), count: num(r.count) })),
    byCity: byCity.map((r) => ({ key: String(r.key), count: num(r.count) })),
    byScore: byScore.map((r) => ({ score: num(r.score), count: num(r.count) })),
  };
}

// Devuelve las dedupe_keys que YA existen (para marcar resultados repetidos).
export async function existingKeys(keys: string[]): Promise<string[]> {
  if (!keys.length) return [];
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT dedupe_key FROM leads WHERE dedupe_key = ANY(${keys})
  `) as Row[];
  return rows.map((r) => String(r.dedupe_key));
}
