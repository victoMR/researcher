"use client";

import { useEffect, useState } from "react";
import type { ResearchRunListItem, ResearchStatus } from "@/lib/research-types";
import type { Me } from "@/lib/types";
import { firstName, timeAgo } from "@/lib/format";
import { Segmented } from "@/components/ui";
import * as Icon from "@/components/icons";
import { listResearch } from "./api";
import { plural } from "./util";

type Scope = "mine" | "all";
const REFRESH_MS = 5000; // mientras haya alguna corriendo

interface ListState {
  scope: Scope;
  runs: ResearchRunListItem[];
  error: string | null;
}

function StatusDot({ status }: { status: ResearchStatus }) {
  if (status === "running") {
    return (
      <span className="relative mt-1.5 flex h-2.5 w-2.5 shrink-0" title="En curso">
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-indigo-400 opacity-75" />
        <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-indigo-500" />
        <span className="sr-only">En curso</span>
      </span>
    );
  }
  const err = status === "error";
  return (
    <span
      className={`mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full ${err ? "bg-rose-400" : "bg-emerald-500"}`}
      title={err ? "Con error" : "Terminada"}
    >
      <span className="sr-only">{err ? "Con error" : "Terminada"}</span>
    </span>
  );
}

// Historial de investigaciones (Mías / Todas). Se refresca solo mientras alguna
// sigue corriendo.
export default function ResearchHistory({
  me,
  onOpen,
}: {
  me: Me | null;
  onOpen: (id: string) => void;
}) {
  const [scope, setScope] = useState<Scope>("mine");
  const [data, setData] = useState<ListState | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ctrl = new AbortController();
    let anyRunning = false;
    async function load() {
      const r = await listResearch(scope, ctrl.signal);
      if (!alive) return;
      setData((prev) => ({
        scope,
        runs: r.ok ? r.data : prev?.scope === scope ? prev.runs : [],
        error: r.ok ? null : r.error,
      }));
      if (r.ok) anyRunning = r.data.some((x) => x.status === "running");
      // Si falla la red con algo corriendo, se reintenta más despacio.
      if (anyRunning) timer = setTimeout(load, r.ok ? REFRESH_MS : REFRESH_MS * 3);
    }
    void load();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      ctrl.abort();
    };
  }, [scope]);

  const cur = data?.scope === scope ? data : null;
  const runs = cur?.runs ?? [];

  return (
    <aside
      aria-labelledby="rh-title"
      className="rounded-2xl border border-black/5 bg-white p-4 shadow-apple-sm lg:sticky lg:top-20 lg:self-start"
    >
      <div className="mb-3 flex items-center justify-between gap-2">
        <h3 id="rh-title" className="flex items-center gap-1.5 text-sm font-semibold text-slate-900">
          <Icon.Clock className="h-4 w-4 text-slate-400" /> Historial
        </h3>
        <Segmented<Scope>
          value={scope}
          onChange={setScope}
          options={[
            { value: "mine", label: "Mías" },
            { value: "all", label: "Todas", title: "Investigaciones de todo el equipo" },
          ]}
        />
      </div>

      {!cur ? (
        <div className="space-y-2" aria-busy="true">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-12 animate-pulse rounded-xl bg-slate-50" />
          ))}
        </div>
      ) : runs.length === 0 ? (
        <p className={`rounded-xl px-3 py-6 text-center text-sm ${cur.error ? "text-amber-700" : "text-slate-400"}`}>
          {cur.error ||
            (scope === "mine"
              ? "Aún no has investigado nada. Tus investigaciones aparecerán aquí."
              : "Nadie del equipo ha investigado todavía.")}
        </p>
      ) : (
        <>
          {cur.error && <p className="mb-2 text-xs text-amber-700">{cur.error}</p>}
          <ul className="-mx-2 max-h-[65vh] space-y-0.5 overflow-y-auto">
            {runs.map((r) => {
              const by =
                scope === "all" && r.createdBy
                  ? r.createdBy === me?.email
                    ? "Tú"
                    : firstName(r.createdBy)
                  : null;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => onOpen(r.id)}
                    className="flex w-full items-start gap-2.5 rounded-xl px-2 py-2 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                  >
                    <StatusDot status={r.status} />
                    <span className="min-w-0 flex-1">
                      <span className="line-clamp-2 text-sm font-medium text-slate-800">
                        {r.title || r.prompt}
                      </span>
                      <span className="mt-0.5 block text-[11px] text-slate-400">
                        {r.status === "running"
                          ? "Investigando…"
                          : r.status === "error"
                            ? "Con error"
                            : plural(r.count ?? 0, "prospecto", "prospectos")}
                        {" · "}
                        {timeAgo(r.createdAt)}
                        {by && ` · ${by}`}
                      </span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </aside>
  );
}
