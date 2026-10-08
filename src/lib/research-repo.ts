// Investigaciones con IA (tabla research_runs) y las acciones que dispara el
// vendedor desde la UI: CSV, "Enviar a GHL" y "Guardar en Prospectos".
// Las acciones con efectos viven aquí (NO en las herramientas del agente) para
// reutilizarlas desde las rutas y, más adelante, desde el servidor MCP.
// Regla de datos: nada de Google sale en CSV/GHL/Prospectos (solo place_id).
import { randomUUID } from "node:crypto";
import { ensureSchema, getSql } from "./db";
import { mxDay } from "./api-usage";
import { normalizePhoneMx } from "./email-extract";
import { addContactNote, contactIdFrom, ghlReady, upsertContactDetailed } from "./ghl";
import { saveLead } from "./leads-repo";
import { displayName } from "./session";
import { sourceLabel } from "./agent/postprocess";
import type { Business } from "./types";
import type {
  ResearchParams,
  ResearchProgress,
  ResearchProspect,
  ResearchRun,
  ResearchRunListItem,
  ResearchStatus,
  ResearchSummary,
} from "./research-types";

type Row = Record<string, unknown>;

export const STALE_MINUTES = 15;
export const STALE_MESSAGE = "La investigación se interrumpió.";
const MAX_PROGRESS = 300;

// Error con mensaje para el usuario + status HTTP.
export class ResearchActionError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : undefined);

function rowToRun(r: Row): ResearchRun {
  return {
    id: String(r.id),
    prompt: String(r.prompt),
    status: (r.status as ResearchStatus) ?? "running",
    ...(r.params ? { params: r.params as ResearchParams } : {}),
    progress: Array.isArray(r.progress) ? (r.progress as ResearchProgress[]) : [],
    ...(Array.isArray(r.results) ? { results: r.results as ResearchProspect[] } : {}),
    ...(r.summary ? { summary: r.summary as ResearchSummary } : {}),
    ...(r.error ? { error: String(r.error) } : {}),
    createdBy: (r.created_by as string) ?? null,
    createdAt: iso(r.created_at) ?? new Date().toISOString(),
    ...(r.finished_at ? { finishedAt: iso(r.finished_at) } : {}),
  };
}

// Marca como error las que siguen "running" tras 15 min (la función murió).
async function markStale(): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE research_runs
    SET status = 'error', error = ${STALE_MESSAGE}, finished_at = now()
    WHERE status = 'running' AND created_at < now() - (${STALE_MINUTES}::int * interval '1 minute')
  `;
}

// ---------- CRUD ----------

export async function createRun(prompt: string, createdBy: string | null): Promise<string> {
  await ensureSchema();
  const sql = getSql();
  const id = randomUUID();
  const first: ResearchProgress[] = [
    { at: new Date().toISOString(), kind: "info", message: "Investigación en cola…" },
  ];
  await sql`
    INSERT INTO research_runs (id, created_by, prompt, status, progress)
    VALUES (${id}, ${createdBy}, ${prompt}, 'running', ${JSON.stringify(first)}::jsonb)
  `;
  return id;
}

export async function getRun(id: string): Promise<ResearchRun | null> {
  await ensureSchema();
  await markStale();
  const sql = getSql();
  const rows = (await sql`SELECT * FROM research_runs WHERE id = ${id}`) as Row[];
  return rows[0] ? rowToRun(rows[0]) : null;
}

export async function listRuns(o: { scope: "mine" | "all"; me: string | null }): Promise<ResearchRunListItem[]> {
  await ensureSchema();
  await markStale();
  const sql = getSql();
  const filter = o.scope === "all" ? sql`TRUE` : o.me ? sql`created_by = ${o.me}` : sql`FALSE`;
  const rows = (await sql`
    SELECT id, prompt, status, created_by, created_at,
           summary->>'title' AS title,
           CASE WHEN jsonb_typeof(results) = 'array' THEN jsonb_array_length(results) END AS count
    FROM research_runs
    WHERE ${filter}
    ORDER BY created_at DESC
    LIMIT 30
  `) as Row[];
  return rows.map((r) => ({
    id: String(r.id),
    prompt: String(r.prompt),
    ...(r.title ? { title: String(r.title) } : {}),
    status: (r.status as ResearchStatus) ?? "running",
    ...(r.count != null ? { count: Number(r.count) } : {}),
    createdBy: (r.created_by as string) ?? null,
    createdAt: iso(r.created_at) ?? new Date().toISOString(),
  }));
}

// ¿Este vendedor ya tiene una investigación corriendo (reciente)?
export async function hasRunningRun(me: string): Promise<boolean> {
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    SELECT 1 FROM research_runs
    WHERE created_by = ${me} AND status = 'running' AND created_at > now() - interval '6 minutes'
    LIMIT 1
  `) as Row[];
  return rows.length > 0;
}

