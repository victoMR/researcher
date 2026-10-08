import { NextRequest, NextResponse } from "next/server";
import {
  emailStatusFrom,
  ensureContactId,
  getEmailMessage,
  ghlEmailReady,
  sendEmail,
} from "@/lib/ghl";
import { displayName, sessionEmail } from "@/lib/session";
import { hasDb } from "@/lib/db";
import { saveLead } from "@/lib/leads-repo";
import { textToHtml } from "@/lib/apply-template";
import {
  getSuppression,
  leadExists,
  logEvent,
  markContacted,
  normEmail,
  recentEmailsSent,
  type OutreachEvent,
} from "@/lib/outreach-repo";
import type { Business } from "@/lib/types";

export const runtime = "nodejs";

// Días en los que avisamos si alguien del equipo ya le escribió a ese correo.
const DUP_WINDOW_DAYS = 30;

// Remitente: SIEMPRE el vendedor logueado, armado por la app al enviar
// ("Aldo Perez (AI Lead Shield) <aldo@…>"). No hay dirección fija en variables
// de entorno ni en el código; GHL debe tener ese buzón dado de alta.
function buildFrom(sender: string): string {
  return `${displayName(sender)} (AI Lead Shield) <${sender}>`;
}

// Todo correo debe decir cómo darse de baja. Si el cuerpo no menciona "BAJA"
// (como palabra; "trabaja" no cuenta), agregamos la línea al final.
const BAJA_LINE = "Si prefiere no recibir más correos, responda BAJA.";
const mentionsBaja = (s: string) => /(^|[^\p{L}])baja([^\p{L}]|$)/iu.test(s);

function withBajaHtml(html: string): string {
  if (mentionsBaja(html)) return html;
  return `${html}<p style="margin-top:16px;font-size:12px;color:#94a3b8">${BAJA_LINE}</p>`;
}

// "2026-10-03T…" -> "3 de octubre de 2026" (hora de México).
function fecha(isoDate: string): string {
  return new Date(isoDate).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "America/Mexico_City",
  });
}

function alreadyContactedMsg(p: OutreachEvent, sender: string | null): string {
  const who =
    p.actor && p.actor === sender
      ? "Tú ya le escribiste"
      : `${p.actorName ?? "Alguien del equipo"} ya le escribió`;
  const subj = p.subject ? ` («${p.subject}»)` : "";
  return `${who} a este correo el ${fecha(p.at)}${subj}. No se envió para no duplicar.`;
}

type SendResult =
  | {
      ok: true;
      provider: "ghl";
      from: string;
      id?: string;
      conversationId?: string;
      contactId?: string;
    }
  | { ok: false; status: number; error: string };

export async function POST(req: NextRequest) {
  let payload: {
    to?: string;
    subject?: string;
    html?: string;
    text?: string;
    name?: string;
    phone?: string;
    leadId?: string;
    lead?: Business;
    city?: string;
    force?: boolean;
  };
  try {
    payload = await req.json();
  } catch {
    return NextResponse.json({ error: "Body inválido." }, { status: 400 });
  }

  const { subject, html, text, name, phone, leadId, lead, city, force } = payload;
  const to = payload.to?.trim();
  if (!to || !subject || (!html && !text)) {
    return NextResponse.json(
      { error: "Faltan campos: 'to', 'subject' y cuerpo." },
      { status: 400 }
    );
  }
  // Un solo destinatario: así la revisión de BAJAS y la bitácora cubren a
  // quien de verdad recibe el correo.
  if (!/^[^\s@,;<>]+@[^\s@,;<>]+\.[^\s@,;<>]+$/.test(to)) {
    return NextResponse.json(
      { error: "Pon un solo correo válido en 'Para'." },
      { status: 400 }
    );
  }
  const target = normEmail(to);
  const body = html || textToHtml(text ?? "");
  const sender = await sessionEmail(req);

  // Antes de enviar: lista de BAJAS y si alguien ya le escribió hace poco.
  // Si la BD falla aquí no enviamos: preferimos no escribirle a alguien que
  // pidió BAJA.
  if (hasDb()) {
    try {
      const supp = await getSuppression(target);
      if (supp) {
        return NextResponse.json(
          {
            code: "suppressed",
            error: `Este correo pidió BAJA${
              supp.createdAt ? ` el ${fecha(supp.createdAt)}` : ""
            }. No se envió.`,
            createdAt: supp.createdAt,
          },
          { status: 409 }
        );
      }
      if (!force) {
        const previous = await recentEmailsSent(target, DUP_WINDOW_DAYS);
        if (previous.length) {
          return NextResponse.json(
            {
              code: "already_contacted",
              error: alreadyContactedMsg(previous[0], sender),
              previous,
            },
            { status: 409 }
          );
        }
      }
    } catch (e) {
      console.error("send pre-check", e);
      return NextResponse.json(
        { error: "No se pudo revisar la lista de BAJAS. Intenta de nuevo en un momento." },
        { status: 503 }
      );
    }
  }

  if (!sender) {
    return NextResponse.json(
      { error: "No hay remitente: vuelve a iniciar sesión." },
      { status: 401 }
    );
  }
  const sent = await sendWithGhl({
    to,
    subject,
    html: withBajaHtml(body),
    from: buildFrom(sender),
    name,
    phone,
  });

  if (!sent.ok) {
    return NextResponse.json({ error: sent.error }, { status: sent.status });
  }

  // El correo ya salió: lo que falle de aquí en adelante solo se registra.
  const savedId = hasDb()
    ? await recordSent({
        sender,
        target,
        subject,
        provider: sent.provider,
        from: sent.from,
        messageId: sent.id,
        leadId,
        lead,
        city,
      })
    : undefined;

  return NextResponse.json({
    ok: true,
    provider: sent.provider,
    from: sent.from,
    id: sent.id,
    conversationId: sent.conversationId,
    contactId: sent.contactId,
    leadId: savedId,
  });
}

