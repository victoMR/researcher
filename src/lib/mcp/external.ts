// guardar_investigacion: una investigación que hizo Claude (cliente MCP) se
// valida con el MISMO post-proceso del agente interno y se guarda como
// research_run terminado.
//
// Regla del "modo externo" (ver docs/mcp.md):
// - Los prospectos se anclan a lo que devolvieron las herramientas de la app
//   en la sesión MCP del vendedor (DENUE, OSM, sitios revisados): los datos de
//   contacto salen de ahí, no de lo que diga el modelo.
// - Datos que Claude encontró con su propia búsqueda web se aceptan solo con
//   la URL de la página donde los vio (`fuentes`): el servidor relee esa página
//   y el dato debe aparecer en ella. Páginas de Google nunca cuentan como
//   fuente, y los prospectos marcados source "google" no aportan contactos.
// - El score sale de computeScore(), se deduplica y se marca quién ya es
//   prospecto o pidió BAJA (attachExisting).
import type { ResearchParams, ResearchProgress, ResearchProspect, ResearchSummary } from "../research-types";
import { createRun, failRun, finishRun } from "../research-repo";
import { safeFetchText } from "../safe-fetch";
import { displayName } from "../session";
import type { Evidence } from "../agent/evidence";
import { attachExisting } from "../agent/existing";
import { cleanUrl, clip, hostOf } from "../agent/normalize";
import { buildProspects, buildSummary, parseReport } from "../agent/postprocess";
import { HARD_MAX_PROSPECTS } from "../agent/prompt";
import { ToolError } from "../agent/tools";
import { loadSessionEvidence } from "./evidence-store";

const MAX_SOURCES = 15; // páginas que se releen por guardado
const SOURCE_TIMEOUT_MS = 12_000;
const SOURCE_MAX_BYTES = 800_000;

// Dominios de Google (y sitios generados por Google Business Profile).
const GOOGLE_HOST = /(^|\.)(google\.[a-z.]+|goo\.gl|g\.page|g\.co|googleusercontent\.com|gstatic\.com|googleapis\.com|business\.site)$/i;

