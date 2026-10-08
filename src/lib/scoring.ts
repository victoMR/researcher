// Modelo de calificación de prospectos (1..10) POR RESTA: un negocio con
// todos sus datos de contacto y actividad reciente vale 10; cada dato que
// falta o está viejo resta puntos. Determinístico y explicable: siempre
// devuelve el desglose para mostrar "10 − 3 (sin correo) − 1 (sin web) = 6".
// Se usa igual en Buscar, Prospectos y el agente "Investigar con IA".

export interface ScoreInput {
  phone?: string | null;
  whatsapp?: string | null;
  email?: string | null;
  emailIsGuess?: boolean; // correo sugerido (no publicado por el negocio)
  website?: string | null;
  address?: string | null;
  businessStatus?: string | null; // OPERATIONAL | CLOSED_TEMPORARILY | CLOSED_PERMANENTLY
  lastActivityAt?: string | number | null; // reseña/publicación más reciente (ISO o ms)
  websiteOk?: boolean; // el sitio respondió en la última revisión
  dataCheckedAt?: string | number | null; // cuándo se revisaron sus datos de contacto
}

export interface ScoreDeduction {
  points: number; // negativo
  reason: string;
}

export interface ScoreResult {
  score: number; // 1..10
  max: 10;
  deductions: ScoreDeduction[];
  label: "Completo" | "Bueno" | "Incompleto" | "Pobre";
}

const DAY = 86400000;

// Correos de área que existen pero no son de ventas.
const LOW_ROLE =
  /^(soporte|support|facturacion|facturaci[oó]n|cobranza|rh|recursoshumanos|reclutamiento|empleo|vacantes|cv|curriculum|sistemas|it)\b/i;

function toMs(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  const ms = typeof v === "number" ? v : Date.parse(v);
  return Number.isFinite(ms) ? ms : null;
}

// Teléfono MX usable: 10 dígitos nacionales (acepta +52 / 521 / 01).
export function isValidMxPhone(phone: string): boolean {
  let d = phone.replace(/\D/g, "");
  if (d.startsWith("521") && d.length === 13) d = d.slice(3);
  else if (d.startsWith("52") && d.length === 12) d = d.slice(2);
  else if (d.startsWith("01") && d.length === 12) d = d.slice(2);
  return d.length === 10;
}

export function scoreLabel(score: number): ScoreResult["label"] {
  if (score >= 9) return "Completo";
  if (score >= 7) return "Bueno";
  if (score >= 4) return "Incompleto";
  return "Pobre";
}

export function computeScore(input: ScoreInput, now = Date.now()): ScoreResult {
  const d: ScoreDeduction[] = [];
  const minus = (points: number, reason: string) => d.push({ points: -points, reason });

  // Teléfono (máx. −3).
  const phone = (input.phone || input.whatsapp || "").trim();
  if (!phone) minus(3, "Sin teléfono");
  else if (!isValidMxPhone(phone)) minus(1, "Teléfono incompleto");

  // Correo (máx. −3).
  const email = (input.email || "").trim();
  if (!email) minus(3, "Sin correo");
  else if (input.emailIsGuess) minus(2, "Correo sugerido, sin confirmar");
  else if (LOW_ROLE.test(email.split("@")[0])) minus(1, "Correo de área (no de ventas)");

  // Actividad / vigencia del negocio (máx. −3).
  const status = (input.businessStatus || "").toUpperCase();
  const last = toMs(input.lastActivityAt);
  if (status === "CLOSED_TEMPORARILY") {
    minus(3, "Cerrado temporalmente");
  } else if (last != null) {
    const days = (now - last) / DAY;
    if (days > 365) minus(2, "Sin actividad en más de un año");
    else if (days > 180) minus(1, "Sin actividad reciente (6–12 meses)");
  } else if (!input.websiteOk) {
    minus(2, "Sin señales de actividad");
  }

  // Datos de contacto viejos (−1).
  const checked = toMs(input.dataCheckedAt);
  if (checked != null && (now - checked) / DAY > 180) {
    minus(1, "Datos sin revisar en más de 6 meses");
  }

  // Dirección y web (−1 c/u).
  if (!(input.address || "").trim()) minus(1, "Sin dirección");
  if (!(input.website || "").trim()) minus(1, "Sin sitio web");

  const total = d.reduce((s, x) => s + x.points, 10);
  const score = Math.max(1, Math.min(10, total));
  return { score, max: 10, deductions: d, label: scoreLabel(score) };
}

// "10 − 3 (sin correo) − 1 (sin web) = 6"
export function formatBreakdown(r: ScoreResult): string {
  if (!r.deductions.length) return "10 · datos completos y activo";
  const parts = r.deductions.map((x) => `− ${-x.points} (${x.reason.toLowerCase()})`);
  return `10 ${parts.join(" ")} = ${r.score}`;
}
