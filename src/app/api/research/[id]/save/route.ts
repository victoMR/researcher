import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { sessionEmail } from "@/lib/session";
import { ResearchActionError, saveRunProspects } from "@/lib/research-repo";

export const runtime = "nodejs";
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

// Guarda en Prospectos los elegidos ({ ids? }; sin ids = todos) con el
// vendedor como dueño. Los de Google se saltan (no se pueden guardar).
export async function POST(req: NextRequest, { params }: Ctx) {
  try {
    const me = await sessionEmail(req);
    if (!me) return NextResponse.json({ error: "No autorizado." }, { status: 401 });
    if (!hasDb()) {
      return NextResponse.json({ error: "Se necesita la base de datos para guardar investigaciones." }, { status: 503 });
    }
    const { id } = await params;
    const body = (await req.json().catch(() => null)) as { ids?: unknown } | null;
    const ids = Array.isArray(body?.ids)
      ? body.ids.filter((x): x is string => typeof x === "string").slice(0, 500)
      : null;
    const result = await saveRunProspects(id, ids, me);
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ResearchActionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("research save", e);
    return NextResponse.json({ error: "No se pudieron guardar los prospectos." }, { status: 500 });
  }
}