export function isGoogleUrl(url: string): boolean {
  const h = hostOf(url);
  return !!h && GOOGLE_HOST.test(h);
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

const codePoint = (n: number) => (n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : " ");

// Texto plano de una página para verificar datos (incluye los href: mailto,
// tel, wa.me y redes), sin scripts ni estilos.
function pageText(html: string): string {
  const hrefs = [...html.matchAll(/href\s*=\s*["']([^"']{1,300})["']/gi)].map((m) => m[1]);
  const text = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&#(\d{1,7});/g, (_, n) => codePoint(Number(n)))
    .replace(/&#x([0-9a-f]{1,6});/gi, (_, n) => codePoint(parseInt(n, 16)))
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");
  return `${text}\n${hrefs.join("\n")}`;
}

export interface ExternalReport {
  prompt: string;
  prospects: ResearchProspect[];
  summary: ResearchSummary;
  params: ResearchParams;
  progress: ResearchProgress[];
  discarded: {
    sinEvidencia: string[]; // prospectos sin ancla verificable
    datosSinFuente: number; // datos de contacto que no se pudieron verificar
    marcadosGoogle: number; // datos de prospectos marcados como de Google
    duplicadosFusionados: number;
  };
  sources: { leidas: number; noLeidas: string[]; rechazadasGoogle: string[] };
}

/**
 * Valida el reporte de Claude contra la evidencia y arma prospectos y resumen
 * (sin escribir en la BD). Lanza ToolError con un mensaje útil para el modelo
 * si el formato no sirve o si nada se pudo verificar.
 */
export async function buildExternalReport(o: {
  userEmail: string;
  input: Record<string, unknown>;
  ev: Evidence;
  signal?: AbortSignal;
}): Promise<ExternalReport> {
  const { ev } = o;
  const prompt = clip(o.input.prompt, 2000);
  if (!prompt) throw new ToolError("Falta 'prompt': la petición original del usuario (nicho y zona).");
  const rawList = Array.isArray(o.input.prospects) ? o.input.prospects.filter(isObj) : [];
  if (!rawList.length) throw new ToolError("Falta 'prospects' con al menos un negocio.");
  if (rawList.length > HARD_MAX_PROSPECTS) {
    throw new ToolError(`Máximo ${HARD_MAX_PROSPECTS} prospectos por investigación; entrega los mejores.`);
  }

  // Datos marcados como de Google: no aportan contactos (solo nombre/id).
  let marcadosGoogle = 0;
  const cleaned = rawList.map((p) => {
    if (String(p.source ?? "").toLowerCase() !== "google") return p;
    const copy: Obj = { ...p };
    for (const k of ["email", "phone", "whatsapp", "website", "socials", "lastActivityAt", "fuentes"]) {
      const v = copy[k];
      if (k !== "fuentes" && v !== undefined && v !== "" && !(Array.isArray(v) && !v.length)) marcadosGoogle++;
      delete copy[k];
    }
    return copy;
  });

  const parsed = parseReport({ summary: o.input.summary, prospects: cleaned });
  if (!parsed.ok) throw new ToolError(parsed.error);
  const draft = parsed.draft;

  // Fuentes externas: se releen y se agregan como texto web verificable.
  const wanted = new Set<string>();
  const rechazadasGoogle: string[] = [];
  for (const p of cleaned) {
    const list = Array.isArray(p.fuentes) ? p.fuentes : [];
    for (const raw of list) {
      const url = cleanUrl(raw);
      if (!url) continue;
      if (isGoogleUrl(url)) {
        if (rechazadasGoogle.length < 10) rechazadasGoogle.push(url);
        continue;
      }
      wanted.add(url);
    }
  }
  const urls = [...wanted].slice(0, MAX_SOURCES);
  const noLeidas: string[] = [];
  let leidas = 0;
  await Promise.all(
    urls.map(async (url) => {
      const signals = [AbortSignal.timeout(SOURCE_TIMEOUT_MS), ...(o.signal ? [o.signal] : [])];
      const html = await safeFetchText(url, AbortSignal.any(signals), SOURCE_MAX_BYTES);
      if (!html) {
        noLeidas.push(url);
        return;
      }
      leidas++;
      ev.addWeb([url], [pageText(html)]);
    })
  );
  noLeidas.push(...[...wanted].slice(MAX_SOURCES));

  const nowIso = new Date().toISOString();
  const built = buildProspects(draft, ev, { max: HARD_MAX_PROSPECTS, nowIso });
  const prospects = built.prospects;
  if (!prospects.length) {
    throw new ToolError(
      `Ningún prospecto se pudo verificar (${built.stats.unanchored.slice(0, 5).join(", ")}). ` +
        "Usa los ids exactos que devolvieron buscar_denue / buscar_osm / consultar_google en ESTA sesión, " +
        "revisa los sitios con revisar_sitio, o para negocios que solo están en la web da su sitio en 'website' " +
        "y la página donde lo viste en 'fuentes'."
    );
  }

  const summary = buildSummary(draft.summary, prospects, {
    niche: [...ev.keywords][0],
    zone: ev.zone?.shortName,
    prompt,
  });

  const at = () => new Date().toISOString();
  const progress: ResearchProgress[] = [
    { at: at(), kind: "info", message: `Investigación hecha por Claude vía MCP para ${displayName(o.userEmail)}.` },
    { at: at(), kind: "info", message: "Validando datos, quitando duplicados y calificando…" },
  ];
  if (built.stats.unanchored.length) {
    progress.push({
      at: at(),
      kind: "warn",
      message: `Se descartaron ${built.stats.unanchored.length} prospecto(s) sin datos verificables: ${built.stats.unanchored.slice(0, 3).join(", ")}.`,
    });
  }
  const rejected = built.stats.rejectedClaims + marcadosGoogle;
  if (rejected) {
    progress.push({ at: at(), kind: "warn", message: `Se descartaron ${rejected} dato(s) de contacto sin fuente verificable.` });
  }
  if (rechazadasGoogle.length) {
    progress.push({ at: at(), kind: "warn", message: "Se ignoraron fuentes de Google (solo sirven como referencia)." });
  }

  const params: ResearchParams = {
    niche: summary.niche,
    zone: summary.zone || ev.zone?.shortName,
    lat: ev.zone?.lat,
    lon: ev.zone?.lon,
    radiusM: ev.radiusM ?? ev.zone?.radiusM,
    keywords: [...ev.keywords].slice(0, 10),
    scianCodes: [...ev.scianCodes].slice(0, 10),
    maxResults: HARD_MAX_PROSPECTS,
  };

  return {
    prompt,
    prospects,
    summary,
    params,
    progress,
    discarded: {
      sinEvidencia: built.stats.unanchored,
      datosSinFuente: built.stats.rejectedClaims,
      marcadosGoogle,
      duplicadosFusionados: built.stats.merged,
    },
    sources: { leidas, noLeidas: noLeidas.slice(0, 10), rechazadasGoogle },
  };
}

/** Valida con la evidencia de la sesión MCP del vendedor y guarda el run (status done). */
export async function saveExternalResearch(o: {
  userEmail: string;
  input: Record<string, unknown>;
  signal?: AbortSignal;
}): Promise<ExternalReport & { id: string }> {
  // Evidencia de la sesión MCP (herramientas de la app que usó Claude).
  const ev = await loadSessionEvidence(o.userEmail);
  const r = await buildExternalReport({ ...o, ev });
  const at = () => new Date().toISOString();
  try {
    await attachExisting(r.prospects, r.summary.zone || ev.zone?.shortName);
  } catch (e) {
    console.error("mcp existing", e);
    r.progress.push({ at: at(), kind: "warn", message: "No se pudo revisar cuáles ya son prospectos." });
  }
  const s = r.summary.stats;
  r.progress.push({
    at: at(),
    kind: "info",
    message: `Listo: ${s.total} prospecto${s.total === 1 ? "" : "s"} (${s.withEmail} con correo, ${s.withWhatsapp} con WhatsApp, ${s.withPhone} con teléfono).`,
  });

  const id = await createRun(r.prompt, o.userEmail);
  try {
    await finishRun(id, { params: r.params, results: r.prospects, summary: r.summary, progress: r.progress });
  } catch (e) {
    await failRun(id, "No se pudo guardar el resultado.", r.progress, r.params).catch(() => {});
    throw e;
  }
  return { ...r, id };
}