// Bitácora tras un envío exitoso: asegura que el prospecto exista (lo guarda
// si no estaba), registra el "email_sent" y lo marca como contactado.
// Nunca truena: devuelve el id del prospecto si se pudo resolver.
async function recordSent(input: {
  sender: string | null;
  target: string;
  subject: string;
  provider: "ghl";
  from: string;
  messageId?: string;
  leadId?: string;
  lead?: Business;
  city?: string;
}): Promise<string | undefined> {
  let id: string | undefined;
  try {
    if (input.leadId && (await leadExists(input.leadId))) {
      id = input.leadId;
    } else if (input.lead?.id && input.lead?.name) {
      const b = { ...input.lead, email: input.lead.email || input.target };
      id = (await saveLead(b, input.city ?? input.lead.city)).id;
    }
  } catch (e) {
    console.error("send: no se pudo guardar el prospecto", e);
  }

  try {
    await logEvent({
      type: "email_sent",
      actor: input.sender,
      target: input.target,
      leadId: id ?? input.leadId ?? null,
      meta: {
        subject: input.subject,
        provider: input.provider,
        from: input.from,
        messageId: input.messageId ?? null,
      },
    });
  } catch (e) {
    console.error("send: no se pudo registrar el evento", e);
  }

  if (id) {
    try {
      await markContacted(id, input.sender);
    } catch (e) {
      console.error("send: no se pudo marcar como contactado", e);
    }
  }
  return id;
}

// El estado tarda un momento en asentarse: recién enviado viene "pending" y
// puede pasar a "failed" un segundo después. Reintentamos para no reportar
// como enviado algo que GHL acabó rebotando.
async function confirmDelivery(
  emailMessageId: string
): Promise<{ status?: string; error?: string }> {
  let last: { status?: string; error?: string } = {};
  for (let i = 0; i < 3; i++) {
    const check = await getEmailMessage(emailMessageId);
    last = emailStatusFrom(check.body);
    if (last.status && last.status !== "pending") return last;
    await new Promise((r) => setTimeout(r, 1200));
  }
  return last;
}

// --- GoHighLevel (Conversations): el correo queda en el hilo del contacto ---
async function sendWithGhl(input: {
  to: string;
  subject: string;
  html: string;
  from: string;
  name?: string;
  phone?: string;
}): Promise<SendResult> {
  if (!ghlEmailReady()) {
    return {
      ok: false,
      status: 503,
      error: "GHL sin configurar. Falta GHL_PIT o GHL_LOCATION_ID.",
    };
  }

  // GHL solo manda correo a un contacto existente: primero lo buscamos/creamos.
  const contact = await ensureContactId({
    email: input.to,
    name: input.name,
    phone: input.phone,
  });
  if ("error" in contact) {
    return { ok: false, status: contact.status, error: contact.error };
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
      return {
        ok: false,
        status: 401,
        error:
          "El token de GHL no tiene el scope 'conversations/message.write'. Agrégalo en Ajustes → Private Integrations y vuelve a generar el token.",
      };
    }
    // El remitente es el correo del vendedor: si GHL no lo tiene dado de alta,
    // rechaza aquí.
    const sender = input.from.match(/<([^>]+)>/)?.[1] ?? input.from;
    return {
      ok: false,
      status: 502,
      error: `GHL rechazó el envío (HTTP ${r.status}). ${msg ?? ""} Revisa que ${sender} esté dado de alta como remitente en GHL.`
        .replace(/\s+/g, " ")
        .trim(),
    };
  }

  const b = r.body as {
    conversationId?: string;
    messageId?: string;
    emailMessageId?: string;
  };

  // GHL responde 200 aunque no lo entregue: confirmamos el estado real.
  if (b?.emailMessageId) {
    const { status, error } = await confirmDelivery(b.emailMessageId);
    if (status === "failed") {
      return {
        ok: false,
        status: 502,
        error:
          error === "Configured email service is expired"
            ? "GHL no lo entregó: el servicio de correo de la subcuenta está vencido. Renuévalo en GHL (Ajustes → Email Services)."
            : `GHL no entregó el correo: ${error || "razón desconocida"}.`,
      };
    }
  }

  return {
    ok: true,
    provider: "ghl",
    from: input.from,
    id: b?.emailMessageId || b?.messageId,
    conversationId: b?.conversationId,
    contactId: contact.id,
  };
}
