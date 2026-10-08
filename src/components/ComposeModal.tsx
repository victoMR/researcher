"use client";

import { useEffect, useRef, useState } from "react";
import type { Business } from "@/lib/types";
import type { Template } from "@/lib/templates-repo";
import type { OutreachEvent } from "@/lib/outreach-repo";
import { applyVars, textToHtml } from "@/lib/apply-template";
import { waLink } from "@/lib/wa";
import Select from "@/components/Select";
import * as Icon from "@/components/icons";

interface Props {
  lead: Business;
  onClose: () => void;
  onSent?: (r: { leadId?: string }) => void;
  // Opcionales (p. ej. el mensaje sugerido por el agente de IA): si vienen,
  // reemplazan el asunto / cuerpo por defecto. Al cuerpo se le agregan igual
  // la firma del vendedor y la línea de BAJA.
  initialSubject?: string;
  initialBody?: string;
}

// Vendedor logueado (GET /api/auth/me).
interface Me {
  email: string;
  name: string;
  isAdmin: boolean;
}

// Resultado de GET /api/suppression para un correo concreto.
interface Supp {
  email: string;
  suppressed: boolean;
  createdAt?: string;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const norm = (e: string) => e.trim().toLowerCase();
const JSON_HEADERS = { "Content-Type": "application/json" };

const BAJA_FOOTER =
  'Si prefiere no recibir más correos, responda "BAJA" y lo retiramos de inmediato.';

// Firma con el vendedor real; sin `me` (cargando o sin sesión) no se nombra a nadie.
// Con `initial` (asunto/cuerpo propuestos) se usan esos textos + firma + BAJA.
function defaultTemplate(
  name: string,
  me: Me | null,
  initial?: { subject?: string; body?: string }
) {
  const intro = me
    ? `Soy ${me.name}, de AI Lead Shield.`
    : "Le escribo de AI Lead Shield.";
  const firma = me ? `${me.name}\nAI Lead Shield\n${me.email}` : "AI Lead Shield";
  const initialBody = initial?.body?.trim();
  if (initialBody) {
    // Si el texto ya se despide, no repetimos "Saludos,".
    const closes = /(saludos|atentamente|quedo atent[oa])[^\n]*\s*$/i.test(initialBody);
    const baja = /(^|[^\p{L}])baja([^\p{L}]|$)/iu.test(initialBody);
    return {
      subject: initial?.subject?.trim() || `Propuesta para ${name}`,
      body: `${initialBody}\n\n${closes ? "" : "Saludos,\n"}${firma}${baja ? "" : `\n\n--\n${BAJA_FOOTER}`}`,
    };
  }
  return {
    subject: initial?.subject?.trim() || `Propuesta para ${name}`,
    body: `Hola, equipo de ${name}:

${intro} Ayudamos a negocios como el suyo a conseguir más clientes con automatización e inteligencia artificial aplicada a ventas.

Me gustaría mostrarles en 15 minutos cómo podríamos generarles prospectos calificados de forma constante.

¿Tendrían un espacio esta semana?

Saludos,
${firma}

--
Si prefiere no recibir más correos, responda "BAJA" y lo retiramos de inmediato.`,
  };
}

// "3 oct" (o "3 oct 2025" si no es de este año).
function shortDate(iso: string): string {
  const d = new Date(iso);
  const sameYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString("es-MX", {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

function longDate(iso: string): string {
  return new Date(iso).toLocaleDateString("es-MX", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}

// Una línea del historial: "Aldo le escribió el 3 oct · «Propuesta para X»".
function describeEvent(e: OutreachEvent, myEmail?: string): string {
  const mine = !!myEmail && e.actor === myEmail;
  const who = mine ? "Tú" : e.actorName || "Alguien del equipo";
  const when = shortDate(e.at);
  switch (e.type) {
    case "email_sent":
      return `${who} ${mine ? "le escribiste" : "le escribió"} el ${when}${
        e.subject ? ` · «${e.subject}»` : ""
      }`;
    case "whatsapp_opened":
      return `${who} ${mine ? "abriste" : "abrió"} WhatsApp el ${when}`;
    case "suppressed":
      return `${who} lo ${mine ? "marcaste" : "marcó"} como BAJA el ${when}`;
    case "status_changed":
      return `${who} ${mine ? "cambiaste" : "cambió"} el estado el ${when}`;
    default:
      return `${who} · ${e.type} · ${when}`;
  }
}

function EventIcon({ type }: { type: string }) {
  const cls = "h-3 w-3 shrink-0";
  if (type === "email_sent") return <Icon.Mail className={`${cls} text-indigo-500`} />;
  if (type === "whatsapp_opened")
    return <Icon.WhatsApp className={`${cls} text-emerald-500`} />;
  if (type === "suppressed") return <Icon.X className={`${cls} text-rose-500`} />;
  return <Icon.Refresh className={`${cls} text-slate-400`} />;
}

export default function ComposeModal({
  lead,
  onClose,
  onSent,
  initialSubject,
  initialBody,
}: Props) {
  const [me, setMe] = useState<Me | null>(null);
  const [meReady, setMeReady] = useState(false);
  // Si el usuario ya tocó el mensaje, no lo reescribimos al llegar `me`.
  const bodyEdited = useRef(false);

  const [to, setTo] = useState(lead.email || "");
  const [subject, setSubject] = useState(
    () => defaultTemplate(lead.name, null, { subject: initialSubject }).subject
  );
  const [body, setBody] = useState(
    () => defaultTemplate(lead.name, null, { body: initialBody }).body
  );
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tplId, setTplId] = useState("");

  // Bajas, historial y aviso de "ya se le escribió", ligados al correo/lead
  // que se consultó (así no se muestra info vieja si cambia "Para").
  const [supp, setSupp] = useState<Supp | null>(null);
  const [hist, setHist] = useState<{ key: string; events: OutreachEvent[] } | null>(null);
  const [showAllHist, setShowAllHist] = useState(false);
  const [dup, setDup] = useState<{ email: string; error: string } | null>(null);

  const toNorm = norm(to);
  const toValid = EMAIL_RE.test(toNorm);
  const histKey = `${toValid ? toNorm : ""}|${lead.id}`;
  const suppressed = supp && supp.email === toNorm && supp.suppressed ? supp : null;
  const events = hist && hist.key === histKey ? hist.events : [];
  const dupNow = dup && dup.email === toNorm ? dup : null;

  useEffect(() => {
    fetch("/api/templates")
      .then((r) => r.json())
      .then((d) => setTemplates(d.templates ?? []))
      .catch(() => {});
  }, []);

  // Quién envía: con eso se firma el mensaje por defecto.
  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((d: Me | null) => {
        if (!d?.name) return;
        setMe(d);
        if (!bodyEdited.current)
          setBody(defaultTemplate(lead.name, d, { body: initialBody }).body);
      })
      .catch(() => {})
      .finally(() => setMeReady(true));
  }, [lead.name, initialBody]);

  // Al abrir y al cambiar "Para" (con espera de 400 ms): ¿pidió BAJA? y
  // ¿quién le ha escrito ya?
  useEffect(() => {
    const email = norm(to);
    const valid = EMAIL_RE.test(email);
    const key = `${valid ? email : ""}|${lead.id}`;
    const ctrl = new AbortController();
    const delay = to === (lead.email || "") ? 0 : 400;
    const t = setTimeout(() => {
      if (valid) {
        fetch(`/api/suppression?email=${encodeURIComponent(email)}`, {
          signal: ctrl.signal,
        })
          .then((r) => (r.ok ? r.json() : null))
          .then((d) => {
            if (d) setSupp({ email, suppressed: !!d.suppressed, createdAt: d.createdAt });
          })
          .catch(() => {});
      }
      const qs = new URLSearchParams({ leadId: lead.id });
      if (valid) qs.set("email", email);
      fetch(`/api/outreach?${qs}`, { signal: ctrl.signal })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (d) setHist({ key, events: d.events ?? [] });
        })
        .catch(() => {});
    }, delay);
    return () => {
      clearTimeout(t);
      ctrl.abort();
    };
  }, [to, lead.id, lead.email]);

