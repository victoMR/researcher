import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

const UA = "Prospector/1.0 (lead research tool)";

// Coordenadas -> nombre de ciudad, para autollenar la búsqueda por geolocalización.
export async function GET(req: NextRequest) {
  const lat = req.nextUrl.searchParams.get("lat");
  const lon = req.nextUrl.searchParams.get("lon");
  if (!lat || !lon) {
    return NextResponse.json({ error: "Faltan lat/lon." }, { status: 400 });
  }

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${encodeURIComponent(
      lat
    )}&lon=${encodeURIComponent(lon)}&format=json&zoom=12&addressdetails=1`;
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 6000);
    const res = await fetch(url, {
      headers: { "User-Agent": UA },
      signal: c.signal,
    }).finally(() => clearTimeout(t));

    if (!res.ok) {
      return NextResponse.json(
        { error: "No se pudo ubicar." },
        { status: 502 }
      );
    }
    const data = (await res.json()) as {
      address?: Record<string, string>;
      display_name?: string;
    };
    const a = data.address || {};
    const city =
      a.city || a.town || a.village || a.municipality || a.county || a.state;
    if (!city) {
      return NextResponse.json(
        { error: "No encontré una ciudad para tu ubicación." },
        { status: 404 }
      );
    }
    const label = [city, a.state, a.country].filter(Boolean).join(", ");
    return NextResponse.json({ city, label });
  } catch {
    return NextResponse.json(
      { error: "Error obteniendo tu ubicación." },
      { status: 500 }
    );
  }
}
