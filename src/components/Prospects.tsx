"use client";

import { useEffect, useState, type Dispatch, type SetStateAction } from "react";
import type { DataSource, Lead, LeadStatus, Me, OwnerFilter } from "@/lib/types";
import { LEAD_STATUSES, isGoogleOnly, sourceOf } from "@/lib/types";
import {
  deleteLead,
  fetchAllLeads,
  linkDenue,
  patchLead,
  suppressEmail,
  useLeadList,
  type LeadFilters,
} from "@/lib/useLeads";
import { downloadCSV, personName, shortDate } from "@/lib/format";
import LeadCard, { canEditLead } from "@/components/LeadCard";
import MapView from "@/components/MapView";
import { EmptyState, Segmented, SkeletonCard, STATUS_META } from "@/components/ui";
import * as Icon from "@/components/icons";

export const PAGE_SIZE = 30;

export interface ProspectFilters {
  q: string;
  status: LeadStatus | null;
  owner: OwnerFilter;
  page: number;
  view: "lista" | "mapa";
}

export const DEFAULT_PROSPECT_FILTERS: ProspectFilters = {
  q: "",
  status: null,
  owner: "mine",
  page: 1,
  view: "lista",
};

// Aviso de lo que no se exporta por los términos de Google.
export function googleSkipNote(n: number): string {
  return n === 1
    ? "1 de Google no se exporta por sus términos; vincúlalo con DENUE."
    : `${n} de Google no se exportan por sus términos; vincúlalas con DENUE.`;
}

// Sube prospectos a GHL en tandas (para no topar el tiempo de la función).
async function pushToGhl(
  list: Lead[],
  onProgress?: (done: number, total: number) => void
): Promise<string> {
  let pushed = 0;
  let skipped = 0;
  let failed = 0;
  let google = 0;
  const CHUNK = 50;
  for (let i = 0; i < list.length; i += CHUNK) {
    const res = await fetch("/api/ghl/contacts", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ leads: list.slice(i, i + CHUNK) }),
    });
    const d = await res.json().catch(() => ({}));
    if (!res.ok) {
      const before = pushed ? ` (${pushed} enviados antes del error)` : "";
      throw new Error((d.error || "No se pudo enviar a GHL.") + before);
    }
    pushed += d.pushed ?? 0;
    skipped += d.skipped ?? 0;
    failed += d.failed ?? 0;
    google += d.googleSkipped ?? 0;
    onProgress?.(Math.min(i + CHUNK, list.length), list.length);
  }
  return (
    `GHL: ${pushed} contacto(s) enviados` +
    (skipped ? `, ${skipped} sin correo/teléfono` : "") +
    (failed ? `, ${failed} con error` : "") +
    "." +
    (google ? " " + googleSkipNote(google) : "")
  );
}

const CSV_HEADER = [
  "Score",
  "Nombre",
  "Giro",
  "Ciudad",
  "Estatus",
  "Vendedor",
  "Contactado por",
  "Contactado el",
  "Correo",
  "Teléfono",
  "Web",
  "Dirección",
  "Nota",
  "Fuente",
];

// Atribución por fila (INEGI pide citar la fuente).
const CSV_SOURCE: Record<DataSource, string> = {
  denue: "INEGI, DENUE",
  osm: "© OpenStreetMap contributors",
  google: "",
  web: "Sitio web del negocio",
};

function csvRow(l: Lead) {
  return [
    l.score,
    l.name,
    l.category,
    l.city,
    STATUS_META[l.status]?.label ?? l.status,
    l.ownerEmail ? personName(l.ownerEmail) : "Sin asignar",
    l.contactedBy ? personName(l.contactedBy) : "",
    shortDate(l.contactedAt),
    l.email,
    l.phone,
    l.website,
    l.address,
    l.note,
    l.denueId ? CSV_SOURCE.denue : CSV_SOURCE[sourceOf(l)],
  ];
}

type Busy = { kind: "csv" | "ghl"; done: number; total: number } | null;

