import { NextRequest, NextResponse } from "next/server";
import { checkPublicUrl } from "@/lib/safe-fetch";
import { extractContacts, normalizeUrl } from "@/lib/email-extract";

export const runtime = "nodejs";
export const maxDuration = 30;

// Saca correos, redes y señales del sitio de un negocio (lógica en
// src/lib/email-extract.ts, compartida con el agente "Investigar con IA").
export async function POST(req: NextRequest) {
  try {
    const { website } = (await req.json()) as { website?: unknown };
    if (!website || typeof website !== "string") {
      return NextResponse.json({ error: "Falta 'website'." }, { status: 400 });
    }

    const base = normalizeUrl(website.trim());
    // Anti-SSRF: solo URLs públicas (http/https, sin hosts ni IPs internas).
    // Si el dominio solo no resuelve, se sigue como antes (respuesta vacía).
    const check = await checkPublicUrl(base);
    if (!check.ok && check.reason !== "dns") {
      return NextResponse.json({ error: "URL no permitida." }, { status: 400 });
    }
    try {
      new URL(base);
    } catch {
      return NextResponse.json({ error: "URL no permitida." }, { status: 400 });
    }

    const r = await extractContacts(base, { timeoutMs: 22000 });
    return NextResponse.json({
      emails: r.emails,
      socials: r.socials.slice(0, 3),
      guesses: r.guesses,
      // Campos nuevos (opcionales para la UI).
      ...(r.whatsapp ? { whatsapp: r.whatsapp } : {}),
      phones: r.phones,
      signals: r.signals,
    });
  } catch (err) {
    console.error("extract-email error", err);
    return NextResponse.json(
      { error: "No se pudo extraer el correo." },
      { status: 500 }
    );
  }
}
