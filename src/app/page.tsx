"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Template } from "@/lib/templates-repo";
import { CATEGORIES, getCategory } from "@/lib/categories";
import type { Business, LeadMatch, Me, SearchResponse } from "@/lib/types";
import { useSavedMatches } from "@/lib/useLeads";
import { downloadCSV, isRecent, shortDate, timeAgo } from "@/lib/format";
import ComposeModal from "@/components/ComposeModal";
import StatusTicker from "@/components/StatusTicker";
import Select from "@/components/Select";
import Dashboard from "@/components/Dashboard";
import Templates from "@/components/Templates";
import BusinessCard from "@/components/BusinessCard";
import MapView from "@/components/MapView";
import Prospects, {
  DEFAULT_PROSPECT_FILTERS,
  type ProspectFilters,
} from "@/components/Prospects";
import { EmptyState, Segmented, SkeletonCard } from "@/components/ui";
import * as Icon from "@/components/icons";

const CAT_ICON: Record<string, React.ReactNode> = {
  autos_nuevos: <Icon.Car className="h-4 w-4 text-slate-500" />,
  seminuevos: <Icon.Car className="h-4 w-4 text-slate-500" />,
  inmobiliarias: <Icon.Building className="h-4 w-4 text-slate-500" />,
  talleres: <Icon.Wrench className="h-4 w-4 text-slate-500" />,
};

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

type Tab = "buscar" | "prospectos" | "plantillas" | "metricas";
type View = "lista" | "mapa";
type SearchMode = "google" | "general";

// Última búsqueda mostrada (para "Cargar más" y "Actualizar").
interface SearchQuery {
  city: string;
  category: string;
  mode: SearchMode;
}

