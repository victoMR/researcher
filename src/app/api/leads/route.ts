import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { listLeads, saveLead, clearLeads } from "@/lib/leads-repo";
import { isAdmin, sessionEmail } from "@/lib/session";
import { LEAD_STATUSES } from "@/lib/types";
import { parseContactParams } from "@/lib/contact-filters";
import type { Business, LeadStatus, OwnerFilter } from "@/lib/types";

export const runtime = "nodejs";
// Guardar/vincular un resultado de Google consulta DENUE (hasta ~20 s).
export const maxDuration = 60;

function noDb() {
  return NextResponse.json(
    { error: "Base de datos no configurada (falta DATABASE_URL)." },
    { status: 503 }
  );
}

const OWNERS: OwnerFilter[] = ["mine", "all", "unassigned"];

// Lista paginada: ?q=&status=&owner=mine|all|unassigned&page=&pageSize=
// Filtros de contacto (Y): has_email=1, has_phone=1, has_website=1,
// has_whatsapp=1 (teléfono MX válido), min_score=1..10. Criterio en
// src/lib/contact-filters.ts. pageSize=0 devuelve solo los conteos.
export async function GET(req: NextRequest) {
  if (!hasDb()) return noDb();
  try {
    const me = await sessionEmail(req);
    const p = req.nextUrl.searchParams;
    const status = p.get("status") as LeadStatus | null;
    const owner = p.get("owner") as OwnerFilter | null;
    const page = Number(p.get("page") || 1);
    const pageSize = p.has("pageSize") ? Number(p.get("pageSize")) : 30;
    const data = await listLeads({
      q: p.get("q") ?? "",
      status: status && LEAD_STATUSES.includes(status) ? status : null,
      owner: owner && OWNERS.includes(owner) ? owner : "mine",
      me,
      page: Number.isFinite(page) ? page : 1,
      pageSize: Number.isFinite(pageSize) ? pageSize : 30,
      contact: parseContactParams(p),
    });
    return NextResponse.json(data);
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
    // Quien lo guarda queda como dueño (si ya existía, se respeta el dueño previo).
    const lead = await saveLead(business, city, await sessionEmail(req));
    return NextResponse.json({ lead });
  } catch (e) {
    console.error("leads POST", e);
    return NextResponse.json({ error: "Error guardando prospecto." }, { status: 500 });
  }
}

// Vaciar TODOS los prospectos: solo administradores.
export async function DELETE(req: NextRequest) {
  if (!hasDb()) return noDb();
  if (!isAdmin(await sessionEmail(req))) {
    return NextResponse.json(
      { error: "Solo un administrador puede vaciar los prospectos." },
      { status: 403 }
    );
  }
  try {
    await clearLeads();
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("leads DELETE", e);
    return NextResponse.json({ error: "Error vaciando prospectos." }, { status: 500 });
  }
}
