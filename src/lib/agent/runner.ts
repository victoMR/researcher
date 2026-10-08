// Bucle agéntico de "Investigar con IA" con la API de Claude (manual: maneja
// pause_turn de las herramientas de servidor, presupuestos de tiempo/turnos y
// un reporte de respaldo si el modelo no termina). Corre en segundo plano
// (after() en POST /api/research) y guarda progreso y resultado en research_runs.
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock,
  BetaContentBlockParam,
  BetaMessage,
  BetaMessageParam,
  BetaToolResultBlockParam,
  BetaToolUnion,
  BetaToolUseBlock,
  BetaUsage,
  MessageCreateParamsNonStreaming,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import type { ResearchParams, ResearchProgress, ResearchProspect } from "../research-types";
import { failRun, finishRun, ProgressLog } from "../research-repo";
import { displayName } from "../session";
import { mxDay } from "../api-usage";
import { denueReady } from "../denue";
import {
  agentEffort,
  agentModel,
  HARD_DEADLINE_MS,
  MAX_ITERATIONS,
  MAX_OUTPUT_TOKENS,
  modelFeatures,
  modelPrices,
  SOFT_DEADLINE_BIG_MS,
  SOFT_DEADLINE_MS,
  WEB_FETCH_MAX_USES,
  WEB_SEARCH_MAX_USES,
  WEB_SEARCH_USD,
  type ModelFeatures,
} from "./config";
import { Evidence } from "./evidence";
import { attachExisting } from "./existing";
import { googleReady } from "./google";
import { buildProspects, buildSummary, fallbackReport, parseReport, type Draft } from "./postprocess";
import {
  buildFirstMessage,
  DEFAULT_MAX_PROSPECTS,
  HARD_MAX_PROSPECTS,
  REPORT_TOOL_DESCRIPTION,
  REPORT_TOOL_NAME,
  REPORT_TOOL_SCHEMA,
  requestedCount,
  SYSTEM_PROMPT,
} from "./prompt";
import { findTool, RESEARCH_TOOLS, ToolError, type ToolContext } from "./tools";

// Error con mensaje final para el vendedor.
class AgentFail extends Error {}

// Por qué terminó el bucle sin reporte.
type EndReason = "time" | "turns" | "refusal" | "no_report";

const NO_DATA_MESSAGE: Record<EndReason, string> = {
  time: "Se acabó el tiempo antes de encontrar negocios. Intenta con una zona o un nicho más concreto.",
  turns: "La IA usó todos sus pasos sin encontrar negocios. Intenta con una zona o un nicho más concreto.",
  refusal: "Claude no pudo completar esta investigación (la rechazó un filtro de seguridad). Reformula la petición.",
  no_report: "La IA no entregó resultados. Intenta de nuevo con una petición más concreta (nicho y zona).",
};
const PARTIAL_MESSAGE: Record<EndReason, string> = {
  time: "La IA no terminó a tiempo.",
  turns: "La IA usó todos sus pasos sin entregar.",
  refusal: "Claude rechazó terminar la investigación.",
  no_report: "La IA no entregó el reporte.",
};

const nowIso = () => new Date().toISOString();
const TOOL_TIMEOUT_MS = 45_000;
const MAX_RESULT_CHARS = 40_000;
// Dominios de Google bloqueados en web_search/web_fetch (su contenido no se
// puede guardar; así no se cuela por la web lo que no podemos usar de Places).
const BLOCKED_DOMAINS = ["google.com", "google.com.mx", "goo.gl", "g.page"];

// ---------- Definición de herramientas (orden fijo para el caché) ----------

