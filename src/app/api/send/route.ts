import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM; // ej. "Ventas <ventas@tudominio.com>"

  if (!apiKey) {
    return NextResponse.json(
      {
        error:
          "Falta RESEND_API_KEY. Acepta los términos de Resend y corre `vercel env pull`.",
      },
      { status: 503 }
    );
  }
  if (!from) {
    return NextResponse.json(
      {
        error:
          "Falta RESEND_FROM. Define el remitente verificado (ej. Ventas <ventas@tudominio.com>).",
      },
      { status: 503 }
    );
  }

  try {
    const { to, subject, html, text } = (await req.json()) as {
      to?: string;
      subject?: string;
      html?: string;
      text?: string;
    };

    if (!to || !subject || (!html && !text)) {
      return NextResponse.json(
        { error: "Faltan campos: 'to', 'subject' y cuerpo." },
        { status: 400 }
      );
    }

    const resend = new Resend(apiKey);
    const { data, error } = await resend.emails.send({
      from,
      to,
      subject,
      html: html || `<p>${text}</p>`,
      text: text || undefined,
    });

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 502 });
    }

    return NextResponse.json({ id: data?.id, ok: true });
  } catch (err) {
    console.error("send error", err);
    return NextResponse.json(
      { error: "No se pudo enviar el correo." },
      { status: 500 }
    );
  }
}
