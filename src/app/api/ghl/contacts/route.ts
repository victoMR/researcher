import { NextRequest, NextResponse } from "next/server";
import { ghlReady, upsertContact } from "@/lib/ghl";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";

// Sube uno o varios prospectos a GHL como contactos.
export async function POST(req: NextRequest) {
  if (!ghlReady()) {
    return NextResponse.json(
      { error: "GHL no configurado (faltan credenciales)." },
      { status: 503 }
    );
  }
  try {
    const body = (await req.json()) as { lead?: Lead; leads?: Lead[] };
    const leads = body.leads ?? (body.lead ? [body.lead] : []);
    if (!leads.length) {
      return NextResponse.json({ error: "No hay prospectos." }, { status: 400 });
    }

    let pushed = 0;
    let skipped = 0;
    const errors: string[] = [];
    for (const l of leads) {
      if (!l.email && !l.phone) {
        skipped++;
        continue; // GHL requiere correo o teléfono
      }
      const r = await upsertContact({
        name: l.name,
        email: l.email || undefined,
        phone: l.phone || undefined,
        companyName: l.name,
        source: "AI Lead Shield",
        tags: [l.category, l.city].filter(Boolean) as string[],
      });
      if (r.ok) pushed++;
      else errors.push(`${l.name}: ${r.status}`);
    }

    return NextResponse.json({
      pushed,
      skipped,
      failed: errors.length,
      errors: errors.slice(0, 5),
    });
  } catch (e) {
    console.error("ghl contacts", e);
    return NextResponse.json({ error: "Error subiendo a GHL." }, { status: 500 });
  }
}
