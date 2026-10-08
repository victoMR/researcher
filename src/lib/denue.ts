import type { Business } from "./types";
import type { GeoPlace } from "./osm";
import { coalesce, getCached, setCached } from "./search-cache";

// DENUE (INEGI): directorio abierto de ~6.1 M establecimientos, base de todo lo
// que se guarda o exporta. Términos de Libre Uso del INEGI: se puede guardar y
// explotar comercialmente citando la fuente ("Fuente: INEGI, DENUE").
// API: https://www.inegi.org.mx/servicios/api_denue.html
//   {BASE}/Buscar/{condición}/{lat},{lon}/{metros ≤ 5000}/{token}
//   {BASE}/BuscarEntidad/{condición}/{entidad}/{reg. ini}/{reg. fin}/{token}
//   {BASE}/BuscarAreaAct/{ent}/{mun}/{loc}/{ageb}/{manzana}/{sector}/{subsector}/
//          {rama}/{clase}/{nombre}/{reg. ini}/{reg. fin}/{id}/{token}   (0 = todos)
// Responde un arreglo JSON con valores de texto (CLEE, Id, Nombre, Razon_social,
// Clase_actividad, Estrato, Tipo_vialidad, Calle, Num_Exterior, Num_Interior,
// Colonia, CP, Ubicacion = "LOCALIDAD, Municipio, ENTIDAD", Telefono, Correo_e,
// Sitio_internet, Tipo, Longitud, Latitud; BuscarAreaAct agrega CLASE_ACTIVIDAD_ID,
// Fecha_Alta, AreaGeo…). Sin token válido: "No autorizado. Utilice una clave válida.".
// Sin resultados: texto "No hay resultados" (o 404 vacío).
// Claves de municipio: catálogo único de INEGI (sin token):
//   https://gaia.inegi.org.mx/wscatgeo/v2/mgem/{cve_ent}

const BASE = "https://www.inegi.org.mx/app/api/denue/v1/consulta";
const CATALOG = "https://gaia.inegi.org.mx/wscatgeo/v2/mgem";
const TIMEOUT_MS = 10_000;
const MAX_RADIUS_M = 5000; // tope de Buscar
const MAX_PAGE = 1000; // registros por llamada (paginamos en bloques ≤ 1000)
const MAX_LIMIT = 3000;
const DAY_MS = 24 * 60 * 60 * 1000;
const TTL_MS = 7 * DAY_MS; // DENUE es abierto: se puede cachear
const CATALOG_TTL_MS = 30 * DAY_MS;

export function denueReady(): boolean {
  return !!process.env.DENUE_TOKEN?.trim();
}

// Error con mensaje listo para el usuario + status HTTP.
export class DenueError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "DenueError";
    this.status = status;
  }
}

export interface DenueEstablishment {
  id: string; // CLEE (o Id si no viene)
  name: string;
  legalName?: string;
  scianCode?: string; // clase SCIAN de 6 dígitos
  activity: string; // nombre de la clase de actividad
  employees?: string; // estrato: "0 a 5 personas"…
  phone?: string;
  email?: string;
  website?: string;
  address?: string;
  colonia?: string;
  cp?: string;
  municipio?: string;
  entidad?: string;
  lat: number;
  lon: number;
  since?: string; // Fecha_Alta "AAAA-MM" (solo BuscarAreaAct*)
}

/* ---------- Entidades federativas (claves INEGI) ---------- */

