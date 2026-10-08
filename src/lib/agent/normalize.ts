// Utilidades puras del agente: textos, nombres, distancias y dominios.

// Recorta y limpia un texto (sin saltos raros); undefined si queda vacío.
export function clip(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// Igual que clip pero respeta saltos de línea (para Markdown corto).
export function clipMultiline(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const s = v
    .replace(/\r/g, "")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!s) return undefined;
  return s.length > max ? s.slice(0, max - 1).trimEnd() + "…" : s;
}

// Lista de textos limpia, sin duplicados (ignora mayúsculas/acentos).
export function clipList(v: unknown, maxItems: number, maxLen: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of v) {
    const s = clip(item, maxLen);
    if (!s) continue;
    const k = normText(s);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(s);
    if (out.length >= maxItems) break;
  }
  return out;
}

export function mergeLists(a: string[], b: string[], maxItems: number): string[] {
  return clipList([...a, ...b], maxItems, 400);
}

// Minúsculas, sin acentos ni puntuación.
export function normText(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

// Palabras que no distinguen a un negocio de otro del mismo giro.
const GENERIC = new Set([
  "de", "del", "la", "el", "los", "las", "y", "e", "en", "a", "s", "c", "v", "sa", "cv", "rl",
  "sc", "sapi", "srl", "the", "dr", "dra", "doctor", "doctora", "lic", "clinica", "consultorio",
  "centro", "grupo", "servicios", "servicio", "mexico", "sucursal", "matriz", "dental", "dentista",
]);

function nameTokens(name: string): Set<string> {
  return new Set(
    normText(name)
      .split(" ")
      .filter((t) => t && !GENERIC.has(t))
  );
}

// ¿Dos nombres son del mismo negocio? (igualdad normalizada o palabras
// distintivas casi iguales). Se combina con distancia o teléfono/dominio.
export function similarNames(a: string, b: string): boolean {
  const na = normText(a);
  const nb = normText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.size || !tb.size) return false;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  const small = Math.min(ta.size, tb.size);
  const union = ta.size + tb.size - inter;
  return inter / union >= 0.5 || (inter === small && small >= 1 && (small >= 2 || union <= 3));
}

// Distancia en metros entre dos puntos (haversine).
export function distanceM(
  a: { lat?: number; lon?: number },
  b: { lat?: number; lon?: number }
): number {
  if (!isNum(a.lat) || !isNum(a.lon) || !isNum(b.lat) || !isNum(b.lon)) return Infinity;
  const R = 6371000;
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

export function isNum(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

export function clampNum(v: unknown, min: number, max: number, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" ? Number(v) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// Hosts compartidos por muchos negocios: no sirven para deduplicar.
const SHARED_HOSTS = [
  "facebook.com", "instagram.com", "linktr.ee", "wa.me", "whatsapp.com", "google.com",
  "goo.gl", "youtube.com", "tiktok.com", "linkedin.com", "twitter.com", "x.com",
  "doctoralia.com.mx", "mercadolibre.com.mx", "sites.google.com", "business.site",
];

// "https://www.Ejemplo.com.mx/contacto" -> "ejemplo.com.mx"
export function hostOf(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.toLowerCase().replace(/^www\./, "") || undefined;
  } catch {
    return undefined;
  }
}

// Dominio útil para deduplicar (undefined si es una red social o similar).
export function ownDomain(url: string | undefined | null): string | undefined {
  const h = hostOf(url);
  if (!h) return undefined;
  if (SHARED_HOSTS.some((s) => h === s || h.endsWith("." + s))) return undefined;
  return h;
}

// URL presentable y segura (solo http/https).
export function cleanUrl(v: unknown): string | undefined {
  const s = clip(v, 300);
  if (!s) return undefined;
  try {
    const u = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
    if (u.protocol !== "http:" && u.protocol !== "https:") return undefined;
    if (!u.hostname.includes(".")) return undefined;
    return u.toString();
  } catch {
    return undefined;
  }
}

export function cleanEmail(v: unknown): string | undefined {
  const s = clip(v, 120)?.toLowerCase();
  if (!s) return undefined;
  return /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/.test(s) ? s : undefined;
}

// "1500" -> "1.5 km"; "800" -> "800 m"
export function fmtDistance(m: number): string {
  if (m >= 1000) return `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km`;
  return `${Math.round(m)} m`;
}