  // Agrega al historial visible un evento recién hecho (sin volver a consultar).
  function pushEvent(type: string, extra?: { subject?: string }) {
    const ev: OutreachEvent = {
      type,
      actor: me?.email ?? null,
      actorName: me?.name ?? null,
      at: new Date().toISOString(),
      ...extra,
    };
    setHist({ key: histKey, events: [ev, ...events] });
  }

  // Aplica una plantilla: sustituye variables con los datos del negocio.
  function applyTemplate(id: string) {
    setTplId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    const ctx = { vendedor: me?.name };
    if (t.subject) setSubject(applyVars(t.subject, lead, ctx));
    setBody(applyVars(t.body, lead, ctx));
  }

  function openWhatsApp() {
    if (!lead.phone) return;
    const url = waLink(lead.phone, body);
    if (!url) return;
    // Bitácora sin esperar respuesta: la ventana se abre en este mismo clic
    // para que el navegador no la bloquee.
    fetch("/api/outreach", {
      method: "POST",
      headers: JSON_HEADERS,
      keepalive: true,
      body: JSON.stringify({
        type: "whatsapp",
        leadId: lead.id,
        email: toValid ? toNorm : undefined,
        phone: lead.phone,
        name: lead.name,
      }),
    }).catch(() => {});
    window.open(url, "_blank");
    pushEvent("whatsapp_opened");
  }

