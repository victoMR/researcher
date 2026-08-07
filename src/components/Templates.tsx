"use client";

import { useEffect, useState } from "react";
import Select from "@/components/Select";
import * as Icon from "@/components/icons";

type Channel = "email" | "whatsapp" | "ambos";
interface Template {
  id: string;
  name: string;
  channel: Channel;
  subject?: string;
  body: string;
  version: number;
  updatedAt: number;
}

const CHANNEL_OPTS = [
  { value: "ambos", label: "Correo + WhatsApp" },
  { value: "email", label: "Solo correo" },
  { value: "whatsapp", label: "Solo WhatsApp" },
];
const CHANNEL_LABEL: Record<Channel, string> = {
  email: "Correo",
  whatsapp: "WhatsApp",
  ambos: "Correo + WhatsApp",
};
const VARS = ["{{nombre}}", "{{ciudad}}", "{{giro}}"];

// Plantilla base v1: mensaje que engancha, sirve para correo y WhatsApp.
function starterV1() {
  return {
    name: "Bienvenida v1",
    channel: "ambos" as Channel,
    subject: "Más clientes para {{nombre}} con IA",
    body: `Hola, equipo de {{nombre}}:

Somos AI Lead Shield. Vimos que en {{ciudad}} el giro de {{giro}} tiene una gran oportunidad de atraer más clientes con automatización e inteligencia artificial.

Nos encantaría ayudarles a captar más prospectos y cerrar más ventas, sin dedicar horas a tareas manuales.

¿Tendrían 15 minutos esta semana para mostrarles cómo?

Saludos,
AI Lead Shield`,
  };
}

