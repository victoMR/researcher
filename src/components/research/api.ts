// Llamadas del navegador a /api/research (contrato con el backend del agente).
import type { ResearchRun, ResearchRunListItem } from "@/lib/research-types";

export type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface GhlPushResult {
  pushed: number;
  skipped: number;
  failed: number;
  skippedGoogle: number;
  errors: string[];
}

const JSON_HEADERS = { "Content-Type": "application/json" };

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    const d = await res.json();
    return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Mensaje claro según el código si el servidor no manda `error`.
function errorFrom(res: Response, d: Record<string, unknown>, fallback: string): string {
  if (typeof d.error === "string" && d.error.trim()) return d.error;
  switch (res.status) {
    case 401:
      return "Tu sesión expiró. Vuelve a iniciar sesión.";
    case 403:
      return "No tienes permiso para ver esta investigación.";
    case 404:
      return "No encontré esa investigación.";
    case 429:
      return "Llegaste al tope diario de investigaciones. Intenta de nuevo mañana.";
    case 503:
      return "El agente no está disponible: falta configurar la IA o la base de datos.";
    default:
      return fallback;
  }
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

function errorList(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((e) => {
      if (typeof e === "string") return e;
      if (e && typeof e === "object") {
        const o = e as Record<string, unknown>;
        const msg = o.error ?? o.message;
        const who = o.name ?? o.id;
        if (typeof msg === "string") return typeof who === "string" ? `${who}: ${msg}` : msg;
      }
      return "";
    })
    .filter(Boolean);
}

export async function startResearch(prompt: string): Promise<Result<{ id: string }>> {
  try {
    const res = await fetch("/api/research", {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify({ prompt }),
    });
    const d = await readJson(res);
    if (!res.ok) {
      return { ok: false, error: errorFrom(res, d, "No se pudo iniciar la investigación.") };
    }
    if (typeof d.id !== "string" || !d.id) {
      return { ok: false, error: "El servidor no devolvió la investigación." };
    }
    return { ok: true, data: { id: d.id } };
  } catch {
    return { ok: false, error: "Error de red. Intenta de nuevo." };
  }
}

export async function listResearch(
  scope: "mine" | "all",
  signal?: AbortSignal
): Promise<Result<ResearchRunListItem[]>> {
  try {
    const res = await fetch(`/api/research?scope=${scope}`, { signal, cache: "no-store" });
    const d = await readJson(res);
    if (!res.ok) {
      return { ok: false, error: errorFrom(res, d, "No se pudo cargar el historial.") };
    }
    return { ok: true, data: Array.isArray(d.runs) ? (d.runs as ResearchRunListItem[]) : [] };
  } catch {
    return { ok: false, error: "Error de red al cargar el historial." };
  }
}

// `fatal`: no tiene caso reintentar (no existe, sin permiso, sin BD...).
export async function fetchRun(
  id: string,
  signal?: AbortSignal
): Promise<{ ok: true; run: ResearchRun } | { ok: false; error: string; fatal: boolean }> {
  try {
    const res = await fetch(`/api/research/${encodeURIComponent(id)}`, {
      signal,
      cache: "no-store",
    });
    const d = await readJson(res);
    if (!res.ok) {
      const transient = res.status === 408 || res.status === 429 || (res.status >= 500 && res.status !== 503);
      return {
        ok: false,
        error: errorFrom(res, d, "No se pudo cargar la investigación."),
        fatal: !transient,
      };
    }
    const run = d.run as ResearchRun | undefined;
    if (!run || typeof run !== "object" || !run.id) {
      return { ok: false, error: "Respuesta inválida del servidor.", fatal: true };
    }
    return {
      ok: true,
      run: { ...run, progress: Array.isArray(run.progress) ? run.progress : [] },
    };
  } catch {
    return { ok: false, error: "Error de red.", fatal: false };
  }
}

// Nombre del archivo desde Content-Disposition (si viene).
function filenameFrom(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const star = /filename\*\s*=\s*UTF-8''([^;]+)/i.exec(header);
  if (star) {
    try {
      return decodeURIComponent(star[1].trim().replace(/"/g, ""));
    } catch {
      /* usa el siguiente */
    }
  }
  const plain = /filename\s*=\s*"?([^";]+)"?/i.exec(header);
  return plain?.[1]?.trim() || fallback;
}

// Descarga el CSV vía fetch -> blob (así podemos leer el aviso de Google).
export async function downloadResearchCsv(
  id: string,
  ids?: string[]
): Promise<Result<{ omittedGoogle: number }>> {
  try {
    const qs = ids?.length ? `?ids=${ids.map(encodeURIComponent).join(",")}` : "";
    const res = await fetch(`/api/research/${encodeURIComponent(id)}/csv${qs}`, {
      cache: "no-store",
    });
    if (!res.ok) {
      const d = await readJson(res);
      return { ok: false, error: errorFrom(res, d, "No se pudo generar el CSV.") };
    }
    const omittedGoogle = Number(res.headers.get("X-Omitidos-Google") || 0) || 0;
    const blob = await res.blob();
    const name = filenameFrom(res.headers.get("Content-Disposition"), `investigacion-${id}.csv`);
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, data: { omittedGoogle } };
  } catch {
    return { ok: false, error: "Error de red al descargar el CSV." };
  }
}

export async function pushResearchToGhl(
  id: string,
  ids?: string[]
): Promise<Result<GhlPushResult>> {
  try {
    const res = await fetch(`/api/research/${encodeURIComponent(id)}/ghl`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(ids?.length ? { ids } : {}),
    });
    const d = await readJson(res);
    if (!res.ok) return { ok: false, error: errorFrom(res, d, "No se pudo enviar a GHL.") };
    return {
      ok: true,
      data: {
        pushed: num(d.pushed),
        skipped: num(d.skipped),
        failed: num(d.failed),
        skippedGoogle: num(d.skippedGoogle),
        errors: errorList(d.errors),
      },
    };
  } catch {
    return { ok: false, error: "Error de red al enviar a GHL." };
  }
}

export async function saveResearch(
  id: string,
  ids?: string[]
): Promise<Result<{ saved: number; skipped: number }>> {
  try {
    const res = await fetch(`/api/research/${encodeURIComponent(id)}/save`, {
      method: "POST",
      headers: JSON_HEADERS,
      body: JSON.stringify(ids?.length ? { ids } : {}),
    });
    const d = await readJson(res);
    if (!res.ok) {
      return { ok: false, error: errorFrom(res, d, "No se pudo guardar en Prospectos.") };
    }
    return { ok: true, data: { saved: num(d.saved), skipped: num(d.skipped) } };
  } catch {
    return { ok: false, error: "Error de red al guardar." };
  }
}
