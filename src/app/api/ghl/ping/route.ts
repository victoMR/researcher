import { NextResponse } from "next/server";
import { ghlReady, ping } from "@/lib/ghl";

export const runtime = "nodejs";

// Verifica si el token de GHL ya tiene permisos activos.
export async function GET() {
  if (!ghlReady()) {
    return NextResponse.json(
      { connected: false, reason: "Faltan GHL_PIT o GHL_LOCATION_ID." },
      { status: 503 }
    );
  }
  const r = await ping();
  return NextResponse.json({
    connected: r.ok,
    status: r.status,
    hint: r.ok
      ? "GHL responde: permisos activos."
      : "GHL rechazó (permisos aún no activos o token inválido).",
  });
}
