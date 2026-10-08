"use client";

import { useEffect, useMemo, useState } from "react";
import type { ResearchProspect, ResearchRun } from "@/lib/research-types";
import type { Business, Me } from "@/lib/types";
import { personName } from "@/lib/format";
import ComposeModal from "@/components/ComposeModal";
import MapView from "@/components/MapView";
import { EmptyState } from "@/components/ui";
import * as Icon from "@/components/icons";
import Markdown, { Inline } from "./Markdown";
import ProspectCard, { cardDomId } from "./ProspectCard";
import { downloadResearchCsv, pushResearchToGhl, saveResearch } from "./api";
import {
  copyText,
  dateTime,
  hasCoords,
  isGoogle,
  plural,
  reportUrl,
  safeUrl,
  toBusiness,
} from "./util";

interface Filters {
  email: boolean;
  wa: boolean;
  top: boolean;
  hideContacted: boolean;
}
const NO_FILTERS: Filters = { email: false, wa: false, top: false, hideContacted: false };
const FILTER_LABEL: Record<keyof Filters, string> = {
  email: "Con correo",
  wa: "Con WhatsApp",
  top: "Score ≥ 7",
  hideContacted: "Ocultar ya contactados",
};
const PAGE = 30;

type Notice = { tone: "ok" | "warn" | "error"; text: string; detail?: string[] } | null;
type Busy = "csv" | "ghl" | "save" | null;

const hasEmail = (p: ResearchProspect) => !!(p.email || p.emails?.length);
const wasContacted = (p: ResearchProspect) =>
  !!(
    p.existing?.contactedBy ||
    p.existing?.suppressed ||
    p.existing?.status === "contactado" ||
    p.existing?.status === "respondio" ||
    p.existing?.status === "descartado"
  );

// Campos que el backend podría omitir: los dejamos siempre definidos.
function normalize(p: ResearchProspect): ResearchProspect {
  const score = Number.isFinite(p.score) ? Math.max(1, Math.min(10, Math.round(p.score))) : 1;
  return { ...p, score, reasons: p.reasons ?? [], signals: p.signals ?? [] };
}

export function ReportSkeleton() {
  return (
    <div className="space-y-4" aria-hidden>
      <div className="h-28 animate-pulse rounded-2xl bg-white" />
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 animate-pulse rounded-2xl bg-white" />
        ))}
      </div>
      <div className="h-40 animate-pulse rounded-2xl bg-white" />
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="h-36 animate-pulse rounded-2xl bg-white" />
      ))}
    </div>
  );
}

function Kpi({ icon, label, value, total }: { icon: React.ReactNode; label: string; value: number; total?: number }) {
  const pct = total ? Math.round((value / total) * 100) : null;
  return (
    <div className="rounded-2xl border border-black/5 bg-white p-4 shadow-apple-sm">
      <div className="flex items-center gap-1.5 text-xs font-medium text-slate-500">
        {icon}
        {label}
      </div>
      <p className="mt-1 text-2xl font-semibold tabular-nums tracking-tight text-slate-900">
        {value}
        {pct != null && <span className="ml-1.5 text-xs font-medium text-slate-400">{pct}%</span>}
      </p>
    </div>
  );
}

