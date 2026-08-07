import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { updateLead, removeLead } from "@/lib/leads-repo";
import type { LeadStatus } from "@/lib/types";

export const runtime = "nodejs";

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasDb())
    return NextResponse.json({ error: "Sin base de datos." }, { status: 503 });
  try {
    const { id } = await params;
    const patch = (await req.json()) as {
      status?: LeadStatus;
      note?: string;
      email?: string;
    };
    await updateLead(id, patch);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("lead PATCH", e);
    return NextResponse.json({ error: "Error actualizando." }, { status: 500 });
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  if (!hasDb())
    return NextResponse.json({ error: "Sin base de datos." }, { status: 503 });
  try {
    const { id } = await params;
    await removeLead(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("lead DELETE", e);
    return NextResponse.json({ error: "Error eliminando." }, { status: 500 });
  }
}