export default function Prospects({
  me,
  filters,
  setFilters,
  refreshKey,
  waTemplateBody,
  onCompose,
  onChanged,
}: {
  me: Me | null;
  filters: ProspectFilters;
  setFilters: Dispatch<SetStateAction<ProspectFilters>>;
  refreshKey: number;
  waTemplateBody?: string;
  onCompose: (l: Lead) => void;
  onChanged: () => void; // algo cambió (contador de la pestaña, resultados de búsqueda)
}) {
  const [qInput, setQInput] = useState(filters.q);
  const [localKey, setLocalKey] = useState(0);
  const [busy, setBusy] = useState<Busy>(null);
  // Aviso tras exportar (p. ej. cuántos de Google se omitieron).
  const [exportNote, setExportNote] = useState<string | null>(null);
  const reload = () => setLocalKey((k) => k + 1);

  // Buscador con debounce (~300 ms).
  useEffect(() => {
    const q = qInput.trim();
    if (q === filters.q) return;
    const t = setTimeout(() => setFilters((f) => ({ ...f, q, page: 1 })), 300);
    return () => clearTimeout(t);
  }, [qInput, filters.q, setFilters]);

  const listFilters: LeadFilters = {
    q: filters.q,
    status: filters.status,
    owner: filters.owner,
  };
  const { data, error, loading, patchLocal, removeLocal } = useLeadList(
    { ...listFilters, page: filters.page, pageSize: PAGE_SIZE },
    `${refreshKey}:${localKey}`
  );
  const leads = data?.leads ?? [];
  const total = data?.total ?? 0;
  const counts = data?.counts;
  // Rango según la página que realmente llegó (no la que se está pidiendo).
  const from = leads.length && data ? (data.page - 1) * data.pageSize + 1 : 0;
  const to = leads.length ? from + leads.length - 1 : 0;
  const statusSum = counts ? LEAD_STATUSES.reduce((a, s) => a + (counts.byStatus[s] ?? 0), 0) : 0;
  const filtered = !!filters.q || !!filters.status;

  const set = (patch: Partial<ProspectFilters>) =>
    setFilters((f) => ({ ...f, page: 1, ...patch }));

  function goPage(page: number) {
    setFilters((f) => ({ ...f, page }));
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function clearFilters() {
    setQInput("");
    set({ q: "", status: null });
  }

  // Tras un cambio en el servidor: recarga la página y avisa al padre.
  function afterChange() {
    reload();
    onChanged();
  }

  function fail(msg?: string) {
    alert(msg || "No se pudo completar la acción.");
  }

  /* ---------- Acciones por prospecto ---------- */

  async function changeStatus(l: Lead, s: LeadStatus) {
    if (s === l.status) return;
    const firstContact =
      s === "contactado" && !l.contactedBy && me
        ? { contactedBy: me.email, contactedAt: new Date().toISOString() }
        : {};
    patchLocal(l.id, { status: s, ...firstContact });
    const r = await patchLead(l.id, { status: s });
    if (!r.ok) fail(r.error);
    else if (r.lead) patchLocal(l.id, r.lead);
    afterChange();
  }

  async function saveNote(l: Lead, note: string): Promise<boolean> {
    const prev = l.note;
    patchLocal(l.id, { note: note || undefined });
    const r = await patchLead(l.id, { note });
    if (!r.ok) {
      patchLocal(l.id, { note: prev });
      return false;
    }
    return true;
  }

  async function saveEmail(l: Lead, email: string): Promise<boolean> {
    const r = await patchLead(l.id, { email });
    if (!r.ok) {
      fail(r.error);
      return false;
    }
    patchLocal(l.id, r.lead ?? { email });
    return true;
  }

  async function claim(l: Lead) {
    if (me) patchLocal(l.id, { ownerEmail: me.email });
    const r = await patchLead(l.id, { claim: true });
    if (!r.ok) fail(r.error);
    afterChange();
  }

  async function reassign(l: Lead) {
    const v = prompt(
      `Correo del vendedor que trabajará “${l.name}” (déjalo vacío para dejarlo sin asignar):`,
      l.ownerEmail ?? ""
    );
    if (v === null) return;
    const r = await patchLead(l.id, { owner: v.trim().toLowerCase() || null });
    if (!r.ok) return fail(r.error);
    if (r.lead) patchLocal(l.id, r.lead);
    afterChange();
  }

  async function suppress(l: Lead) {
    if (!l.email) return;
    if (
      !confirm(
        `¿Dar de baja ${l.email}? No se le volverá a escribir y el prospecto quedará como descartado.`
      )
    )
      return;
    const r = await suppressEmail(l.email, "Marcado por vendedor");
    if (!r.ok) return fail(r.error);
    patchLocal(l.id, { status: "descartado" });
    afterChange();
  }

  async function remove(l: Lead) {
    if (!confirm(`¿Quitar “${l.name}” de prospectos? Se borra para todo el equipo.`)) return;
    removeLocal(l.id);
    const r = await deleteLead(l.id);
    if (!r.ok) fail(r.error);
    // Si la página quedó vacía, regresa una.
    if (r.ok && leads.length === 1 && filters.page > 1) goPage(filters.page - 1);
    afterChange();
  }

  async function ghlOne(l: Lead) {
    if (isGoogleOnly(l)) return fail(googleSkipNote(1));
    try {
      alert(await pushToGhl([l]));
    } catch (e) {
      fail((e as Error).message);
    }
  }

  // Solo-Google -> busca el mismo negocio en DENUE y completa sus datos.
  async function linkOne(l: Lead) {
    const r = await linkDenue(l.id);
    if (!r.ok) return fail(r.error);
    if (r.lead) patchLocal(l.id, r.lead);
    if (!r.matched) alert(r.message || "No encontré este negocio en DENUE.");
    else afterChange();
  }

  /* ---------- Acciones sobre todo el filtro ---------- */

  async function exportAll() {
    if (!total || busy) return;
    setBusy({ kind: "csv", done: 0, total });
    try {
      const all = await fetchAllLeads(listFilters, (done, t) =>
        setBusy({ kind: "csv", done, total: t })
      );
      // Términos de Google: sus filas no se exportan.
      const rows = all.filter((l) => !isGoogleOnly(l));
      const google = all.length - rows.length;
      if (rows.length) downloadCSV("prospectos.csv", CSV_HEADER, rows.map(csvRow));
      setExportNote(
        google
          ? (rows.length ? "" : "No hay nada que exportar. ") + googleSkipNote(google)
          : null
      );
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  async function ghlAll() {
    if (!total || busy) return;
    if (!confirm(`¿Enviar a GHL los ${total} prospecto(s) de este filtro?`)) return;
    setBusy({ kind: "ghl", done: 0, total });
    try {
      const all = await fetchAllLeads(listFilters);
      // Solo los que puedo trabajar (los de otro vendedor se saltan) y sin
      // contenido de Google (sus términos no permiten exportarlo).
      const google = all.filter((l) => isGoogleOnly(l)).length;
      const open = all.filter((l) => !isGoogleOnly(l));
      const mineToo = open.filter((l) => canEditLead(l, me));
      const others = open.length - mineToo.length;
      if (!mineToo.length) {
        fail(
          google && !open.length
            ? `No hay nada que enviar. ${googleSkipNote(google)}`
            : "Todos los prospectos de este filtro los trabaja otro vendedor."
        );
        return;
      }
      setBusy({ kind: "ghl", done: 0, total: mineToo.length });
      const msg = await pushToGhl(mineToo, (done, t) => setBusy({ kind: "ghl", done, total: t }));
      alert(
        msg +
          (others ? ` Se omitieron ${others} de otros vendedores.` : "") +
          (google ? " " + googleSkipNote(google) : "")
      );
    } catch (e) {
      fail((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  const ownerLabel = (label: string, n?: number) => (n == null ? label : `${label} (${n})`);

  return (
    <section>
      {/* Barra: buscador, dueño, vista y acciones */}
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="flex min-w-[220px] flex-1 items-center gap-2 rounded-full border border-black/5 bg-white px-3 shadow-apple-sm focus-within:ring-2 focus-within:ring-indigo-500">
          {loading && data ? (
            <Icon.Loader className="h-4 w-4 shrink-0 text-indigo-500" />
          ) : (
            <Icon.Search className="h-4 w-4 shrink-0 text-slate-400" />
          )}
          <input
            value={qInput}
            onChange={(e) => setQInput(e.target.value)}
            aria-label="Buscar prospectos"
            placeholder="Buscar por nombre, correo, teléfono o ciudad"
            className="min-w-0 flex-1 border-0 bg-transparent py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400"
          />
          {qInput && (
            <button
              onClick={() => setQInput("")}
              title="Limpiar búsqueda"
              className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            >
              <Icon.X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>

        <Segmented<OwnerFilter>
          value={filters.owner}
          onChange={(owner) => set({ owner })}
          options={[
            { value: "mine", label: ownerLabel("Míos", counts?.mine), title: "Prospectos que trabajas tú" },
            { value: "all", label: ownerLabel("Todos", counts?.all), title: "Todo el equipo" },
            {
              value: "unassigned",
              label: ownerLabel("Sin asignar", counts?.unassigned),
              title: "Prospectos sin vendedor: tómalos",
            },
          ]}
        />

        <Segmented<"lista" | "mapa">
          value={filters.view}
          onChange={(view) => setFilters((f) => ({ ...f, view }))}
          options={[
            {
              value: "lista",
              label: (
                <>
                  <Icon.List className="h-3.5 w-3.5" /> Lista
                </>
              ),
            },
            {
              value: "mapa",
              label: (
                <>
                  <Icon.MapIcon className="h-3.5 w-3.5" /> Mapa
                </>
              ),
            },
          ]}
        />

        <button
          onClick={exportAll}
          disabled={!total || !!busy}
          title="Descargar todos los prospectos de este filtro"
          className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          <Icon.Download className="h-3.5 w-3.5" />
          {busy?.kind === "csv" ? `Exportando… ${busy.done}/${busy.total}` : `CSV (${total})`}
        </button>
        <button
          onClick={ghlAll}
          disabled={!total || !!busy}
          title="Enviar a GHL todos los prospectos de este filtro"
          className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          <Icon.Send className="h-3.5 w-3.5" />
          {busy?.kind === "ghl"
            ? `Enviando… ${busy.done}/${busy.total}`
            : `Enviar a GHL (${total})`}
        </button>
      </div>

      {/* Chips de estatus con conteo */}
      <div className="mb-4 flex flex-wrap items-center gap-1.5">
        <StatusChip
          active={!filters.status}
          label="Todos"
          count={counts ? statusSum : undefined}
          onClick={() => set({ status: null })}
        />
        {LEAD_STATUSES.map((s) => (
          <StatusChip
            key={s}
            active={filters.status === s}
            label={STATUS_META[s].label}
            dot={STATUS_META[s].dot}
            count={counts?.byStatus[s]}
            onClick={() => set({ status: filters.status === s ? null : s })}
          />
        ))}
        {total > 0 && (
          <span className="ml-auto text-xs font-medium text-slate-500">
            {from}–{to} de {total}
          </span>
        )}
      </div>

      {error && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          {error}
        </p>
      )}

      {exportNote && (
        <div className="mb-4 flex items-start justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>{exportNote}</span>
          <button
            onClick={() => setExportNote(null)}
            title="Cerrar aviso"
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full text-amber-700 hover:bg-amber-100"
          >
            <Icon.X className="h-3.5 w-3.5" />
          </button>
        </div>
      )}

      {/* Primera carga */}
      {!data && loading && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <SkeletonCard key={i} />
          ))}
        </div>
      )}

      {data && leads.length > 0 && filters.view === "mapa" && (
        <div className="h-[70vh] overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
          <MapView points={leads} />
        </div>
      )}

      {data && leads.length > 0 && filters.view === "lista" && (
        <div
          className={`grid gap-3 transition-opacity sm:grid-cols-2 lg:grid-cols-3 ${
            loading ? "opacity-60" : ""
          }`}
        >
          {leads.map((l) => (
            <LeadCard
              key={l.id}
              l={l}
              me={me}
              waTemplateBody={waTemplateBody}
              onStatus={(s) => changeStatus(l, s)}
              onNote={(n) => saveNote(l, n)}
              onEmail={(e) => saveEmail(l, e)}
              onClaim={() => claim(l)}
              onReassign={me?.isAdmin ? () => reassign(l) : undefined}
              onSuppress={() => suppress(l)}
              onRemove={() => remove(l)}
              onCompose={() => onCompose(l)}
              onGhl={() => ghlOne(l)}
              onLinkDenue={() => linkOne(l)}
            />
          ))}
        </div>
      )}

      {/* Paginación */}
      {data && total > PAGE_SIZE && (
        <div className="mt-6 flex items-center justify-between gap-3">
          <span className="text-sm text-slate-500">
            {from}–{to} de {total}
          </span>
          <div className="flex gap-2">
            <button
              onClick={() => goPage(filters.page - 1)}
              disabled={filters.page <= 1 || loading}
              className="flex items-center gap-1 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              <Icon.ChevronLeft className="h-3.5 w-3.5" /> Anterior
            </button>
            <button
              onClick={() => goPage(filters.page + 1)}
              disabled={to >= total || loading}
              className="flex items-center gap-1 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
            >
              Siguiente <Icon.ChevronRight className="h-3.5 w-3.5" />
            </button>
          </div>
        </div>
      )}

      {/* Estados vacíos */}
      {data && !loading && leads.length === 0 && (
        <>
          {filters.page > 1 && total > 0 ? (
            <EmptyState
              icon={<Icon.List className="h-8 w-8" />}
              title="Esta página quedó vacía"
              sub="Los prospectos cambiaron mientras navegabas."
            >
              <EmptyButton onClick={() => goPage(1)}>Ir a la primera página</EmptyButton>
            </EmptyState>
          ) : filtered ? (
            <EmptyState
              icon={<Icon.Search className="h-8 w-8" />}
              title="Sin resultados"
              sub="Ningún prospecto coincide con la búsqueda o el estatus elegido."
            >
              <EmptyButton onClick={clearFilters}>Limpiar filtros</EmptyButton>
            </EmptyState>
          ) : filters.owner === "mine" && (counts?.all ?? 0) > 0 ? (
            <EmptyState
              icon={<Icon.User className="h-8 w-8" />}
              title="Aún no tienes prospectos"
              sub="Guarda negocios desde Buscar o toma alguno que nadie esté trabajando."
            >
              {(counts?.unassigned ?? 0) > 0 && (
                <EmptyButton onClick={() => set({ owner: "unassigned" })}>
                  Ver sin asignar ({counts?.unassigned})
                </EmptyButton>
              )}
              <EmptyButton onClick={() => set({ owner: "all" })}>Ver todos</EmptyButton>
            </EmptyState>
          ) : filters.owner === "unassigned" ? (
            <EmptyState
              icon={<Icon.Users className="h-8 w-8" />}
              title="Nada sin asignar"
              sub="Todos los prospectos guardados ya tienen vendedor."
            />
          ) : (
            <EmptyState
              icon={<Icon.Bookmark className="h-8 w-8" />}
              title="Aún no guardas prospectos"
              sub="Búscalos y dale “Guardar” para armar tu lista."
            />
          )}
        </>
      )}
    </section>
  );
}

function StatusChip({
  active,
  label,
  count,
  dot,
  onClick,
}: {
  active: boolean;
  label: string;
  count?: number;
  dot?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
        active
          ? "bg-indigo-600 text-white shadow-apple-sm"
          : "border border-black/10 bg-white text-slate-600 hover:bg-slate-50"
      }`}
    >
      {dot && <span className={`h-1.5 w-1.5 rounded-full ${active ? "bg-white" : dot}`} />}
      {label}
      {count != null && (
        <span className={active ? "text-white/80" : "text-slate-400"}>{count}</span>
      )}
    </button>
  );
}

function EmptyButton({ onClick, children }: { onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
    >
      {children}
    </button>
  );
}
