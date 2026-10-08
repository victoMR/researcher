// ¿Ya lo trabajamos? Busca negocios en Prospectos (leads), bajas (suppression)
// y correos enviados (events) para no pisarnos entre vendedores.
import { ensureSchema, getSql, hasDb } from "../db";
import { phoneKey } from "../email-extract";
import type { ResearchProspect } from "../research-types";
import { leadIdFor } from "../research-repo";
import { distanceM, normText } from "./normalize";

type Row = Record<string, unknown>;

export interface ExistingQuery {
  key: string; // identificador de quien pregunta (id del prospecto, índice...)
  name?: string;
  emails?: string[];
  phones?: string[];
  leadIds?: string[]; // ids posibles en leads ("node/1", "denue/x", "place/y", "web/z")
  denueId?: string;
  placeId?: string;
  lat?: number;
  lon?: number;
  city?: string;
  allowNameOnly?: boolean; // true = basta el nombre (consulta del modelo)
}

export interface ExistingMatch {
  leadId?: string;
  leadName?: string;
  leadCity?: string;
  ownerEmail?: string;
  status?: string;
  contactedBy?: string;
  contactedAt?: string;
  suppressed?: boolean;
  lastEmailAt?: string;
  lastEmailBy?: string;
  matchedBy?: "id" | "correo" | "teléfono" | "nombre";
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

// Clave de nombre igual a la primera parte de leads.dedupe_key (ver dedupe.ts).
function nameKey(name: string): string {
  return normText(name);
}

/** Devuelve, por `key`, lo que ya sabemos de cada negocio. Sin BD -> vacío. */
export async function lookupExisting(qs: ExistingQuery[]): Promise<Map<string, ExistingMatch>> {
  const out = new Map<string, ExistingMatch>();
  if (!hasDb() || !qs.length) return out;
  await ensureSchema();
  const sql = getSql();

  const ids = new Set<string>();
  const denueIds = new Set<string>();
  const placeIds = new Set<string>();
  const emails = new Set<string>();
  const phones = new Set<string>();
  const names = new Set<string>();
  for (const q of qs) {
    q.leadIds?.forEach((i) => i && ids.add(i));
    if (q.denueId) denueIds.add(q.denueId);
    if (q.placeId) placeIds.add(q.placeId);
    q.emails?.forEach((e) => e && emails.add(e.toLowerCase()));
    q.phones?.forEach((p) => {
      const k = phoneKey(p);
      if (k.length === 10) phones.add(k);
    });
    if (q.name) {
      const k = nameKey(q.name);
      if (k.length >= 3) names.add(k);
    }
  }

  const [leads, supp, sent] = (await Promise.all([
    sql`
      SELECT id, name, city, email, phone, owner_email, status, contacted_by, contacted_at,
             denue_id, place_id, split_part(dedupe_key, '|', 1) AS name_key, lat, lon
      FROM leads
      WHERE id = ANY(${[...ids]}::text[])
         OR denue_id = ANY(${[...denueIds]}::text[])
         OR place_id = ANY(${[...placeIds]}::text[])
         OR lower(email) = ANY(${[...emails]}::text[])
         OR right(regexp_replace(COALESCE(phone, ''), '[^0-9]', '', 'g'), 10) = ANY(${[...phones]}::text[])
         OR split_part(dedupe_key, '|', 1) = ANY(${[...names]}::text[])
      LIMIT 500
    `,
    emails.size
      ? sql`SELECT email FROM suppression WHERE email = ANY(${[...emails]}::text[])`
      : Promise.resolve([]),
    emails.size
      ? sql`
          SELECT DISTINCT ON (target_email) target_email, actor_email, created_at
          FROM events
          WHERE type = 'email_sent' AND target_email = ANY(${[...emails]}::text[])
          ORDER BY target_email, created_at DESC
        `
      : Promise.resolve([]),
  ])) as [Row[], Row[], Row[]];

  const suppressed = new Set(supp.map((r) => String(r.email)));
  const lastSent = new Map(sent.map((r) => [String(r.target_email), r]));

  for (const q of qs) {
    const qEmails = (q.emails ?? []).map((e) => e.toLowerCase());
    const qPhones = (q.phones ?? []).map(phoneKey).filter((k) => k.length === 10);
    const qName = q.name ? nameKey(q.name) : "";
    const qCity = q.city ? normText(q.city) : "";

    let best: { row: Row; by: ExistingMatch["matchedBy"] } | null = null;
    for (const r of leads) {
      let by: ExistingMatch["matchedBy"] | null = null;
      if (
        (q.leadIds ?? []).includes(String(r.id)) ||
        (q.denueId && r.denue_id === q.denueId) ||
        (q.placeId && r.place_id === q.placeId)
      ) {
        by = "id";
      } else if (r.email && qEmails.includes(String(r.email).toLowerCase())) {
        by = "correo";
      } else if (r.phone && qPhones.includes(phoneKey(String(r.phone)))) {
        by = "teléfono";
      } else if (qName && r.name_key === qName) {
        // Solo nombre: exige misma ciudad o cercanía (salvo consulta explícita).
        const leadCity = r.city ? normText(String(r.city)).split(" ") : [];
        const sameCity =
          !!qCity && qCity.split(" ").some((t) => t.length >= 4 && leadCity.includes(t));
        const near =
          distanceM({ lat: q.lat, lon: q.lon }, { lat: Number(r.lat), lon: Number(r.lon) }) < 300;
        if (q.allowNameOnly || sameCity || near) by = "nombre";
      }
      if (by && (!best || rank(by) > rank(best.by))) best = { row: r, by };
    }

    const m: ExistingMatch = {};
    if (best) {
      const r = best.row;
      m.leadId = String(r.id);
      m.leadName = String(r.name);
      m.leadCity = (r.city as string) || undefined;
      m.ownerEmail = (r.owner_email as string) || undefined;
      m.status = (r.status as string) || undefined;
      m.contactedBy = (r.contacted_by as string) || undefined;
      m.contactedAt = iso(r.contacted_at);
      m.matchedBy = best.by;
      if (r.email) qEmails.push(String(r.email).toLowerCase());
    }
    if (qEmails.some((e) => suppressed.has(e))) m.suppressed = true;
    const sentRow = qEmails.map((e) => lastSent.get(e)).find(Boolean);
    if (sentRow) {
      m.lastEmailAt = iso(sentRow.created_at);
      m.lastEmailBy = (sentRow.actor_email as string) || undefined;
    }
    if (Object.keys(m).length) out.set(q.key, m);
  }
  return out;
}

function rank(by: ExistingMatch["matchedBy"]): number {
  return by === "id" ? 4 : by === "correo" ? 3 : by === "teléfono" ? 2 : 1;
}

/**
 * Marca en cada prospecto (campo `existing`) si ya es prospecto de algún
 * vendedor, si ya lo contactaron y si pidió BAJA (datos reales de la BD).
 * Lo usan el agente interno y guardar_investigacion del servidor MCP.
 */
export async function attachExisting(prospects: ResearchProspect[], zone?: string): Promise<void> {
  const found = await lookupExisting(
    prospects.map((p) => ({
      key: p.id,
      name: p.name,
      emails: [p.emailIsGuess ? undefined : p.email, ...(p.emails ?? [])].filter((e): e is string => !!e),
      phones: [p.phone, p.whatsapp].filter((x): x is string => !!x),
      leadIds: [leadIdFor(p)],
      denueId: p.denueId,
      placeId: p.placeId,
      lat: p.lat,
      lon: p.lon,
      city: zone,
    }))
  );
  for (const p of prospects) {
    const m = found.get(p.id);
    if (!m) continue;
    const existing = {
      leadId: m.leadId,
      ownerEmail: m.ownerEmail,
      status: m.status,
      contactedBy: m.contactedBy ?? m.lastEmailBy,
      contactedAt: m.contactedAt ?? m.lastEmailAt,
      suppressed: m.suppressed,
    };
    p.existing = Object.fromEntries(Object.entries(existing).filter(([, v]) => v !== undefined));
  }
}
