import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { listTemplates, createTemplate, type Channel } from "@/lib/templates-repo";

export const runtime = "nodejs";

function noDb() {
  return NextResponse.json({ error: "Sin base de datos." }, { status: 503 });
}

export async function GET() {
  if (!hasDb()) return NextResponse.json({ templates: [] });
  try {
    return NextResponse.json({ templates: await listTemplates() });
  } catch (e) {
    console.error("templates GET", e);
    return NextResponse.json({ error: "Error leyendo plantillas." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasDb()) return noDb();
  try {
    const b = (await req.json()) as {
      name?: string;
      channel?: Channel;
      subject?: string;
      body?: string;
    };
    if (!b.name || !b.body) {
      return NextResponse.json({ error: "Falta nombre o cuerpo." }, { status: 400 });
    }
    const tpl = await createTemplate({
      name: b.name,
      channel: b.channel ?? "ambos",
      subject: b.subject,
      body: b.body,
    });
    return NextResponse.json({ template: tpl });
  } catch (e) {
    console.error("templates POST", e);
    return NextResponse.json({ error: "Error creando plantilla." }, { status: 500 });
  }
}
