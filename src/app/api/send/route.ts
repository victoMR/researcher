import { NextRequest, NextResponse } from "next/server";
import { Resend } from "resend";
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

// Cómo se arma el remitente:
//  - "shared" (default): la dirección es siempre GHL_EMAIL_FROM (el buzón SMTP
//    de GoDaddy, que es el único que ese servidor deja usar), pero el NOMBRE
//    visible es el del vendedor -> "Aldo (AI Lead Shield) <contact@...>".
//  - "peruser": la dirección es la del vendedor. Solo sirve con un proveedor
//    que permita cualquier buzón del dominio (LeadConnector con dominio
//    dedicado, o Resend con dominio verificado).
function senderMode(): "shared" | "peruser" {
  return (process.env.EMAIL_SENDER_MODE || "shared").toLowerCase() === "peruser"
    ? "peruser"
    : "shared";
}

function buildFrom(sender: string | null): string | null {
  const shared = process.env.GHL_EMAIL_FROM;
  if (senderMode() === "peruser") return sender || shared || null;
  if (!shared) return sender;
  return sender ? `${displayName(sender)} (AI Lead Shield) <${shared}>` : shared;
}

// Quita acentos y pasa a minúsculas para comparar nombres.
const fold = (s: string) =>
  s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Últimas líneas con texto del cuerpo HTML (donde suele ir la firma).
function lastLines(html: string, n = 6): string[] {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li|h[1-6])>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .slice(-n);
}

// ¿El vendedor ya firmó con su nombre (completo o el de pila) al final?
function signedBy(html: string, sender: string): boolean {
  const tail = fold(lastLines(html).join("\n"));
  const full = fold(displayName(sender));
  if (full && tail.includes(full)) return true;
  const first = full.split(" ")[0];
  if (first.length < 3) return false;
  const esc = first.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^\\p{L}])${esc}([^\\p{L}]|$)`, "u").test(tail);
}

// Con remitente compartido, el prospecto no ve el correo del vendedor, así que
// se lo agregamos al pie para que pueda contestarle directo. Si el vendedor ya
// puso su correo en el cuerpo, o ya firmó con su nombre, no duplicamos.
function withSignature(html: string, sender: string | null): string {
  if (senderMode() === "peruser" || !sender) return html;
  if (html.toLowerCase().includes(sender.toLowerCase())) return html;
  if (signedBy(html, sender)) return html;
  return `${html}<p style="margin-top:16px">—<br/>${displayName(
    sender
  )} · AI Lead Shield<br/><a href="mailto:${sender}">${sender}</a></p>`;
}

// Todo correo debe decir cómo darse de baja. Si el cuerpo no menciona "BAJA"
// (como palabra; "trabaja" no cuenta), agregamos la línea al final.
const BAJA_LINE = "Si prefiere no recibir más correos, responda BAJA.";
const mentionsBaja = (s: string) => /(^|[^\p{L}])baja([^\p{L}]|$)/iu.test(s);

function withBajaHtml(html: string): string {
  if (mentionsBaja(html)) return html;
  return `${html}<p style="margin-top:16px;font-size:12px;color:#94a3b8">${BAJA_LINE}</p>`;
}

function withBajaText(text: string | undefined): string | undefined {
  if (!text || mentionsBaja(text)) return text;
  return `${text}\n\n${BAJA_LINE}`;
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

// Quién manda el correo: "ghl" | "resend" | "auto" (default).
// En auto se usa GHL si está configurado, y si no se cae a Resend.
function provider(): "ghl" | "resend" {
  const want = (process.env.EMAIL_PROVIDER || "auto").toLowerCase();
  if (want === "ghl") return "ghl";
  if (want === "resend") return "resend";
  return ghlEmailReady() ? "ghl" : "resend";
}

type SendResult =
  | {
      ok: true;
      provider: "ghl" | "resend";
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

  let sent: SendResult;
  if (provider() === "ghl") {
    const from = buildFrom(sender);
    if (!from) {
      return NextResponse.json(
        {
          error:
            "No hay remitente: inicia sesión de nuevo o define GHL_EMAIL_FROM.",
        },
        { status: 401 }
      );
    }
    sent = await sendWithGhl({
      to,
      subject,
      html: withBajaHtml(withSignature(body, sender)),
      from,
      name,
      phone,
    });
  } else {
    sent = await sendWithResend({
      to,
      subject,
      html: withBajaHtml(body),
      text: withBajaText(text),
      sender,
    });
  }

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
  provider: "ghl" | "resend";
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
    return {
      ok: false,
      status: 502,
      error: `GHL rechazó el envío (HTTP ${r.status}). ${msg ?? ""}`.trim(),
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

// --- Resend (respaldo) ---
async function sendWithResend(input: {
  to: string;
  subject: string;
  html: string;
  text?: string;
  sender?: string | null;
}): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const fallback = process.env.RESEND_FROM; // ej. "Ventas <ventas@tudominio.com>"

  if (!apiKey) {
    return {
      ok: false,
      status: 503,
      error: "Falta RESEND_API_KEY (o usa EMAIL_PROVIDER=ghl).",
    };
  }
  if (!fallback) {
    return {
      ok: false,
      status: 503,
      error:
        "Falta RESEND_FROM. Define el remitente verificado (ej. Ventas <ventas@tudominio.com>).",
    };
  }

  // En "shared" se manda desde la dirección base con el nombre del vendedor.
  // En "peruser" se usa su propio correo, pero solo si es del mismo dominio
  // verificado en Resend; si no, Resend rechazaría el envío.
  const domainOf = (s: string) => s.split("@")[1]?.replace(/>$/, "").toLowerCase();
  const addrOf = (s: string) => s.match(/<([^>]+)>/)?.[1] ?? s;
  let from = fallback;
  if (input.sender) {
    if (senderMode() === "shared") {
      from = `${displayName(input.sender)} (AI Lead Shield) <${addrOf(fallback)}>`;
    } else if (domainOf(input.sender) === domainOf(fallback)) {
      from = `${displayName(input.sender)} <${input.sender}>`;
    }
  }

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
      return { ok: false, status: 502, error: error.message };
    }
    return { ok: true, provider: "resend", from, id: data?.id };
  } catch (err) {
    console.error("send error", err);
    return { ok: false, status: 500, error: "No se pudo enviar el correo." };
  }
}
