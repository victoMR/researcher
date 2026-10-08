"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type {
  Business,
  Lead,
  LeadMatch,
  LeadStatus,
  LeadsPage,
  OwnerFilter,
} from "./types";
import { dedupeKey } from "./dedupe";

/* ---------- Llamadas a la API (cliente) ---------- */

export interface ApiResult {
  ok: boolean;
  lead?: Lead;
  error?: string;
}

async function readJson(res: Response): Promise<Record<string, unknown>> {
  try {
    return (await res.json()) as Record<string, unknown>;
  } catch {
    return {};
  }
}

// PATCH /api/leads/[id]: status, note, email, claim, owner (admin).
export async function patchLead(
  id: string,
  body: {
    status?: LeadStatus;
    note?: string;
    email?: string;
    claim?: boolean;
    owner?: string | null;
  }
): Promise<ApiResult> {
  try {
    const res = await fetch(`/api/leads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const d = await readJson(res);
    if (!res.ok) return { ok: false, error: (d.error as string) || "No se pudo actualizar." };
    return { ok: true, lead: d.lead as Lead | undefined };
  } catch {
    return { ok: false, error: "Error de red al actualizar." };
  }
}

// "Vincular con DENUE" (prospectos solo-Google): el servidor busca el mismo
// negocio en DENUE y, si lo encuentra, completa el prospecto con esos datos.
export async function linkDenue(
  id: string
): Promise<ApiResult & { matched?: boolean; message?: string }> {
  try {
    const res = await fetch(`/api/leads/${encodeURIComponent(id)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ linkDenue: true }),
    });
    const d = await readJson(res);
    if (!res.ok) return { ok: false, error: (d.error as string) || "No se pudo vincular." };
    return {
      ok: true,
      lead: d.lead as Lead | undefined,
      matched: !!d.matched,
      message: d.message as string | undefined,
    };
  } catch {
    return { ok: false, error: "Error de red al vincular con DENUE." };
  }
}

export async function deleteLead(id: string): Promise<ApiResult> {
  try {
    const res = await fetch(`/api/leads/${encodeURIComponent(id)}`, { method: "DELETE" });
    const d = await readJson(res);
    if (!res.ok) return { ok: false, error: (d.error as string) || "No se pudo quitar." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Error de red al quitar." };
  }
}

// Lista de baja: el servidor marca como 'descartado' los prospectos con ese correo.
export async function suppressEmail(email: string, reason: string): Promise<ApiResult> {
  try {
    const res = await fetch("/api/suppression", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email, reason }),
    });
    const d = await readJson(res);
    if (!res.ok) return { ok: false, error: (d.error as string) || "No se pudo dar de baja." };
    return { ok: true };
  } catch {
    return { ok: false, error: "Error de red al dar de baja." };
  }
}

export interface EmailLookup {
  emails: string[];
  guesses: string[];
  socials: string[];
  error?: string;
}

// Busca correos en la web del negocio.
export async function lookupEmails(website: string): Promise<EmailLookup> {
  try {
    const res = await fetch("/api/extract-email", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ website }),
    });
    const d = await readJson(res);
    const arr = (v: unknown) => (Array.isArray(v) ? (v as string[]) : []);
    return {
      emails: arr(d.emails),
      guesses: arr(d.guesses),
      socials: arr(d.socials),
      error: res.ok ? undefined : (d.error as string) || "No se pudo revisar la web.",
    };
  } catch {
    return { emails: [], guesses: [], socials: [], error: "Error de red al revisar la web." };
  }
}

export interface LeadFilters {
  q: string;
  status: LeadStatus | null;
  owner: OwnerFilter;
}

function leadsQuery(f: LeadFilters, page: number, pageSize: number): string {
  const p = new URLSearchParams();
  if (f.q) p.set("q", f.q);
  if (f.status) p.set("status", f.status);
  p.set("owner", f.owner);
  p.set("page", String(page));
  p.set("pageSize", String(pageSize));
  return `/api/leads?${p.toString()}`;
}

