import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { listLeads, saveLead, clearLeads } from "@/lib/leads-repo";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

function noDb() {
  return NextResponse.json(
    { error: "Base de datos no configurada (falta DATABASE_URL)." },
    { status: 503 }
  );
}

export async function GET() {
  if (!hasDb()) return noDb();
  try {
    return NextResponse.json({ leads: await listLeads() });
  } catch (e) {
    console.error("leads GET", e);
    return NextResponse.json({ error: "Error leyendo prospectos." }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  if (!hasDb()) return noDb();
  try {
    const { business, city } = (await req.json()) as {
      business?: Business;
      city?: string;
    };
    if (!business?.id || !business?.name) {
      return NextResponse.json({ error: "Falta 'business'." }, { status: 400 });
    }
    const lead = await saveLead(business, city);
    return NextResponse.json({ lead });
  } catch (e) {
    console.error("leads POST", e);
    return NextResponse.json({ error: "Error guardando prospecto." }, { status: 500 });
  }
}

export async function DELETE() {
  if (!hasDb()) return noDb();
  try {
    await clearLeads();
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("leads DELETE", e);
    return NextResponse.json({ error: "Error vaciando prospectos." }, { status: 500 });
  }
}