const ENTIDADES: { code: string; name: string; iso: string; alias: string[] }[] = [
  { code: "01", name: "Aguascalientes", iso: "AGU", alias: ["ags"] },
  { code: "02", name: "Baja California", iso: "BCN", alias: ["bc"] },
  { code: "03", name: "Baja California Sur", iso: "BCS", alias: [] },
  { code: "04", name: "Campeche", iso: "CAM", alias: [] },
  { code: "05", name: "Coahuila de Zaragoza", iso: "COA", alias: ["coahuila"] },
  { code: "06", name: "Colima", iso: "COL", alias: [] },
  { code: "07", name: "Chiapas", iso: "CHP", alias: [] },
  { code: "08", name: "Chihuahua", iso: "CHH", alias: [] },
  {
    code: "09",
    name: "Ciudad de México",
    iso: "CMX",
    alias: ["cdmx", "df", "distrito federal", "mexico city", "ciudad de mexico"],
  },
  { code: "10", name: "Durango", iso: "DUR", alias: [] },
  { code: "11", name: "Guanajuato", iso: "GUA", alias: ["gto"] },
  { code: "12", name: "Guerrero", iso: "GRO", alias: [] },
  { code: "13", name: "Hidalgo", iso: "HID", alias: [] },
  { code: "14", name: "Jalisco", iso: "JAL", alias: [] },
  {
    code: "15",
    name: "México",
    iso: "MEX",
    alias: ["estado de mexico", "edomex", "edo mex", "edo de mexico", "mexico"],
  },
  { code: "16", name: "Michoacán de Ocampo", iso: "MIC", alias: ["michoacan"] },
  { code: "17", name: "Morelos", iso: "MOR", alias: [] },
  { code: "18", name: "Nayarit", iso: "NAY", alias: [] },
  { code: "19", name: "Nuevo León", iso: "NLE", alias: ["nl"] },
  { code: "20", name: "Oaxaca", iso: "OAX", alias: [] },
  { code: "21", name: "Puebla", iso: "PUE", alias: [] },
  { code: "22", name: "Querétaro", iso: "QUE", alias: ["queretaro de arteaga", "qro"] },
  { code: "23", name: "Quintana Roo", iso: "ROO", alias: ["qroo"] },
  { code: "24", name: "San Luis Potosí", iso: "SLP", alias: [] },
  { code: "25", name: "Sinaloa", iso: "SIN", alias: [] },
  { code: "26", name: "Sonora", iso: "SON", alias: [] },
  { code: "27", name: "Tabasco", iso: "TAB", alias: [] },
  { code: "28", name: "Tamaulipas", iso: "TAM", alias: [] },
  { code: "29", name: "Tlaxcala", iso: "TLA", alias: [] },
  {
    code: "30",
    name: "Veracruz de Ignacio de la Llave",
    iso: "VER",
    alias: ["veracruz"],
  },
  { code: "31", name: "Yucatán", iso: "YUC", alias: [] },
  { code: "32", name: "Zacatecas", iso: "ZAC", alias: [] },
];

// Minúsculas, sin acentos ni puntuación.
function norm(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9ñ]+/g, " ")
    .trim();
}

/**
 * Clave INEGI de 2 dígitos de una entidad: acepta "22", "Querétaro", "CDMX",
 * "Estado de México" o ISO 3166-2 ("MX-QUE" / "QUE"). "00" = todo el país.
 */
export function entidadCode(input: string): string | null {
  const s = input.trim();
  if (/^\d{1,2}$/.test(s)) {
    const n = Number(s);
    return n >= 0 && n <= 32 ? String(n).padStart(2, "0") : null;
  }
  const iso = s.toUpperCase().replace(/^MX-/, "");
  const byIso = ENTIDADES.find((e) => e.iso === iso || (iso === "DIF" && e.code === "09"));
  if (byIso) return byIso.code;
  const find = (n: string) =>
    ENTIDADES.find((e) => norm(e.name) === n || e.alias.includes(n))?.code ?? null;
  const n = norm(s);
  if (["todas", "todo el pais", "nacional", "pais"].includes(n)) return "00";
  // "Estado de Jalisco" -> "jalisco" (pero "Estado de México" es alias propio).
  return find(n) ?? find(n.replace(/^(estado|edo) (de |del )?/, ""));
}

export function entidadName(code: string): string | undefined {
  return ENTIDADES.find((e) => e.code === code)?.name;
}

/* ---------- Municipios (catálogo único de claves de INEGI) ---------- */

interface Municipio {
  code: string; // 3 dígitos
  name: string;
}

async function municipiosOf(ent: string): Promise<Municipio[]> {
  const key = `inegi-mun|${ent}`;
  const hit = await getCached<Municipio[]>(key, CATALOG_TTL_MS);
  if (hit && Array.isArray(hit.data) && hit.data.length) return hit.data;
  return coalesce(key, async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      const res = await fetch(`${CATALOG}/${ent}`, {
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(String(res.status));
      const d = (await res.json()) as { datos?: { cve_mun?: string; nomgeo?: string }[] };
      const list = (d.datos ?? [])
        .filter((m) => m.cve_mun && m.nomgeo)
        .map((m) => ({ code: String(m.cve_mun).padStart(3, "0"), name: String(m.nomgeo) }));
      if (list.length) {
        await setCached(key, { source: "inegi", category: "municipios", data: list });
      }
      return list;
    } catch {
      throw new DenueError("No se pudo leer el catálogo de municipios de INEGI.", 502);
    } finally {
      clearTimeout(t);
    }
  });
}

function normMunicipio(s: string): string {
  return norm(s)
    .replace(/^(municipio|alcaldia|delegacion|ciudad) (de |del )?/, "")
    .trim();
}

