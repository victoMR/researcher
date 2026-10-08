import { getSql, ensureSchema } from "./db";
import { displayName } from "./session";

// Bitácora de contacto (quién escribió a quién) y lista de BAJAS.

type Row = Record<string, unknown>;

export type OutreachType =
  | "email_sent"
  | "whatsapp_opened"
  | "suppressed"
  | "status_changed";

// Un contacto previo, tal como lo ve la UI.
export interface OutreachEvent {
  type: string;
  actor: string | null;
  actorName: string | null;
  at: string; // ISO
  subject?: string;
}

export interface Suppression {
  email: string;
  reason?: string;
  createdAt?: string; // ISO
  createdBy?: string;
}

// Correos siempre en minúsculas y sin espacios para comparar.
export function normEmail(email: string | null | undefined): string {
  return (email ?? "").trim().toLowerCase();
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

function toEvent(r: Row): OutreachEvent {
  const actor = (r.actor_email as string) ?? null;
  return {
    type: String(r.type),
    actor,
    actorName: actor ? displayName(actor) : null,
    at: iso(r.created_at) ?? new Date().toISOString(),
    ...(r.subject ? { subject: String(r.subject) } : {}),
  };
}

// --- Bajas ---

export async function getSuppression(email: string): Promise<Suppression | null> {
  const e = normEmail(email);
  if (!e) return null;
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT email, reason, created_at, created_by FROM suppression WHERE email = ${e}
  `) as Row[];
  if (!rows.length) return null;
  const r = rows[0];
  return {
    email: String(r.email),
    reason: (r.reason as string) ?? undefined,
    createdAt: iso(r.created_at),
    createdBy: (r.created_by as string) ?? undefined,
  };
}

// Registra la baja (si ya existía se conserva la original), descarta los
// prospectos con ese correo y lo deja en la bitácora.
export async function addSuppression(
  email: string,
  reason: string | null,
  by: string | null
): Promise<void> {
  const e = normEmail(email);
  if (!e) return;
  await ensureSchema();
  const sql = getSql();
  await sql`
    INSERT INTO suppression (email, reason, created_by)
    VALUES (${e}, ${reason}, ${by})
    ON CONFLICT (email) DO NOTHING
  `;
  const leads = (await sql`
    UPDATE leads SET status = 'descartado', updated_at = now()
    WHERE lower(email) = ${e}
    RETURNING id
  `) as Row[];
  const meta = { reason };
  if (!leads.length) {
    await logEvent({ type: "suppressed", actor: by, target: e, meta });
    return;
  }
  for (const l of leads) {
    await logEvent({ type: "suppressed", actor: by, target: e, leadId: String(l.id), meta });
  }
}

export async function removeSuppression(email: string): Promise<void> {
  const e = normEmail(email);
  if (!e) return;
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM suppression WHERE email = ${e}`;
}

// --- Bitácora ---

export async function logEvent(input: {
  type: OutreachType;
  actor: string | null;
  target?: string | null;
  leadId?: string | null;
  meta?: Record<string, unknown>;
}): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  const target = input.target ? normEmail(input.target) : null;
  await sql`
    INSERT INTO events (type, actor_email, target_email, lead_id, meta)
    VALUES (
      ${input.type}, ${input.actor}, ${target}, ${input.leadId ?? null},
      ${JSON.stringify(input.meta ?? {})}::jsonb
    )
  `;
}

// Historial de contacto de un correo y/o prospecto (más recientes primero).
export async function recentOutreach(
  email: string | null,
  leadId: string | null,
  limit = 20
): Promise<OutreachEvent[]> {
  const e = email ? normEmail(email) : null;
  if (!e && !leadId) return [];
  await ensureSchema();
  const sql = getSql();
  // `= NULL` nunca es verdadero, así que el criterio que falte no estorba.
  const rows = (await sql`
    SELECT type, actor_email, created_at, meta->>'subject' AS subject
    FROM events
    WHERE target_email = ${e} OR lead_id = ${leadId}
    ORDER BY created_at DESC
    LIMIT ${limit}
  `) as Row[];
  return rows.map(toEvent);
}

// Correos ya enviados a esa dirección en los últimos `days` días.
export async function recentEmailsSent(email: string, days = 30): Promise<OutreachEvent[]> {
  const e = normEmail(email);
  if (!e) return [];
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT type, actor_email, created_at, meta->>'subject' AS subject
    FROM events
    WHERE type = 'email_sent'
      AND target_email = ${e}
      AND created_at > now() - (${days}::int * interval '1 day')
    ORDER BY created_at DESC
    LIMIT 20
  `) as Row[];
  return rows.map(toEvent);
}

// --- Prospectos ---

export async function leadExists(id: string): Promise<boolean> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT 1 FROM leads WHERE id = ${id}`) as Row[];
  return rows.length > 0;
}

// Tras escribirle: pasa a "contactado" (si seguía "nuevo"), anota quién y
// cuándo, y si no tenía dueño se le asigna al vendedor.
export async function markContacted(id: string, actor: string | null): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  await sql`
    UPDATE leads SET
      status       = CASE WHEN status = 'nuevo' THEN 'contactado' ELSE status END,
      contacted_by = COALESCE(${actor}, contacted_by),
      contacted_at = now(),
      owner_email  = COALESCE(owner_email, ${actor}),
      updated_at   = now()
    WHERE id = ${id}
  `;
}
