"use client";

import { useState } from "react";
import type { Me } from "@/lib/types";
import * as Icon from "@/components/icons";
import ResearchReport, { ReportSkeleton } from "./ResearchReport";
import ResearchTimeline from "./ResearchTimeline";
import { startResearch } from "./api";
import { useResearchRun } from "./useResearchRun";
import { plural } from "./util";

// Una investigación: mientras corre, la actividad del agente; al terminar, el
// reporte; si falla, el error con "Reintentar" (relanza el mismo prompt).
export default function ResearchRunView({
  id,
  me,
  standalone = false,
  onOpen,
  onBack,
  onChanged,
}: {
  id: string;
  me: Me | null;
  standalone?: boolean;
  onOpen: (id: string) => void; // abrir otra corrida (p. ej. al reintentar)
  onBack?: () => void;
  onChanged?: () => void;
}) {
  const { run, error, offline } = useResearchRun(id);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);

  async function retry(prompt: string) {
    if (retrying) return;
    setRetrying(true);
    setRetryError(null);
    const r = await startResearch(prompt);
    setRetrying(false);
    if (r.ok) onOpen(r.data.id);
    else setRetryError(r.error);
  }

  const backButton = onBack && (
    <button
      type="button"
      onClick={onBack}
      className="flex items-center gap-1.5 rounded-full px-2 py-1 text-sm font-medium text-slate-500 hover:bg-black/[0.04] hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
    >
      <Icon.ArrowLeft className="h-4 w-4" /> Investigaciones
    </button>
  );

  const retryNote = retryError && (
    <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      {retryError}
    </p>
  );

  // No se pudo leer (no existe, sin permiso, sin BD...).
  if (error && !run) {
    return (
      <div className="space-y-4">
        {backButton}
        <div role="alert" className="flex flex-col items-center rounded-2xl border border-dashed border-black/10 bg-white px-6 py-14 text-center">
          <Icon.AlertTriangle className="mb-3 h-8 w-8 text-amber-500" />
          <h3 className="font-semibold text-slate-800">No se pudo abrir la investigación</h3>
          <p className="mt-1 max-w-md text-sm text-slate-500">{error}</p>
        </div>
      </div>
    );
  }

  if (!run) {
    return (
      <div className="space-y-4" aria-busy="true">
        {backButton}
        <p className="sr-only" role="status">
          Cargando investigación…
        </p>
        <ReportSkeleton />
      </div>
    );
  }

  // Ya teníamos datos: un error definitivo después (p. ej. sesión vencida) o
  // la red caída se avisan sin perder lo que ya se ve.
  const offlineNote = error ? (
    <p role="alert" className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-800">
      {error}
    </p>
  ) : offline ? (
    <p role="status" className="flex items-center gap-2 rounded-xl bg-amber-50 px-4 py-2 text-xs text-amber-800">
      <Icon.Loader className="h-3.5 w-3.5" /> Sin conexión con el servidor; reintentando…
    </p>
  ) : null;

  if (run.status === "running") {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {backButton}
        {offlineNote}
        <div className="flex justify-end">
          <p className="max-w-[85%] rounded-2xl rounded-br-md bg-indigo-600 px-4 py-2.5 text-sm text-white shadow-apple-sm">
            {run.prompt}
          </p>
        </div>
        <section className="rounded-2xl border border-black/5 bg-white p-5 shadow-apple-sm" aria-busy="true">
          <ResearchTimeline progress={run.progress} running startedAt={run.createdAt} />
        </section>
        <p className="text-center text-xs text-slate-400">
          Puedes salir de aquí: la investigación sigue en segundo plano y la encuentras en el
          historial.
        </p>
      </div>
    );
  }

  const processLog =
    run.progress.length > 0 ? (
      <details className="group rounded-2xl border border-black/5 bg-white px-5 py-3 shadow-apple-sm">
        <summary className="flex cursor-pointer list-none items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 [&::-webkit-details-marker]:hidden">
          <Icon.ChevronRight className="h-4 w-4 transition group-open:rotate-90" />
          Cómo lo investigó el agente
          <span className="font-normal text-slate-400">· {plural(run.progress.length, "paso", "pasos")}</span>
        </summary>
        <div className="mt-3">
          <ResearchTimeline progress={run.progress} running={false} compact />
        </div>
      </details>
    ) : null;

  if (run.status === "error") {
    return (
      <div className="mx-auto max-w-3xl space-y-4">
        {backButton}
        <div role="alert" className="rounded-2xl border border-rose-200 bg-white p-6 shadow-apple-sm">
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-rose-50 text-rose-600">
              <Icon.AlertTriangle className="h-5 w-5" />
            </span>
            <div className="min-w-0">
              <h3 className="font-semibold text-slate-900">La investigación no se pudo completar</h3>
              <p className="mt-1 break-words text-sm text-slate-600">
                {run.error || "El agente se detuvo por un error inesperado."}
              </p>
              <p className="mt-2 line-clamp-3 text-xs italic text-slate-400">«{run.prompt}»</p>
              <div className="mt-4 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={() => retry(run.prompt)}
                  disabled={retrying}
                  className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 disabled:opacity-60"
                >
                  {retrying ? <Icon.Loader className="h-4 w-4" /> : <Icon.Refresh className="h-4 w-4" />}
                  Reintentar
                </button>
                {onBack && (
                  <button
                    type="button"
                    onClick={onBack}
                    className="rounded-full border border-black/10 px-4 py-2 text-sm font-medium text-slate-600 hover:bg-slate-50"
                  >
                    Volver
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
        {retryNote}
        {processLog}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {backButton}
      {retryNote}
      <ResearchReport
        run={run}
        me={me}
        standalone={standalone}
        onRetry={() => retry(run.prompt)}
        retrying={retrying}
        onChanged={onChanged}
      />
      {processLog}
    </div>
  );
}