  async function send(force = false) {
    setSending(true);
    setMsg(null);
    setDup(null);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          to,
          subject,
          // GHL necesita un contacto: mandamos nombre y teléfono para crearlo
          // si todavía no existe en la subcuenta.
          name: lead.name,
          phone: lead.phone || undefined,
          text: body,
          html: textToHtml(body),
          // Para la bitácora: si el negocio no estaba guardado, se guarda.
          leadId: lead.id,
          lead,
          city: lead.city,
          ...(force ? { force: true } : {}),
        }),
      });
      const data = await res.json();
      if (res.status === 409 && data.code === "already_contacted") {
        setDup({ email: toNorm, error: data.error || "Ya se le escribió a este correo." });
        return;
      }
      if (res.status === 409 && data.code === "suppressed") {
        // El aviso rojo ya lo explica (y deshabilita el envío).
        setSupp({ email: toNorm, suppressed: true, createdAt: data.createdAt });
        return;
      }
      if (!res.ok) {
        setMsgOk(false);
        setMsg(data.error || "No se pudo enviar.");
      } else {
        setMsgOk(true);
        setMsg("Correo enviado.");
        pushEvent("email_sent", { subject });
        onSent?.({ leadId: data.leadId });
      }
    } catch {
      setMsgOk(false);
      setMsg("Error de red al enviar.");
    } finally {
      setSending(false);
    }
  }

  async function markBaja() {
    const email = toNorm;
    if (!EMAIL_RE.test(email)) return;
    if (
      !confirm(
        `¿Marcar ${email} como BAJA?\n\nNadie del equipo podrá volver a enviarle correos y sus prospectos quedarán como descartados.`
      )
    )
      return;
    try {
      const res = await fetch("/api/suppression", {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({ email, reason: "Marcada a mano" }),
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsgOk(false);
        setMsg(d.error || "No se pudo registrar la baja.");
        return;
      }
      setSupp({ email, suppressed: true, createdAt: new Date().toISOString() });
      setMsg(null);
      pushEvent("suppressed");
    } catch {
      setMsgOk(false);
      setMsg("Error de red al registrar la baja.");
    }
  }

  // Solo admins: quita la BAJA (por si se marcó por error).
  async function unmarkBaja() {
    const email = toNorm;
    if (!confirm(`¿Quitar la BAJA de ${email}? Se le podrá volver a escribir.`)) return;
    try {
      const res = await fetch(`/api/suppression?email=${encodeURIComponent(email)}`, {
        method: "DELETE",
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMsgOk(false);
        setMsg(d.error || "No se pudo quitar la baja.");
        return;
      }
      setSupp({ email, suppressed: false });
    } catch {
      setMsgOk(false);
      setMsg("Error de red al quitar la baja.");
    }
  }

  function openMailto() {
    const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body)}`;
    window.open(url);
  }

  const visibleEvents = showAllHist ? events : events.slice(0, 3);

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[92vh] w-full max-w-2xl overflow-auto rounded-2xl bg-white p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            Propuesta para {lead.name}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <Icon.X className="h-4 w-4" />
          </button>
        </div>

        {events.length > 0 && (
          <div className="mb-3 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <p className="mb-1 font-medium text-slate-700">Historial de contacto</p>
            <ul className="space-y-0.5">
              {visibleEvents.map((e, i) => (
                <li key={`${e.at}-${i}`} className="flex items-center gap-1.5">
                  <EventIcon type={e.type} />
                  <span className="truncate">{describeEvent(e, me?.email)}</span>
                </li>
              ))}
            </ul>
            {events.length > 3 && (
              <button
                onClick={() => setShowAllHist((v) => !v)}
                className="mt-1 text-[11px] font-medium text-indigo-600 hover:underline"
              >
                {showAllHist ? "Ver menos" : `Ver todo (${events.length})`}
              </button>
            )}
          </div>
        )}

        {templates.length > 0 && meReady && (
          <div className="mb-3">
            <label className="mb-1 block text-sm font-medium text-slate-700">
              Plantilla
            </label>
            <Select
              value={tplId}
              onChange={applyTemplate}
              options={[
                { value: "", label: "Elegir plantilla…" },
                ...templates.map((t) => ({ value: t.id, label: `${t.name} (v${t.version})` })),
              ]}
            />
          </div>
        )}

        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Para</label>
          {toValid && !suppressed && (
            <button
              onClick={markBaja}
              title="El prospecto pidió no recibir más correos"
              className="text-xs text-slate-400 hover:text-rose-600 hover:underline"
            >
              Marcar como BAJA
            </button>
          )}
        </div>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="correo@negocio.com"
          className="mb-3 w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
        />

        {suppressed && (
          <div className="mb-3 flex flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
            <span>
              <b>Este correo pidió BAJA</b>
              {suppressed.createdAt ? ` el ${longDate(suppressed.createdAt)}` : ""}. No se le
              puede enviar correo.
            </span>
            {me?.isAdmin && (
              <button
                onClick={unmarkBaja}
                className="ml-auto text-xs font-medium text-rose-600 underline hover:text-rose-800"
              >
                Quitar BAJA
              </button>
            )}
          </div>
        )}

        <label className="mb-1 block text-sm font-medium text-slate-700">Asunto</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="mb-3 w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
        />

        <label className="mb-1 block text-sm font-medium text-slate-700">Mensaje</label>
        <textarea
          value={body}
          onChange={(e) => {
            bodyEdited.current = true;
            setBody(e.target.value);
          }}
          rows={12}
          className="mb-4 w-full rounded-xl border-0 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
        />

        {dupNow && (
          <div className="mb-3 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            <p>{dupNow.error}</p>
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => send(true)}
                disabled={sending || !!suppressed}
                className="rounded-lg bg-amber-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-amber-700 disabled:opacity-50"
              >
                {sending ? "Enviando…" : "Enviar de todos modos"}
              </button>
              <button
                onClick={() => setDup(null)}
                className="rounded-lg border border-amber-200 px-3 py-1.5 text-xs font-medium text-amber-800 hover:bg-amber-100"
              >
                Cancelar
              </button>
            </div>
          </div>
        )}

        {msg && (
          <p
            className={`mb-3 rounded-lg px-3 py-2 text-sm ${
              msgOk
                ? "bg-emerald-50 text-emerald-700"
                : "bg-amber-50 text-amber-800"
            }`}
          >
            {msg}
          </p>
        )}

        <div className="flex flex-wrap gap-2">
          <button
            onClick={() => send()}
            disabled={sending || !to || !!suppressed}
            title={suppressed ? "Este correo pidió BAJA" : undefined}
            className="flex items-center gap-1.5 rounded-xl bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            <Icon.Mail className="h-4 w-4" />
            {sending ? "Enviando…" : "Enviar correo"}
          </button>
          {lead.phone && (
            <button
              onClick={openWhatsApp}
              className="flex items-center gap-1.5 rounded-xl bg-emerald-500 px-4 py-2 text-sm font-semibold text-white hover:bg-emerald-600"
            >
              <Icon.WhatsApp className="h-4 w-4" />
              WhatsApp
            </button>
          )}
          <button
            onClick={openMailto}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Abrir en mi correo
          </button>
          <button
            onClick={() => navigator.clipboard.writeText(body)}
            className="rounded-xl border border-slate-200 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Copiar texto
          </button>
        </div>
      </div>
    </div>
  );
}
