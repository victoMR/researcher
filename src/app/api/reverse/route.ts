import { NextRequest, NextResponse } from "next/server";
import { OSM_USER_AGENT } from "@/lib/osm";
import { coalesce } from "@/lib/search-cache";

export const runtime = "nodejs";

// La política de Nominatim pide cachear. Redondeamos a 2 decimales (~1 km): a
// zoom=12 (nivel ciudad) da lo mismo y además no mandamos la ubicación exacta.
// Caché sólo en memoria (no guardamos ubicaciones de usuarios en la BD).
const TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 500;
const cache = new Map<string, { city: string; label: string; at: number }>();

class ReverseError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

async function lookup(lat: string, lon: string): Promise<{ city: string; label: string }> {
  const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(
    lat
  )}&lon=${encodeURIComponent(lon)}&format=json&zoom=12&addressdetails=1`;
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), 6000);
  const res = await fetch(url, {
    headers: { "User-Agent": OSM_USER_AGENT },
    signal: c.signal,
  }).finally(() => clearTimeout(t));

  if (!res.ok) throw new ReverseError("No se pudo ubicar.", 502);
  const data = (await res.json()) as {
    address?: Record<string, string>;
    display_name?: string;
  };
  const a = data.address || {};
  const city =
    a.city || a.town || a.village || a.municipality || a.county || a.state;
  if (!city) {
    throw new ReverseError("No encontré una ciudad para tu ubicación.", 404);
  }
  const label = [city, a.state, a.country].filter(Boolean).join(", ");
  return { city, label };
}

// Coordenadas -> nombre de ciudad, para autollenar la búsqueda por geolocalización.
export async function GET(req: NextRequest) {
  const latRaw = Number(req.nextUrl.searchParams.get("lat"));
  const lonRaw = Number(req.nextUrl.searchParams.get("lon"));
  if (
    !req.nextUrl.searchParams.get("lat") ||
    !req.nextUrl.searchParams.get("lon") ||
    !Number.isFinite(latRaw) ||
    !Number.isFinite(lonRaw) ||
    Math.abs(latRaw) > 90 ||
    Math.abs(lonRaw) > 180
  ) {
    return NextResponse.json({ error: "Faltan lat/lon." }, { status: 400 });
  }
  const lat = latRaw.toFixed(2);
  const lon = lonRaw.toFixed(2);
  const key = `${lat},${lon}`;

  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return NextResponse.json({ city: hit.city, label: hit.label });
  }

  try {
    const r = await coalesce(`rev|${key}`, () => lookup(lat, lon));
    cache.delete(key);
    cache.set(key, { ...r, at: Date.now() });
    while (cache.size > MAX_ENTRIES) {
      const oldest = cache.keys().next().value;
      if (oldest === undefined) break;
      cache.delete(oldest);
    }
    return NextResponse.json(r);
  } catch (e) {
    if (e instanceof ReverseError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    return NextResponse.json(
      { error: "Error obteniendo tu ubicación." },
      { status: 500 }
    );
  }
}
