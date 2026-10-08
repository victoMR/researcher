import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { sessionEmail } from "@/lib/session";
import { getRun } from "@/lib/research-repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// Una investigación con su progreso completo (y resultados cuando termina).
// Si sigue "running" tras 15 min se marca como interrumpida.
export async function GET(req: NextRequest, { params }: Ctx) {
  try {
    const me = await sessionEmail(req);
    if (!me) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
    if (!hasDb()) {
      return NextResponse.json({ error: "Se necesita la base de datos para guardar investigaciones." }, { status: 503 });
    }
    const { id } = await params;
    const run = await getRun(id);
    if (!run) return NextResponse.json({ error: "No encontré esa investigación." }, { status: 404 });
    return NextResponse.json({ run }, { headers: { "Cache-Control": "no-store" } });
  } catch (e) {
    console.error("research GET id", e);
    return NextResponse.json({ error: "No se pudo cargar la investigación." }, { status: 500 });
  }
}
