// Filtros de contacto ("Con correo", "Con teléfono", ...) que se combinan con Y.
// Lógica pura (cliente y servidor): Buscar filtra en el navegador con estas
// funciones; Prospectos manda los mismos filtros a GET /api/leads y
// src/lib/leads-repo.ts los aplica en SQL con el MISMO criterio.
//
// Criterio de "Con WhatsApp": en México, desde la marcación a 10 dígitos
// (2019), un celular y un fijo tienen el mismo formato y no se distinguen sin
// el plan de numeración del IFT. Por eso cuenta como "posible WhatsApp":
//   1) un teléfono MX válido de 10 dígitos (acepta +52, 521 y 01; si el campo
//      trae varios números separados por ; , / o |, basta con uno), o
//   2) un botón/enlace de WhatsApp detectado en su web (solo en Buscar, cuando
//      ya se revisó el sitio; en Prospectos no se guarda ese dato).
import { isValidMxPhone } from "./scoring";

export type ContactFilterKey = "email" | "phone" | "website" | "whatsapp" | "score" | "hideSaved";
export type ContactFilterSel = Partial<Record<ContactFilterKey, boolean>>;

// "Score ≥ 7" = Bueno o Completo (ver scoreLabel en src/lib/scoring.ts).
export const SCORE_CHIP_MIN = 7;

export const SEARCH_FILTER_KEYS: ContactFilterKey[] = [
  "email",
  "phone",
  "website",
  "whatsapp",
  "score",
  "hideSaved",
];
export const PROSPECT_FILTER_KEYS: ContactFilterKey[] = [
  "email",
  "phone",
  "website",
  "whatsapp",
  "score",
];

export const CONTACT_FILTER_META: Record<ContactFilterKey, { label: string; title: string }> = {
  email: { label: "Con correo", title: "Solo los que tienen correo" },
  phone: { label: "Con teléfono", title: "Solo los que tienen teléfono" },
  website: { label: "Con sitio web", title: "Solo los que tienen sitio web" },
  whatsapp: {
    label: "Con WhatsApp",
    title:
      "Teléfono de México válido a 10 dígitos (posible WhatsApp: en México no se distingue celular de fijo por el número). En Buscar también cuenta el botón de WhatsApp de su web.",
  },
  score: {
    label: `Score ≥ ${SCORE_CHIP_MIN}`,
    title: `Solo prospectos con calificación de ${SCORE_CHIP_MIN} o más (Bueno o Completo)`,
  },
  hideSaved: {
    label: "Ocultar ya guardados",
    title: "Oculta los que ya están en Prospectos (guardados o contactados por alguien del equipo)",
  },
};

// Alguno de los dígitos del campo es un teléfono MX válido (10 dígitos).
// Mismo criterio que el SQL de leads-repo (regexp_split_to_table + regex).
export function hasMxWhatsappNumber(phone?: string | null): boolean {
  if (!phone) return false;
  return phone.split(/[;,/|]/).some((p) => isValidMxPhone(p));
}

// Señales de /api/extract-email: número del botón o el aviso de botón/enlace.
export function webHasWhatsapp(d: { whatsapp?: unknown; signals?: unknown }): boolean {
  if (typeof d.whatsapp === "string" && d.whatsapp.trim()) return true;
  return (
    Array.isArray(d.signals) &&
    d.signals.some((s) => typeof s === "string" && /^Bot[oó]n o enlace de WhatsApp/i.test(s))
  );
}

// Lo que se sabe de un negocio para filtrar en el navegador (Buscar).
export interface ContactFacts {
  email?: string | null;
  phone?: string | null;
  website?: string | null;
  score?: number;
  waWeb?: boolean; // WhatsApp detectado en su web
  saved?: boolean; // ya está en Prospectos (guardado o contactado)
}

const filled = (v?: string | null) => !!v && v.trim() !== "";

export function matchesContactFilter(key: ContactFilterKey, f: ContactFacts): boolean {
  switch (key) {
    case "email":
      return filled(f.email);
    case "phone":
      return filled(f.phone);
    case "website":
      return filled(f.website);
    case "whatsapp":
      return !!f.waWeb || hasMxWhatsappNumber(f.phone);
    case "score":
      return (f.score ?? 0) >= SCORE_CHIP_MIN;
    case "hideSaved":
      return !f.saved;
  }
}