function searchBody(qy: SearchQuery, extra: { refresh?: boolean; pageToken?: string } = {}) {
  return JSON.stringify({
    city: qy.city,
    category: qy.category,
    source: qy.mode === "general" ? "osm" : undefined,
    global: qy.mode === "general",
    ...extra,
  });
}

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
  const [guesses, setGuesses] = useState<Record<string, string[]>>({});
  const [autoProgress, setAutoProgress] = useState<{ done: number; total: number } | null>(null);
  const [mode, setMode] = useState<SearchMode>("google");
  const [userCoords, setUserCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  // Paginación / caché de la búsqueda (opcionales según la respuesta).
  const [lastQuery, setLastQuery] = useState<SearchQuery | null>(null);
  const [nextPageToken, setNextPageToken] = useState<string | null>(null);
  const [cacheInfo, setCacheInfo] = useState<{ cachedAt?: string } | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  // Pestaña Prospectos: filtros (sobreviven al cambiar de pestaña) y recarga.
  const [prospectFilters, setProspectFilters] =
    useState<ProspectFilters>(DEFAULT_PROSPECT_FILTERS);
  const [prospectsKey, setProspectsKey] = useState(0);

  // Quién está logueado (para dueño, permisos y {{vendedor}}).
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Me | null) => {
        if (d?.email) setMe(d);
      })
      .catch(() => {});
  }, []);

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

  const { matchFor, check, addLead, claim, updateSaved, mineCount, refreshCount } =
    useSavedMatches(me?.email);

  // La extracción automática corre en segundo plano: usa siempre las
  // coincidencias más recientes (llegan después de iniciar).
  const matchRef = useRef(matchFor);
  useEffect(() => {
    matchRef.current = matchFor;
  }, [matchFor]);

  // ¿Puedo modificar este prospecto guardado?
  const canTouch = (m: LeadMatch) =>
    !m.ownerEmail || m.ownerEmail === me?.email || !!me?.isAdmin;

  const catLabel = getCategory(category)?.label ?? "";

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST" });
    // Recarga completa a propósito: no queda nada del vendedor en memoria.
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    window.location.href = "/login";
  }

  // Algo cambió en los prospectos: contador, tarjetas de resultados y lista.
  function refreshSaved({ list = true }: { list?: boolean } = {}) {
    refreshCount();
    if (results.length) check(results, "refresh");
    if (list) setProspectsKey((k) => k + 1);
  }

  async function search(e?: React.FormEvent, cityArg?: string) {
    e?.preventDefault();
    const q = (cityArg ?? city).trim();
    if (!q) return;
    await runSearch({ city: q, category, mode });
  }

  async function runSearch(qy: SearchQuery, opts: { refresh?: boolean } = {}) {
    setLoading(true);
    setError(null);
    setNotice(null);
    setResults([]);
    setSearchedCity(qy.city);
    setNextPageToken(null);
    setCacheInfo(null);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: searchBody(qy, opts.refresh ? { refresh: true } : {}),
      });
      const data = (await res.json()) as SearchResponse & { error?: string };
      if (!res.ok) {
        setError(data.error || "Error en la búsqueda.");
      } else {
        // Marca la ciudad buscada en cada resultado (para dedupe y guardado).
        const withCity = (data.results ?? []).map((r) => ({ ...r, city: qy.city }));
        setResults(withCity);
        setSource(data.source || null);
        setSocials({});
        setGuesses({});
        setLastQuery(qy);
        setNextPageToken(data.nextPageToken || null);
        setCacheInfo(data.cached ? { cachedAt: data.cachedAt } : null);
        setNotice(data.notice || null);
        if (!withCity.length) {
          const label = getCategory(qy.category)?.label ?? "negocios";
          setError(
            `No encontré ${label.toLowerCase()} en ${qy.city}. Prueba otra ciudad o giro.`
          );
        } else {
          check(withCity, "reset");
          autoExtract(withCity);
        }
      }
    } catch {
      setError("Error de red. Intenta de nuevo.");
    } finally {
      setLoading(false);
    }
  }

  // Siguiente página de la misma búsqueda (misma ciudad/giro/modo).
  async function loadMore() {
    if (!lastQuery || !nextPageToken || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await fetch("/api/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: searchBody(lastQuery, { pageToken: nextPageToken }),
      });
      const data = (await res.json()) as SearchResponse & { error?: string };
      if (!res.ok) {
        setError(data.error || "No se pudieron cargar más resultados.");
        return;
      }
      const seen = new Set(results.map((r) => r.id));
      const fresh = (data.results ?? [])
        .map((r) => ({ ...r, city: lastQuery.city }))
        .filter((r) => !seen.has(r.id) && seen.add(r.id));
      setResults((rs) => {
        const ids = new Set(rs.map((r) => r.id));
        return [...rs, ...fresh.filter((r) => !ids.has(r.id))];
      });
      setNextPageToken(data.nextPageToken || null);
      if (data.notice) setNotice(data.notice);
      if (fresh.length) {
        check(fresh, "merge");
        autoExtract(fresh);
      }
    } catch {
      setError("Error de red al cargar más resultados.");
    } finally {
      setLoadingMore(false);
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
      if (data.guesses?.length)
        setGuesses((s) => ({ ...s, [b.id]: data.guesses }));
      setResults((rs) =>
        rs.map((r) => (r.id === b.id ? { ...r, email: email ?? "" } : r))
      );
      // Si ya estaba guardado (y es mío o sin dueño), guarda el correo.
      const m = matchRef.current(b);
      if (email && m && canTouch(m)) updateSaved(b, m, { email });
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
        `La ubicación solo funciona en un sitio seguro (HTTPS o localhost). Abriste la app por ${location.hostname}: entra por localhost en esta computadora o usa la versión publicada con HTTPS.`
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

  // Elige un correo sugerido (dominio de la matriz) como el correo del negocio.
  function pickEmail(b: Business, email: string) {
    setResults((rs) => rs.map((r) => (r.id === b.id ? { ...r, email } : r)));
    const m = matchFor(b);
    if (m && canTouch(m)) updateSaved(b, m, { email });
  }

  async function saveResult(b: Business) {
    const err = await addLead(b);
    if (err) alert(err);
    else setProspectsKey((k) => k + 1);
  }

  async function claimResult(b: Business, m: LeadMatch) {
    const err = await claim(b, m);
    if (err) alert(err);
    else setProspectsKey((k) => k + 1);
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

  function exportResultsCSV(rows: Business[]) {
    downloadCSV(
      "negocios.csv",
      ["Score", "Nombre", "Giro", "Correo", "Teléfono", "Web", "Rating", "Reseñas", "Dirección"],
      rows.map((r) => [
        r.score,
        r.name,
        r.category,
        r.email,
        r.phone,
        r.website,
        r.rating,
        r.reviewCount,
        r.address,
      ])
    );
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

  const isSearch = tab === "buscar";
  const hasResults = isSearch && results.length > 0; // hay búsqueda (aunque el filtro oculte todo)
  const showResults = isSearch && filteredResults.length > 0;

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
              <p className="text-xs text-slate-400">
                {me ? `Hola, ${me.name.split(" ")[0]}` : "Prospección de clientes"}
              </p>
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
                {t === "prospectos" && mineCount
                  ? `Prospectos (${mineCount})`
                  : t === "metricas"
                    ? "Métricas"
                    : t}
              </button>
            ))}
            <button
              onClick={logout}
              title={me ? `Cerrar sesión (${me.email})` : "Cerrar sesión"}
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
        {tab === "prospectos" && (
          <Prospects
            me={me}
            filters={prospectFilters}
            setFilters={setProspectFilters}
            refreshKey={prospectsKey}
            waTemplateBody={waTemplateBody}
            onCompose={(l) => setCompose(l)}
            onChanged={() => refreshSaved({ list: false })}
          />
        )}

        {isSearch && (
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
              <Segmented<SearchMode>
                value={mode}
                onChange={setMode}
                options={[
                  {
                    value: "google",
                    label: (
                      <>
                        <Icon.Target className="h-3.5 w-3.5" /> México (Google)
                      </>
                    ),
                  },
                  {
                    value: "general",
                    label: (
                      <>
                        <Icon.Globe className="h-3.5 w-3.5" /> General · mundial (gratis)
                      </>
                    ),
                  },
                ]}
              />
            </div>
            <p className="mt-1 text-center text-xs text-slate-400">
              {mode === "google"
                ? "Mejor cobertura en México. Usa la API de Google."
                : "Cualquier ciudad del mundo con OpenStreetMap. No gasta cuota de Google."}
            </p>
          </section>
        )}

        {/* Barra de resultados */}
        {isSearch && (hasResults || loading) && (
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
                <span className="flex flex-wrap items-center gap-y-1 text-sm font-medium text-slate-600">
                  {filteredResults.length} negocios
                  {source && (
                    <span className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
                      {source === "google" ? "Google" : "OSM (gratis)"}
                    </span>
                  )}
                  {cacheInfo && (
                    <span
                      className="ml-2 flex items-center gap-1 rounded-full bg-slate-100 py-0.5 pl-2 pr-0.5 text-xs text-slate-500"
                      title={
                        cacheInfo.cachedAt
                          ? `Resultados guardados el ${shortDate(cacheInfo.cachedAt)}: no gastaron cuota.`
                          : "Resultados guardados: no gastaron cuota."
                      }
                    >
                      <Icon.Clock className="h-3 w-3" />
                      En caché{cacheInfo.cachedAt ? ` · ${timeAgo(cacheInfo.cachedAt)}` : ""}
                      <button
                        onClick={() => lastQuery && runSearch(lastQuery, { refresh: true })}
                        title="Volver a consultar la fuente (puede gastar cuota)"
                        className="ml-0.5 flex items-center gap-1 rounded-full bg-white px-1.5 py-0.5 font-medium text-indigo-600 shadow-apple-sm hover:bg-indigo-50"
                      >
                        <Icon.Refresh className="h-3 w-3" /> Actualizar
                      </button>
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
            {hasResults && !loading && (
              <div className="flex flex-wrap items-center gap-2">
                {hasActivityData && (
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
                <Segmented<View>
                  value={view}
                  onChange={setView}
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
                  onClick={() => exportResultsCSV(filteredResults)}
                  className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  <Icon.Download className="h-3.5 w-3.5" /> CSV
                </button>
              </div>
            )}
          </div>
        )}

        {/* Aviso modo gratis */}
        {isSearch && !loading && source === "osm" && mode === "google" && (
          <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Estás en <b>modo gratis (OSM)</b>: bueno para agencias de autos, pero
            casi sin datos de seminuevos e inmobiliarias. Agrega tu key de Google
            Places (<code>GOOGLE_PLACES_API_KEY</code>) para cobertura completa.
          </p>
        )}

        {/* Aviso de la búsqueda (p. ej. tope de gasto o datos parciales) */}
        {isSearch && notice && !loading && (
          <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {notice}
          </p>
        )}

        {isSearch && error && !loading && (
          <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}
          </p>
        )}

        {/* Loading skeleton */}
        {isSearch && loading && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {Array.from({ length: 6 }).map((_, i) => (
              <SkeletonCard key={i} />
            ))}
          </div>
        )}

        {/* Contenido */}
        {!loading && showResults && view === "mapa" && (
          <div className="h-[70vh] overflow-hidden rounded-2xl border border-slate-200 shadow-sm">
            <MapView points={filteredResults} />
          </div>
        )}

        {!loading && showResults && view === "lista" && (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {filteredResults.map((b) => {
              const m = matchFor(b);
              return (
                <BusinessCard
                  key={b.id}
                  b={b}
                  city={searchedCity}
                  socials={socials[b.id]}
                  guesses={guesses[b.id]}
                  waTemplateBody={waTemplateBody}
                  me={me}
                  match={m}
                  extracting={!!extracting[b.id]}
                  onSave={() => saveResult(b)}
                  onClaim={() => m && claimResult(b, m)}
                  onExtract={() => extractEmail(b)}
                  onCompose={() => setCompose(b)}
                  onPickEmail={(e) => pickEmail(b, e)}
                />
              );
            })}
          </div>
        )}

        {/* Más resultados (siguiente página de la fuente) */}
        {isSearch && !loading && results.length > 0 && nextPageToken && (
          <div className="mt-6 flex justify-center">
            <button
              onClick={loadMore}
              disabled={loadingMore}
              className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-5 py-2 text-sm font-medium text-slate-700 shadow-apple-sm transition hover:bg-slate-50 disabled:opacity-60"
            >
              {loadingMore ? (
                <>
                  <Icon.Loader className="h-4 w-4" /> Cargando…
                </>
              ) : (
                <>
                  <Icon.Plus className="h-4 w-4" /> Cargar más resultados
                </>
              )}
            </button>
          </div>
        )}

        {/* Estado vacío */}
        {isSearch && !loading && !showResults && !error && (
          <EmptyState
            icon={<Icon.Search className="h-8 w-8" />}
            title={results.length ? "Ningún negocio activo" : "Empieza una búsqueda"}
            sub={
              results.length
                ? "Quita el filtro “Solo activos” para ver todos."
                : "Elige un giro y una ciudad para encontrar negocios."
            }
          />
        )}
      </main>

      {compose && (
        <ComposeModal
          lead={compose}
          onClose={() => setCompose(null)}
          onSent={() => refreshSaved()}
        />
      )}
    </div>
  );
}
