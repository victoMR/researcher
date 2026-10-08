import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { sessionEmail } from "@/lib/session";
import { logEvent, normEmail, recentOutreach } from "@/lib/outreach-repo";

export const runtime = "nodejs";

// Historial de contacto de un correo y/o prospecto: { events: [...] }.
export async function GET(req: NextRequest) {
  const email = normEmail(req.nextUrl.searchParams.get("email")) || null;
  const leadId = req.nextUrl.searchParams.get("leadId") || null;
  if (!hasDb() || (!email && !leadId)) return NextResponse.json({ events: [] });
  try {
    return NextResponse.json({ events: await recentOutreach(email, leadId, 20) });
  } catch (e) {
    console.error("outreach GET", e);
    return NextResponse.json({ error: "Error leyendo el historial." }, { status: 500 });
  }
}

// Registra un contacto hecho fuera de /api/send (hoy: abrir WhatsApp).
export async function POST(req: NextRequest) {
  let b: {
    type?: string;
    leadId?: string;
    email?: string;
    phone?: string;
    name?: string;
  };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }
  if (b.type !== "whatsapp") {
    return NextResponse.json({ error: "Tipo no soportado." }, { status: 400 });
  }
  // Sin BD no hay bitácora; no es un error para quien abre WhatsApp.
  if (!hasDb()) return NextResponse.json({ ok: true });
  try {
    await logEvent({
      type: "whatsapp_opened",
      actor: await sessionEmail(req),
      target: b.email || null,
      leadId: b.leadId || null,
      meta: { phone: b.phone ?? null, name: b.name ?? null },
    });
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("outreach POST", e);
    return NextResponse.json({ error: "No se pudo registrar." }, { status: 500 });
  }
}
