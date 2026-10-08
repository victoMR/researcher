// Giros de negocio y cómo se buscan en cada fuente:
// - DENUE (INEGI): clases SCIAN México 2023 (base principal en México).
// - OpenStreetMap (Overpass): combinaciones de tags.
// - Google Places: frase de búsqueda (solo consulta en vivo).

export interface Category {
  slug: string;
  label: string;
  // Clases SCIAN (6 dígitos) o ramas (4) del giro en DENUE.
  scian: string[];
  // Palabras (sin acentos) para el método Buscar de DENUE por cercanía; deben
  // aparecer en el nombre de la clase de actividad. Se filtra después por SCIAN.
  keywords: string[];
  // Filtros Overpass (fuente OSM gratis). Cada string se inserta como node/way["k"="v"].
  filters: string[];
  // Frase de búsqueda para Google Places.
  googleQuery: string;
}

export const CATEGORIES: Category[] = [
  {
    slug: "autos_nuevos",
    label: "Agencias / autos nuevos",
    // 468111 Comercio al por menor de automóviles y camionetas nuevos.
    scian: ["468111"],
    keywords: ["automoviles"],
    filters: ['"shop"="car"'],
    googleQuery: "agencia de autos nuevos",
  },
  {
    slug: "seminuevos",
    label: "Seminuevos / usados",
    // 468112 Comercio al por menor de automóviles y camionetas usados.
    scian: ["468112"],
    keywords: ["automoviles"],
    filters: ['"shop"="car"]["second_hand"~"^(yes|only)$"'],
    googleQuery: "compra venta de autos seminuevos usados",
  },
  {
    slug: "inmobiliarias",
    label: "Inmobiliarias / corretaje",
    // 531210 Inmobiliarias y corredores de bienes raíces.
    scian: ["531210"],
    keywords: ["inmobiliarias"],
    filters: ['"office"="estate_agent"', '"shop"="estate_agent"'],
    googleQuery: "inmobiliaria bienes raíces",
  },
  {
    slug: "talleres",
    label: "Talleres / refaccionarias",
    // 811111 Reparación mecánica en general de automóviles y camiones;
    // 811121 Hojalatería y pintura; 468211 Partes y refacciones nuevas.
    scian: ["811111", "811121", "468211"],
    keywords: ["automoviles", "refacciones"],
    filters: ['"shop"="car_repair"', '"shop"="car_parts"'],
    googleQuery: "taller mecánico y refaccionaria automotriz",
  },
];

export function getCategory(slug: string): Category | undefined {
  return CATEGORIES.find((c) => c.slug === slug);
}

// ¿El código SCIAN de un establecimiento pertenece al giro? (por prefijo).
export function matchesScian(cat: Category, code?: string): boolean {
  return !!code && cat.scian.some((s) => code.startsWith(s));
}
