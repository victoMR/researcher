"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import type { Business, Lead, LeadStatus } from "./types";
import { dedupeKey } from "./dedupe";

export function useLeads() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [ready, setReady] = useState(false);

  // Carga inicial desde la base de datos.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/leads");
        const data = await res.json();
        if (alive && res.ok) setLeads(data.leads ?? []);
      } catch {
        /* sin conexión: queda vacío */
      } finally {
        if (alive) setReady(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, []);

  const savedIds = useMemo(() => new Set(leads.map((l) => l.id)), [leads]);
  const savedKeys = useMemo(
    () => new Set(leads.map((l) => dedupeKey(l.name, l.city))),
    [leads]
  );

  // Acepta id (string) o el negocio completo (para dedupe por nombre+ciudad).
  const isSaved = useCallback(
    (b: Business | string) => {
      if (typeof b === "string") return savedIds.has(b);
      return savedIds.has(b.id) || savedKeys.has(dedupeKey(b.name, b.city));
    },
    [savedIds, savedKeys]
  );

  const addLead = useCallback(
    async (b: Business) => {
      if (savedIds.has(b.id) || savedKeys.has(dedupeKey(b.name, b.city))) return;
      // Optimista: lo mostramos guardado de inmediato.
      const optimistic: Lead = { ...b, status: "nuevo", savedAt: Date.now() };
      setLeads((prev) => [optimistic, ...prev]);
      try {
        const res = await fetch("/api/leads", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ business: b, city: b.city }),
        });
        const data = await res.json();
        if (res.ok && data.lead) {
          // Reemplaza el optimista con el real (dedup por id).
          setLeads((prev) => [
            data.lead,
            ...prev.filter((l) => l.id !== b.id && l.id !== data.lead.id),
          ]);
        } else {
          setLeads((prev) => prev.filter((l) => l.id !== b.id));
        }
      } catch {
        setLeads((prev) => prev.filter((l) => l.id !== b.id));
      }
    },
    [savedIds, savedKeys]
  );

  const removeLead = useCallback(async (id: string) => {
    setLeads((prev) => prev.filter((l) => l.id !== id));
    try {
      await fetch(`/api/leads/${encodeURIComponent(id)}`, { method: "DELETE" });
    } catch {
      /* ignora */
    }
  }, []);

  const updateLead = useCallback(
    async (id: string, patch: Partial<Lead>) => {
      setLeads((prev) => prev.map((l) => (l.id === id ? { ...l, ...patch } : l)));
      try {
        await fetch(`/api/leads/${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            status: patch.status,
            note: patch.note,
            email: patch.email,
          }),
        });
      } catch {
        /* ignora */
      }
    },
    []
  );

  const clearAll = useCallback(async () => {
    setLeads([]);
    try {
      await fetch("/api/leads", { method: "DELETE" });
    } catch {
      /* ignora */
    }
  }, []);

  return { leads, ready, isSaved, addLead, removeLead, updateLead, clearAll };
}

export type { Lead, LeadStatus };
