// Utilidades de la UI "Investigar con IA". Todo lo que viene del agente pudo
// salir de webs no confiables: los enlaces se validan antes de pintarlos.
import type { ResearchProspect, ResearchSource } from "@/lib/research-types";
import type { Business } from "@/lib/types";

export const SOURCE_LABEL: Record<ResearchSource, string> = {
  denue: "DENUE",
  osm: "OpenStreetMap",
  web: "Web del negocio",
  google: "Google",
};

// Lo de Google es solo para ver: no se exporta, no va a GHL, no va al mapa.
export const isGoogle = (p: Pick<ResearchProspect, "source">) => p.source === "google";

// Solo http(s). javascript:, data:, mailto: y demás se descartan.
export function safeUrl(raw?: string | null): string | null {
  if (!raw) return null;
  let s = raw.trim();
  if (!s || /\s/.test(s)) return null;
  if (!/^https?:\/\//i.test(s)) {
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s)) return null; // otro esquema
    s = `https://${s.replace(/^\/+/, "")}`;
  }
  try {
    const u = new URL(s);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    if (!u.hostname.includes(".")) return null;
    return u.toString();
  } catch {
    return null;
  }
}

// "https://www.clinica.mx/contacto" -> "clinica.mx"
export function displayHost(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

export function socialLabel(url: string): string {
  const h = displayHost(url).toLowerCase();
  if (h.includes("facebook") || h === "fb.com" || h.endsWith(".fb.com")) return "Facebook";
  if (h.includes("instagram")) return "Instagram";
  if (h.includes("linkedin")) return "LinkedIn";
  if (h.includes("tiktok")) return "TikTok";
  if (h.includes("youtube") || h === "youtu.be") return "YouTube";
  if (h === "x.com" || h.includes("twitter")) return "X";
  if (h.includes("wa.me") || h.includes("whatsapp")) return "WhatsApp";
  return h;
}

const EMAIL_RE = /^[^\s@<>()"',;:]+@[^\s@<>()"',;:]+\.[^\s@<>()"',;:]+$/;

export function mailHref(email?: string | null): string | null {
  const e = email?.trim();
  return e && EMAIL_RE.test(e) ? `mailto:${e}` : null;
}

export function telHref(phone?: string | null): string | null {
  const d = phone?.replace(/[^\d+]/g, "") ?? "";
  return d.replace(/\D/g, "").length >= 7 ? `tel:${d}` : null;
}

// "14:05:32"
export function clockTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleTimeString("es-MX", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

// "8 oct 2026, 14:05"
export function dateTime(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleString("es-MX", {
    day: "numeric",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

// "1 min 20 s"
export function duration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  return `${m} min ${String(s % 60).padStart(2, "0")} s`;
}

export function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const hasCoords = (p: ResearchProspect) =>
  typeof p.lat === "number" &&
  typeof p.lon === "number" &&
  Number.isFinite(p.lat) &&
  Number.isFinite(p.lon) &&
  !(p.lat === 0 && p.lon === 0);

// Prospecto del agente -> Business (para ComposeModal). Nunca lleva datos de
// Google: de un resultado de Google solo pasa el nombre, su place_id y lo que
// salió de su web (correo / WhatsApp). Sin coordenadas = NaN (convención de
// Business). Si ya estaba guardado, se usa el id del prospecto guardado.
export function toBusiness(p: ResearchProspect, city?: string): Business {
  const google = isGoogle(p);
  const coords = !google && hasCoords(p);
  return {
    id: p.existing?.leadId || p.id,
    name: p.name,
    category: p.category ?? "",
    email: p.email || p.emails?.[0] || undefined,
    phone: google ? p.whatsapp || undefined : p.phone || p.whatsapp || undefined,
    website: google ? undefined : safeUrl(p.website) ?? undefined,
    address: google ? undefined : p.address,
    city: city || undefined,
    lat: coords ? (p.lat as number) : NaN,
    lon: coords ? (p.lon as number) : NaN,
    source: p.source === "web" ? undefined : p.source,
    denueId: p.denueId,
    placeId: p.placeId,
    employees: p.employees,
    score: p.score,
  };
}

// Copia al portapapeles; con respaldo para sitios sin HTTPS (IP de red local).
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* intenta el respaldo */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

export function reportUrl(id: string): string {
  return `${window.location.origin}/investigacion/${encodeURIComponent(id)}`;
}
