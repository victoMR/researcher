import { NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { getStats } from "@/lib/leads-repo";

export const runtime = "nodejs";

export async function GET() {
  if (!hasDb())
    return NextResponse.json(
      { error: "Base de datos no configurada." },
      { status: 503 }
    );
  try {
    return NextResponse.json(await getStats());
  } catch (e) {
    console.error("stats", e);
    return NextResponse.json({ error: "Error leyendo métricas." }, { status: 500 });
  }
}
