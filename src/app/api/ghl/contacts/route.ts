import { NextRequest, NextResponse } from "next/server";
import { ghlReady, upsertContact } from "@/lib/ghl";
import { hasDb } from "@/lib/db";
import { getLeadsByIds } from "@/lib/leads-repo";
import { isGoogleOnly } from "@/lib/types";
import type { Lead } from "@/lib/types";

export const runtime = "nodejs";

// Sube uno o varios prospectos a GHL como contactos.
// Solo datos abiertos (DENUE / OSM / correo de su web): los prospectos
// solo-Google se omiten por los términos de Google (googleSkipped).
export async function POST(req: NextRequest) {
  if (!ghlReady()) {
    return NextResponse.json(
      { error: "GHL no configurado (faltan credenciales)." },
      { status: 503 }
    );
  }
  try {
    const body = (await req.json()) as { lead?: Lead; leads?: Lead[] };
    let leads = (body.leads ?? (body.lead ? [body.lead] : [])).filter(
      (l): l is Lead => !!l && typeof l.id === "string" && typeof l.name === "string"
    );
    if (!leads.length) {
      return NextResponse.json({ error: "No hay prospectos." }, { status: 400 });
    }

    // La BD manda: fuente y datos guardados (no lo que diga el navegador).
    if (hasDb()) {
      const saved = new Map((await getLeadsByIds(leads.map((l) => l.id))).map((l) => [l.id, l]));
      leads = leads.map((l) => saved.get(l.id) ?? l);
    }

    let pushed = 0;
    let skipped = 0;
    let googleSkipped = 0;
    const errors: string[] = [];
    for (const l of leads) {
      if (isGoogleOnly(l)) {
        googleSkipped++;
        continue; // contenido de Google: no se exporta
      }
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
      googleSkipped,
      failed: errors.length,
      errors: errors.slice(0, 5),
    });
  } catch (e) {
    console.error("ghl contacts", e);
    return NextResponse.json({ error: "Error subiendo a GHL." }, { status: 500 });
  }
}
