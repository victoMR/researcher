"use client";

import { useEffect, useRef, useState, type ComponentType, type SVGProps } from "react";
import type { ResearchProgress } from "@/lib/research-types";
import * as Icon from "@/components/icons";
import { clockTime, duration } from "./util";

type Kind = ResearchProgress["kind"];

const KIND: Record<Kind, { icon: ComponentType<SVGProps<SVGSVGElement>>; cls: string; label: string }> = {
  think: { icon: Icon.Sparkles, cls: "bg-violet-50 text-violet-600", label: "Razonando" },
  tool: { icon: Icon.Search, cls: "bg-indigo-50 text-indigo-600", label: "Consultando" },
  info: { icon: Icon.Check, cls: "bg-emerald-50 text-emerald-600", label: "Avance" },
  warn: { icon: Icon.AlertTriangle, cls: "bg-amber-50 text-amber-600", label: "Aviso" },
};

// Reloj que avanza cada segundo (solo mientras corre). Arranca en null para no
// leer la hora durante el render.
function useNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return active ? now : null;
}

// Línea de tiempo tipo "agente trabajando": cada paso con su icono y hora; el
// último, animado mientras la investigación sigue.
export default function ResearchTimeline({
  progress,
  running,
  startedAt,
  compact = false,
}: {
  progress: ResearchProgress[];
  running: boolean;
  startedAt?: string;
  compact?: boolean;
}) {
  const listRef = useRef<HTMLOListElement>(null);
  const now = useNow(running);
  const started = startedAt ? Date.parse(startedAt) : NaN;
  const elapsed = now != null && Number.isFinite(started) ? duration(now - started) : null;

  // Mantiene a la vista el paso más reciente.
  useEffect(() => {
    if (!running) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [progress.length, running]);

  return (
    <div>
      {running && (
        <div className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1">
          <span className="flex items-center gap-2 text-sm font-semibold text-slate-900">
            <span className="flex gap-1" aria-hidden>
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-500 [animation-delay:-0.3s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-500 [animation-delay:-0.15s]" />
              <span className="h-2 w-2 animate-bounce rounded-full bg-indigo-500" />
            </span>
            El agente está investigando…
          </span>
          {elapsed && <span className="text-xs tabular-nums text-slate-400">{elapsed}</span>}
        </div>
      )}

      {progress.length === 0 ? (
        <p className="text-sm text-slate-400" aria-live="polite">
          {running ? "Preparando el plan de búsqueda…" : "Sin actividad registrada."}
        </p>
      ) : (
        <ol
          ref={listRef}
          role="log"
          aria-live="polite"
          aria-label="Actividad del agente"
          className={`${compact ? "" : "max-h-[55vh]"} overflow-y-auto pr-1`}
        >
          {progress.map((s, i) => {
            const last = i === progress.length - 1;
            const active = running && last;
            const meta = KIND[s.kind] ?? KIND.info;
            const KindIcon = meta.icon;
            return (
              <li key={`${s.at}-${i}`} className="relative flex gap-3 pb-3 last:pb-0 animate-[fadeIn_0.3s_ease]">
                {!last && (
                  <span aria-hidden className="absolute bottom-0 left-[13px] top-7 w-px bg-slate-200" />
                )}
                <span
                  className={`relative z-10 grid h-7 w-7 shrink-0 place-items-center rounded-full ${meta.cls}`}
                  title={meta.label}
                >
                  {active && (
                    <span aria-hidden className="absolute inset-0 animate-ping rounded-full bg-indigo-400/30" />
                  )}
                  {active ? <Icon.Loader className="h-3.5 w-3.5" /> : <KindIcon className="h-3.5 w-3.5" />}
                  <span className="sr-only">{meta.label}: </span>
                </span>
                <div className="min-w-0 flex-1 pt-1">
                  <p
                    className={`break-words text-sm ${
                      active
                        ? "font-medium text-slate-900"
                        : s.kind === "warn"
                          ? "text-amber-800"
                          : "text-slate-600"
                    }`}
                  >
                    {s.message}
                  </p>
                  <time dateTime={s.at} className="text-[11px] tabular-nums text-slate-400">
                    {clockTime(s.at)}
                  </time>
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