// Trae TODAS las páginas del filtro actual (para CSV / GHL).
export async function fetchAllLeads(
  f: LeadFilters,
  onProgress?: (done: number, total: number) => void
): Promise<Lead[]> {
  const out: Lead[] = [];
  for (let page = 1; page <= 100; page++) {
    const res = await fetch(leadsQuery(f, page, 200));
    const d = (await readJson(res)) as Partial<LeadsPage> & { error?: string };
    if (!res.ok) throw new Error(d.error || "No se pudieron leer los prospectos.");
    const batch = d.leads ?? [];
    out.push(...batch);
    onProgress?.(out.length, d.total ?? out.length);
    if (!batch.length || out.length >= (d.total ?? 0)) break;
  }
  return out;
}

// Prospectos míos (para el contador de la pestaña).
async function fetchMineCount(): Promise<number | null> {
  try {
    const res = await fetch("/api/leads?owner=mine&pageSize=0");
    if (!res.ok) return null;
    const d = (await res.json()) as LeadsPage;
    return d.counts?.mine ?? null;
  } catch {
    return null;
  }
}

/* ---------- Resultados de búsqueda vs. guardados ---------- */

const kKey = (key: string) => `k:${key}`;
const kId = (id: string) => `i:${id}`;

function toMatch(l: Lead, key: string): LeadMatch {
  return {
    key,
    id: l.id,
    ownerEmail: l.ownerEmail ?? null,
    status: l.status,
    contactedBy: l.contactedBy ?? null,
    contactedAt: l.contactedAt ?? null,
    placeId: l.placeId ?? null,
    denueId: l.denueId ?? null,
  };
}

// Sabe qué resultados ya están guardados (y con quién) sin cargar todos los
// prospectos: pregunta a /api/leads/check por las dedupe keys de los resultados.
export function useSavedMatches(meEmail?: string | null) {
  const [map, setMap] = useState<Record<string, LeadMatch>>({});
  const [mineCount, setMineCount] = useState<number | null>(null);
  const seq = useRef(0);

  useEffect(() => {
    let alive = true;
    fetchMineCount().then((n) => {
      if (alive && n != null) setMineCount(n);
    });
    return () => {
      alive = false;
    };
  }, []);

  const refreshCount = useCallback(() => {
    fetchMineCount().then((n) => {
      if (n != null) setMineCount(n);
    });
  }, []);

  // mode: "reset" = búsqueda nueva (limpia ya), "refresh" = vuelve a consultar
  // los mismos resultados (reemplaza al llegar, sin parpadeo), "merge" = agrega.
  const check = useCallback(
    async (list: Business[], mode: "reset" | "refresh" | "merge" = "merge") => {
      const my = mode === "merge" ? seq.current : ++seq.current;
      if (mode === "reset") setMap({});
      if (!list.length) {
        if (mode === "refresh") setMap({});
        return;
      }
      try {
        const res = await fetch("/api/leads/check", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            keys: list.map((b) => dedupeKey(b.name, b.city)),
            ids: list.map((b) => b.id),
          }),
        });
        const d = (await res.json()) as { matches?: LeadMatch[] };
        if (my !== seq.current) return; // llegó tarde: ya hay otra búsqueda
        const next: Record<string, LeadMatch> = {};
        for (const m of d.matches ?? []) {
          next[kKey(m.key)] = m;
          next[kId(m.id)] = m;
          // Un resultado de Google/DENUE guardado con otro id (p. ej. vinculado).
          if (m.placeId) next[kId(`place/${m.placeId}`)] = m;
          if (m.denueId) next[kId(`denue/${m.denueId}`)] = m;
        }
        setMap((prev) => (mode === "refresh" ? next : { ...prev, ...next }));
      } catch {
        /* sin conexión: quedan como estaban */
      }
    },
    []
  );

  const matchFor = useCallback(
    (b: Business): LeadMatch | undefined =>
      map[kId(b.id)] ?? map[kKey(dedupeKey(b.name, b.city))],
    [map]
  );

  // Reemplaza la coincidencia de un negocio (por id y por key).
  const put = useCallback((b: Business, m: LeadMatch | null) => {
    const key = dedupeKey(b.name, b.city);
    setMap((prev) => {
      const next = { ...prev };
      if (m) {
        next[kKey(key)] = m;
        next[kId(b.id)] = m;
        next[kId(m.id)] = m;
      } else {
        delete next[kKey(key)];
        delete next[kId(b.id)];
      }
      return next;
    });
  }, []);

  // Guarda con actualización optimista. Devuelve el error, si hubo.
  const addLead = useCallback(
    async (b: Business): Promise<string | null> => {
      const key = dedupeKey(b.name, b.city);
      put(b, {
        key,
        id: b.id,
        ownerEmail: meEmail ?? null,
        status: "nuevo",
        contactedBy: null,
        contactedAt: null,
      });
      try {
        const res = await fetch("/api/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ business: b, city: b.city }),
        });
        const d = await readJson(res);
        if (res.ok && d.lead) {
          put(b, toMatch(d.lead as Lead, key));
          refreshCount();
          return null;
        }
        put(b, null);
        return (d.error as string) || "No se pudo guardar.";
      } catch {
        put(b, null);
        return "Error de red al guardar.";
      }
    },
    [meEmail, put, refreshCount]
  );

  // Tomar un prospecto sin dueño desde la tarjeta de resultado.
  const claim = useCallback(
    async (b: Business, m: LeadMatch): Promise<string | null> => {
      const r = await patchLead(m.id, { claim: true });
      if (r.lead) put(b, toMatch(r.lead, m.key));
      if (!r.ok) return r.error ?? "No se pudo tomar.";
      refreshCount();
      return null;
    },
    [put, refreshCount]
  );

  // Actualiza un campo de un prospecto ya guardado (p. ej. el correo hallado).
  const updateSaved = useCallback(
    async (b: Business, m: LeadMatch, body: { email?: string }) => {
      const r = await patchLead(m.id, body);
      if (r.lead) put(b, toMatch(r.lead, m.key));
      return r;
    },
    [put]
  );

  return { matchFor, check, addLead, claim, updateSaved, mineCount, refreshCount };
}

