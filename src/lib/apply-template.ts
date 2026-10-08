import type { Business } from "./types";

// Datos extra que no vienen del negocio (p. ej. quién envía).
export interface VarsContext {
  vendedor?: string;
}

// Sustituye las variables de una plantilla con los datos del negocio.
// {{vendedor}} = nombre del vendedor logueado (vacío si no se conoce).
export function applyVars(
  text: string,
  lead: Pick<Business, "name" | "city" | "category">,
  ctx?: VarsContext
): string {
  return text
    .replace(/\{\{\s*nombre\s*\}\}/gi, lead.name || "")
    .replace(/\{\{\s*ciudad\s*\}\}/gi, lead.city || "")
    .replace(/\{\{\s*giro\s*\}\}/gi, lead.category || "")
    .replace(/\{\{\s*vendedor\s*\}\}/gi, ctx?.vendedor || "");
}

// Escapa los caracteres especiales de HTML (un "<" suelto rompe el correo).
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

// Texto plano -> HTML de correo: un <p> por línea, <br/> en las vacías.
export function textToHtml(text: string): string {
  return text
    .split("\n")
    .map((l) => (l.trim() ? `<p>${escapeHtml(l)}</p>` : "<br/>"))
    .join("");
}
