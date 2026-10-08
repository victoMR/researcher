import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { sessionEmail } from "@/lib/session";
import { pushRunToGhl, ResearchActionError } from "@/lib/research-repo";

export const runtime = "nodejs";
export const maxDuration = 120; // hasta 60 prospectos × (upsert + nota)

type Ctx = { params: Promise<{ id: string }> };

// Sube a GHL los prospectos elegidos ({ ids? }; sin ids = todos). Salta los de
// Google, los que tienen BAJA y los que no tienen correo ni teléfono.
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
    // Enlace a la investigación para la nota en GHL (APP_URL si está definida).
    const base = (process.env.APP_URL?.trim() || req.nextUrl.origin).replace(/\/$/, "");
    const result = await pushRunToGhl(id, ids, me, { runUrl: `${base}/investigacion/${encodeURIComponent(id)}` });
    return NextResponse.json(result);
  } catch (e) {
    if (e instanceof ResearchActionError) {
      return NextResponse.json({ error: e.message }, { status: e.status });
    }
    console.error("research ghl", e);
    return NextResponse.json({ error: "Error subiendo a GHL." }, { status: 500 });
  }
}