function buildTools(f: ModelFeatures): BetaToolUnion[] {
  const client: BetaToolUnion[] = RESEARCH_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema,
    eager_input_streaming: true,
  }));
  client.push({
    name: REPORT_TOOL_NAME,
    description: REPORT_TOOL_DESCRIPTION,
    input_schema: REPORT_TOOL_SCHEMA,
    strict: true,
    eager_input_streaming: true,
  });
  if (f.web2026) {
    client.push(
      {
        type: "web_search_20260209",
        name: "web_search",
        max_uses: WEB_SEARCH_MAX_USES,
        blocked_domains: BLOCKED_DOMAINS,
        user_location: { type: "approximate", country: "MX", timezone: "America/Mexico_City" },
      },
      {
        type: "web_fetch_20260209",
        name: "web_fetch",
        max_uses: WEB_FETCH_MAX_USES,
        blocked_domains: BLOCKED_DOMAINS,
        max_content_tokens: 12000,
      }
    );
  } else {
    client.push(
      {
        type: "web_search_20250305",
        name: "web_search",
        max_uses: WEB_SEARCH_MAX_USES,
        blocked_domains: BLOCKED_DOMAINS,
        user_location: { type: "approximate", country: "MX", timezone: "America/Mexico_City" },
      },
      {
        type: "web_fetch_20250910",
        name: "web_fetch",
        max_uses: WEB_FETCH_MAX_USES,
        blocked_domains: BLOCKED_DOMAINS,
        max_content_tokens: 12000,
      }
    );
  }
  return client;
}

// ---------- Uso y costo ----------

class UsageMeter {
  input = 0;
  output = 0;
  cacheWrite = 0;
  cacheRead = 0;
  searches = 0;
  fetches = 0;
  calls = 0;

  add(u: BetaUsage | null | undefined) {
    if (!u) return;
    this.calls++;
    this.input += u.input_tokens ?? 0;
    this.output += u.output_tokens ?? 0;
    this.cacheWrite += u.cache_creation_input_tokens ?? 0;
    this.cacheRead += u.cache_read_input_tokens ?? 0;
    const st = (u as { server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number } | null })
      .server_tool_use;
    this.searches += st?.web_search_requests ?? 0;
    this.fetches += st?.web_fetch_requests ?? 0;
  }

  cost(model: string): number {
    const [pin, pout, pw, pr] = modelPrices(model);
    return (
      (this.input * pin + this.output * pout + this.cacheWrite * pw + this.cacheRead * pr) / 1e6 +
      this.searches * WEB_SEARCH_USD
    );
  }

  describe(model: string): string {
    const totalIn = this.input + this.cacheWrite + this.cacheRead;
    const pct = totalIn ? Math.round((this.cacheRead / totalIn) * 100) : 0;
    const k = (n: number) => `${Math.round(n / 1000)}k`;
    return `Costo estimado de IA: US$${this.cost(model).toFixed(2)} (${this.calls} llamadas; ${k(totalIn)} tokens de entrada, ${pct}% desde caché; ${k(this.output)} de salida; ${this.searches} búsquedas web).`;
  }
}

// ---------- Progreso desde los bloques del modelo ----------

