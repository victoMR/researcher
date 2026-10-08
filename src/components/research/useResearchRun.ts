"use client";

import { useEffect, useState } from "react";
import type { ResearchRun } from "@/lib/research-types";
import { fetchRun } from "./api";

const POLL_MS = 2000;
const HIDDEN_POLL_MS = 6000; // pestaña del navegador oculta: consulta menos
const MAX_BACKOFF_MS = 20000;

interface RunState {
  id: string;
  run: ResearchRun | null;
  error: string | null; // error definitivo (no existe, sin permiso...)
  offline: boolean; // falló la red: se sigue reintentando
}

// Lee una investigación y la consulta cada 2 s mientras está corriendo. El
// polling se detiene al terminar, al fallar de forma definitiva o al desmontar.
// Los setState solo ocurren tras un `await` (nunca síncronos en el efecto).
export function useResearchRun(id: string) {
  const [state, setState] = useState<RunState | null>(null);

  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let ctrl: AbortController | undefined;
    let fails = 0;

    const next = (ms: number) => {
      if (alive) timer = setTimeout(tick, ms);
    };

    async function tick() {
      ctrl = new AbortController();
      const r = await fetchRun(id, ctrl.signal);
      if (!alive) return;
      if (r.ok) {
        fails = 0;
        setState({ id, run: r.run, error: null, offline: false });
        if (r.run.status === "running") {
          next(document.visibilityState === "hidden" ? HIDDEN_POLL_MS : POLL_MS);
        }
        return;
      }
      if (r.fatal) {
        setState((s) => ({
          id,
          run: s?.id === id ? s.run : null,
          error: r.error,
          offline: false,
        }));
        return;
      }
      fails += 1;
      setState((s) => ({ id, run: s?.id === id ? s.run : null, error: null, offline: true }));
      next(Math.min(POLL_MS * 2 ** fails, MAX_BACKOFF_MS));
    }

    void tick();
    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    };
  }, [id]);

  const cur = state?.id === id ? state : null;
  return {
    run: cur?.run ?? null,
    error: cur?.error ?? null,
    offline: cur?.offline ?? false,
  };
}
