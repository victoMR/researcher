import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { sessionEmail } from "@/lib/session";
import { getRun, runToCsv } from "@/lib/research-repo";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// CSV de la investigación (?ids=a,b para elegir). Sin Google: los prospectos
// de fuente "google" se omiten y se reportan en X-Omitidos-Google.
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
    if (run.status !== "done") {
      return NextResponse.json({ error: "La investigación aún no termina." }, { status: 409 });
    }
    const raw = req.nextUrl.searchParams.get("ids");
    const ids = raw ? raw.split(",").map((s) => s.trim()).filter(Boolean).slice(0, 500) : null;
    const { csv, filename, omittedGoogle } = runToCsv(run, ids);
    const ascii = filename.replace(/[^\x20-\x7e]/g, "_");
    return new NextResponse(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`,
        "X-Omitidos-Google": String(omittedGoogle),
        "Access-Control-Expose-Headers": "X-Omitidos-Google, Content-Disposition",
        "Cache-Control": "no-store",
      },
    });
  } catch (e) {
    console.error("research csv", e);
    return NextResponse.json({ error: "No se pudo generar el CSV." }, { status: 500 });
  }
}
