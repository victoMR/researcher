// Mapeo de giros de negocio a etiquetas de OpenStreetMap (Overpass).
// Cada giro puede consultar varias combinaciones de tags.

export interface Category {
  slug: string;
  label: string;
  // Filtros Overpass (fuente OSM gratis). Cada string se inserta como node/way["k"="v"].
  filters: string[];
  // Frase de búsqueda para Google Places (fuente principal).
  googleQuery: string;
}

export const CATEGORIES: Category[] = [
  {
    slug: "autos_nuevos",
    label: "Agencias / autos nuevos",
    filters: ['"shop"="car"'],
    googleQuery: "agencia de autos nuevos",
  },
  {
    slug: "seminuevos",
    label: "Seminuevos / usados",
    filters: ['"shop"="car"]["second_hand"~"^(yes|only)$"'],
    googleQuery: "compra venta de autos seminuevos usados",
  },
  {
    slug: "inmobiliarias",
    label: "Inmobiliarias / corretaje",
    filters: ['"office"="estate_agent"', '"shop"="estate_agent"'],
    googleQuery: "inmobiliaria bienes raíces",
  },
  {
    slug: "talleres",
    label: "Talleres / refaccionarias",
    filters: ['"shop"="car_repair"', '"shop"="car_parts"'],
    googleQuery: "taller mecánico y refaccionaria automotriz",
  },
];

export function getCategory(slug: string): Category | undefined {
  return CATEGORIES.find((c) => c.slug === slug);
}