function firstSentence(s: string, max = 200): string {
  const clean = s.replace(/[*#_`>]+/g, "").replace(/\s+/g, " ").trim();
  const cut = clean.match(/^(.{20,}?[.!?…])(\s|$)/)?.[1] ?? clean;
  return cut.length > max ? cut.slice(0, max - 1).trimEnd() + "…" : cut;
}

// El resumen del razonamiento puede venir en inglés: solo se muestra en español.
function looksSpanish(s: string): boolean {
  const t = ` ${s.toLowerCase()} `;
  const es = (t.match(/ (el|la|los|las|de|que|para|con|una|por|del|y|voy|vamos|buscar|revisar) /g) || []).length;
  const en = (t.match(/ (the|and|to|of|is|for|with|this|that|i|let|will|need) /g) || []).length;
  return es >= 2 && es > en;
}

function blockProgress(b: BetaContentBlock, say: (p: ResearchProgress) => void) {
  if (b.type === "server_tool_use") {
    const input = (b.input ?? {}) as Record<string, unknown>;
    if (b.name === "web_search" && typeof input.query === "string") {
      say({ at: nowIso(), kind: "tool", message: `Buscando en la web: «${input.query.slice(0, 120)}»…` });
    } else if (b.name === "web_fetch" && typeof input.url === "string") {
      const u = input.url.replace(/^https?:\/\/(www\.)?/, "").slice(0, 100);
      say({ at: nowIso(), kind: "tool", message: `Leyendo en la web: ${u}…` });
    }
  } else if (b.type === "thinking" && b.thinking?.trim()) {
    const s = firstSentence(b.thinking);
    if (s.length >= 15 && looksSpanish(s)) say({ at: nowIso(), kind: "think", message: s });
  } else if (b.type === "text" && b.text?.trim()) {
    const s = firstSentence(b.text);
    if (s.length >= 10) say({ at: nowIso(), kind: "think", message: s });
  }
}

// URLs y textos de resultados de web_search/web_fetch (para verificar datos).
function harvestWeb(content: BetaContentBlock[], ev: Evidence) {
  const urls: string[] = [];
  const texts: string[] = [];
  const walk = (v: unknown, key: string, depth: number) => {
    if (depth > 8 || v == null) return;
    if (typeof v === "string") {
      if (key === "url" && /^https?:\/\//i.test(v)) urls.push(v);
      else if (["data", "text", "stdout", "title"].includes(key) && v) {
        // Salta binarios en base64 (p. ej. PDF).
        if (v.length > 1000 && !/\s/.test(v.slice(0, 300))) return;
        texts.push(v);
      }
      return;
    }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1);
      return;
    }
    if (typeof v === "object") {
      for (const [k, x] of Object.entries(v as Record<string, unknown>)) {
        if (k === "encrypted_content" || k === "encrypted_index" || k === "signature") continue;
        walk(x, k, depth + 1);
      }
    }
  };
  for (const b of content) {
    if (b.type.endsWith("_tool_result")) walk(b, "", 0);
  }
  if (urls.length || texts.length) ev.addWeb(urls, texts);
}

// Tras un respaldo a otro modelo a media respuesta, no se reenvían thinking /
// tool_use / server_tool_use sin resultado previos al último bloque "fallback".
function echoContent(content: BetaContentBlock[]): BetaContentBlockParam[] {
  const lastFallback = content.map((b) => b.type).lastIndexOf("fallback");
  if (lastFallback < 0) return content as BetaContentBlockParam[];
  const resultIds = new Set(
    content
      .filter((b) => b.type.endsWith("_tool_result"))
      .map((b) => (b as { tool_use_id?: string }).tool_use_id)
      .filter(Boolean)
  );
  return content.filter((b, i) => {
    if (i > lastFallback) return true;
    if (b.type === "thinking" || b.type === "redacted_thinking" || b.type === "tool_use") return false;
    if (b.type === "server_tool_use") return resultIds.has(b.id);
    return true;
  }) as BetaContentBlockParam[];
}

function capText(s: string): string {
  return s.length > MAX_RESULT_CHARS ? s.slice(0, MAX_RESULT_CHARS) + "…(recortado)" : s;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new ToolError("La herramienta tardó demasiado; intenta con algo más acotado.")), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

function friendlyApiError(e: unknown, model: string): string {
  if (e instanceof AgentFail) return e.message;
  if (e instanceof Anthropic.AuthenticationError) return "La llave de Anthropic (ANTHROPIC_API_KEY) no es válida.";
  if (e instanceof Anthropic.PermissionDeniedError) return "La llave de Anthropic no tiene permiso para usar este modelo.";
  if (e instanceof Anthropic.NotFoundError) return `El modelo configurado (${model}) no existe; revisa AGENT_MODEL.`;
  if (e instanceof Anthropic.BadRequestError)
    return "La API de Claude rechazó la solicitud (revisa AGENT_MODEL y el saldo de la cuenta de Anthropic).";
  if (e instanceof Anthropic.RateLimitError) return "Claude está recibiendo demasiadas solicitudes. Intenta de nuevo en unos minutos.";
  if (e instanceof Anthropic.InternalServerError) return "Claude está saturado en este momento. Intenta de nuevo en unos minutos.";
  if (e instanceof Anthropic.APIConnectionError) return "No se pudo conectar con la API de Claude.";
  if (e instanceof Anthropic.APIError) return `Error de la API de Claude (HTTP ${e.status ?? "?"}).`;
  return "Ocurrió un error inesperado durante la investigación.";
}

// ---------- Ejecución ----------

export interface RunInput {
  runId: string;
  prompt: string;
  userEmail: string | null;
  startedAt: number; // ms (inicio de la petición: cuenta para maxDuration)
}

/** Corre una investigación completa. Nunca lanza: todo termina en done o error. */
export async function runResearch(o: RunInput): Promise<void> {
  const log = new ProgressLog(o.runId, [
    { at: new Date(o.startedAt).toISOString(), kind: "info", message: "Investigación en cola…" },
  ]);
  const say = (p: ResearchProgress) => log.push(p);
  const ev = new Evidence();
  const model = agentModel();
  const usage = new UsageMeter();
  const requested = requestedCount(o.prompt);
  const maxResults = Math.min(HARD_MAX_PROSPECTS, requested ?? DEFAULT_MAX_PROSPECTS);
  const vendorName = o.userEmail ? displayName(o.userEmail) : "Equipo AI Lead Shield";
  const params = (): ResearchParams => ({
    zone: ev.zone?.shortName,
    lat: ev.zone?.lat,
    lon: ev.zone?.lon,
    radiusM: ev.radiusM ?? ev.zone?.radiusM,
    keywords: [...ev.keywords].slice(0, 10),
    scianCodes: [...ev.scianCodes].slice(0, 10),
    maxResults,
  });

  try {
    let draft: Draft | null = null;
    let end: EndReason = "no_report";
    let apiFailure: unknown = null;
    try {
      const out = await agentLoop({ ...o, ev, say, usage, model, maxResults, vendorName, requested });
      draft = out.draft;
      end = out.end ?? "no_report";
    } catch (e) {
      if (e instanceof AgentFail) throw e;
      // Error de la API a media investigación: si ya hay datos, se arma el respaldo.
      console.error("research agent", e);
      apiFailure = e;
      if (!ev.hasData()) throw new AgentFail(friendlyApiError(e, model));
    }

    const now = nowIso();
    let prospects: ResearchProspect[];
    let summary;
    if (draft) {
      say({ at: nowIso(), kind: "info", message: "Validando datos, quitando duplicados y calificando…" });
      const built = buildProspects(draft, ev, { max: maxResults, nowIso: now });
      prospects = built.prospects;
      if (built.stats.unanchored.length) {
        say({
          at: nowIso(),
          kind: "warn",
          message: `Se descartaron ${built.stats.unanchored.length} prospecto(s) sin datos verificables: ${built.stats.unanchored.slice(0, 3).join(", ")}.`,
        });
      }
      if (built.stats.rejectedClaims) {
        say({ at: nowIso(), kind: "warn", message: `Se descartaron ${built.stats.rejectedClaims} dato(s) de contacto sin fuente verificable.` });
      }
      if (!prospects.length && ev.hasData()) {
        // El reporte no trajo nada verificable: se listan los negocios encontrados.
        say({ at: nowIso(), kind: "warn", message: "El reporte no traía prospectos verificables; se listan los negocios encontrados." });
        prospects = fallbackReport(ev, { max: maxResults, nowIso: now, vendorName, prompt: o.prompt }).prospects;
      }
      summary = buildSummary(draft.summary, prospects, {
        niche: [...ev.keywords][0],
        zone: ev.zone?.shortName,
        prompt: o.prompt,
      });
    } else {
      if (!ev.hasData()) throw new AgentFail(NO_DATA_MESSAGE[end]);
      const why = apiFailure ? friendlyApiError(apiFailure, model) : PARTIAL_MESSAGE[end];
      say({ at: nowIso(), kind: "warn", message: `${why} Armé el reporte con los datos ya reunidos.` });
      const fb = fallbackReport(ev, { max: maxResults, nowIso: now, vendorName, prompt: o.prompt });
      prospects = fb.prospects;
      summary = fb.summary;
    }

    // ¿Ya son prospectos / contactados / con BAJA? (datos reales de la BD)
    try {
      await attachExisting(prospects, summary.zone || ev.zone?.shortName);
    } catch (e) {
      console.error("research existing", e);
      say({ at: nowIso(), kind: "warn", message: "No se pudo revisar cuáles ya son prospectos." });
    }

    const s = summary.stats;
    say({
      at: nowIso(),
      kind: "info",
      message: `Listo: ${s.total} prospecto${s.total === 1 ? "" : "s"} (${s.withEmail} con correo, ${s.withWhatsapp} con WhatsApp, ${s.withPhone} con teléfono).`,
    });
    say({ at: nowIso(), kind: "info", message: usage.describe(model) });
    console.info(`[research] ${o.runId} ${model} ${usage.describe(model)}`);

    await log.close();
    await finishRun(o.runId, {
      params: { ...params(), niche: summary.niche, zone: summary.zone || params().zone },
      results: prospects,
      summary,
      progress: log.list,
    });
  } catch (e) {
    const message = friendlyApiError(e, model);
    if (!(e instanceof AgentFail)) console.error("research run", e);
    try {
      say({ at: nowIso(), kind: "warn", message });
      if (usage.calls) say({ at: nowIso(), kind: "info", message: usage.describe(model) });
      await log.close();
      await failRun(o.runId, message, log.list, params());
    } catch (dbErr) {
      console.error("research failRun", dbErr);
    }
  }
}

interface LoopInput extends RunInput {
  ev: Evidence;
  say: (p: ResearchProgress) => void;
  usage: UsageMeter;
  model: string;
  maxResults: number;
  vendorName: string;
  requested?: number;
}

// Devuelve el reporte validado, o draft null + motivo si no llegó.
async function agentLoop(o: LoopInput): Promise<{ draft: Draft | null; end?: EndReason }> {
  const { ev, say, usage, model } = o;
  const f = modelFeatures(model);
  const client = new Anthropic({ maxRetries: 2 });
  const softDeadline = o.startedAt + (o.maxResults > 30 ? SOFT_DEADLINE_BIG_MS : SOFT_DEADLINE_MS);
  const hardDeadline = o.startedAt + HARD_DEADLINE_MS;
  const abort = new AbortController();
  const hardTimer = setTimeout(() => abort.abort(), Math.max(1000, hardDeadline - Date.now()));
  const ctx: ToolContext = { userEmail: o.userEmail, progress: say, evidence: ev, signal: abort.signal };

  const tools = buildTools(f);
  const messages: BetaMessageParam[] = [
    {
      role: "user",
      content: buildFirstMessage({
        prompt: o.prompt,
        vendorName: o.vendorName,
        today: mxDay(),
        requested: o.requested,
        denue: denueReady(),
        google: googleReady(),
      }),
    },
  ];
  // Mismos parámetros en cada vuelta (tools + system idénticos -> caché).
  const request = (): MessageCreateParamsNonStreaming => ({
    model,
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: "text", text: SYSTEM_PROMPT, cache_control: { type: "ephemeral" } }],
    tools,
    messages,
    cache_control: { type: "ephemeral" }, // caché automático de la conversación
    ...(f.adaptive
      ? { thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: agentEffort() } }
      : {}),
    // Si un filtro de seguridad rechaza (falso positivo), reintenta en el modelo recomendado.
    ...(f.fallbacks ? { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" } : {}),
  });

  say({ at: nowIso(), kind: "think", message: "Entendiendo la petición y planeando la búsqueda…" });

  let iter = 0;
  let wrapUp = false;
  let wrapTurns = 0;
  let nudges = 0;
  let jsonRetries = 0;
  try {
    while (true) {
      if (Date.now() > hardDeadline - 5000) return { draft: null, end: "time" };
      if (iter >= MAX_ITERATIONS + 3) return { draft: null, end: "turns" };
      iter++;

      let msg: BetaMessage;
      try {
        const stream = client.beta.messages.stream(request(), { signal: abort.signal });
        stream.on("contentBlock", (b) => blockProgress(b, say));
        msg = await stream.finalMessage();
        jsonRetries = 0;
      } catch (e) {
        if (abort.signal.aborted) return { draft: null, end: "time" };
        // JSON de una herramienta que no se pudo leer (no es error de la API): reintenta el turno.
        if (e instanceof Anthropic.AnthropicError && !(e instanceof Anthropic.APIError) && jsonRetries < 2) {
          jsonRetries++;
          continue;
        }
        throw e;
      }
      usage.add(msg.usage);
      harvestWeb(msg.content, ev);

      if (msg.stop_reason === "refusal") {
        say({ at: nowIso(), kind: "warn", message: "Claude rechazó continuar con esta investigación." });
        return { draft: null, end: "refusal" };
      }
      const content = echoContent(msg.content);
      // La API no acepta turnos de assistant vacíos en el historial.
      if (content.length) messages.push({ role: "assistant", content });
      if (msg.stop_reason === "pause_turn") continue; // herramientas de servidor: reanudar

      const uses = content.filter((b): b is BetaToolUseBlock => b.type === "tool_use");
      if (!uses.length) {
        // Terminó sin entregar: se le pide el reporte (máx. 2 veces).
        if (++nudges > 2) return { draft: null, end: "no_report" };
        messages.push({
          role: "user",
          content: [{ type: "text", text: `Falta entregar el resultado: llama ahora a ${REPORT_TOOL_NAME} con el reporte.` }],
        });
        continue;
      }

      const truncated = msg.stop_reason === "max_tokens";
      const results: BetaToolResultBlockParam[] = [];
      for (const use of uses.filter((u) => u.name === REPORT_TOOL_NAME)) {
        if (truncated) {
          results.push({
            type: "tool_result",
            tool_use_id: use.id,
            is_error: true,
            content: "El reporte se cortó por longitud. Entrégalo otra vez, más corto (menos prospectos o textos más breves).",
          });
          continue;
        }
        const parsed = parseReport(use.input);
        if (parsed.ok) {
          say({ at: nowIso(), kind: "think", message: "Armando el reporte final…" });
          return { draft: parsed.draft };
        }
        say({ at: nowIso(), kind: "warn", message: "El reporte venía incompleto; se pidió corregirlo." });
        results.push({ type: "tool_result", tool_use_id: use.id, is_error: true, content: parsed.error });
      }

      // Herramientas propias en paralelo (todas son de solo lectura).
      const others = uses.filter((u) => u.name !== REPORT_TOOL_NAME);
      const ran = await Promise.all(
        others.map(async (use): Promise<BetaToolResultBlockParam> => {
          if (truncated) {
            return { type: "tool_result", tool_use_id: use.id, is_error: true, content: "La llamada se cortó por longitud; repítela." };
          }
          if (wrapUp) {
            return {
              type: "tool_result",
              tool_use_id: use.id,
              is_error: true,
              content: `Se acabó el tiempo: no uses más herramientas; llama ya a ${REPORT_TOOL_NAME}.`,
            };
          }
          const tool = findTool(use.name);
          if (!tool) return { type: "tool_result", tool_use_id: use.id, is_error: true, content: `Herramienta desconocida: ${use.name}` };
          const input = use.input;
          if (!input || typeof input !== "object" || Array.isArray(input)) {
            return {
              type: "tool_result",
              tool_use_id: use.id,
              is_error: true,
              content: JSON.stringify({ INVALID_JSON: JSON.stringify(input) }),
            };
          }
          try {
            const out = await withTimeout(tool.run(input as Record<string, unknown>, ctx), TOOL_TIMEOUT_MS);
            return { type: "tool_result", tool_use_id: use.id, content: capText(JSON.stringify(out)) };
          } catch (e) {
            const message = e instanceof ToolError ? e.message : "La herramienta falló; sigue con otra fuente.";
            if (!(e instanceof ToolError)) console.error(`research tool ${use.name}`, e);
            say({ at: nowIso(), kind: "warn", message: message.slice(0, 200) });
            return { type: "tool_result", tool_use_id: use.id, is_error: true, content: message };
          }
        })
      );
      results.push(...ran);

      // Presupuesto / orden de entregar (texto después de los tool_result).
      const left = Math.max(0, Math.round((softDeadline - Date.now()) / 1000));
      const turnsLeft = MAX_ITERATIONS - iter;
      if (wrapUp) wrapTurns++;
      if (!wrapUp && (left <= 0 || turnsLeft <= 2)) {
        wrapUp = true;
        say({ at: nowIso(), kind: "think", message: "Se acabó el tiempo de búsqueda; pidiendo el reporte con lo reunido…" });
      }
      if (wrapUp && wrapTurns > 2) return { draft: null, end: left <= 0 ? "time" : "turns" };
      const note = wrapUp
        ? `[Hora de entregar] Se acabó el tiempo de investigación. Llama AHORA a ${REPORT_TOOL_NAME} con los mejores prospectos que ya tienes (máx. ${o.maxResults}); no uses otras herramientas. Razones de una línea y mensajes de 35 a 50 palabras.`
        : `[Presupuesto] Quedan ~${left} s y ${turnsLeft} turnos para investigar; búsquedas web usadas: ${usage.searches}. Máximo ${o.maxResults} prospectos en el reporte.`;
      messages.push({ role: "user", content: [...results, { type: "text", text: note }] });
    }
  } finally {
    clearTimeout(hardTimer);
  }
}