/**
 * Clave INEGI de 3 dígitos de un municipio dentro de una entidad. Acepta la
 * clave ("14", "014") o el nombre ("Querétaro", "Municipio de León").
 */
export async function municipioCode(ent: string, input: string): Promise<string | null> {
  const s = input.trim();
  if (/^\d{1,3}$/.test(s)) return s.padStart(3, "0");
  if (/^\d{5}$/.test(s) && s.startsWith(ent)) return s.slice(2);
  const want = normMunicipio(s);
  if (!want) return null;
  const list = await municipiosOf(ent);
  const exact = list.find((m) => normMunicipio(m.name) === want);
  if (exact) return exact.code;
  // "Dolores Hidalgo" vs "Dolores Hidalgo Cuna de la Independencia Nacional".
  const partial = list
    .filter((m) => {
      const n = normMunicipio(m.name);
      return n.startsWith(want + " ") || want.startsWith(n + " ");
    })
    .sort((a, b) => a.name.length - b.name.length)[0];
  return partial?.code ?? null;
}

/* ---------- Limpieza de campos ---------- */

// Texto limpio; DENUE trae vacíos, "0" o "NINGUNO" cuando no hay dato.
function txt(v: unknown): string | undefined {
  const s = String(v ?? "")
    .replace(/\s+/g, " ")
    .trim();
  if (!s || /^(0+|-+|n\/?a|null|none|ninguno|sin dato|sin nombre|no aplica)$/i.test(s)) {
    return undefined;
  }
  return s;
}

const LOWER_WORDS = new Set([
  "de", "del", "la", "las", "los", "el", "y", "e", "en", "a", "al", "para", "con", "por", "sin",
]);

