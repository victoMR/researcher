import { getSql, ensureSchema } from "./db";

export type Channel = "email" | "whatsapp" | "ambos";

export interface Template {
  id: string;
  name: string;
  channel: Channel;
  subject?: string;
  body: string;
  version: number;
  updatedAt: number;
}

export interface TemplateVersion {
  version: number;
  name: string;
  channel: Channel;
  subject?: string;
  body: string;
  note?: string;
  createdAt: number;
}

type Row = Record<string, unknown>;

function toTemplate(r: Row): Template {
  return {
    id: String(r.id),
    name: String(r.name),
    channel: (r.channel as Channel) ?? "ambos",
    subject: (r.subject as string) ?? undefined,
    body: String(r.body),
    version: Number(r.version ?? 1),
    updatedAt: r.updated_at ? new Date(r.updated_at as string).getTime() : Date.now(),
  };
}

export async function listTemplates(): Promise<Template[]> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM templates ORDER BY updated_at DESC`) as Row[];
  return rows.map(toTemplate);
}

export async function createTemplate(data: {
  name: string;
  channel: Channel;
  subject?: string;
  body: string;
}): Promise<Template> {
  await ensureSchema();
  const sql = getSql();
  const id = crypto.randomUUID();
  const rows = (await sql`
    INSERT INTO templates (id, name, channel, subject, body, version)
    VALUES (${id}, ${data.name}, ${data.channel}, ${data.subject ?? null}, ${data.body}, 1)
    RETURNING *
  `) as Row[];
  await sql`
    INSERT INTO template_versions (template_id, version, name, channel, subject, body, note)
    VALUES (${id}, 1, ${data.name}, ${data.channel}, ${data.subject ?? null}, ${data.body}, 'Versión inicial')
  `;
  return toTemplate(rows[0]);
}

export async function updateTemplate(
  id: string,
  data: { name: string; channel: Channel; subject?: string; body: string; note?: string }
): Promise<Template> {
  await ensureSchema();
  const sql = getSql();
  const cur = (await sql`SELECT version FROM templates WHERE id = ${id}`) as Row[];
  if (!cur.length) throw new Error("Plantilla no encontrada");
  const nextVersion = Number(cur[0].version) + 1;
  const rows = (await sql`
    UPDATE templates
    SET name = ${data.name}, channel = ${data.channel}, subject = ${data.subject ?? null},
        body = ${data.body}, version = ${nextVersion}, updated_at = now()
    WHERE id = ${id}
    RETURNING *
  `) as Row[];
  await sql`
    INSERT INTO template_versions (template_id, version, name, channel, subject, body, note)
    VALUES (${id}, ${nextVersion}, ${data.name}, ${data.channel}, ${data.subject ?? null}, ${data.body}, ${data.note ?? null})
  `;
  return toTemplate(rows[0]);
}

export async function deleteTemplate(id: string): Promise<void> {
  await ensureSchema();
  const sql = getSql();
  await sql`DELETE FROM templates WHERE id = ${id}`;
}

export async function getHistory(id: string): Promise<TemplateVersion[]> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT * FROM template_versions WHERE template_id = ${id} ORDER BY version DESC
  `) as Row[];
  return rows.map((r) => ({
    version: Number(r.version),
    name: String(r.name),
    channel: (r.channel as Channel) ?? "ambos",
    subject: (r.subject as string) ?? undefined,
    body: String(r.body),
    note: (r.note as string) ?? undefined,
    createdAt: r.created_at ? new Date(r.created_at as string).getTime() : Date.now(),
  }));
}

// Changelog en Markdown, legible para el usuario y usable por GHL.
export async function historyMarkdown(id: string): Promise<string> {
  const sql = getSql();
  const t = (await sql`SELECT name FROM templates WHERE id = ${id}`) as Row[];
  const name = t.length ? String(t[0].name) : "Plantilla";
  const versions = await getHistory(id);
  const CH: Record<string, string> = { email: "Correo", whatsapp: "WhatsApp", ambos: "Correo + WhatsApp" };
  let md = `# Historial — ${name}\n\n`;
  for (const v of versions) {
    const date = new Date(v.createdAt).toISOString().slice(0, 16).replace("T", " ");
    md += `## v${v.version} — ${date}\n`;
    md += `- **Canal:** ${CH[v.channel] ?? v.channel}\n`;
    if (v.subject) md += `- **Asunto:** ${v.subject}\n`;
    if (v.note) md += `- **Cambio:** ${v.note}\n`;
    md += `\n${v.body}\n\n---\n\n`;
  }
  return md.trim();
}
