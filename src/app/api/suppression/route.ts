import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { isAdmin, sessionEmail } from "@/lib/session";
import {
  addSuppression,
  getSuppression,
  normEmail,
  removeSuppression,
} from "@/lib/outreach-repo";

export const runtime = "nodejs";

const looksLikeEmail = (e: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

// ¿Este correo pidió BAJA? -> { suppressed, reason?, createdAt?, createdBy? }
export async function GET(req: NextRequest) {
  const email = normEmail(req.nextUrl.searchParams.get("email"));
  if (!email) {
    return NextResponse.json({ error: "Falta 'email'." }, { status: 400 });
  }
  // Sin BD no hay lista de bajas: nada está suprimido.
  if (!hasDb()) return NextResponse.json({ suppressed: false });
  try {
    const s = await getSuppression(email);
    if (!s) return NextResponse.json({ suppressed: false });
    return NextResponse.json({
      suppressed: true,
      reason: s.reason,
      createdAt: s.createdAt,
      createdBy: s.createdBy,
    });
  } catch (e) {
    console.error("suppression GET", e);
    return NextResponse.json({ error: "Error leyendo la lista de bajas." }, { status: 500 });
  }
}

// Marca un correo como BAJA: ya no se le podrá enviar.
export async function POST(req: NextRequest) {
  if (!hasDb()) {
    return NextResponse.json({ error: "Sin base de datos." }, { status: 503 });
  }
  let b: { email?: string; reason?: string };
  try {
    b = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }
  const email = normEmail(b.email);
  if (!looksLikeEmail(email)) {
    return NextResponse.json({ error: "Correo inválido." }, { status: 400 });
  }
  try {
    const by = await sessionEmail(req);
    await addSuppression(email, b.reason?.trim() || null, by);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("suppression POST", e);
    return NextResponse.json({ error: "No se pudo registrar la baja." }, { status: 500 });
  }
}

// Quita una BAJA (solo administradores).
export async function DELETE(req: NextRequest) {
  const me = await sessionEmail(req);
  if (!isAdmin(me)) {
    return NextResponse.json(
      { error: "Solo un administrador puede quitar una BAJA." },
      { status: 403 }
    );
  }
  if (!hasDb()) {
    return NextResponse.json({ error: "Sin base de datos." }, { status: 503 });
  }
  const email = normEmail(req.nextUrl.searchParams.get("email"));
  if (!email) {
    return NextResponse.json({ error: "Falta 'email'." }, { status: 400 });
  }
  try {
    await removeSuppression(email);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("suppression DELETE", e);
    return NextResponse.json({ error: "No se pudo quitar la baja." }, { status: 500 });
  }
}