// "TALLER MECANICO EL RAPIDO" -> "Taller Mecanico el Rapido". Solo si viene en
// mayúsculas; respeta siglas (S.A., HSBC) y romanos.
export function titleCase(s: string): string {
  if (s !== s.toUpperCase()) return s;
  return s
    .toLowerCase()
    .split(" ")
    .map((w, i) => {
      if (!w) return w;
      if (i > 0 && LOWER_WORDS.has(w)) return w;
      if (/^(s\.?a\.?|c\.?v\.?|s\.?c\.?|r\.?l\.?|sapi|sab|srl|[ivx]{2,4})[.,]?$/.test(w)) {
        return w.toUpperCase();
      }
      if (/^[bcdfghjklmnpqrstvwxzñ]{2,5}[.,]?$/.test(w)) return w.toUpperCase(); // siglas sin vocales
      return w.replace(/(^|[-/(."'])(\p{L})/gu, (_m, p: string, c: string) => p + c.toUpperCase());
    })
    .join(" ");
}

function titleOpt(v: unknown): string | undefined {
  const s = txt(v);
  return s ? titleCase(s) : undefined;
}

// Teléfono MX a 10 dígitos ("442 123 4567"). Puede traer varios separados.
export function normPhone(v: unknown): string | undefined {
  const s = txt(v);
  if (!s) return undefined;
  for (const part of s.split(/[/,;]| y | o /i)) {
    let d = part.replace(/\D/g, "");
    if (d.length === 12 && d.startsWith("52")) d = d.slice(2);
    else if (d.length === 13 && /^(521|044|045)/.test(d)) d = d.slice(3);
    if (d.length !== 10 || /^(\d)\1+$/.test(d)) continue;
    // Lada de 2 dígitos (CDMX, GDL, MTY) o de 3.
    return /^(55|56|33|81)/.test(d)
      ? `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`
      : `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  }
  return undefined;
}

export function normEmail(v: unknown): string | undefined {
  const s = txt(v);
  if (!s) return undefined;
  for (const p of s.split(/[\s,;/]+/)) {
    const e = p.toLowerCase().replace(/^mailto:/, "").replace(/[.)]+$/, "");
    if (/^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(e)) return e;
  }
  return undefined;
}

export function normWebsite(v: unknown): string | undefined {
  const s = txt(v);
  if (!s) return undefined;
  const first = s.split(/[\s,;]+/)[0];
  if (!first || first.includes("@")) return undefined;
  const raw = /^https?:\/\//i.test(first) ? first : `https://${first.replace(/^\/+/, "")}`;
  try {
    const u = new URL(raw);
    if (!u.hostname.includes(".") || /\.(\d+)$/.test(u.hostname)) return undefined;
    return u.toString().replace(/\/$/, "");
  } catch {
    return undefined;
  }
}

type RawRow = Record<string, unknown>;

// "COYOACÁN, Coyoacán, CIUDAD DE MÉXICO" -> localidad, municipio, entidad.
function parseUbicacion(v: unknown): { municipio?: string; entidad?: string } {
  const parts = (txt(v) ?? "")
    .split(",")
    .map((p) => p.trim())
    .filter(Boolean);
  if (!parts.length) return {};
  return {
    entidad: titleCase(parts[parts.length - 1]),
    municipio: parts.length >= 2 ? titleCase(parts[parts.length - 2]) : undefined,
  };
}

// Fila cruda de la API -> DenueEstablishment (null si no sirve).
function toEstablishment(r: RawRow): DenueEstablishment | null {
  const clee = txt(r.CLEE);
  const id = clee ?? txt(r.Id);
  const name = txt(r.Nombre) ?? txt(r.Razon_social);
  const lat = Number(r.Latitud);
  const lon = Number(r.Longitud);
  if (!id || !name || !Number.isFinite(lat) || !Number.isFinite(lon) || (!lat && !lon)) {
    return null;
  }

  // La CLEE trae entidad (2) + municipio (3) + clase SCIAN (6) + …
  const fromClee = clee && /^\d{11}/.test(clee) ? clee.slice(5, 11) : undefined;
  const scian = txt(r.CLASE_ACTIVIDAD_ID) ?? txt(r.Codigo_Act) ?? fromClee;
  const ubi = parseUbicacion(r.Ubicacion);
  const entidad =
    ubi.entidad ?? (clee && /^\d{2}/.test(clee) ? entidadName(clee.slice(0, 2)) : undefined);

  const tipo = titleOpt(r.Tipo_vialidad);
  const calle = titleOpt(r.Calle);
  const street =
    calle && tipo && !norm(calle).startsWith(norm(tipo)) ? `${tipo} ${calle}` : calle;
  const ext = txt(r.Num_Exterior);
  const int = txt(r.Num_Interior);
  const colonia = titleOpt(r.Colonia);
  const cp = txt(r.CP);
  const address = [
    [street, ext && !/^s\/?n$/i.test(ext) ? ext : ext ? "s/n" : undefined]
      .filter(Boolean)
      .join(" "),
    int ? `int. ${int}` : undefined,
    colonia ? `Col. ${colonia}` : undefined,
    cp ? `C.P. ${cp}` : undefined,
    ubi.municipio,
    entidad,
  ]
    .filter(Boolean)
    .join(", ");

  return {
    id,
    name: titleCase(name),
    legalName: txt(r.Razon_social),
    scianCode: scian && /^\d{6}$/.test(scian) ? scian : undefined,
    activity: txt(r.Clase_actividad) ?? "",
    employees: txt(r.Estrato),
    phone: normPhone(r.Telefono),
    email: normEmail(r.Correo_e),
    website: normWebsite(r.Sitio_internet),
    address: address || undefined,
    colonia,
    cp,
    municipio: ubi.municipio,
    entidad,
    lat,
    lon,
    since: txt(r.Fecha_Alta),
  };
}

function toList(rows: RawRow[]): DenueEstablishment[] {
  const seen = new Set<string>();
  const out: DenueEstablishment[] = [];
  for (const r of rows) {
    const e = toEstablishment(r);
    if (!e || seen.has(e.id)) continue;
    seen.add(e.id);
    out.push(e);
  }
  return out;
}

/* ---------- Llamadas a la API ---------- */

// Condición de búsqueda para la ruta: sin acentos (IIS da 404 con %C3%A9),
// palabras separadas por coma (así lo pide INEGI).
function encodeCondition(s: string | undefined, empty: string): string {
  const words = norm(s ?? "")
    .replace(/ñ/g, "n")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 6);
  return words.length ? words.map(encodeURIComponent).join(",") : empty;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function parseBody(text: string, status: number): RawRow[] {
  const s = text.trim();
  if (!s || /no hay resultados|sin resultados/i.test(s)) return [];
  if (/no autorizado|clave v[aá]lida/i.test(s)) {
    throw new DenueError(
      "El token de DENUE no es válido. Revisa DENUE_TOKEN (se obtiene gratis en inegi.org.mx).",
      502
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(s);
    // Buscar y BuscarEntidad, si se les pide JSON, mandan el arreglo
    // codificado DOS veces (un string que contiene el JSON). Lo desempacamos.
    if (typeof data === "string") {
      const inner = data.trim();
      if (!inner || /no hay resultados|sin resultados/i.test(inner)) return [];
      data = JSON.parse(inner);
    }
  } catch {
    // IIS responde 404 con HTML cuando la consulta no trae nada.
    if (status === 404) return [];
    throw new DenueError("El DENUE (INEGI) respondió algo inesperado. Intenta más tarde.", 502);
  }
  if (Array.isArray(data)) {
    return data.filter((x): x is RawRow => !!x && typeof x === "object" && !Array.isArray(x));
  }
  if (status === 404) return [];
  if (status >= 400) {
    throw new DenueError(`El DENUE (INEGI) rechazó la consulta (${status}).`, 502);
  }
  return [];
}

// Una llamada a la API con timeout (~10 s) y reintento en 5xx / red.
async function call(method: string, params: (string | number)[]): Promise<RawRow[]> {
  const token = process.env.DENUE_TOKEN?.trim();
  if (!token) {
    throw new DenueError("DENUE no está configurado (falta DENUE_TOKEN).", 503);
  }
  const url = [BASE, method, ...params.map(String), encodeURIComponent(token)].join("/");
  let lastErr: DenueError | null = null;

  for (let attempt = 0; attempt < 3; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    try {
      // Sin "Accept: application/json": con ese header Buscar/BuscarEntidad
      // responden JSON doblemente codificado.
      const res = await fetch(url, { signal: ctrl.signal });
      const text = await res.text();
      if (res.status >= 500 || res.status === 429) {
        lastErr = new DenueError(
          `El DENUE (INEGI) no responde ahora (${res.status}). Intenta de nuevo en unos segundos.`,
          502
        );
      } else {
        return parseBody(text, res.status);
      }
    } catch (e) {
      if (e instanceof DenueError) throw e;
      lastErr = ctrl.signal.aborted
        ? new DenueError("El DENUE (INEGI) tardó demasiado en responder. Intenta de nuevo.", 504)
        : new DenueError("No se pudo conectar con el DENUE (INEGI).", 502);
      if (attempt >= 1) break; // red o timeout: un solo reintento
    } finally {
      clearTimeout(timer);
    }
    await sleep(600 * (attempt + 1));
  }
  // Nunca incluye la URL (lleva el token).
  throw lastErr ?? new DenueError("No se pudo consultar el DENUE (INEGI).", 502);
}

export interface DenueResult {
  data: DenueEstablishment[];
  cachedAt?: string; // ISO si vino de la caché
}

// Caché en search_cache (7 días). No guardamos vacíos.
async function cachedCall(
  key: string,
  fn: () => Promise<DenueEstablishment[]>,
  refresh = false
): Promise<DenueResult> {
  if (!refresh) {
    const hit = await getCached<DenueEstablishment[]>(key, TTL_MS);
    if (hit && Array.isArray(hit.data)) return { data: hit.data, cachedAt: hit.createdAt };
  }
  const data = await coalesce(key, async () => {
    const list = await fn();
    if (list.length) await setCached(key, { source: "denue", data: list });
    return list;
  });
  return { data };
}

// Distancia en metros (haversine).
export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const toRad = (x: number) => (x * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export interface NearOptions {
  keyword: string;
  lat: number;
  lon: number;
  radiusM: number;
}

// Buscar: establecimientos alrededor de un punto (radio ≤ 5 km), del más cercano al más lejano.
export async function denueNearResult(
  o: NearOptions,
  opts: { refresh?: boolean } = {}
): Promise<DenueResult> {
  if (!Number.isFinite(o.lat) || !Number.isFinite(o.lon)) {
    throw new DenueError("Coordenadas inválidas para buscar en DENUE.", 400);
  }
  const radius = Math.max(1, Math.min(MAX_RADIUS_M, Math.round(o.radiusM || 0) || 1000));
  const cond = encodeCondition(o.keyword, "todos");
  const point = `${o.lat.toFixed(6)},${o.lon.toFixed(6)}`;
  const key = `denue|near|${cond}|${o.lat.toFixed(4)},${o.lon.toFixed(4)}|${radius}`;
  const r = await cachedCall(
    key,
    async () => toList(await call("Buscar", [cond, point, radius])),
    opts.refresh
  );
  const d = (e: DenueEstablishment) => distanceM(o.lat, o.lon, e.lat, e.lon);
  return { ...r, data: [...r.data].sort((a, b) => d(a) - d(b)) };
}

export async function denueNear(o: NearOptions): Promise<DenueEstablishment[]> {
  return (await denueNearResult(o)).data;
}

export interface AreaOptions {
  entidad: string; // clave ("22") o nombre ("Querétaro")
  municipio?: string; // clave ("014") o nombre ("Querétaro")
  scianCode?: string; // 2 a 6 dígitos (sector, subsector, rama o clase)
  keyword?: string;
  limit?: number; // máx. de registros (por defecto 100, tope 3000)
}

// Resuelve entidad/municipio a claves INEGI o lanza un error claro.
async function resolveArea(o: AreaOptions): Promise<{ ent: string; mun: string | null }> {
  const ent = entidadCode(o.entidad ?? "");
  if (!ent) throw new DenueError(`No reconozco la entidad "${o.entidad}".`, 400);
  let mun: string | null = null;
  if (o.municipio?.trim()) {
    if (ent === "00") throw new DenueError("Para buscar por municipio indica la entidad.", 400);
    mun = await municipioCode(ent, o.municipio);
    if (!mun) {
      throw new DenueError(
        `No encontré el municipio "${o.municipio}" en ${entidadName(ent) ?? ent}.`,
        400
      );
    }
  }
  return { ent, mun };
}

/**
 * Una página de BuscarAreaAct (registros start..end, 1-indexados). Niveles SCIAN
 * por prefijo del código: "811111" -> sector 81, subsector 811, rama 8111, clase 811111.
 */
export async function denueAreaPage(
  q: { ent: string; mun?: string | null; scianCode?: string; keyword?: string },
  start: number,
  end: number,
  opts: { refresh?: boolean } = {}
): Promise<DenueResult> {
  const scian = (q.scianCode ?? "").replace(/\D/g, "");
  if (scian && (scian.length < 2 || scian.length > 6)) {
    throw new DenueError(`Código SCIAN inválido: ${q.scianCode}`, 400);
  }
  const lvl = (n: number) => (scian.length >= n ? scian.slice(0, n) : "0");
  const nombre = encodeCondition(q.keyword, "0");
  const s = Math.max(1, Math.floor(start));
  const e = Math.min(s + MAX_PAGE - 1, Math.max(s, Math.floor(end)));
  const params = [
    q.ent,
    q.mun || "0",
    "0", // localidad
    "0", // AGEB
    "0", // manzana
    lvl(2),
    lvl(3),
    lvl(4),
    scian.length === 6 ? scian : "0",
    nombre,
    s,
    e,
    "0", // id
  ];
  const key = `denue|area|${params.join("|")}`;
  return cachedCall(key, async () => toList(await call("BuscarAreaAct", params)), opts.refresh);
}

// BuscarEntidad: texto libre (nombre, razón social, calle, colonia, actividad…) en un estado.
async function entidadPage(
  ent: string,
  keyword: string,
  start: number,
  end: number
): Promise<DenueEstablishment[]> {
  const cond = encodeCondition(keyword, "todos");
  const params = [cond, ent, start, end];
  const key = `denue|ent|${params.join("|")}`;
  return (
    await cachedCall(key, async () => toList(await call("BuscarEntidad", params)))
  ).data;
}

/**
 * Establecimientos por área (entidad / municipio) y giro (SCIAN) o palabra.
 * - Con SCIAN: BuscarAreaAct (keyword filtra por nombre).
 * - Solo palabra + municipio: BuscarEntidad y filtra por municipio (CLEE).
 * - Solo palabra: BuscarEntidad.
 */
export async function denueByArea(o: AreaOptions): Promise<DenueEstablishment[]> {
  const { ent, mun } = await resolveArea(o);
  const limit = Math.max(1, Math.min(MAX_LIMIT, Math.floor(o.limit ?? 100)));
  const keyword = o.keyword?.trim() || undefined;
  const out: DenueEstablishment[] = [];
  const seen = new Set<string>();
  const push = (list: DenueEstablishment[]) => {
    for (const e of list) {
      if (out.length >= limit) break;
      if (seen.has(e.id)) continue;
      seen.add(e.id);
      out.push(e);
    }
  };

  if (keyword && !o.scianCode) {
    // Texto libre: BuscarEntidad busca también en la clase de actividad.
    const inMun = (e: DenueEstablishment) => !mun || e.id.slice(2, 5) === mun;
    const pages = mun ? 3 : Math.ceil(limit / MAX_PAGE);
    for (let p = 0; p < pages && out.length < limit; p++) {
      const start = p * MAX_PAGE + 1;
      const size = mun ? MAX_PAGE : Math.min(MAX_PAGE, limit - out.length);
      const batch = await entidadPage(ent, keyword, start, start + size - 1);
      push(batch.filter(inMun));
      if (batch.length < size) break;
    }
    return out;
  }

  for (let start = 1; out.length < limit; start += MAX_PAGE) {
    const size = Math.min(MAX_PAGE, limit - out.length);
    const { data } = await denueAreaPage(
      { ent, mun, scianCode: o.scianCode, keyword },
      start,
      start + size - 1
    );
    push(data);
    if (data.length < size) break;
  }
  return out;
}

/* ---------- Lugar geocodificado (OSM) -> área de búsqueda DENUE ---------- */

// Lugares más chicos que un municipio: se buscan por cercanía al punto.
const SUB_MUNICIPAL = new Set([
  "suburb", "neighbourhood", "quarter", "hamlet", "village", "isolated_dwelling",
  "locality", "road", "residential", "city_block", "square", "farm", "postcode",
  "amenity", "building", "shop", "office", "industrial", "commercial", "retail",
]);

export interface DenueArea {
  entidad: string; // clave INEGI
  municipio?: string; // nombre del municipio (se resuelve a clave después)
  scope: "municipio" | "entidad" | "punto";
}

/** Decide cómo buscar en DENUE un lugar geocodificado (null si no es de México). */
export function denueAreaForPlace(
  p: Pick<GeoPlace, "kind" | "stateIso" | "state" | "county" | "borough">,
  query?: string
): DenueArea | null {
  const ent = (p.stateIso && entidadCode(p.stateIso)) || (p.state && entidadCode(p.state)) || null;
  if (!ent || ent === "00") return null;
  const kind = p.kind ?? "";
  if (kind === "state") return { entidad: ent, scope: "entidad" };
  const mun = p.county ?? p.borough;
  if (SUB_MUNICIPAL.has(kind)) return { entidad: ent, municipio: mun, scope: "punto" };
  // CDMX: el "municipio" es la alcaldía; solo si eso fue lo que se buscó.
  if (ent === "09" && !p.county) {
    if (p.borough && query && norm(query).includes(norm(p.borough))) {
      return { entidad: ent, municipio: p.borough, scope: "municipio" };
    }
    return { entidad: ent, scope: "entidad" };
  }
  return mun ? { entidad: ent, municipio: mun, scope: "municipio" } : { entidad: ent, scope: "entidad" };
}

/* ---------- Conversión a Business ---------- */

export function denueToBusiness(e: DenueEstablishment, category: string): Business {
  return {
    id: `denue/${e.id}`,
    name: e.name,
    category,
    phone: e.phone,
    website: e.website,
    email: e.email,
    address: e.address,
    city: e.municipio,
    lat: e.lat,
    lon: e.lon,
    source: "denue",
    denueId: e.id,
    employees: e.employees,
  };
}

/* ---------- Emparejar un negocio (p. ej. de Google) con DENUE ---------- */

const STOP = new Set([
  "de", "del", "la", "las", "el", "los", "y", "e", "en", "the", "and", "sa", "cv", "rl",
  "srl", "sapi", "sab", "sc", "sas", "suc", "sucursal", "no", "num", "mx",
]);

// Palabras de giro que no distinguen a un negocio de otro.
const GENERIC = new Set([
  "taller", "talleres", "mecanico", "mecanica", "mecanicos", "automotriz", "automotor",
  "automotores", "auto", "autos", "automoviles", "automovil", "car", "cars", "motors",
  "motor", "refaccionaria", "refaccionarias", "refacciones", "servicio", "servicios",
  "agencia", "inmobiliaria", "inmobiliarias", "bienes", "raices", "realty", "real",
  "estate", "grupo", "comercializadora", "comercial", "centro", "venta", "ventas",
  "compra", "seminuevos", "usados", "nuevos", "hojalateria", "pintura", "electrico",
  "electrica", "llantera", "llantas", "lavado", "matriz", "distribuidora", "distribuidor",
  "tienda", "plaza", "corporativo", "consultores", "asesores", "partes", "accesorios",
  "mexico", "camiones", "camionetas", "reparacion", "mantenimiento", "multimarca",
]);

function tokens(s: string): string[] {
  return norm(s.replace(/&/g, " y "))
    .split(/\s+/)
    .filter((t) => t.length >= 2 && !STOP.has(t));
}

function bigrams(s: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < s.length - 1; i++) out.push(s.slice(i, i + 2));
  return out;
}

function dice(a: string, b: string): number {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return a === b && !!a ? 1 : 0;
  const pool = new Map<string, number>();
  for (const x of B) pool.set(x, (pool.get(x) ?? 0) + 1);
  let inter = 0;
  for (const x of A) {
    const n = pool.get(x) ?? 0;
    if (n > 0) {
      inter++;
      pool.set(x, n - 1);
    }
  }
  return (2 * inter) / (A.length + B.length);
}

// Mismo token con una letra de diferencia ("rapida" ~ "rapido") o prefijo largo.
function sameToken(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.length >= 4 && b.length >= 4 && (a.startsWith(b) || b.startsWith(a))) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  // Distancia de edición ≤ 1.
  let i = 0;
  let j = 0;
  let edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/**
 * Similitud 0..1 entre dos nombres de negocio. Ignora acentos, mayúsculas,
 * "S.A. de C.V." y palabras de giro ("taller", "autos"…): "Taller Juárez" y
 * "Taller González" NO se parecen; "Toyota Satélite" y "AUTOS SATELITE TOYOTA" sí.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = tokens(a);
  const tb = tokens(b);
  if (!ta.length || !tb.length) return 0;
  if (ta.join(" ") === tb.join(" ")) return 1;
  const da = [...new Set(ta.filter((t) => !GENERIC.has(t)))];
  const db = [...new Set(tb.filter((t) => !GENERIC.has(t)))];
  // Sin palabras distintivas: solo vale si el nombre completo casi coincide.
  if (!da.length || !db.length) {
    const d = dice(ta.join(""), tb.join(""));
    return d >= 0.9 ? d : d * 0.5;
  }
  const inter = da.filter((t) => db.some((u) => sameToken(t, u))).length;
  const tokDice = (2 * inter) / (da.length + db.length);
  const contain = inter / Math.min(da.length, db.length);
  const containScore = contain === 1 ? 0.85 + 0.15 * tokDice : contain * 0.6;
  const charScore = dice(da.join(""), db.join("")) * 0.9;
  return Math.min(1, Math.max(tokDice, containScore, charScore));
}

// Palabra más distintiva del nombre (para acotar la búsqueda en DENUE).
function keyWord(name: string): string | undefined {
  return tokens(name)
    .filter((t) => !GENERIC.has(t) && t.length >= 3 && !/^\d+$/.test(t))
    .sort((x, y) => y.length - x.length)[0];
}

export interface DenueMatch {
  e: DenueEstablishment;
  score: number; // similitud de nombre 0..1
  distanceM?: number;
}

function bestMatch(
  name: string,
  list: DenueEstablishment[],
  min: number,
  point?: { lat: number; lon: number; maxM: number }
): DenueMatch | null {
  let best: DenueMatch | null = null;
  for (const e of list) {
    const dist = point ? distanceM(point.lat, point.lon, e.lat, e.lon) : undefined;
    if (point && dist! > point.maxM) continue;
    const score = Math.max(
      nameSimilarity(name, e.name),
      e.legalName ? nameSimilarity(name, e.legalName) : 0
    );
    if (score < min) continue;
    const better =
      !best ||
      score > best.score + 0.02 ||
      (Math.abs(score - best.score) <= 0.02 && (dist ?? 0) < (best.distanceM ?? 0));
    if (better) best = { e, score, distanceM: dist };
  }
  return best;
}

/**
 * Busca en DENUE el mismo negocio: por cercanía (≤ 250 m del punto) con nombre
 * parecido; si no hay coordenadas, por nombre dentro del municipio (más estricto).
 * Devuelve null si no hay una coincidencia confiable.
 */
export async function denueMatch(o: {
  name: string;
  lat?: number | null;
  lon?: number | null;
  maxDistanceM?: number;
  area?: { entidad: string; municipio?: string };
}): Promise<DenueMatch | null> {
  const name = o.name?.trim();
  if (!name) return null;
  const word = keyWord(name);

  if (typeof o.lat === "number" && typeof o.lon === "number" && Number.isFinite(o.lat) && Number.isFinite(o.lon)) {
    const maxM = Math.min(o.maxDistanceM ?? 250, 1000);
    const point = { lat: o.lat, lon: o.lon, maxM };
    // 1) Con la palabra más distintiva (respuesta chica); 2) todos los del radio.
    if (word) {
      const near = await denueNear({ keyword: word, lat: o.lat, lon: o.lon, radiusM: maxM });
      const m = bestMatch(name, near, 0.6, point);
      if (m) return m;
    }
    const all = await denueNear({ keyword: "todos", lat: o.lat, lon: o.lon, radiusM: maxM });
    return bestMatch(name, all, 0.6, point);
  }

  if (o.area && word) {
    const list = await denueByArea({
      entidad: o.area.entidad,
      municipio: o.area.municipio,
      keyword: word,
      limit: 200,
    });
    return bestMatch(name, list, 0.75);
  }
  return null;
}
