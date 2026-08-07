"use client";

import { useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import type { Template } from "@/lib/templates-repo";
import { CATEGORIES, getCategory } from "@/lib/categories";
import type { Business, Lead, LeadStatus } from "@/lib/types";
import { useLeads } from "@/lib/useLeads";
import { waLink } from "@/lib/wa";
import { applyVars } from "@/lib/apply-template";
import ComposeModal from "@/components/ComposeModal";
import StatusTicker from "@/components/StatusTicker";
import Select from "@/components/Select";
import Dashboard from "@/components/Dashboard";
import Templates from "@/components/Templates";
import * as Icon from "@/components/icons";

const CAT_ICON: Record<string, React.ReactNode> = {
  autos_nuevos: <Icon.Car className="h-4 w-4 text-slate-500" />,
  seminuevos: <Icon.Car className="h-4 w-4 text-slate-500" />,
  inmobiliarias: <Icon.Building className="h-4 w-4 text-slate-500" />,
  talleres: <Icon.Wrench className="h-4 w-4 text-slate-500" />,
};

// Un negocio es "activo" si su reseña más reciente es de los últimos 6 meses.
const ACTIVE_WINDOW_MS = 1000 * 60 * 60 * 24 * 180;
function isRecent(iso?: string): boolean {
  if (!iso) return false;
  return Date.now() - Date.parse(iso) <= ACTIVE_WINDOW_MS;
}

const SORT_OPTIONS = [
  { value: "score", label: "Mejor prospecto" },
  { value: "activos", label: "Más activos" },
  { value: "resenas", label: "Más reseñas" },
  { value: "rating", label: "Mejor calificados" },
];

// Calificación de prospecto 1..10 con las señales que tenemos:
// calidad de reseñas Google + actividad reciente + facilidad de contacto + redes.
function scoreLead(b: Business, hasSocial: boolean): number {
  let s = 0;
  // Calidad de calificación (máx 3)
  if (b.rating != null) s += (b.rating / 5) * 3;
  // Volumen de reseñas = confianza (máx 2)
  if (b.reviewCount != null) s += Math.min(b.reviewCount / 40, 1) * 2;
  // Actividad reciente / redes actualizadas (máx 2)
  if (b.lastReviewTime) {
    const days = (Date.now() - Date.parse(b.lastReviewTime)) / 86400000;
    s += days <= 30 ? 2 : days <= 90 ? 1.5 : days <= 180 ? 1 : days <= 365 ? 0.5 : 0;
  }
  // Facilidad de contacto (máx 3): teléfono + web/redes + correo
  if (b.phone) s += 1;
  if (b.website || hasSocial) s += 1;
  if (b.email) s += 1;
  return Math.max(1, Math.min(10, Math.round(s)));
}

// Mensaje de WhatsApp: usa la plantilla elegida (con variables) o uno por defecto.
function buildWaText(
  lead: Pick<Business, "name" | "city" | "category">,
  templateBody?: string
): string {
  if (templateBody) return applyVars(templateBody, lead);
  return `Hola, equipo de ${lead.name}. Le escribo de AI Lead Shield: ayudamos a negocios como el suyo a conseguir más clientes con automatización e inteligencia artificial. ¿Tendrían 15 min esta semana para mostrarles cómo?`;
}

function scoreColor(score: number): string {
  if (score >= 8) return "bg-emerald-100 text-emerald-700";
  if (score >= 5) return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-500";
}

// Distancia en km entre dos coordenadas (haversine).
function distanceKm(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

const LeadsMap = dynamic(() => import("@/components/LeadsMap"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center text-sm text-slate-400">
      Cargando mapa…
    </div>
  ),
});

type Tab = "buscar" | "prospectos" | "plantillas" | "metricas";
type View = "lista" | "mapa";

const STATUS_META: Record<LeadStatus, { label: string; cls: string }> = {
  nuevo: { label: "Nuevo", cls: "bg-slate-100 text-slate-600" },
  contactado: { label: "Contactado", cls: "bg-indigo-100 text-indigo-700" },
  respondio: { label: "Respondió", cls: "bg-emerald-100 text-emerald-700" },
  descartado: { label: "Descartado", cls: "bg-rose-100 text-rose-700" },
};

export default function Home() {
  const [tab, setTab] = useState<Tab>("buscar");
  const [view, setView] = useState<View>("lista");
  const [city, setCity] = useState("");
  const [category, setCategory] = useState(CATEGORIES[0].slug);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [results, setResults] = useState<Business[]>([]);
  const [source, setSource] = useState<string | null>(null);
  const [searchedCity, setSearchedCity] = useState("");
  const [extracting, setExtracting] = useState<Record<string, boolean>>({});
  const [compose, setCompose] = useState<Business | null>(null);
  const [onlyActive, setOnlyActive] = useState(false);
  const [sortBy, setSortBy] = useState("score");
  const [socials, setSocials] = useState<Record<string, string[]>>({});
  const [autoProgress, setAutoProgress] = useState<{ done: number; total: number } | null>(null);
  const [mode, setMode] = useState<"google" | "general">("google");
  const [userCoords, setUserCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);

  // Carga plantillas (para usarlas en WhatsApp y en la propuesta). Se refresca
  // al volver a Buscar/Prospectos por si creaste plantillas nuevas.
  useEffect(() => {
    if (tab !== "buscar" && tab !== "prospectos") return;
    fetch("/api/templates")
      .then((r) => r.json())
      .then((d) => setTemplates(d.templates ?? []))
      .catch(() => {});
  }, [tab]);

  // Plantilla por defecto para WhatsApp (whatsapp o ambos).
  const waTemplateBody = useMemo(
    () => templates.find((t) => t.channel === "whatsapp" || t.channel === "ambos")?.body,
    [templates]
  );

  const { leads, ready, isSaved, addLead, removeLead, updateLead, clearAll } =
    useLeads();

  const catLabel = getCategory(category)?.label ?? "";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    window.location.href = "/login";
  }

  const [ghlBusy, setGhlBusy] = useState(false);
  async function pushToGhl(list: Lead[]) {
    if (!list.length) return;
    setGhlBusy(true);
    try {
      const res = await fetch("/api/ghl/contacts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ leads: list }),
      });
      const d = await res.json();
      if (!res.ok) {
        alert(d.error || "No se pudo enviar a GHL.");
      } else {
        alert(
          `GHL: ${d.pushed} contacto(s) enviados` +
            (d.skipped ? `, ${d.skipped} sin correo/teléfono` : "") +
            (d.failed ? `, ${d.failed} con error` : "") +
            "."
        );
      }
    } catch {
      alert("Error de red al enviar a GHL.");
    } finally {
      setGhlBusy(false);
    }
  }

  async function search(e?: React.FormEvent, cityArg?: string) {
    e?.preventDefault();
    const q = (cityArg ?? city).trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    setResults([]);
    setSearchedCity(q);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          city: q,
          category,
          source: mode === "general" ? "osm" : undefined,
          global: mode === "general",
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Error en la búsqueda.");
      } else {
        // Marca la ciudad buscada en cada resultado (para dedupe y guardado).
        const withCity = (data.results as Business[]).map((r) => ({
          ...r,
          city: q,
        }));
        setResults(withCity);
        setSource(data.source || null);
        setSocials({});
        if (!withCity.length)
          setError(
            `No encontré ${catLabel.toLowerCase()} en ${q}. Prueba otra ciudad o giro.`
          );
        else autoExtract(withCity);
      }
    } catch {
      setError("Error de red. Intenta de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  async function extractEmail(b: Business) {
    if (!b.website) return;
    setExtracting((s) => ({ ...s, [b.id]: true }));
    try {
      const res = await fetch("/api/extract-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ website: b.website }),
      });
      const data = await res.json();
      const email: string | undefined = data.emails?.[0];
      if (data.socials?.length)
        setSocials((s) => ({ ...s, [b.id]: data.socials }));
      setResults((rs) =>
        rs.map((r) => (r.id === b.id ? { ...r, email: email ?? "" } : r))
      );
      if (email && isSaved(b)) updateLead(b.id, { email });
    } catch {
      /* ignora */
    } finally {
      setExtracting((s) => ({ ...s, [b.id]: false }));
    }
  }

  // Detecta ubicación del navegador -> ciudad -> busca y ordena por cercanía.
  function geolocate() {
    if (!navigator.geolocation) {
      setError("Tu navegador no permite geolocalización.");
      return;
    }
    // El navegador SOLO permite ubicación en HTTPS o en localhost.
    // Si abriste por la IP de red (192.168.x), el permiso ni aparece.
    if (!window.isSecureContext) {
      setError(
        `La ubicación solo funciona en un sitio seguro. Abre la app en http://localhost:3002 (no por la IP de red ${location.hostname}), o despliégala con HTTPS.`
      );
      return;
    }
    setLocating(true);
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        const { latitude, longitude } = pos.coords;
        setUserCoords({ lat: latitude, lon: longitude });
        try {
          const r = await fetch(
            `/api/reverse?lat=${latitude}&lon=${longitude}`
          );
          const data = await r.json();
          if (r.ok && data.city) {
            setCity(data.city);
            setSortBy("cercanos");
            await search(undefined, data.city);
          } else {
            setError(data.error || "No pude ubicarte.");
          }
        } catch {
          setError("Error obteniendo tu ubicación.");
        } finally {
          setLocating(false);
        }
      },
      (err) => {
        setLocating(false);
        setError(
          err.code === err.PERMISSION_DENIED
            ? "Diste que no al permiso de ubicación. Actívalo para usar “cerca de mí”."
            : "No pude obtener tu ubicación."
        );
      },
      { enableHighAccuracy: false, timeout: 10000 }
    );
  }

  // Saca correos de todos los negocios con web, varios en paralelo, con progreso.
  async function autoExtract(list: Business[]) {
    const queue = list.filter((b) => b.website && b.email === undefined);
    if (!queue.length) return;
    const total = queue.length;
    let done = 0;
    setAutoProgress({ done, total });
    const CONCURRENCY = 5;
    const worker = async () => {
      for (;;) {
        const b = queue.shift();
        if (!b) break;
        await extractEmail(b);
        done += 1;
        setAutoProgress({ done, total });
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    setAutoProgress(null);
  }

  function exportCSV(rows: Business[]) {
    const header = ["Score", "Nombre", "Giro", "Correo", "Teléfono", "Web", "Rating", "Reseñas", "Dirección"];
    const lines = rows.map((r) =>
      [
        r.score ?? "",
        r.name,
        r.category,
        r.email || "",
        r.phone || "",
        r.website || "",
        r.rating ?? "",
        r.reviewCount ?? "",
        r.address || "",
      ]
        .map((v) => `"${String(v).replace(/"/g, '""')}"`)
        .join(",")
    );
    const csv = [header.join(","), ...lines].join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "prospectos.csv";
    a.click();
    URL.revokeObjectURL(url);
  }

  // Resultados con score + distancia (si hay ubicación) + filtro + orden.
  const filteredResults = useMemo(() => {
    let r = results.map((b) => ({
      ...b,
      score: scoreLead(b, (socials[b.id]?.length ?? 0) > 0),
      distanceKm: userCoords
        ? distanceKm(userCoords.lat, userCoords.lon, b.lat, b.lon)
        : undefined,
    }));
    if (onlyActive) r = r.filter((b) => isRecent(b.lastReviewTime));
    const sorted = [...r];
    if (sortBy === "score") {
      sorted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else if (sortBy === "cercanos") {
      sorted.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    } else if (sortBy === "resenas") {
      sorted.sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
    } else if (sortBy === "rating") {
      sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    } else {
      sorted.sort(
        (a, b) =>
          (b.lastReviewTime ? Date.parse(b.lastReviewTime) : 0) -
          (a.lastReviewTime ? Date.parse(a.lastReviewTime) : 0)
      );
    }
    return sorted;
  }, [results, onlyActive, sortBy, userCoords, socials]);

  const sortOptions = useMemo(
    () =>
      userCoords
        ? [{ value: "cercanos", label: "Más cercanos" }, ...SORT_OPTIONS]
        : SORT_OPTIONS,
    [userCoords]
  );

  const activeCount = useMemo(
    () => results.filter((b) => isRecent(b.lastReviewTime)).length,
    [results]
  );
  const hasActivityData = useMemo(
    () => results.some((b) => b.lastReviewTime || b.rating != null),
    [results]
  );

  const rows =
    tab === "buscar" ? filteredResults : tab === "prospectos" ? leads : [];
  const showResults =
    (tab === "buscar" || tab === "prospectos") && rows.length > 0;
  const mapPoints = tab === "buscar" ? filteredResults : (leads as Business[]);

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Barra superior */}
      <header className="sticky top-0 z-20 border-b border-black/5 bg-white/70 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3">
          <div className="flex items-center gap-2.5">
            <span className="grid h-9 w-9 place-items-center rounded-2xl bg-gradient-to-b from-indigo-500 to-indigo-600 text-white shadow-apple-sm">
              <Icon.Shield className="h-5 w-5" />
            </span>
            <div>
              <h1 className="text-base font-semibold leading-tight tracking-tight text-slate-900">
                AI Lead Shield
              </h1>
              <p className="text-xs text-slate-400">Prospección de clientes</p>
            </div>
          </div>
          <nav className="flex gap-1 rounded-full bg-black/[0.04] p-1">
            {(["buscar", "prospectos", "plantillas", "metricas"] as Tab[]).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`rounded-full px-4 py-1.5 text-sm font-medium capitalize transition ${
                  tab === t
                    ? "bg-white text-slate-900 shadow-apple-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {t === "prospectos" && ready && leads.length > 0
                  ? `Prospectos (${leads.length})`
                  : t === "metricas"
                    ? "Métricas"
                    : t}
              </button>
            ))}
            <button
              onClick={logout}
              title="Cerrar sesión"
              className="ml-1 grid h-8 w-8 place-items-center rounded-full text-slate-400 transition hover:bg-black/[0.04] hover:text-slate-700"
            >
              <Icon.LogOut className="h-4 w-4" />
            </button>
          </nav>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {tab === "metricas" && <Dashboard />}
        {tab === "plantillas" && <Templates />}

        {tab === "buscar" && (
          <section className="mx-auto mb-8 max-w-3xl text-center">
            <h2 className="text-4xl font-semibold tracking-[-0.03em] text-slate-900 sm:text-5xl">
              Encuentra clientes potenciales
            </h2>
            <p className="mx-auto mt-3 max-w-xl text-lg tracking-normal text-slate-500">
              Busca negocios por giro y ciudad, localízalos en el mapa, saca su
              correo y mándales propuesta.
            </p>

            <form
              onSubmit={search}
              className="mt-7 flex flex-col gap-2 rounded-[22px] border border-black/5 bg-white p-2 shadow-apple sm:flex-row sm:items-center"
            >
              <Select
                value={category}
                onChange={setCategory}
                className="sm:w-56"
                options={CATEGORIES.map((c) => ({
                  value: c.slug,
                  label: c.label,
                  icon: CAT_ICON[c.slug],
                }))}
              />
              <div className="flex flex-1 items-center gap-1 rounded-xl bg-slate-50 pr-1 focus-within:ring-2 focus-within:ring-indigo-500">
                <input
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Ciudad — ej. Guadalajara, o usa tu ubicación"
                  className="flex-1 rounded-xl border-0 bg-transparent px-4 py-3 text-sm text-slate-900 outline-none placeholder:text-slate-400"
                />
                <button
                  type="button"
                  onClick={geolocate}
                  disabled={locating}
                  title="Buscar cerca de mí"
                  className="shrink-0 rounded-lg px-2.5 py-2 text-slate-500 transition hover:bg-slate-200 disabled:opacity-50"
                >
                  {locating ? (
                    <Icon.Loader className="h-4 w-4" />
                  ) : (
                    <Icon.MapPin className="h-4 w-4" />
                  )}
                </button>
              </div>
              <button
                type="submit"
                disabled={loading}
                className="rounded-full bg-indigo-600 px-7 py-3 text-sm font-semibold text-white transition hover:bg-indigo-700 active:scale-[0.98] disabled:opacity-60"
              >
                {loading ? "Buscando…" : "Buscar"}
              </button>
            </form>

            {/* Selector de modo de búsqueda */}
            <div className="mt-3 flex items-center justify-center gap-2 text-xs">
              <span className="text-slate-400">Modo:</span>
              <div className="flex rounded-full bg-black/[0.04] p-0.5">
                <button
                  onClick={() => setMode("google")}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 font-medium transition ${
                    mode === "google"
                      ? "bg-white text-slate-900 shadow-apple-sm"
                      : "text-slate-500"
                  }`}
                >
                  <Icon.Target className="h-3.5 w-3.5" /> México (Google)
                </button>
                <button
                  onClick={() => setMode("general")}
                  className={`flex items-center gap-1.5 rounded-full px-3 py-1 font-medium transition ${
                    mode === "general"
                      ? "bg-white text-slate-900 shadow-apple-sm"
                      : "text-slate-500"
                  }`}
                >
                  <Icon.Globe className="h-3.5 w-3.5" /> General · mundial (gratis)
                </button>
              </div>
            </div>
            <p className="mt-1 text-center text-xs text-slate-400">
              {mode === "google"
                ? "Mejor cobertura en México. Usa la API de Google."
                : "Cualquier ciudad del mundo con OpenStreetMap. No gasta cuota de Google."}
            </p>
          </section>
        )}

        {/* Barra de resultados */}
        {(showResults || loading) && (
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              {loading ? (
                <StatusTicker
                  messages={[
                    `Ubicando ${searchedCity}…`,
                    `Rastreando ${catLabel.toLowerCase()}…`,
                    "Cruzando teléfonos y sitios web…",
                    "Ordenando los mejores prospectos…",
                  ]}
                />
              ) : (
                <span className="flex items-center text-sm font-medium text-slate-600">
                  {rows.length} {tab === "buscar" ? "negocios" : "prospectos"}
                  {tab === "buscar" && source && (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                      {source === "google" ? "Google" : "OSM (gratis)"}
                    </span>
                  )}
                  {autoProgress && (
                    <span className="ml-2 flex items-center gap-1.5 rounded-full bg-indigo-50 px-2 py-0.5 text-xs font-medium text-indigo-600">
                      <span className="h-1.5 w-1.5 animate-ping rounded-full bg-indigo-500" />
                      Sacando correos {autoProgress.done}/{autoProgress.total}
                    </span>
                  )}
                </span>
              )}
            </div>
            {showResults && (
              <div className="flex flex-wrap items-center gap-2">
                {tab === "buscar" && hasActivityData && (
                  <>
                    <button
                      onClick={() => setOnlyActive((v) => !v)}
                      title="Sólo negocios con reseñas de los últimos 6 meses"
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                        onlyActive
                          ? "bg-emerald-600 text-white shadow-apple-sm"
                          : "border border-black/10 bg-white text-slate-600 hover:bg-slate-50"
                      }`}
                    >
                      <Icon.Flame className="h-3.5 w-3.5" /> Solo activos ({activeCount})
                    </button>
                    <Select
                      value={sortBy}
                      onChange={setSortBy}
                      options={sortOptions}
                      align="right"
                      compact
                      className="w-40"
                    />
                  </>
                )}
                <div className="flex rounded-full bg-black/[0.04] p-0.5">
                  {(["lista", "mapa"] as View[]).map((v) => (
                    <button
                      key={v}
                      onClick={() => setView(v)}
                      className={`flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium capitalize transition ${
                        view === v
                          ? "bg-white text-slate-900 shadow-apple-sm"
                          : "text-slate-500"
                      }`}
                    >
                      {v === "lista" ? (
                        <Icon.List className="h-3.5 w-3.5" />
                      ) : (
                        <Icon.MapIcon className="h-3.5 w-3.5" />
                      )}
                      {v === "lista" ? "Lista" : "Mapa"}
                    </button>
                  ))}
                </div>
                <button
                  onClick={() => exportCSV(rows)}
                  className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  <Icon.Download className="h-3.5 w-3.5" /> CSV
                </button>
                {tab === "prospectos" && (
                  <button
                    onClick={() => pushToGhl(leads)}
                    disabled={ghlBusy}
                    className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                  >
                    <Icon.Send className="h-3.5 w-3.5" />
                    {ghlBusy ? "Enviando…" : "Enviar a GHL"}
                  </button>
                )}
                {tab === "prospectos" && (
                  <button
                    onClick={() => confirm("¿Borrar todos los prospectos?") && clearAll()}
                    className="rounded-full border border-rose-200 bg-white px-3 py-1.5 text-xs font-medium text-rose-600 hover:bg-rose-50"
                  >
                    Vaciar
                  </button>
                )}
              </div>
            )}
          </div>
        )}

        {/* Aviso modo gratis */}
        {tab === "buscar" && !loading && source === "osm" && mode === "google" && (
          <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Estás en <b>modo gratis (OSM)</b>: bueno para agencias de autos, pero
            casi sin datos de seminuevos e inmobiliarias. Agrega tu key de Google
            Places (<code>GOOGLE_PLACES_API_KEY</code>) para cobertura completa.
          </p>
        )}

        {error && !loading && (
          <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}
          </p>
        )}

        {/* Loading skeleton */}
        {loading && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        )}

        {/* Contenido */}
        {!loading && showResults && view === "mapa" && (
          <div className="h-[70vh] overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
            <LeadsMap points={mapPoints} />
          </div>
        )}

        {!loading && showResults && view === "lista" && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {tab === "buscar"
              ? filteredResults.map((b) => (
                  <BusinessCard
                    key={b.id}
                    b={b}
                    city={searchedCity}
                    socials={socials[b.id]}
                    waTemplateBody={waTemplateBody}
                    saved={isSaved(b)}
                    extracting={!!extracting[b.id]}
                    onSave={() => addLead(b)}
                    onExtract={() => extractEmail(b)}
                    onCompose={() => setCompose(b)}
                  />
                ))
              : (leads as Lead[]).map((l) => (
                  <LeadCard
                    key={l.id}
                    l={l}
                    waTemplateBody={waTemplateBody}
                    onStatus={(s) => updateLead(l.id, { status: s })}
                    onRemove={() => removeLead(l.id)}
                    onCompose={() => setCompose(l)}
                    onGhl={() => pushToGhl([l])}
                  />
                ))}
          </div>
        )}

        {/* Estados vacíos */}
        {!loading && !showResults && !error && tab === "buscar" && (
          <EmptyState
            icon={<Icon.Search className="h-8 w-8" />}
            title="Empieza una búsqueda"
            sub="Elige un giro y una ciudad para encontrar negocios."
          />
        )}
        {!loading && !showResults && tab === "prospectos" && (
          <EmptyState
            icon={<Icon.Bookmark className="h-8 w-8" />}
            title="Aún no guardas prospectos"
            sub="Búscalos y dale “Guardar” para armar tu lista."
          />
        )}
      </main>

      {compose && (
        <ComposeModal
          lead={compose}
          onClose={() => setCompose(null)}
          onSent={() =>
            isSaved(compose) && updateLead(compose.id, { status: "contactado" })
          }
        />
      )}
    </div>
  );
}

/* ---------- Subcomponentes ---------- */

function SkeletonCard() {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-slate-200 bg-white p-4">
      <div className="absolute inset-0 -translate-x-full animate-[shimmer_1.5s_infinite] bg-gradient-to-r from-transparent via-slate-100 to-transparent" />
      <div className="mb-3 h-4 w-2/3 rounded bg-slate-100" />
      <div className="mb-2 h-3 w-full rounded bg-slate-100" />
      <div className="mb-4 h-3 w-1/2 rounded bg-slate-100" />
      <div className="flex gap-2">
        <div className="h-7 w-20 rounded-lg bg-slate-100" />
        <div className="h-7 w-20 rounded-lg bg-slate-100" />
      </div>
    </div>
  );
}

function EmptyState({
  icon,
  title,
  sub,
}: {
  icon: React.ReactNode;
  title: string;
  sub: string;
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 bg-white py-16 text-center">
      <span className="mb-3 text-slate-300">{icon}</span>
      <h3 className="font-semibold text-slate-700">{title}</h3>
      <p className="mt-1 text-sm text-slate-400">{sub}</p>
    </div>
  );
}

function CardShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col rounded-2xl border border-black/5 bg-white p-4 shadow-apple-sm transition hover:shadow-apple animate-[fadeIn_0.3s_ease]">
      {children}
    </div>
  );
}

function BusinessCard({
  b,
  city,
  socials,
  waTemplateBody,
  saved,
  extracting,
  onSave,
  onExtract,
  onCompose,
}: {
  b: Business;
  city: string;
  socials?: string[];
  waTemplateBody?: string;
  saved: boolean;
  extracting: boolean;
  onSave: () => void;
  onExtract: () => void;
  onCompose: () => void;
}) {
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(
    `"${b.name}" ${city} correo OR contacto OR email`
  )}`;
  const wa = b.phone ? waLink(b.phone, buildWaText(b, waTemplateBody)) : null;
  const recent = isRecent(b.lastReviewTime);
  return (
    <CardShell>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          {b.score != null && (
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-bold ${scoreColor(b.score)}`}
              title="Calificación de prospecto (1–10): calidad de reseñas, actividad reciente y facilidad de contacto"
            >
              {b.score}
            </span>
          )}
          <h3 className="truncate font-semibold text-slate-900" title={b.name}>
            {b.name}
          </h3>
        </div>
        {b.lastReviewAgo && (
          <span
            className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              recent
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-100 text-slate-500"
            }`}
            title={`Reseña más reciente: ${b.lastReviewAgo}`}
          >
            {recent && <Icon.Flame className="h-3 w-3" />}
            {b.lastReviewAgo}
          </span>
        )}
      </div>
      {(b.rating != null || b.reviewCount != null) && (
        <div className="mt-1 flex items-center gap-1 text-xs text-slate-500">
          <Icon.Star className="h-3.5 w-3.5 text-amber-500" />
          <span className="font-medium text-slate-700">
            {b.rating?.toFixed(1) ?? "—"}
          </span>
          {b.reviewCount != null && <span>({b.reviewCount} reseñas)</span>}
        </div>
      )}
      {b.address && (
        <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{b.address}</p>
      )}
      <div className="mt-2 flex flex-1 flex-col gap-1 text-xs text-slate-600">
        {b.distanceKm != null && (
          <span className="flex items-center gap-1.5 font-medium text-slate-500">
            <Icon.MapPin className="h-3.5 w-3.5" />a{" "}
            {b.distanceKm < 1
              ? `${Math.round(b.distanceKm * 1000)} m`
              : `${b.distanceKm.toFixed(1)} km`}{" "}
            de ti
          </span>
        )}
        {b.phone && (
          <span className="flex items-center gap-1.5">
            <Icon.Phone className="h-3.5 w-3.5 text-slate-400" />
            {b.phone}
          </span>
        )}
        {b.website && (
          <a
            href={b.website}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 truncate text-indigo-600 hover:underline"
          >
            <Icon.Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{b.website.replace(/^https?:\/\//, "")}</span>
          </a>
        )}
        {b.email ? (
          <span className="flex items-center gap-1.5 font-medium text-emerald-600">
            <Icon.Mail className="h-3.5 w-3.5" />
            {b.email}
          </span>
        ) : extracting ? (
          <span className="flex items-center gap-1.5 text-slate-400">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-indigo-400" />
            buscando correo…
          </span>
        ) : b.email === "" ? (
          <div className="flex flex-wrap items-center gap-2 text-slate-400">
            <span>sin correo directo</span>
            <a
              href={googleUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200"
            >
              <Icon.Search className="h-3 w-3" /> Google
            </a>
            {socials?.map((s) => (
              <a
                key={s}
                href={s}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200"
              >
                <Icon.ExternalLink className="h-3 w-3" />
                {s.includes("facebook")
                  ? "Facebook"
                  : s.includes("instagram")
                    ? "Instagram"
                    : "Red"}
              </a>
            ))}
          </div>
        ) : null}
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {b.website && b.email === undefined && !extracting && (
          <button
            onClick={onExtract}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Buscar correo
          </button>
        )}
        {b.email === "" && (
          <button
            onClick={onExtract}
            disabled={extracting}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Icon.Refresh className="h-3.5 w-3.5" /> Reintentar
          </button>
        )}
        <button
          onClick={onSave}
          disabled={saved}
          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
        >
          {saved ? (
            <>
              <Icon.Check className="h-3.5 w-3.5" /> Guardado
            </>
          ) : (
            <>
              <Icon.Plus className="h-3.5 w-3.5" /> Guardar
            </>
          )}
        </button>
        {b.phone && wa && (
          <a
            href={wa}
            target="_blank"
            rel="noreferrer"
            className="ml-auto flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-600"
          >
            <Icon.WhatsApp className="h-3.5 w-3.5" /> WhatsApp
          </a>
        )}
        <button
          onClick={onCompose}
          className={`${b.phone && wa ? "" : "ml-auto "}rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700`}
        >
          Propuesta
        </button>
      </div>
    </CardShell>
  );
}

function LeadCard({
  l,
  waTemplateBody,
  onStatus,
  onRemove,
  onCompose,
  onGhl,
}: {
  l: Lead;
  waTemplateBody?: string;
  onStatus: (s: LeadStatus) => void;
  onRemove: () => void;
  onCompose: () => void;
  onGhl: () => void;
}) {
  const wa = l.phone ? waLink(l.phone, buildWaText(l, waTemplateBody)) : null;
  return (
    <CardShell>
      <div className="flex items-start justify-between gap-2">
        <h3 className="truncate font-semibold text-slate-900" title={l.name}>
          {l.name}
        </h3>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_META[l.status].cls}`}
        >
          {STATUS_META[l.status].label}
        </span>
      </div>
      <div className="mt-2 flex flex-1 flex-col gap-1 text-xs text-slate-600">
        {l.phone && (
          <span className="flex items-center gap-1.5">
            <Icon.Phone className="h-3.5 w-3.5 text-slate-400" />
            {l.phone}
          </span>
        )}
        {l.email && (
          <span className="flex items-center gap-1.5 font-medium text-emerald-600">
            <Icon.Mail className="h-3.5 w-3.5" />
            {l.email}
          </span>
        )}
        {l.address && <span className="text-slate-400">{l.address}</span>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Select
          value={l.status}
          onChange={(v) => onStatus(v as LeadStatus)}
          compact
          className="w-32"
          options={(Object.keys(STATUS_META) as LeadStatus[]).map((s) => ({
            value: s,
            label: STATUS_META[s].label,
          }))}
        />
        {wa && (
          <a
            href={wa}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-600"
          >
            <Icon.WhatsApp className="h-3.5 w-3.5" /> WhatsApp
          </a>
        )}
        <button
          onClick={onCompose}
          className="rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700"
        >
          Propuesta
        </button>
        <button
          onClick={onGhl}
          title="Enviar este contacto a GHL"
          className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          <Icon.Send className="h-3.5 w-3.5" /> GHL
        </button>
        <button
          onClick={onRemove}
          className="ml-auto rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
        >
          Quitar
        </button>
      </div>
    </CardShell>
  );
}
