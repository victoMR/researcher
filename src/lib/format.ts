// Utilidades de presentación, seguras en el cliente (sin dependencias de servidor).

// "aldo.perez@ialeadshield.com.mx" -> "Aldo Perez"
export function personName(email: string): string {
  return email
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// "aldo.perez@..." -> "Aldo"
export function firstName(email: string): string {
  return personName(email).split(" ")[0] || email;
}

// "hace 3 días", "hace 2 h", "hace un momento".
export function timeAgo(iso?: string | null): string {
  if (!iso) return "";
  const ms = Date.now() - Date.parse(iso);
  if (!Number.isFinite(ms)) return "";
  const min = Math.round(ms / 60000);
  if (min < 1) return "hace un momento";
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  if (d === 1) return "ayer";
  if (d < 30) return `hace ${d} días`;
  const m = Math.floor(d / 30);
  if (m < 12) return m === 1 ? "hace 1 mes" : `hace ${m} meses`;
  const y = Math.max(1, Math.floor(d / 365));
  return y === 1 ? "hace 1 año" : `hace ${y} años`;
}

// Fecha corta en español de México: "8 oct 2026".
export function shortDate(iso?: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("es-MX", { day: "numeric", month: "short", year: "numeric" });
}

// Un negocio es "activo" si su reseña más reciente es de los últimos 6 meses.
const ACTIVE_WINDOW_MS = 1000 * 60 * 60 * 24 * 180;
export function isRecent(iso?: string): boolean {
  if (!iso) return false;
  return Date.now() - Date.parse(iso) <= ACTIVE_WINDOW_MS;
}

export function scoreColor(score: number): string {
  if (score >= 8) return "bg-emerald-100 text-emerald-700";
  if (score >= 5) return "bg-amber-100 text-amber-700";
  return "bg-slate-100 text-slate-500";
}

// Descarga un CSV (con BOM para que Excel respete los acentos).
export function downloadCSV(
  filename: string,
  header: string[],
  rows: (string | number | null | undefined)[][]
): void {
  const lines = rows.map((r) =>
    r.map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`).join(",")
  );
  const csv = [header.join(","), ...lines].join("\n");
  const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
