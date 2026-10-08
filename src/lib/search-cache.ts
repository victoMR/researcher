import { ensureSchema, getSql, hasDb } from "./db";

// Caché de búsquedas en la tabla search_cache (con respaldo en memoria si no hay BD).
// OJO: sólo para datos que se pueden guardar legalmente: OpenStreetMap / Nominatim
// (licencia ODbL; la política de Nominatim de hecho PIDE cachear).
// Los resultados de Google Places NO pasan por aquí (ver src/lib/places.ts).

export interface CacheHit<T> {
  data: T;
  city: string | null; // nombre "bonito" del lugar (display_name de Nominatim)
  createdAt: string; // ISO
}

interface CacheEntry {
  source: string; // osm | nominatim
  category?: string | null;
  city?: string | null;
  data: unknown;
}

type Row = Record<string, unknown>;

// Normaliza un pedazo de llave: minúsculas, sin acentos, sin puntuación ni
// espacios repetidos. "  León, Gto. " -> "leon gto".
export function normalizeKeyPart(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[\s,.;:()'"`´|/\\_-]+/g, " ")
    .trim();
}

// --- Respaldo en memoria (por instancia), para cuando no hay BD o falla ---
const MEM_MAX = 100;
const mem = new Map<string, { data: unknown; city: string | null; createdAt: number }>();

function memSet(key: string, data: unknown, city: string | null) {
  mem.delete(key);
  mem.set(key, { data, city, createdAt: Date.now() });
  // Map conserva orden de inserción -> el primero es el más viejo.
  while (mem.size > MEM_MAX) {
    const oldest = mem.keys().next().value;
    if (oldest === undefined) break;
    mem.delete(oldest);
  }
}

function memGet<T>(key: string, maxAgeMs: number): CacheHit<T> | null {
  const m = mem.get(key);
  if (!m) return null;
  if (Date.now() - m.createdAt > maxAgeMs) {
    mem.delete(key);
    return null;
  }
  return {
    data: m.data as T,
    city: m.city,
    createdAt: new Date(m.createdAt).toISOString(),
  };
}

// Lee de caché si existe y no es más vieja que maxAgeMs. Nunca lanza.
export async function getCached<T>(
  key: string,
  maxAgeMs: number
): Promise<CacheHit<T> | null> {
  if (hasDb()) {
    try {
      await ensureSchema();
      const sql = getSql();
      const rows = (await sql`
        SELECT results, city, created_at FROM search_cache WHERE key = ${key}
      `) as Row[];
      const r = rows[0];
      if (!r) return memGet<T>(key, maxAgeMs);
      const created = new Date(r.created_at as string).getTime();
      if (!Number.isFinite(created) || Date.now() - created > maxAgeMs) {
        return null;
      }
      return {
        data: r.results as T,
        city: (r.city as string) ?? null,
        createdAt: new Date(created).toISOString(),
      };
    } catch (e) {
      console.error("search-cache: no se pudo leer la caché de BD", e);
    }
  }
  return memGet<T>(key, maxAgeMs);
}

// Guarda (o renueva) una entrada. Nunca lanza: si la BD falla, queda en memoria.
export async function setCached(key: string, entry: CacheEntry): Promise<void> {
  const city = entry.city ?? null;
  if (hasDb()) {
    try {
      await ensureSchema();
      const sql = getSql();
      await sql`
        INSERT INTO search_cache (key, source, category, city, results, created_at)
        VALUES (
          ${key}, ${entry.source}, ${entry.category ?? null}, ${city},
          ${JSON.stringify(entry.data)}::jsonb, now()
        )
        ON CONFLICT (key) DO UPDATE SET
          source     = EXCLUDED.source,
          category   = EXCLUDED.category,
          city       = EXCLUDED.city,
          results    = EXCLUDED.results,
          created_at = now()
      `;
      return;
    } catch (e) {
      console.error("search-cache: no se pudo guardar en BD", e);
    }
  }
  memSet(key, entry.data, city);
}

// --- Coalescing: búsquedas idénticas simultáneas comparten la misma promesa ---
// Sólo vive mientras la petición está en vuelo (no es caché): al terminar se borra.
const inflight = new Map<string, Promise<unknown>>();

export function coalesce<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const running = inflight.get(key) as Promise<T> | undefined;
  if (running) return running;
  const p = fn().finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}
