import { applyVars } from "./apply-template";
import type { Business } from "./types";

// Arma un link de WhatsApp (wa.me) con el texto ya listo. MX por defecto.
export function waLink(phone: string, text: string): string | null {
  let digits = phone.replace(/\D/g, "");
  if (!digits) return null;
  if (digits.length === 10) digits = "52" + digits; // MX sin lada país
  else if (digits.length === 13 && digits.startsWith("521")) digits = "52" + digits.slice(3);
  return `https://wa.me/${digits}?text=${encodeURIComponent(text)}`;
}

// Mensaje de WhatsApp: usa la plantilla elegida (con variables) o uno por defecto.
export function buildWaText(
  lead: Pick<Business, "name" | "city" | "category">,
  templateBody?: string,
  vendedor?: string
): string {
  if (templateBody) return applyVars(templateBody, lead, { vendedor });
  return `Hola, equipo de ${lead.name}. Le escribo de AI Lead Shield: ayudamos a negocios como el suyo a conseguir más clientes con automatización e inteligencia artificial. ¿Tendrían 15 min esta semana para mostrarles cómo?`;
}

// Registra que se abrió WhatsApp con este negocio (no bloquea el link).
export function logWhatsApp(p: {
  leadId?: string;
  phone?: string;
  name?: string;
  email?: string;
}): void {
  try {
    fetch("/api/outreach", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "whatsapp", ...p }),
      keepalive: true,
    }).catch(() => {});
  } catch {
    /* ignora */
  }
}