export function activeKeys(sel: ContactFilterSel, keys: ContactFilterKey[]): ContactFilterKey[] {
  return keys.filter((k) => sel[k]);
}

// Aplica los filtros activos (Y) y cuenta, por chip, cuántos quedarían con ese
// chip encendido además de los demás activos (si ya está activo = lo que se ve).
export function applyContactFilters<T>(
  items: T[],
  sel: ContactFilterSel,
  facts: (t: T) => ContactFacts,
  keys: ContactFilterKey[] = SEARCH_FILTER_KEYS
): { items: T[]; counts: Record<ContactFilterKey, number> } {
  const on = activeKeys(sel, keys);
  const counts = Object.fromEntries(keys.map((k) => [k, 0])) as Record<ContactFilterKey, number>;
  const out: T[] = [];
  for (const it of items) {
    const f = facts(it);
    const pass = new Set(keys.filter((k) => matchesContactFilter(k, f)));
    const failed = on.filter((k) => !pass.has(k));
    if (!failed.length) out.push(it);
    for (const k of keys) {
      // Cuenta si cumple k y todos los activos distintos de k.
      if (pass.has(k) && failed.every((x) => x === k)) counts[k] += 1;
    }
  }
  return { items: out, counts };
}

/* ---------- Prospectos: parámetros de GET /api/leads ---------- */

// Filtros de contacto ya validados para listLeads.
export interface ContactQuery {
  hasEmail: boolean;
  hasPhone: boolean;
  hasWebsite: boolean;
  hasWhatsapp: boolean;
  minScore: number | null; // 1..10
}

// Selección de chips -> ?has_email=1&has_phone=1&...&min_score=7
export function contactSelToParams(sel: ContactFilterSel | undefined, p: URLSearchParams): void {
  if (!sel) return;
  if (sel.email) p.set("has_email", "1");
  if (sel.phone) p.set("has_phone", "1");
  if (sel.website) p.set("has_website", "1");
  if (sel.whatsapp) p.set("has_whatsapp", "1");
  if (sel.score) p.set("min_score", String(SCORE_CHIP_MIN));
}

// Lee y valida los parámetros (cualquier otro valor = filtro apagado).
export function parseContactParams(p: URLSearchParams): ContactQuery {
  const flag = (k: string) => {
    const v = (p.get(k) ?? "").toLowerCase();
    return v === "1" || v === "true";
  };
  const raw = p.get("min_score");
  const n = raw == null || raw.trim() === "" ? NaN : Number(raw);
  return {
    hasEmail: flag("has_email"),
    hasPhone: flag("has_phone"),
    hasWebsite: flag("has_website"),
    hasWhatsapp: flag("has_whatsapp"),
    minScore: Number.isFinite(n) ? Math.max(1, Math.min(10, Math.floor(n))) : null,
  };
}

/* ---------- Selección guardada por usuario (Buscar) ---------- */

const storageKey = (user: string) => `als:buscar-filtros:${user.toLowerCase()}`;

export function loadContactSel(user: string | null | undefined): ContactFilterSel {
  if (!user) return {};
  try {
    const raw = window.localStorage.getItem(storageKey(user));
    const v = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
    if (!v || typeof v !== "object") return {};
    const out: ContactFilterSel = {};
    for (const k of SEARCH_FILTER_KEYS) if (v[k] === true) out[k] = true;
    return out;
  } catch {
    return {}; // modo privado, almacenamiento bloqueado o JSON roto
  }
}

export function saveContactSel(user: string | null | undefined, sel: ContactFilterSel): void {
  if (!user) return;
  try {
    const on = activeKeys(sel, SEARCH_FILTER_KEYS);
    if (on.length) {
      window.localStorage.setItem(
        storageKey(user),
        JSON.stringify(Object.fromEntries(on.map((k) => [k, true])))
      );
    } else {
      window.localStorage.removeItem(storageKey(user));
    }
  } catch {
    /* sin almacenamiento: solo dura la sesión */
  }
}
