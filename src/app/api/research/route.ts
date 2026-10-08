import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { sessionEmail } from "@/lib/session";
import { listRuns, ResearchActionError } from "@/lib/research-repo";
import { NO_DB_MESSAGE, startResearch } from "@/lib/agent/start";

export const runtime = "nodejs";
// La investigación sigue en segundo plano con after(), que vive lo que dure la
// función: 300 s (máximo de Vercel con Fluid compute en Hobby; Pro llega a 800).
// El agente se corta a los ~280 s y entrega lo que tenga (ver agent/config.ts).
export const maxDuration = 300;

const err = (error: string, status: number) => NextResponse.json({ error }, { status });

// Lanza una investigación: responde { id } de inmediato y el agente sigue en
// segundo plano (la UI consulta GET /api/research/[id]). La lógica (topes,
// validación) vive en startResearch y la comparte el servidor MCP.
export async function POST(req: NextRequest) {
  const startedAt = Date.now();
  try {
    const me = await sessionEmail(req);
    if (!me) return err("No autorizado.", 401);

    const body = (await req.json().catch(() => null)) as { prompt?: unknown } | null;
    const prompt = typeof body?.prompt === "string" ? body.prompt : "";
    const { id } = await startResearch({ prompt, userEmail: me, startedAt });
    return NextResponse.json({ id });
  } catch (e) {
    if (e instanceof ResearchActionError) return err(e.message, e.status);
    console.error("research POST", e);
    return err("No se pudo iniciar la investigación.", 500);
  }
}

// Últimas 30 investigaciones: ?scope=mine (por defecto) | all.
export async function GET(req: NextRequest) {
  try {
    const me = await sessionEmail(req);
    if (!me) return err("No autorizado.", 401);
    if (!hasDb()) return NextResponse.json({ error: NO_DB_MESSAGE, runs: [] }, { status: 503 });
    const scope = req.nextUrl.searchParams.get("scope") === "all" ? "all" : "mine";
    const runs = await listRuns({ scope, me });
    return NextResponse.json({ runs });
  } catch (e) {
    console.error("research GET", e);
    return err("No se pudieron cargar las investigaciones.", 500);
  }
}