// Reporte de una investigación terminada. Se usa en la pestaña y en la página
// compartible /investigacion/[id].
export default function ResearchReport({
  run,
  me,
  standalone = false,
  onRetry,
  retrying = false,
  onChanged,
}: {
  run: ResearchRun;
  me: Me | null;
  standalone?: boolean; // en la página compartible (sin "Abrir en página")
  onRetry?: () => void;
  retrying?: boolean;
  onChanged?: () => void; // se guardó o contactó algo (contador de Prospectos)
}) {
  const results = useMemo(
    () => (run.results ?? []).map(normalize).sort((a, b) => b.score - a.score),
    [run.results]
  );
  const summary = run.summary;
  const city = summary?.zone || run.params?.zone;

  const [filters, setFilters] = useState<Filters>(NO_FILTERS);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [savedIds, setSavedIds] = useState<Set<string>>(() => new Set());
  const [savingId, setSavingId] = useState<string | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [compose, setCompose] = useState<{ lead: Business; body?: string } | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const [highlight, setHighlight] = useState<string | null>(null);
  const [linkCopied, setLinkCopied] = useState(false);

  // El aviso se va solo después de unos segundos.
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), notice.tone === "ok" ? 7000 : 12000);
    return () => clearTimeout(t);
  }, [notice]);

  const visible = useMemo(
    () =>
      results.filter(
        (p) =>
          (!filters.email || hasEmail(p)) &&
          (!filters.wa || !!p.whatsapp) &&
          (!filters.top || p.score >= 7) &&
          (!filters.hideContacted || !wasContacted(p))
      ),
    [results, filters]
  );
  const googleTotal = useMemo(() => results.filter(isGoogle).length, [results]);
  const exportableAll = results.length - googleTotal;
  const exportableVisible = useMemo(() => visible.filter((p) => !isGoogle(p)), [visible]);
  const filtered = Object.values(filters).some(Boolean);

  // A qué aplican las acciones masivas: lo seleccionado, o lo visible si no
  // hay selección. `undefined` = todos los exportables (URL más corta).
  const selectedIds = results.filter((p) => selected.has(p.id)).map((p) => p.id);
  const targetIds: string[] | undefined = selectedIds.length
    ? selectedIds
    : filtered
      ? exportableVisible.map((p) => p.id)
      : undefined;
  const targetCount = targetIds ? targetIds.length : exportableAll;
  const allVisibleSelected =
    exportableVisible.length > 0 && exportableVisible.every((p) => selected.has(p.id));

  const stats = summary?.stats ?? {
    total: results.length,
    withEmail: results.filter(hasEmail).length,
    withPhone: results.filter((p) => !!p.phone).length,
    withWhatsapp: results.filter((p) => !!p.whatsapp).length,
  };

  // Mapa: solo DENUE / OSM / web con coordenadas (términos de Google).
  const mapPoints = useMemo<Business[]>(
    () =>
      results
        .filter((p) => !isGoogle(p) && hasCoords(p))
        .map((p) => ({
          id: p.id,
          name: p.name,
          category: p.category ?? "",
          phone: p.phone,
          website: safeUrl(p.website) ?? undefined,
          address: p.address,
          lat: p.lat as number,
          lon: p.lon as number,
        })),
    [results]
  );

  const requester = run.createdBy
    ? run.createdBy === me?.email
      ? "ti"
      : personName(run.createdBy)
    : null;

  function toggle(id: string) {
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  }

  function toggleAll() {
    setSelected((s) => {
      const n = new Set(s);
      if (allVisibleSelected) exportableVisible.forEach((p) => n.delete(p.id));
      else exportableVisible.forEach((p) => n.add(p.id));
      return n;
    });
  }

  function markSaved(ids: string[]) {
    setSavedIds((s) => new Set([...s, ...ids]));
  }

  async function copyLink() {
    if (await copyText(reportUrl(run.id))) {
      setLinkCopied(true);
      setTimeout(() => setLinkCopied(false), 2000);
    } else {
      setNotice({ tone: "warn", text: `No pude copiar. Enlace: ${reportUrl(run.id)}` });
    }
  }

  async function doCsv() {
    setBusy("csv");
    setNotice(null);
    const r = await downloadResearchCsv(run.id, targetIds);
    setBusy(null);
    if (!r.ok) return setNotice({ tone: "error", text: r.error });
    const g = r.data.omittedGoogle;
    setNotice({
      tone: "ok",
      text: `CSV descargado.${g ? ` Se omitieron ${plural(g, "resultado", "resultados")} de Google (solo referencia).` : ""}`,
    });
  }

  async function doGhl() {
    const googleNote = googleTotal
      ? `\nLos resultados de Google (${googleTotal}) no se envían: son solo referencia.`
      : "";
    if (
      !confirm(
        `¿Enviar ${plural(targetCount, "prospecto", "prospectos")} a GHL?\n\nSolo van datos de DENUE, OpenStreetMap o la web del negocio.${googleNote}`
      )
    )
      return;
    setBusy("ghl");
    setNotice(null);
    const r = await pushResearchToGhl(run.id, targetIds);
    setBusy(null);
    if (!r.ok) return setNotice({ tone: "error", text: r.error });
    const d = r.data;
    const parts = [`${d.pushed} enviado${d.pushed === 1 ? "" : "s"}`];
    if (d.skipped) parts.push(`${d.skipped} omitido${d.skipped === 1 ? "" : "s"} (sin correo ni teléfono o ya existían)`);
    if (d.failed) parts.push(`${d.failed} con error`);
    if (d.skippedGoogle) parts.push(`${d.skippedGoogle} de Google no se envían`);
    setNotice({
      tone: d.failed ? "warn" : "ok",
      text: `GHL: ${parts.join(", ")}.`,
      detail: d.errors.slice(0, 3),
    });
  }

  async function doSaveAll() {
    setBusy("save");
    setNotice(null);
    const r = await saveResearch(run.id, targetIds);
    setBusy(null);
    if (!r.ok) return setNotice({ tone: "error", text: r.error });
    markSaved(targetIds ?? results.filter((p) => !isGoogle(p)).map((p) => p.id));
    setNotice({
      tone: "ok",
      text: `Guardados en Prospectos: ${r.data.saved}${
        r.data.skipped ? ` · ${r.data.skipped} ya estaban guardados u omitidos` : ""
      }.`,
    });
    onChanged?.();
  }

  async function saveOne(p: ResearchProspect) {
    setSavingId(p.id);
    const r = await saveResearch(run.id, [p.id]);
    setSavingId(null);
    if (!r.ok) return setNotice({ tone: "error", text: r.error });
    markSaved([p.id]);
    setNotice({
      tone: r.data.saved ? "ok" : "warn",
      text: r.data.saved ? `${p.name} se guardó en Prospectos.` : `${p.name} ya estaba guardado o no se pudo guardar.`,
    });
    onChanged?.();
  }

  // Clic en un punto del mapa: lleva a su tarjeta.
  function focusCard(b: Business) {
    const idx = results.findIndex((p) => p.id === b.id);
    if (idx < 0) return;
    if (!visible.some((p) => p.id === b.id)) setFilters(NO_FILTERS);
    setLimit((l) => Math.max(l, idx + 1));
    setHighlight(b.id);
    setTimeout(() => {
      document
        .getElementById(cardDomId(b.id))
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    }, 60);
  }

  const shown = visible.slice(0, limit);
  const sources = summary?.sources?.filter((s) => s.count > 0) ?? [];

  return (
    <div className="space-y-5">
      {/* Encabezado */}
      <header className="rounded-2xl border border-black/5 bg-white p-5 shadow-apple-sm sm:p-6">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-indigo-600">
              <Icon.Sparkles className="h-3.5 w-3.5" /> Reporte de investigación
            </p>
            <h2 className="mt-1 break-words text-2xl font-semibold tracking-tight text-slate-900 sm:text-3xl">
              {summary?.title || run.prompt}
            </h2>
            <div className="mt-2 flex flex-wrap gap-1.5 text-xs">
              {summary?.niche && (
                <span className="rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600">
                  {summary.niche}
                </span>
              )}
              {summary?.zone && (
                <span className="flex items-center gap-1 rounded-full bg-slate-100 px-2.5 py-1 font-medium text-slate-600">
                  <Icon.MapPin className="h-3 w-3" /> {summary.zone}
                </span>
              )}
            </div>
            <p className="mt-2 text-xs text-slate-400">
              {dateTime(run.finishedAt || run.createdAt)}
              {requester && ` · Pedido por ${requester}`}
            </p>
            {summary?.title && (
              <p className="mt-1 line-clamp-2 text-xs italic text-slate-400">«{run.prompt}»</p>
            )}
          </div>
          {/* En la página compartible el encabezado ya trae "Copiar enlace". */}
          {!standalone && (
            <div className="flex shrink-0 flex-wrap gap-2">
              <button
                type="button"
                onClick={copyLink}
                className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {linkCopied ? (
                  <>
                    <Icon.Check className="h-3.5 w-3.5 text-emerald-600" /> Enlace copiado
                  </>
                ) : (
                  <>
                    <Icon.LinkIcon className="h-3.5 w-3.5" /> Copiar enlace
                  </>
                )}
              </button>
              <a
                href={`/investigacion/${encodeURIComponent(run.id)}`}
                target="_blank"
                rel="noopener"
                className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                <Icon.ExternalLink className="h-3.5 w-3.5" /> Abrir en página
              </a>
            </div>
          )}
        </div>
        {/* Mini-leyenda del modelo de score (por resta, src/lib/scoring.ts) */}
        <div className="mt-4 flex items-start gap-1.5 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
          <Icon.Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-slate-400" />
          <p>
            <span className="font-medium text-slate-700">Score:</span> 10 = nombre, teléfono,
            correo, dirección, web y actividad reciente; se restan puntos por lo que falta o está
            viejo.{" "}
            <span className="whitespace-nowrap">9–10 Completo</span> ·{" "}
            <span className="whitespace-nowrap">7–8 Bueno</span> ·{" "}
            <span className="whitespace-nowrap">4–6 Incompleto</span> ·{" "}
            <span className="whitespace-nowrap">1–3 Pobre</span>.
          </p>
        </div>
        {sources.length > 0 && (
          <div className="mt-4 flex flex-wrap items-center gap-1.5 border-t border-black/5 pt-3 text-xs">
            <span className="text-slate-400">Fuentes:</span>
            {sources.map((s) => {
              const g = /google/i.test(s.name);
              return (
                <span
                  key={s.name}
                  className={`rounded-full px-2 py-0.5 font-medium ${
                    g ? "bg-amber-50 text-amber-700" : "bg-indigo-50 text-indigo-700"
                  }`}
                  title={g ? "Solo referencia: no se exporta ni se guarda" : undefined}
                >
                  {s.name} · {s.count}
                  {g && " (referencia)"}
                </span>
              );
            })}
          </div>
        )}
      </header>

      {/* KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Kpi icon={<Icon.Target className="h-3.5 w-3.5" />} label="Prospectos" value={stats.total} />
        <Kpi
          icon={<Icon.Mail className="h-3.5 w-3.5" />}
          label="Con correo"
          value={stats.withEmail}
          total={stats.total}
        />
        <Kpi
          icon={<Icon.Phone className="h-3.5 w-3.5" />}
          label="Con teléfono"
          value={stats.withPhone}
          total={stats.total}
        />
        <Kpi
          icon={<Icon.WhatsApp className="h-3.5 w-3.5" />}
          label="Con WhatsApp"
          value={stats.withWhatsapp}
          total={stats.total}
        />
      </div>

      {/* Resumen de la IA */}
      {summary && (summary.overview || summary.insights?.length || summary.nextSteps?.length) ? (
        <section
          aria-labelledby="rr-resumen"
          className="rounded-2xl border border-black/5 bg-white p-5 shadow-apple-sm sm:p-6"
        >
          <h3 id="rr-resumen" className="mb-3 flex items-center gap-1.5 text-sm font-semibold text-slate-900">
            <Icon.Sparkles className="h-4 w-4 text-violet-500" /> Resumen de la IA
          </h3>
          {summary.overview && <Markdown text={summary.overview} />}
          {(summary.insights?.length > 0 || summary.nextSteps?.length > 0) && (
            <div className="mt-5 grid gap-4 md:grid-cols-2">
              {summary.insights?.length > 0 && (
                <div className="rounded-xl bg-slate-50 p-4">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">
                    <Icon.Lightbulb className="h-3.5 w-3.5 text-amber-500" /> Hallazgos
                  </p>
                  <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700 marker:text-slate-300">
                    {summary.insights.map((t, i) => (
                      <li key={i}>
                        <Inline text={t} />
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {summary.nextSteps?.length > 0 && (
                <div className="rounded-xl bg-indigo-50/60 p-4">
                  <p className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-indigo-700">
                    <Icon.ArrowRight className="h-3.5 w-3.5" /> Próximos pasos
                  </p>
                  <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700 marker:text-indigo-400">
                    {summary.nextSteps.map((t, i) => (
                      <li key={i}>
                        <Inline text={t} />
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </div>
          )}
        </section>
      ) : null}

      {results.length === 0 ? (
        <EmptyState
          icon={<Icon.Search className="h-8 w-8" />}
          title="El agente no encontró prospectos"
          sub="Prueba con una zona más amplia, otro giro o menos condiciones."
        >
          {onRetry && (
            <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-60"
            >
              {retrying ? <Icon.Loader className="h-4 w-4" /> : <Icon.Refresh className="h-4 w-4" />}
              Reintentar
            </button>
          )}
        </EmptyState>
      ) : (
        <>
          {/* Mapa */}
          <section
            aria-labelledby="rr-mapa"
            className="overflow-hidden rounded-2xl border border-black/5 bg-white shadow-apple-sm"
          >
            <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
              <h3 id="rr-mapa" className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
                <Icon.MapIcon className="h-4 w-4 text-slate-400" /> Mapa
                <span className="font-normal text-slate-400">
                  · {plural(mapPoints.length, "punto", "puntos")}
                </span>
              </h3>
              {googleTotal > 0 && (
                <p className="text-xs text-amber-700">
                  {plural(googleTotal, "resultado", "resultados")} de Google no se muestran en el mapa
                  (términos de Google).
                </p>
              )}
            </div>
            {mapPoints.length > 0 ? (
              <div className="relative isolate z-0 h-72 sm:h-96">
                <MapView points={mapPoints} onSelect={focusCard} />
              </div>
            ) : (
              <p className="px-4 pb-4 text-sm text-slate-400">Ningún prospecto exportable trae ubicación.</p>
            )}
          </section>

          {/* Lista rankeada */}
          <section aria-labelledby="rr-lista">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <h3 id="rr-lista" className="text-sm font-semibold text-slate-900">
                Ranking{" "}
                <span className="font-normal text-slate-400">
                  · {visible.length} de {results.length}, por score
                </span>
              </h3>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filtros rápidos">
                {(Object.keys(FILTER_LABEL) as (keyof Filters)[]).map((k) => (
                  <button
                    key={k}
                    type="button"
                    aria-pressed={filters[k]}
                    onClick={() => {
                      setFilters((f) => ({ ...f, [k]: !f[k] }));
                      setLimit(PAGE);
                    }}
                    className={`rounded-full px-3 py-1.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                      filters[k]
                        ? "bg-indigo-600 text-white shadow-apple-sm"
                        : "border border-black/10 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    {FILTER_LABEL[k]}
                  </button>
                ))}
              </div>
            </div>

            {visible.length === 0 ? (
              <EmptyState
                icon={<Icon.Search className="h-8 w-8" />}
                title="Ningún prospecto con esos filtros"
                sub="Quita algún filtro para ver más."
              >
                <button
                  type="button"
                  onClick={() => setFilters(NO_FILTERS)}
                  className="rounded-full border border-black/10 bg-white px-4 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Quitar filtros
                </button>
              </EmptyState>
            ) : (
              <div className="space-y-3">
                {shown.map((p) => (
                  <ProspectCard
                    key={p.id}
                    p={p}
                    rank={results.indexOf(p) + 1}
                    me={me}
                    checked={selected.has(p.id)}
                    onToggle={() => toggle(p.id)}
                    saved={savedIds.has(p.id)}
                    saving={savingId === p.id}
                    onSave={() => saveOne(p)}
                    onCompose={() => setCompose({ lead: toBusiness(p, city), body: p.opener })}
                    highlighted={highlight === p.id}
                  />
                ))}
                {visible.length > shown.length && (
                  <div className="flex justify-center pt-1">
                    <button
                      type="button"
                      onClick={() => setLimit((l) => l + PAGE)}
                      className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-apple-sm hover:bg-slate-50"
                    >
                      <Icon.Plus className="h-4 w-4" /> Mostrar {Math.min(PAGE, visible.length - shown.length)} más
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Barra de acciones (fija abajo mientras recorres la lista) */}
            <div className="sticky bottom-3 z-10 mt-4 rounded-2xl border border-black/5 bg-white/90 p-3 shadow-apple backdrop-blur-xl">
              <div aria-live="polite">
                {notice && (
                  <div
                    className={`mb-2 flex items-start gap-2 rounded-xl px-3 py-2 text-sm ${
                      notice.tone === "ok"
                        ? "bg-emerald-50 text-emerald-800"
                        : notice.tone === "warn"
                          ? "bg-amber-50 text-amber-800"
                          : "bg-rose-50 text-rose-700"
                    }`}
                  >
                    <div className="min-w-0 flex-1">
                      <p className="break-words">{notice.text}</p>
                      {notice.detail && notice.detail.length > 0 && (
                        <ul className="mt-1 list-disc pl-4 text-xs opacity-80">
                          {notice.detail.map((d, i) => (
                            <li key={i} className="break-words">
                              {d}
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                    <button
                      type="button"
                      onClick={() => setNotice(null)}
                      aria-label="Cerrar aviso"
                      className="rounded p-0.5 opacity-60 hover:opacity-100"
                    >
                      <Icon.X className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex cursor-pointer items-center gap-2 rounded-full px-2 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={toggleAll}
                    disabled={exportableVisible.length === 0}
                    className="h-4 w-4 rounded accent-indigo-600"
                  />
                  Seleccionar todo
                  {selectedIds.length > 0 && (
                    <span className="text-slate-400">({selectedIds.length})</span>
                  )}
                </label>
                {selectedIds.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setSelected(new Set())}
                    className="text-xs text-slate-400 hover:text-slate-700 hover:underline"
                  >
                    Limpiar
                  </button>
                )}
                <div className="ml-auto flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={doCsv}
                    disabled={!!busy || targetCount === 0}
                    className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"
                  >
                    {busy === "csv" ? <Icon.Loader className="h-3.5 w-3.5" /> : <Icon.Download className="h-3.5 w-3.5" />}
                    Descargar CSV ({targetCount})
                  </button>
                  <button
                    type="button"
                    onClick={doSaveAll}
                    disabled={!!busy || targetCount === 0}
                    className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 disabled:opacity-50"
                  >
                    {busy === "save" ? <Icon.Loader className="h-3.5 w-3.5" /> : <Icon.Bookmark className="h-3.5 w-3.5" />}
                    Guardar en Prospectos ({targetCount})
                  </button>
                  <button
                    type="button"
                    onClick={doGhl}
                    disabled={!!busy || targetCount === 0}
                    className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-3.5 py-1.5 text-xs font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 disabled:opacity-50"
                  >
                    {busy === "ghl" ? <Icon.Loader className="h-3.5 w-3.5" /> : <Icon.Send className="h-3.5 w-3.5" />}
                    Enviar a GHL ({targetCount})
                  </button>
                </div>
              </div>
              <p className="mt-1.5 px-2 text-[11px] text-slate-400">
                {selectedIds.length
                  ? "Las acciones aplican a los seleccionados."
                  : filtered
                    ? "Sin selección: aplican a los visibles con estos filtros."
                    : "Sin selección: aplican a todos los prospectos exportables."}
                {googleTotal > 0 &&
                  ` ${plural(googleTotal, "resultado", "resultados")} de Google ${
                    googleTotal === 1 ? "es" : "son"
                  } solo referencia: no se exportan, no van a GHL ni se guardan completos.`}
              </p>
            </div>
          </section>
        </>
      )}

      <footer className="pt-1 text-center text-[11px] text-slate-400">
        Datos: DENUE (INEGI) · © OpenStreetMap contributors · Google solo como referencia
      </footer>

      {compose && (
        <ComposeModal
          lead={compose.lead}
          initialBody={compose.body}
          onClose={() => setCompose(null)}
          onSent={() => onChanged?.()}
        />
      )}
    </div>
  );
}