export async function finishRun(
  id: string,
  data: { params: ResearchParams; results: ResearchProspect[]; summary: ResearchSummary; progress: ResearchProgress[] }
): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE research_runs SET
      status = 'done',
      params = ${JSON.stringify(data.params)}::jsonb,
      results = ${JSON.stringify(data.results)}::jsonb,
      summary = ${JSON.stringify(data.summary)}::jsonb,
      progress = ${JSON.stringify(data.progress.slice(-MAX_PROGRESS))}::jsonb,
      error = NULL,
      finished_at = now()
    WHERE id = ${id}
  `;
}

export async function failRun(
  id: string,
  error: string,
  progress: ResearchProgress[],
  params?: ResearchParams
): Promise<void> {
  const sql = getSql();
  await sql`
    UPDATE research_runs SET
      status = 'error',
      error = ${error.slice(0, 500)},
      progress = ${JSON.stringify(progress.slice(-MAX_PROGRESS))}::jsonb,
      params = COALESCE(${params ? JSON.stringify(params) : null}::jsonb, params),
      finished_at = now()
    WHERE id = ${id}
  `;
}

async function saveRunResults(id: string, results: ResearchProspect[]): Promise<void> {
  const sql = getSql();
  await sql`UPDATE research_runs SET results = ${JSON.stringify(results)}::jsonb WHERE id = ${id}`;
}

// Bitácora de progreso con escrituras agrupadas: como mucho una cada
// `intervalMs`, en serie, y siempre la lista completa (máx. 300 pasos).
export class ProgressLog {
  private items: ResearchProgress[];
  private timer: ReturnType<typeof setTimeout> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private dirty = false;

  constructor(
    private runId: string,
    initial: ResearchProgress[] = [],
    private intervalMs = 2500
  ) {
    this.items = [...initial];
  }

  get list(): ResearchProgress[] {
    return this.items;
  }

  push(p: ResearchProgress): void {
    const last = this.items[this.items.length - 1];
    if (last && last.message === p.message && last.kind === p.kind) return; // sin repetidos
    this.items.push({ ...p, message: p.message.slice(0, 300) });
    if (this.items.length > MAX_PROGRESS) this.items = this.items.slice(-MAX_PROGRESS);
    this.dirty = true;
    if (!this.timer) this.timer = setTimeout(() => void this.flush(), this.intervalMs);
  }

  // Escribe lo pendiente (solo mientras siga "running").
  flush(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.dirty) return this.chain;
    this.dirty = false;
    const snapshot = JSON.stringify(this.items);
    this.chain = this.chain
      .then(async () => {
        const sql = getSql();
        await sql`
          UPDATE research_runs SET progress = ${snapshot}::jsonb
          WHERE id = ${this.runId} AND status = 'running'
        `;
      })
      .catch((e) => console.error("research progress", e));
    return this.chain;
  }

  // Detiene el temporizador sin escribir (antes de finishRun/failRun).
  async close(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.dirty = false;
    await this.chain;
  }
}

// ---------- Selección de prospectos ----------

function pick(run: ResearchRun, ids?: string[] | null): ResearchProspect[] {
  const all = run.results ?? [];
  if (!ids || !ids.length) return all;
  const want = new Set(ids);
  return all.filter((p) => want.has(p.id));
}

async function loadDoneRun(runId: string): Promise<ResearchRun> {
  const run = await getRun(runId);
  if (!run) throw new ResearchActionError("No encontré esa investigación.", 404);
  if (run.status !== "done") throw new ResearchActionError("La investigación aún no termina.", 409);
  return run;
}

// ---------- CSV ----------

export const CSV_HEADER = [
  "Score",
  "Nombre",
  "Giro",
  "Correo",
  "Teléfono",
  "WhatsApp",
  "Web",
  "Redes",
  "Dirección",
  "Personal (estrato)",
  "Fuente",
  "Por qué",
  "Señales",
  "Mensaje sugerido",
  "Lat",
  "Lon",
];

// Celda CSV: comillas dobles y protección contra fórmulas (=, +, -, @) sin
// romper teléfonos como "+52 442...".
function cell(v: string | number | undefined | null): string {
  let s = String(v ?? "");
  if (/^[=+\-@\t\r]/.test(s) && !/^\+?[\d\s()-]+$/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
}

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "reporte"
  );
}

/** CSV (con BOM) SIN prospectos de Google ni el campo `google`. */
export function runToCsv(
  run: ResearchRun,
  ids?: string[] | null
): { csv: string; filename: string; omittedGoogle: number; count: number } {
  const chosen = pick(run, ids);
  const rows = chosen.filter((p) => p.source !== "google");
  const omittedGoogle = chosen.length - rows.length;
  const lines = [CSV_HEADER.map(cell).join(",")];
  for (const p of rows) {
    lines.push(
      [
        p.score,
        p.name,
        p.category,
        p.email ? (p.emailIsGuess ? `${p.email} (sugerido)` : p.email) : "",
        p.phone,
        p.whatsapp,
        p.website,
        (p.socials ?? []).join(" | "),
        p.address,
        p.employees,
        sourceLabel(p.source),
        p.reasons.join(" · "),
        p.signals.join(" · "),
        p.opener,
        p.lat != null ? p.lat.toFixed(6) : "",
        p.lon != null ? p.lon.toFixed(6) : "",
      ]
        .map(cell)
        .join(",")
    );
  }
  const day = mxDay(new Date(run.createdAt));
  return {
    csv: "﻿" + lines.join("\r\n") + "\r\n",
    filename: `investigacion-${slug(run.summary?.title ?? run.prompt)}-${day}.csv`,
    omittedGoogle,
    count: rows.length,
  };
}

// ---------- Enviar a GHL ----------

export interface GhlPushResult {
  pushed: number;
  skipped: number;
  failed: number;
  skippedGoogle: number;
  errors: string[];
}

function noteFor(p: ResearchProspect, run: ResearchRun, runUrl?: string): string {
  const lines = [
    "Investigación con IA — AI Lead Shield",
    `Calificación: ${p.score}/10 · Fuente: ${sourceLabel(p.source)}`,
  ];
  if (p.reasons.length) lines.push("", "Por qué:", ...p.reasons.map((r) => `- ${r}`));
  if (p.signals.length) lines.push("", "Señales:", ...p.signals.map((s) => `- ${s}`));
  if (p.opener) lines.push("", "Mensaje sugerido:", p.opener);
  const who = run.createdBy ? ` (pedida por ${displayName(run.createdBy)})` : "";
  lines.push("", `Investigación: ${run.summary?.title ?? run.prompt}${who}`);
  if (runUrl) lines.push(runUrl);
  return lines.join("\n").slice(0, 5000);
}

// "El Refugio, Querétaro" -> "Querétaro"
function cityOf(zone: string | undefined): string | undefined {
  const parts = (zone ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return parts.length > 1 ? parts[1] : parts[0];
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Sube los prospectos (todos o `ids`) como contactos de GHL con una nota.
 * Salta los de Google, los que tienen BAJA y los que no tienen correo ni teléfono.
 */
export async function pushRunToGhl(
  runId: string,
  ids: string[] | null | undefined,
  userEmail: string | null,
  opts: { runUrl?: string } = {}
): Promise<GhlPushResult> {
  if (!ghlReady()) throw new ResearchActionError("GHL no está configurado (faltan GHL_PIT o GHL_LOCATION_ID).", 503);
  const run = await loadDoneRun(runId);
  const chosen = pick(run, ids);
  const res: GhlPushResult = { pushed: 0, skipped: 0, failed: 0, skippedGoogle: 0, errors: [] };

  // Bajas vigentes (se revisan al momento, no con lo que había al investigar).
  const emails = [
    ...new Set(chosen.flatMap((p) => [p.email, ...(p.emails ?? [])]).filter((e): e is string => !!e).map((e) => e.toLowerCase())),
  ];
  const sql = getSql();
  const supp = emails.length
    ? ((await sql`SELECT email FROM suppression WHERE email = ANY(${emails}::text[])`) as Row[])
    : [];
  const suppressed = new Set(supp.map((r) => String(r.email)));

  const niche = run.summary?.niche ?? run.params?.niche;
  const zone = run.summary?.zone ?? run.params?.zone;
  const tags = [niche, zone, `investigacion-${mxDay(new Date(run.createdAt))}`, "AI Lead Shield"]
    .map((t) => t?.trim().slice(0, 60))
    .filter((t): t is string => !!t);

  for (const p of chosen) {
    if (p.source === "google") {
      res.skippedGoogle++;
      continue;
    }
    const pEmails = [p.email, ...(p.emails ?? [])].filter((e): e is string => !!e).map((e) => e.toLowerCase());
    if (p.existing?.suppressed || pEmails.some((e) => suppressed.has(e))) {
      res.skipped++;
      continue;
    }
    const email = p.email && !p.emailIsGuess ? p.email : undefined;
    const phone = normalizePhoneMx(p.phone) ?? normalizePhoneMx(p.whatsapp);
    if (!email && !phone) {
      res.skipped++;
      continue;
    }
    const input = {
      name: p.name,
      companyName: p.name,
      email,
      phone,
      website: p.website,
      address1: p.address,
      city: cityOf(zone),
      country: "MX",
      source: `AI Lead Shield · ${sourceLabel(p.source)}`,
      tags,
    };
    try {
      let up = await upsertContactDetailed(input);
      if (up.status === 429) {
        await sleep(2000);
        up = await upsertContactDetailed(input);
      }
      const contactId = contactIdFrom(up.body);
      if (!up.ok || !contactId) {
        res.failed++;
        res.errors.push(`${p.name}: HTTP ${up.status}`);
        continue;
      }
      res.pushed++;
      const note = await addContactNote(contactId, noteFor(p, run, opts.runUrl));
      if (!note.ok) res.errors.push(`${p.name}: se subió, pero la nota falló (HTTP ${note.status})`);
    } catch (e) {
      console.error("research ghl push", e);
      res.failed++;
      res.errors.push(`${p.name}: error de red`);
    }
  }
  if (userEmail) console.info(`[research] ${userEmail} subió ${res.pushed} prospectos de ${runId} a GHL`);
  res.errors = res.errors.slice(0, 10);
  return res;
}

// ---------- Guardar en Prospectos ----------

// Id del prospecto en la tabla leads (mismo formato que los otros flujos).
export function leadIdFor(p: ResearchProspect): string {
  if (p.source === "denue" && p.denueId) return `denue/${p.denueId}`;
  if (p.source === "osm" && p.osmId) return p.osmId; // "node/123"
  return p.id;
}

/** Guarda en Prospectos (dueño = quien guarda). Salta los de Google. */
export async function saveRunProspects(
  runId: string,
  ids: string[] | null | undefined,
  userEmail: string | null
): Promise<{ saved: number; skipped: number }> {
  const run = await loadDoneRun(runId);
  const chosen = new Set(pick(run, ids).map((p) => p.id));
  const zone = run.summary?.zone ?? run.params?.zone ?? "";
  const niche = run.summary?.niche ?? run.params?.niche ?? "";
  let saved = 0;
  let skipped = 0;
  const results = (run.results ?? []).map((p) => ({ ...p }));

  for (const p of results) {
    if (!chosen.has(p.id)) continue;
    if (p.source === "google") {
      skipped++;
      continue;
    }
    const b: Business = {
      id: leadIdFor(p),
      name: p.name,
      category: p.category ?? niche,
      phone: p.phone ?? p.whatsapp,
      website: p.website,
      email: p.email && !p.emailIsGuess ? p.email : undefined,
      address: p.address,
      city: zone || undefined,
      lat: p.lat ?? NaN, // sin coordenadas = NaN (convención de types.ts)
      lon: p.lon ?? NaN,
      score: p.score,
      // Business.source no tiene "web": esos se deducen del id ("web/...").
      ...(p.source === "denue" || p.source === "osm" ? { source: p.source } : {}),
      ...(p.denueId ? { denueId: p.denueId } : {}),
      ...(p.placeId ? { placeId: p.placeId } : {}),
      ...(p.employees ? { employees: p.employees } : {}),
    };
    try {
      const lead = await saveLead(b, zone || undefined, userEmail);
      p.existing = {
        ...p.existing,
        leadId: lead.id,
        ownerEmail: lead.ownerEmail,
        status: lead.status,
        contactedBy: lead.contactedBy,
        contactedAt: lead.contactedAt,
      };
      saved++;
    } catch (e) {
      console.error("research save lead", e);
      skipped++;
    }
  }
  if (saved) await saveRunResults(runId, results);
  return { saved, skipped };
}
