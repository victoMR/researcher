import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import {
  updateTemplate,
  deleteTemplate,
  historyMarkdown,
  type Channel,
} from "@/lib/templates-repo";

export const runtime = "nodejs";

export async function GET(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasDb()) return NextResponse.json({ error: "Sin base de datos." }, { status: 503 });
  try {
    const { id } = await params;
    return NextResponse.json({ historyMd: await historyMarkdown(id) });
  } catch (e) {
    console.error("template GET", e);
    return NextResponse.json({ error: "Error leyendo historial." }, { status: 500 });
  }
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasDb()) return NextResponse.json({ error: "Sin base de datos." }, { status: 503 });
  try {
    const { id } = await params;
    const b = (await req.json()) as {
      name?: string;
      channel?: Channel;
      subject?: string;
      body?: string;
      note?: string;
    };
    if (!b.name || !b.body) {
      return NextResponse.json({ error: "Falta nombre o cuerpo." }, { status: 400 });
    }
    const tpl = await updateTemplate(id, {
      name: b.name,
      channel: b.channel ?? "ambos",
      subject: b.subject,
      body: b.body,
      note: b.note,
    });
    return NextResponse.json({ template: tpl });
  } catch (e) {
    console.error("template PATCH", e);
    return NextResponse.json({ error: "Error actualizando plantilla." }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasDb()) return NextResponse.json({ error: "Sin base de datos." }, { status: 503 });
  try {
    const { id } = await params;
    await deleteTemplate(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("template DELETE", e);
    return NextResponse.json({ error: "Error eliminando plantilla." }, { status: 500 });
  }
}
