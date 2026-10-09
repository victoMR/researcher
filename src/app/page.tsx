"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Template } from "@/lib/templates-repo";
import { CATEGORIES, getCategory } from "@/lib/categories";
import type { Business, LeadMatch, Me, SearchResponse } from "@/lib/types";
import {
  applyPage,
  hasCoords,
  isGoogleOnly,
  knownOf,
  sourceOf,
  withoutGoogleLive,
  type KnownResult,
} from "@/lib/types";
import { useSavedMatches } from "@/lib/useLeads";
import { downloadCSV, isRecent, shortDate, sourceCredit, timeAgo } from "@/lib/format";
import { computeScore } from "@/lib/scoring";
import {
  SEARCH_FILTER_KEYS,
  activeKeys,
  applyContactFilters,
  loadContactSel,
  saveContactSel,
  webHasWhatsapp,
  type ContactFilterSel,
} from "@/lib/contact-filters";
import ContactFilters from "@/components/ContactFilters";
import ComposeModal from "@/components/ComposeModal";
import StatusTicker from "@/components/StatusTicker";
import Select from "@/components/Select";
import Dashboard from "@/components/Dashboard";
import Templates from "@/components/Templates";
import BusinessCard from "@/components/BusinessCard";
import MapView from "@/components/MapView";
import Prospects, {
  DEFAULT_PROSPECT_FILTERS,
  googleSkipNote,
  type ProspectFilters,
} from "@/components/Prospects";
import ResearchPanel from "@/components/research/ResearchPanel";
import Team from "@/components/Team";
import UserMenu from "@/components/UserMenu";
import PasswordModal from "@/components/PasswordModal";
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

// Calificación de prospecto 1..10 POR RESTA (src/lib/scoring.ts): 10 = datos
// completos y activo; cada dato faltante o viejo resta puntos.
function scoreLead(b: Business, websiteOk: boolean) {
  return computeScore({
    phone: b.phone,
    email: b.email,
    emailIsGuess: b.emailIsGuess,
    website: b.website,
    address: b.address,
    businessStatus: b.status,
    lastActivityAt: b.lastReviewTime,
    websiteOk,
  });
}

// Liga oficial para pedir el token gratis del DENUE (formulario "Obtener Token").
const DENUE_TOKEN_URL = "https://www.inegi.org.mx/servicios/api_denue.html";

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

type Tab = "investigar" | "buscar" | "prospectos" | "plantillas" | "metricas" | "equipo";
const TABS: Tab[] = ["investigar", "buscar", "prospectos", "plantillas", "metricas"];
const ADMIN_TABS: Tab[] = [...TABS, "equipo"]; // Equipo: solo administradores
type View = "lista" | "mapa";
// mixta = DENUE + Google unidos (lo de DENUE se guarda/exporta, lo de Google es
// solo consulta); denue = México con DENUE (base, se guarda/exporta);
// google = solo consulta; general = mundial con OpenStreetMap (gratis).
type SearchMode = "mixta" | "denue" | "google" | "general";

// Última búsqueda mostrada (para "Cargar más" y "Actualizar").
interface SearchQuery {
  city: string;
  category: string;
  mode: SearchMode;
}

function searchBody(
  qy: SearchQuery,
  extra: { refresh?: boolean; pageToken?: string; known?: KnownResult[] } = {}
) {
  return JSON.stringify({
    city: qy.city,
    category: qy.category,
    source: qy.mode === "general" ? "osm" : qy.mode === "google" ? undefined : qy.mode,
    global: qy.mode === "general",
    ...extra,
  });
}

// Vuelve a leer quién está logueado. Si la sesión ya no vale, manda al login.
async function refreshMe(): Promise<Me | null> {
  try {
    const r = await fetch("/api/auth/me", { cache: "no-store" });
    if (r.status === 401) {
      // eslint-disable-next-line @next/next/no-location-assign-relative-destination
      window.location.href = "/login?e=sesion";
      return null;
    }
    return r.ok ? ((await r.json()) as Me) : null;
  } catch {
    return null;
  }
}