export default function Templates() {
  const [templates, setTemplates] = useState<Template[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<Template | "new" | null>(null);
  const [history, setHistory] = useState<{ name: string; md: string } | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch("/api/templates");
      const data = await res.json();
      setTemplates(data.templates ?? []);
    } catch {
      /* ignora */
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    load();
  }, []);

  async function openHistory(t: Template) {
    const res = await fetch(`/api/templates/${t.id}`);
    const data = await res.json();
    setHistory({ name: t.name, md: data.historyMd ?? "" });
  }

  async function remove(id: string) {
    if (!confirm("¿Borrar esta plantilla?")) return;
    await fetch(`/api/templates/${id}`, { method: "DELETE" });
    setTemplates((t) => t.filter((x) => x.id !== id));
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">
            Plantillas
          </h2>
          <p className="text-sm text-slate-500">
            Mensajes reutilizables para correo y WhatsApp, con historial de cambios.
          </p>
        </div>
        <div className="flex gap-2">
          <button
            onClick={() => setEditing("new")}
            className="flex items-center gap-1.5 rounded-full border border-black/10 bg-white px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            <Icon.Plus className="h-4 w-4" /> Nueva
          </button>
        </div>
      </div>

      {loading ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-32 animate-pulse rounded-2xl bg-white" />
          ))}
        </div>
      ) : templates.length === 0 ? (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed border-black/10 bg-white py-16 text-center">
          <span className="mb-3 text-slate-300">
            <Icon.Mail className="h-8 w-8" />
          </span>
          <h3 className="font-semibold text-slate-700">Sin plantillas todavía</h3>
          <p className="mt-1 text-sm text-slate-400">
            Crea una, o genera la <b>base v1</b> para empezar.
          </p>
          <button
            onClick={() => setEditing("new")}
            className="mt-4 rounded-full bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
          >
            Crear plantilla
          </button>
        </div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {templates.map((t) => (
            <div
              key={t.id}
              className="flex flex-col rounded-2xl border border-black/5 bg-white p-4 shadow-apple-sm"
            >
              <div className="flex items-start justify-between gap-2">
                <h3 className="truncate font-semibold text-slate-900">{t.name}</h3>
                <span className="shrink-0 rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-medium text-slate-500">
                  v{t.version}
                </span>
              </div>
              <span className="mt-1 w-fit rounded-full bg-indigo-50 px-2 py-0.5 text-[11px] font-medium text-indigo-700">
                {CHANNEL_LABEL[t.channel]}
              </span>
              <p className="mt-2 line-clamp-3 flex-1 whitespace-pre-wrap text-xs text-slate-500">
                {t.body}
              </p>
              <div className="mt-3 flex flex-wrap gap-1.5">
                <button
                  onClick={() => setEditing(t)}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Editar
                </button>
                <button
                  onClick={() => openHistory(t)}
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  Historial (MD)
                </button>
                <button
                  onClick={() => {
                    const html = t.body
                      .split("\n")
                      .map((l) => (l.trim() ? `<p>${l}</p>` : "<br/>"))
                      .join("");
                    navigator.clipboard.writeText(html);
                    setCopiedId(t.id);
                    setTimeout(() => setCopiedId(null), 1500);
                  }}
                  title="Copiar como HTML para pegar en GHL"
                  className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
                >
                  {copiedId === t.id ? "Copiado" : "Copiar HTML"}
                </button>
                <button
                  onClick={() => remove(t.id)}
                  className="ml-auto rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50"
                >
                  Borrar
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {editing && (
        <Editor
          initial={editing === "new" ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
          }}
        />
      )}
      {history && (
        <HistoryModal
          name={history.name}
          md={history.md}
          onClose={() => setHistory(null)}
        />
      )}
    </div>
  );
}

function Editor({
  initial,
  onClose,
  onSaved,
}: {
  initial: Template | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(initial?.name ?? "");
  const [channel, setChannel] = useState<Channel>(initial?.channel ?? "ambos");
  const [subject, setSubject] = useState(initial?.subject ?? "");
  const [body, setBody] = useState(initial?.body ?? "");
  const [note, setNote] = useState("");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const isEdit = !!initial;

  function genV1() {
    const s = starterV1();
    setName((n) => n || s.name);
    setChannel(s.channel);
    setSubject(s.subject);
    setBody(s.body);
  }

  async function save() {
    if (!name.trim() || !body.trim()) {
      setErr("Ponle nombre y cuerpo a la plantilla.");
      return;
    }
    setSaving(true);
    setErr(null);
    try {
      const payload = { name, channel, subject: channel === "whatsapp" ? undefined : subject, body, note };
      const res = isEdit
        ? await fetch(`/api/templates/${initial!.id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await fetch("/api/templates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
      if (res.ok) onSaved();
      else {
        const d = await res.json();
        setErr(d.error || "No se pudo guardar.");
      }
    } catch {
      setErr("Error de red.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[90vh] w-full max-w-2xl overflow-auto rounded-[22px] bg-white p-6 shadow-apple"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-slate-900">
            {isEdit ? `Editar — ${initial!.name}` : "Nueva plantilla"}
          </h2>
          <button
            onClick={onClose}
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <Icon.X className="h-4 w-4" />
          </button>
        </div>

        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="flex-1">
            <label className="mb-1 block text-sm font-medium text-slate-700">Nombre</label>
            <input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Ej. Bienvenida inmobiliarias"
              className="w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div className="w-52">
            <label className="mb-1 block text-sm font-medium text-slate-700">Canal</label>
            <Select
              value={channel}
              onChange={(v) => setChannel(v as Channel)}
              options={CHANNEL_OPTS}
            />
          </div>
          <button
            onClick={genV1}
            className="rounded-full border border-indigo-200 bg-indigo-50 px-3 py-2 text-xs font-semibold text-indigo-700 hover:bg-indigo-100"
          >
            Generar v1
          </button>
        </div>

        {channel !== "whatsapp" && (
          <div className="mb-3">
            <label className="mb-1 block text-sm font-medium text-slate-700">Asunto (correo)</label>
            <input
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              className="w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
        )}

        <div className="mb-1 flex items-center justify-between">
          <label className="text-sm font-medium text-slate-700">Mensaje</label>
          <div className="flex gap-1">
            {VARS.map((v) => (
              <button
                key={v}
                onClick={() => setBody((b) => b + v)}
                className="rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200"
              >
                {v}
              </button>
            ))}
          </div>
        </div>
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={11}
          className="mb-3 w-full rounded-xl border-0 bg-slate-50 px-3 py-2 font-mono text-sm outline-none focus:ring-2 focus:ring-indigo-500"
        />

        {isEdit && (
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="¿Qué cambiaste? (queda en el historial)"
            className="mb-3 w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-indigo-500"
          />
        )}

        {err && (
          <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{err}</p>
        )}

        <div className="flex gap-2">
          <button
            onClick={save}
            disabled={saving}
            className="rounded-full bg-indigo-600 px-5 py-2 text-sm font-semibold text-white hover:bg-indigo-700 disabled:opacity-50"
          >
            {saving ? "Guardando…" : isEdit ? "Guardar nueva versión" : "Crear plantilla"}
          </button>
          <button
            onClick={onClose}
            className="rounded-full border border-slate-200 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50"
          >
            Cancelar
          </button>
        </div>
      </div>
    </div>
  );
}

function HistoryModal({
  name,
  md,
  onClose,
}: {
  name: string;
  md: string;
  onClose: () => void;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
    >
      <div
        className="max-h-[85vh] w-full max-w-2xl overflow-hidden rounded-[22px] bg-white shadow-apple"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-black/5 px-6 py-4">
          <h2 className="text-lg font-semibold text-slate-900">Historial — {name}</h2>
          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                navigator.clipboard.writeText(md);
                setCopied(true);
                setTimeout(() => setCopied(false), 1500);
              }}
              className="rounded-full border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 hover:bg-slate-50"
            >
              {copied ? "Copiado" : "Copiar MD"}
            </button>
            <button
              onClick={onClose}
              className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
            >
              <Icon.X className="h-4 w-4" />
            </button>
          </div>
        </div>
        <pre className="max-h-[70vh] overflow-auto whitespace-pre-wrap bg-slate-50 p-6 font-mono text-xs leading-relaxed text-slate-700">
          {md}
        </pre>
      </div>
    </div>
  );
}
