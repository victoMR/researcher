// Clave de dedupe estable: nombre normalizado + ciudad. Cliente-seguro
// (sin dependencias de servidor), se usa en el navegador y en el backend.
export function dedupeKey(name: string, city?: string): string {
  const norm = (s: string) =>
    s
      .toLowerCase()
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  return `${norm(name)}|${norm(city || "")}`;
}