export default function Home() {
  const [tab, setTab] = useState<Tab>("investigar");
  // Investigación abierta en la pestaña IA (sobrevive al cambiar de pestaña).
  const [researchId, setResearchId] = useState<string | null>(null);
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
  // Chips de contacto de Buscar (Y). Se guardan por usuario en localStorage.
  const [contactSel, setContactSel] = useState<ContactFilterSel>({});
  // WhatsApp detectado en la web del negocio al sacar su correo (por id).
  const [waWeb, setWaWeb] = useState<Record<string, boolean>>({});
  const [socials, setSocials] = useState<Record<string, string[]>>({});
  const [guesses, setGuesses] = useState<Record<string, string[]>>({});
  const [autoProgress, setAutoProgress] = useState<{ done: number; total: number } | null>(null);
  const [mode, setMode] = useState<SearchMode>("google");
  // ¿El servidor tiene DENUE_TOKEN? (null = aún no sabemos)
  const [denueAvailable, setDenueAvailable] = useState<boolean | null>(null);
  const modeTouched = useRef(false);
  // Sitios web que sí se pudieron leer al sacar el correo (señal de actividad del score).
  const [siteOk, setSiteOk] = useState<Record<string, boolean>>({});
  // Aviso tras exportar resultados (cuántos de Google se omitieron).
  const [exportNote, setExportNote] = useState<string | null>(null);
  const [userCoords, setUserCoords] = useState<{ lat: number; lon: number } | null>(null);
  const [locating, setLocating] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [me, setMe] = useState<Me | null>(null);
  // "Cambiar mi contraseña" (forced = entró con contraseña temporal).
  const [pwModal, setPwModal] = useState<null | "self" | "forced">(null);
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

  // Quién está logueado (para dueño, permisos y {{vendedor}}). Si entró con
  // contraseña temporal, se le pide cambiarla.
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Me | null) => {
        if (!d?.email) return;
        setMe(d);
        setContactSel(loadContactSel(d.email)); // filtros que dejó este usuario
        if (d.mustChangePassword) setPwModal("forced");
      })
      .catch(() => {});
  }, []);

  // Al volver a la pestaña del navegador revisa la sesión: si la cortaron
  // (desactivado, cambio de rol o de contraseña) manda al login.
  useEffect(() => {
    const onFocus = () => {
      refreshMe().then((d) => d && setMe(d));
    };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  // Me edité en Equipo (nombre o rol): si ya no soy admin salgo de Equipo.
  async function afterSelfChanged() {
    const d = await refreshMe();
    if (!d) return;
    setMe(d);
    if (!d.isAdmin) setTab("investigar");
  }

  // Fuentes del servidor: con DENUE_TOKEN y Google el modo por defecto es Mixta;
  // solo con DENUE_TOKEN, DENUE.
  useEffect(() => {
    fetch("/api/search")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: { denueAvailable?: boolean; googleAvailable?: boolean } | null) => {
        const ok = !!d?.denueAvailable;
        setDenueAvailable(ok);
        if (ok && !modeTouched.current) setMode(d?.googleAvailable ? "mixta" : "denue");
      })
      .catch(() => setDenueAvailable(false));
  }, []);

  function pickMode(m: SearchMode) {
    modeTouched.current = true;
    setMode(m);
  }

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
        setSiteOk({});
        setExportNote(null);
        if (typeof data.denueAvailable === "boolean") setDenueAvailable(data.denueAvailable);
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
        body: searchBody(lastQuery, {
          pageToken: nextPageToken,
          // Mixta: lo ya mostrado, para emparejar la página nueva sin duplicar.
          ...(lastQuery.mode === "mixta" ? { known: knownOf(results) } : {}),
        }),
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
      // Agrega sin repetir id; en mixta además quita `mergedIds` y aplica `updates`.
      setResults((rs) => applyPage(rs, fresh, data));
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
      // El sitio respondió con contenido: cuenta como señal de actividad (score).
      const readable =
        res.ok &&
        !data.error &&
        [data.emails, data.socials, data.phones, data.signals].some(
          (v) => Array.isArray(v) && v.length > 0
        );
      if (readable) setSiteOk((s) => ({ ...s, [b.id]: true }));
      if (webHasWhatsapp(data)) setWaWeb((s) => ({ ...s, [b.id]: true }));
      setResults((rs) =>
        rs.map((r) =>
          r.id === b.id ? { ...r, email: email ?? "", emailIsGuess: email ? false : r.emailIsGuess } : r
        )
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
    // Sugerido = no lo publicó el negocio: resta en el score hasta confirmarlo.
    setResults((rs) =>
      rs.map((r) => (r.id === b.id ? { ...r, email, emailIsGuess: true } : r))
    );
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

  // CSV solo con datos abiertos (DENUE / OSM): los de Google no se exportan.
  // Tampoco sus señales (DENUE + Google): el Score se recalcula sin rating,
  // reseñas ni businessStatus, igual que al guardar en Prospectos.
  function exportResultsCSV(rows: Business[]) {
    const open = rows.filter((r) => !isGoogleOnly(r));
    const google = rows.length - open.length;
    if (open.length) {
      downloadCSV(
        "negocios.csv",
        ["Score", "Nombre", "Giro", "Correo", "Teléfono", "Web", "Dirección", "Personal", "Fuente"],
        open.map((r) => [
          scoreLead(withoutGoogleLive(r), !!siteOk[r.id]).score,
          r.name,
          r.category,
          r.email,
          r.phone,
          r.website,
          r.address,
          r.employees,
          sourceOf(r) === "denue" ? "INEGI, DENUE" : "© OpenStreetMap contributors",
        ])
      );
    }
    setExportNote(
      google ? (open.length ? "" : "No hay nada que exportar. ") + googleSkipNote(google) : null
    );
  }

  // Cambia los chips de contacto y los guarda para este usuario.
  function changeContactSel(next: ContactFilterSel) {
    setContactSel(next);
    saveContactSel(me?.email, next);
  }

  // Resultados con score + distancia (si hay ubicación) + filtros + orden.
  // contactCounts = cuántos quedarían al prender cada chip de contacto.
  const { filteredResults, contactCounts } = useMemo(() => {
    let r = results.map((b) => {
      const s = scoreLead(b, !!siteOk[b.id]);
      return {
        ...b,
        score: s.score,
        scoreDeductions: s.deductions,
        distanceKm:
          userCoords && hasCoords(b)
            ? distanceKm(userCoords.lat, userCoords.lon, b.lat, b.lon)
            : undefined,
      };
    });
    // "Solo activos" y los órdenes por reseñas solo aplican con señales de Google.
    const hasAct = results.some((b) => b.lastReviewTime || b.rating != null);
    if (onlyActive && hasAct) r = r.filter((b) => isRecent(b.lastReviewTime));
    // Chips de contacto (Y) sobre lo que queda; el correo se va llenando en segundo plano.
    const cf = applyContactFilters(
      r,
      contactSel,
      (b) => ({
        email: b.email,
        phone: b.phone,
        website: b.website,
        score: b.score,
        waWeb: !!waWeb[b.id],
        saved: !!matchFor(b),
      }),
      SEARCH_FILTER_KEYS
    );
    r = cf.items;
    const by = hasAct || sortBy === "cercanos" ? sortBy : "score";
    const sorted = [...r];
    if (by === "score") {
      sorted.sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
    } else if (by === "cercanos") {
      sorted.sort((a, b) => (a.distanceKm ?? Infinity) - (b.distanceKm ?? Infinity));
    } else if (by === "resenas") {
      sorted.sort((a, b) => (b.reviewCount ?? 0) - (a.reviewCount ?? 0));
    } else if (by === "rating") {
      sorted.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0));
    } else {
      sorted.sort(
        (a, b) =>
          (b.lastReviewTime ? Date.parse(b.lastReviewTime) : 0) -
          (a.lastReviewTime ? Date.parse(a.lastReviewTime) : 0)
      );
    }
    return { filteredResults: sorted, contactCounts: cf.counts };
  }, [results, onlyActive, sortBy, userCoords, siteOk, contactSel, waWeb, matchFor]);

  const activeCount = useMemo(
    () => results.filter((b) => isRecent(b.lastReviewTime)).length,
    [results]
  );
  const hasActivityData = useMemo(
    () => results.some((b) => b.lastReviewTime || b.rating != null),
    [results]
  );

  // ¿Hay filtros encendidos? (para "12 de 40", la etiqueta del CSV y el vacío)
  const contactOn = activeKeys(contactSel, SEARCH_FILTER_KEYS).length > 0;
  const searchFiltered = contactOn || (onlyActive && hasActivityData);

  // Sin señales de Google (DENUE / OSM) solo aplican "Mejor prospecto" y cercanía.
  const sortOptions = useMemo(() => {
    const base = hasActivityData ? SORT_OPTIONS : SORT_OPTIONS.slice(0, 1);
    return userCoords ? [{ value: "cercanos", label: "Más cercanos" }, ...base] : base;
  }, [userCoords, hasActivityData]);

  // Resultados de Google en la lista actual (no se exportan ni van al mapa).
  const googleCount = useMemo(() => results.filter((b) => isGoogleOnly(b)).length, [results]);

  const isSearch = tab === "buscar";
  const hasResults = isSearch && results.length > 0; // hay búsqueda (aunque el filtro oculte todo)
  const showResults = isSearch && filteredResults.length > 0;

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Barra superior */}
      <header className="sticky top-0 z-20 border-b border-black/5 bg-white/70 backdrop-blur-xl backdrop-saturate-150">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-3">
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
          <div className="flex min-w-0 max-w-full items-center gap-2">
          <nav className="flex min-w-0 max-w-full gap-1 overflow-x-auto rounded-full bg-black/[0.04] p-1 [scrollbar-width:none]">
            {(me?.isAdmin ? ADMIN_TABS : TABS).map((t) => (
              <button
                key={t}
                onClick={() => setTab(t)}
                aria-current={tab === t ? "page" : undefined}
                className={`shrink-0 whitespace-nowrap rounded-full px-4 py-1.5 text-sm font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 ${
                  t === "investigar" ? "" : "capitalize"
                } ${
                  tab === t
                    ? "bg-white text-slate-900 shadow-apple-sm"
                    : "text-slate-500 hover:text-slate-800"
                }`}
              >
                {t === "investigar" ? (
                  <span className="flex items-center gap-1.5">
                    <Icon.Sparkles
                      className={`h-3.5 w-3.5 ${tab === t ? "text-violet-600" : "text-violet-500"}`}
                    />
                    <span className="sm:hidden">IA</span>
                    <span className="hidden sm:inline">Investigar con IA</span>
                  </span>
                ) : t === "prospectos" && mineCount ? (
                  `Prospectos (${mineCount})`
                ) : t === "metricas" ? (
                  "Métricas"
                ) : t === "equipo" ? (
                  <span className="flex items-center gap-1.5">
                    <Icon.Users className="h-3.5 w-3.5" /> Equipo
                  </span>
                ) : (
                  t
                )}
              </button>
            ))}
          </nav>
          <UserMenu
            me={me}
            onTeam={() => setTab("equipo")}
            onPassword={() => setPwModal("self")}
            onLogout={logout}
          />
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-6xl px-4 py-8">
        {tab === "investigar" && (
          <ResearchPanel
            me={me}
            openId={researchId}
            onOpen={setResearchId}
            onChanged={() => refreshSaved()}
          />
        )}
        {tab === "metricas" && <Dashboard />}
        {tab === "plantillas" && <Templates />}
        {tab === "equipo" && me?.isAdmin && <Team me={me} onSelfChanged={afterSelfChanged} />}
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
            <div className="mt-3 flex flex-wrap items-center justify-center gap-2 text-xs">
              <span className="text-slate-400">Modo:</span>
              {/* 4 modos: en pantallas chicas se desliza de lado */}
              <div className="max-w-full overflow-x-auto [scrollbar-width:none]">
                <Segmented<SearchMode>
                  value={mode}
                  onChange={pickMode}
                  options={[
                    {
                      value: "mixta",
                      title: "DENUE y Google a la vez, sin repetidos",
                      label: (
                        <>
                          <Icon.LinkIcon className="h-3.5 w-3.5" /> Mixta · DENUE + Google (más
                          resultados)
                        </>
                      ),
                    },
                    {
                      value: "denue",
                      label: (
                        <>
                          <Icon.Building className="h-3.5 w-3.5" /> México · DENUE
                        </>
                      ),
                    },
                    {
                      value: "google",
                      label: (
                        <>
                          <Icon.Target className="h-3.5 w-3.5" /> Google (solo consulta)
                        </>
                      ),
                    },
                    {
                      value: "general",
                      label: (
                        <>
                          <Icon.Globe className="h-3.5 w-3.5" /> Mundial · OSM (gratis)
                        </>
                      ),
                    },
                  ]}
                />
              </div>
            </div>
            <p className="mt-1 text-center text-xs text-slate-400">
              {mode === "mixta"
                ? "DENUE y Google a la vez, sin repetidos. Lo de DENUE se guarda, se exporta a CSV y va a GHL; lo de Google (calificación, reseñas y negocios que no están en DENUE) es solo consulta."
                : mode === "denue"
                  ? "Directorio oficial de INEGI: todo México, gratis. Se guarda, se exporta a CSV y va a GHL."
                  : mode === "google"
                    ? "Consulta en vivo con Google. Sus datos no se exportan ni se pintan en el mapa; al guardar se vinculan con DENUE."
                    : "Cualquier ciudad del mundo con OpenStreetMap. No gasta cuota de Google."}
            </p>
            {denueAvailable === false && mode !== "general" && (
              <p className="mx-auto mt-2 max-w-xl rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-left text-xs text-amber-800">
                <b>DENUE no está configurado</b> en el servidor (falta <code>DENUE_TOKEN</code>
                ). Mientras tanto se usa Google u OpenStreetMap. El token es gratis:{" "}
                <a
                  href={DENUE_TOKEN_URL}
                  target="_blank"
                  rel="noreferrer"
                  className="font-semibold text-indigo-700 underline"
                >
                  pídelo en la página del API del DENUE (INEGI)
                </a>
                .
              </p>
            )}
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
                  {searchFiltered
                    ? `${filteredResults.length} de ${results.length} negocios`
                    : `${results.length} negocios`}
                  {source && (
                    <span
                      className="ml-2 rounded-full bg-slate-100 px-2 py-0.5 text-xs text-slate-500"
                      title={
                        source === "mixta"
                          ? `${sourceCredit("denue")} · Google Maps solo consulta`
                          : sourceCredit(
                              source === "denue" ? "denue" : source === "google" ? "google" : "osm"
                            )
                      }
                    >
                      {source === "mixta"
                        ? "DENUE + Google"
                        : source === "denue"
                          ? "DENUE (INEGI)"
                          : source === "google"
                            ? "Google · solo consulta"
                            : "OSM (gratis)"}
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
                </span>
              )}
            </div>
            {hasResults && !loading && (
              <div className="flex flex-wrap items-center gap-2">
                {hasActivityData && (
                  <button
                    onClick={() => setOnlyActive((v) => !v)}
                    aria-pressed={onlyActive}
                    title="Sólo negocios con reseñas de los últimos 6 meses"
                    className={`flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium transition ${
                      onlyActive
                        ? "bg-emerald-600 text-white shadow-apple-sm"
                        : "border border-black/10 bg-white text-slate-600 hover:bg-slate-50"
                    }`}
                  >
                    <Icon.Flame className="h-3.5 w-3.5" /> Solo activos ({activeCount})
                  </button>
                )}
                {sortOptions.length > 1 && (
                  <Select
                    value={sortOptions.some((o) => o.value === sortBy) ? sortBy : "score"}
                    onChange={setSortBy}
                    options={sortOptions}
                    align="right"
                    compact
                    className="w-40"
                  />
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
                  disabled={!filteredResults.length}
                  title={
                    (searchFiltered
                      ? `Descarga solo los ${filteredResults.length} que ves con los filtros`
                      : "Descargar estos resultados") +
                    (googleCount
                      ? ". Solo datos abiertos (DENUE / OSM): los de Google no se exportan por sus términos"
                      : "")
                  }
                  className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
                >
                  <Icon.Download className="h-3.5 w-3.5" />
                  {searchFiltered ? `CSV (${filteredResults.length} filtrados)` : "CSV"}
                </button>
              </div>
            )}
          </div>
        )}

        {/* Chips de contacto (Y): el conteo es cuántos quedarían al prender cada uno */}
        {hasResults && !loading && (
          <ContactFilters
            keys={SEARCH_FILTER_KEYS}
            value={contactSel}
            onChange={changeContactSel}
            counts={contactCounts}
            hints={{
              // Los correos llegan en segundo plano: el número de "Con correo" crece.
              email: autoProgress && (
                <span
                  className="flex items-center gap-1.5 whitespace-nowrap rounded-full bg-indigo-50 px-2 py-1 text-[11px] font-medium text-indigo-600"
                  title="Se están revisando las webs: el número de “Con correo” puede crecer"
                >
                  <span aria-hidden className="h-1.5 w-1.5 animate-ping rounded-full bg-indigo-500" />
                  sacando correos {autoProgress.done}/{autoProgress.total}…
                </span>
              ),
            }}
            className="mb-4"
          />
        )}

        {/* Aviso modo gratis */}
        {isSearch && !loading && source === "osm" && mode !== "general" && (
          <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Estás viendo <b>OpenStreetMap (gratis)</b>: bueno para agencias de autos,
            pero casi sin datos de talleres, seminuevos e inmobiliarias. Para todo
            México usa el modo <b>DENUE</b> (agrega <code>DENUE_TOKEN</code>, es gratis).
          </p>
        )}

        {/* Datos de Google: solo consulta */}
        {isSearch && !loading && googleCount > 0 && (
          <p className="mb-4 rounded-xl border border-slate-200 bg-white px-4 py-3 text-xs text-slate-600">
            {googleCount === 1 ? "1 resultado es" : `${googleCount} resultados son`} de{" "}
            <b>Google</b>: solo para consultar. No se exportan a CSV ni a GHL y no se
            pintan en el mapa. Al guardarlos se buscan en DENUE; si no aparecen se guarda
            lo mínimo y desde Prospectos puedes vincularlos con DENUE.
          </p>
        )}

        {/* Aviso tras exportar */}
        {isSearch && exportNote && !loading && (
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
            title={
              !results.length
                ? "Empieza una búsqueda"
                : contactOn
                  ? "Ningún negocio con esos filtros"
                  : "Ningún negocio activo"
            }
            sub={
              !results.length
                ? "Elige un giro y una ciudad para encontrar negocios."
                : contactOn
                  ? autoProgress && contactSel.email
                    ? "Aún se están sacando correos: pueden aparecer más. O quita algún filtro."
                    : "Quita algún filtro para ver más negocios."
                  : "Quita el filtro “Solo activos” para ver todos."
            }
          >
            {results.length > 0 && searchFiltered && (
              <button
                type="button"
                onClick={() => {
                  setOnlyActive(false);
                  changeContactSel({});
                }}
                className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
              >
                Limpiar filtros
              </button>
            )}
          </EmptyState>
        )}
      </main>

      {pwModal && me && (
        <PasswordModal
          me={me}
          forced={pwModal === "forced"}
          onClose={() => setPwModal(null)}
          onChanged={() => setMe((m) => (m ? { ...m, mustChangePassword: false } : m))}
        />
      )}

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
