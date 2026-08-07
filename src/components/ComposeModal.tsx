"use client";

import { useEffect, useState } from "react";
import type { Business } from "@/lib/types";
import type { Template } from "@/lib/templates-repo";
import { applyVars } from "@/lib/apply-template";
import { waLink } from "@/lib/wa";
import Select from "@/components/Select";
import * as Icon from "@/components/icons";

interface Props {
  lead: Business;
  onClose: () => void;
  onSent?: () => void;
}

function defaultTemplate(name: string) {
  return {
    subject: `Propuesta para ${name}`,
    body: `Hola, equipo de ${name}:

Soy Víctor, de AI Lead Shield. Ayudamos a negocios como el suyo a conseguir más clientes con automatización e inteligencia artificial aplicada a ventas.

Me gustaría mostrarles en 15 minutos cómo podríamos generarles prospectos calificados de forma constante.

¿Tendrían un espacio esta semana?

Saludos,
Víctor
AI Lead Shield

--
Si prefiere no recibir más correos, responda "BAJA" y lo retiramos de inmediato.`,
  };
}

export default function ComposeModal({ lead, onClose, onSent }: Props) {
  const tpl = defaultTemplate(lead.name);
  const [to, setTo] = useState(lead.email || "");
  const [subject, setSubject] = useState(tpl.subject);
  const [body, setBody] = useState(tpl.body);
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [msgOk, setMsgOk] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  const [tplId, setTplId] = useState("");

  useEffect(() => {
    fetch("/api/templates")
      .then((r) => r.json())
      .then((d) => setTemplates(d.templates ?? []))
      .catch(() => {});
  }, []);

  // Aplica una plantilla: sustituye variables con los datos del negocio.
  function applyTemplate(id: string) {
    setTplId(id);
    const t = templates.find((x) => x.id === id);
    if (!t) return;
    if (t.subject) setSubject(applyVars(t.subject, lead));
    setBody(applyVars(t.body, lead));
  }

  function openWhatsApp() {
    if (!lead.phone) return;
    const url = waLink(lead.phone, body);
    if (url) window.open(url, "_blank");
  }

  async function send() {
    setSending(true);
    setMsg(null);
    try {
      const res = await fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to,
          subject,
          text: body,
          html: body
            .split("\n")
            .map((l) => (l.trim() ? `<p>${l}</p>` : "<br/>"))
            .join(""),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setMsgOk(false);
        setMsg(data.error || "No se pudo enviar.");
      } else {
        setMsgOk(true);
        setMsg("Correo enviado.");
        onSent?.();
      }
    } catch {
      setMsgOk(false);
      setMsg("Error de red al enviar.");
    } finally {
      setSending(false);
    }
  }

  function openMailto() {
    const url = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(
      subject
    )}&body=${encodeURIComponent(body)}`;
    window.open(url);
  }

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl rounded-2xl bg-white p-6 shadow-2xl"
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

        {templates.length > 0 && (
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

        <label className="mb-1 block text-sm font-medium text-slate-700">Para</label>
        <input
          value={to}
          onChange={(e) => setTo(e.target.value)}
          placeholder="correo@negocio.com"
          className="mb-3 w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
        />

        <label className="mb-1 block text-sm font-medium text-slate-700">Asunto</label>
        <input
          value={subject}
          onChange={(e) => setSubject(e.target.value)}
          className="mb-3 w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
        />

        <label className="mb-1 block text-sm font-medium text-slate-700">Mensaje</label>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={12}
          className="mb-4 w-full rounded-xl border-0 bg-slate-50 px-3 py-2 font-mono text-sm text-slate-900 outline-none focus:ring-2 focus:ring-indigo-500"
        />

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
            onClick={send}
            disabled={sending || !to}
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
