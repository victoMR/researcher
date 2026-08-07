import type { Business } from "./types";

// Sustituye las variables de una plantilla con los datos del negocio.
export function applyVars(text: string, lead: Pick<Business, "name" | "city" | "category">): string {
  return text
    .replace(/\{\{\s*nombre\s*\}\}/gi, lead.name || "")
    .replace(/\{\{\s*ciudad\s*\}\}/gi, lead.city || "")
    .replace(/\{\{\s*giro\s*\}\}/gi, lead.category || "");
}
