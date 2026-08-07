import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
import {
  emailStatusFrom,
  ensureContactId,
  getEmailMessage,
  ghlEmailReady,
  sendEmail,
} from "@/lib/ghl";
import { SESSION_COOKIE, verifySession } from "@/lib/auth";

export const runtime = "nodejs";

// El remitente es SIEMPRE el usuario logueado (cada vendedor manda con su
// propio correo). GHL_EMAIL_FROM / RESEND_FROM solo son el respaldo.
async function senderEmail(req: NextRequest): Promise<string | null> {
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  return session?.email ?? null;
}

// "aldo@ialeadshield.com.mx" -> "Aldo"
function displayName(email: string): string {
  const local = email.split("@")[0].replace(/[._-]+/g, " ").trim();
  return local.charAt(0).toUpperCase() + local.slice(1);
}

// Quién manda el correo: "ghl" | "resend" | "auto" (default).
// En auto se usa GHL si está configurado, y si no se cae a Resend.
function provider(): "ghl" | "resend" {
  const want = (process.env.EMAIL_PROVIDER || "auto").toLowerCase();
  if (want === "ghl") return "ghl";
  if (want === "resend") return "resend";
  return ghlEmailReady() ? "ghl" : "resend";
}

export async function POST(req: NextRequest) {
  let payload: {
    to?: string;
    subject?: string;
    html?: string;
    text?: string;
    name?: string;
    phone?: string;
  };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  const { to, subject, html, text, name, phone } = payload;
  if (!to || !subject || (!html && !text)) {
    return NextResponse.json(
      { error: "Faltan campos: 'to', 'subject' y cuerpo." },
      { status: 400 }
    );
  }
  const body = html || `<p>${text}</p>`;
  const sender = await senderEmail(req);

  if (provider() === "ghl") {
    const from = sender || process.env.GHL_EMAIL_FROM;
    if (!from) {
      return NextResponse.json(
        { error: "No hay remitente: inicia sesión de nuevo." },
        { status: 401 }
      );
    }
    return sendWithGhl({ to, subject, html: body, from, name, phone });
  }
  return sendWithResend({ to, subject, html: body, text, sender });
}

// --- GoHighLevel (Conversations): el correo queda en el hilo del contacto ---
async function sendWithGhl(input: {
  to: string;
  subject: string;
  html: string;
  from: string;
  name?: string;
  phone?: string;
}) {
  if (!ghlEmailReady()) {
    return NextResponse.json(
      { error: "GHL sin configurar. Falta GHL_PIT o GHL_LOCATION_ID." },
      { status: 503 }
    );
  }

  // GHL solo manda correo a un contacto existente: primero lo buscamos/creamos.
  const contact = await ensureContactId({
    email: input.to,
    name: input.name,
    phone: input.phone,
  });
  if ("error" in contact) {
    return NextResponse.json({ error: contact.error }, { status: contact.status });
  }

  const r = await sendEmail({
    contactId: contact.id,
    subject: input.subject,
    html: input.html,
    from: input.from,
    to: input.to,
  });

  if (!r.ok) {
    const detail =
      typeof r.body === "string"
        ? r.body
        : (r.body as { message?: string | string[] })?.message;
    const msg = Array.isArray(detail) ? detail.join(", ") : detail;
    if (r.status === 401) {
      return NextResponse.json(
        {
          error:
            "El token de GHL no tiene el scope 'conversations/message.write'. Agrégalo en Ajustes → Private Integrations y vuelve a generar el token.",
        },
        { status: 401 }
      );
    }
    return NextResponse.json(
      { error: `GHL rechazó el envío (HTTP ${r.status}). ${msg ?? ""}`.trim() },
      { status: 502 }
    );
  }

  const b = r.body as {
    conversationId?: string;
    messageId?: string;
    emailMessageId?: string;
  };

  // GHL responde 200 aunque no lo entregue: confirmamos el estado real.
  if (b?.emailMessageId) {
    const check = await getEmailMessage(b.emailMessageId);
    const { status, error } = emailStatusFrom(check.body);
    if (status === "failed") {
      return NextResponse.json(
        {
          error:
            error === "Configured email service is expired"
              ? "GHL no lo entregó: el servicio de correo de la subcuenta está vencido. Renuévalo en GHL (Ajustes → Email Services)."
              : `GHL no entregó el correo: ${error || "razón desconocida"}.`,
        },
        { status: 502 }
      );
    }
  }

  return NextResponse.json({
    ok: true,
    provider: "ghl",
    from: input.from,
    id: b?.emailMessageId || b?.messageId,
    conversationId: b?.conversationId,
    contactId: contact.id,
  });
}

// --- Resend (respaldo) ---
async function sendWithResend(input: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  sender?: string | null;
}) {
  const apiKey = process.env.RESEND_API_KEY;
  const fallback = process.env.RESEND_FROM; // ej. "Ventas <ventas@tudominio.com>"

  if (!apiKey) {
    return NextResponse.json(
      { error: "Falta RESEND_API_KEY (o usa EMAIL_PROVIDER=ghl)." },
      { status: 503 }
    );
  }
  if (!fallback) {
    return NextResponse.json(
      {
        error:
          "Falta RESEND_FROM. Define el remitente verificado (ej. Ventas <ventas@tudominio.com>).",
      },
      { status: 503 }
    );
  }

  // Usa el correo del usuario logueado si es del mismo dominio verificado que
  // RESEND_FROM; si no, Resend rechazaría el envío y caemos al remitente base.
  const domainOf = (s: string) => s.split("@")[1]?.replace(/>$/, "").toLowerCase();
  const from =
    input.sender && domainOf(input.sender) === domainOf(fallback)
      ? `${displayName(input.sender)} <${input.sender}>`
      : fallback;

  try {
    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from,
      to: input.to,
      subject: input.subject,
      html: input.html,
      text: input.text || undefined,
    });
    if (error) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }
    return NextResponse.json({ ok: true, provider: "resend", from, id: data?.id });
  } catch (err) {
    console.error("send error", err);
    return NextResponse.json(
      { error: "No se pudo enviar el correo." },
      { status: 500 }
    );
  }
}