/* ---------- Lista paginada de Prospectos ---------- */

interface ListState {
  key: string;
  data: LeadsPage | null;
  error: string | null;
}

// Pide al servidor la página actual con filtros. Mantiene los datos previos
// mientras carga la siguiente (sin parpadeo).
export function useLeadList(
  f: LeadFilters & { page: number; pageSize: number },
  refreshKey: string | number
) {
  const url = leadsQuery({ q: f.q, status: f.status, owner: f.owner }, f.page, f.pageSize);
  const reqKey = `${url}#${refreshKey}`;
  const [state, setState] = useState<ListState>({ key: "", data: null, error: null });

  useEffect(() => {
    const ctrl = new AbortController();
    fetch(url, { signal: ctrl.signal })
      .then(async (res) => {
        const d = (await readJson(res)) as Partial<LeadsPage> & { error?: string };
        if (res.ok) setState({ key: reqKey, data: d as LeadsPage, error: null });
        else
          setState((s) => ({
            key: reqKey,
            data: s.data,
            error: d.error || "No se pudieron cargar los prospectos.",
          }));
      })
      .catch(() => {
        if (ctrl.signal.aborted) return;
        setState((s) => ({
          key: reqKey,
          data: s.data,
          error: "Error de red al cargar prospectos.",
        }));
      });
    return () => ctrl.abort();
  }, [url, reqKey]);

  // Cambio local optimista (ajusta también los conteos por estado).
  const patchLocal = useCallback((id: string, patch: Partial<Lead>) => {
    setState((s) => {
      if (!s.data) return s;
      const prev = s.data.leads.find((l) => l.id === id);
      if (!prev) return s;
      const byStatus = { ...s.data.counts.byStatus };
      if (patch.status && patch.status !== prev.status) {
        byStatus[prev.status] = Math.max(0, (byStatus[prev.status] ?? 0) - 1);
        byStatus[patch.status] = (byStatus[patch.status] ?? 0) + 1;
      }
      return {
        ...s,
        data: {
          ...s.data,
          counts: { ...s.data.counts, byStatus },
          leads: s.data.leads.map((l) => (l.id === id ? { ...l, ...patch } : l)),
        },
      };
    });
  }, []);

  const removeLocal = useCallback((id: string) => {
    setState((s) =>
      s.data
        ? {
            ...s,
            data: {
              ...s.data,
              total: Math.max(0, s.data.total - 1),
              leads: s.data.leads.filter((l) => l.id !== id),
            },
          }
        : s
    );
  }, []);

  return {
    data: state.data,
    error: state.key === reqKey ? state.error : null,
    loading: state.key !== reqKey,
    patchLocal,
    removeLocal,
  };
}

export type { Lead, LeadStatus };
