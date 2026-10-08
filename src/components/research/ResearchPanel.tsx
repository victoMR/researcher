"use client";

import { useRef, useState } from "react";
import type { Me } from "@/lib/types";
import * as Icon from "@/components/icons";
import ResearchHistory from "./ResearchHistory";
import ResearchRunView from "./ResearchRunView";
import { startResearch } from "./api";

const EXAMPLES = [
  "Clínicas dentales activas en El Refugio, Querétaro",
  "Agencias de seminuevos en Zapopan con más de 10 empleados",
  "Inmobiliarias en Polanco que no tengan WhatsApp en su web",
  "Talleres mecánicos cerca de Juriquilla con buenas reseñas",
];

const SOURCES = ["DENUE (INEGI)", "OpenStreetMap", "Sitios web de los negocios", "Google (solo referencia)"];

const MAX_PROMPT = 1000;

// Pestaña "Investigar con IA": el vendedor escribe qué busca en lenguaje
// natural, el agente investiga y entrega un reporte. La corrida abierta vive en
// el padre (`openId`) para no perderla al cambiar de pestaña.
export default function ResearchPanel({
  me,
  openId,
  onOpen,
  onChanged,
}: {
  me: Me | null;
  openId: string | null;
  onOpen: (id: string | null) => void;
  onChanged?: () => void;
}) {
  const [draft, setDraft] = useState("");
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  function open(id: string | null) {
    onOpen(id);
    window.scrollTo({ top: 0 });
  }

  async function submit(e?: React.FormEvent) {
    e?.preventDefault();
    const prompt = draft.trim();
    if (!prompt || starting) return;
    if (prompt.length < 8) {
      setError("Cuéntale un poco más al agente: qué giro buscas y en qué zona.");
      return;
    }
    setStarting(true);
    setError(null);
    const r = await startResearch(prompt);
    setStarting(false);
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setDraft("");
    open(r.data.id);
  }

  function pickExample(text: string) {
    setDraft(text);
    setError(null);
    inputRef.current?.focus();
  }

  if (openId) {
    return (
      <ResearchRunView
        key={openId}
        id={openId}
        me={me}
        onOpen={open}
        onBack={() => open(null)}
        onChanged={onChanged}
      />
    );
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <section aria-labelledby="ri-title" className="min-w-0">
        <div className="mb-6 text-center lg:text-left">
          <span className="inline-flex items-center gap-1.5 rounded-full bg-violet-50 px-3 py-1 text-xs font-semibold text-violet-700">
            <Icon.Sparkles className="h-3.5 w-3.5" /> Agente de prospección
          </span>
          <h2
            id="ri-title"
            className="mt-3 text-3xl font-semibold tracking-[-0.03em] text-slate-900 sm:text-4xl"
          >
            Investiga clientes con IA
          </h2>
          <p className="mx-auto mt-2 max-w-xl text-base text-slate-500 lg:mx-0">
            Escribe qué negocios buscas y dónde. El agente investiga paso a paso y te entrega un
            ranking con el porqué de cada prospecto y un mensaje sugerido.
          </p>
        </div>

        <form
          onSubmit={submit}
          className="rounded-[22px] border border-black/5 bg-white p-2 shadow-apple"
        >
          <label htmlFor="research-prompt" className="block px-3 pb-1.5 pt-2 text-sm font-semibold text-slate-800">
            ¿Qué clientes buscas y dónde?
          </label>
          <textarea
            id="research-prompt"
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void submit();
              }
            }}
            rows={4}
            maxLength={MAX_PROMPT}
            aria-describedby="research-hint"
            placeholder="Ej. busca clientes activos en El Refugio, Querétaro, nicho clínicas dentales"
            className="block w-full resize-y rounded-2xl border-0 bg-slate-50 px-4 py-3 text-[15px] leading-relaxed text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500"
          />
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 pb-1 pt-2">
            <span id="research-hint" className="text-xs text-slate-400">
              <kbd className="font-sans font-medium text-slate-500">Enter</kbd> investiga ·{" "}
              <kbd className="font-sans font-medium text-slate-500">Shift + Enter</kbd> salto de línea
            </span>
            <button
              type="submit"
              disabled={starting || !draft.trim()}
              className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-6 py-2.5 text-sm font-semibold text-white transition hover:bg-indigo-700 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:opacity-50"
            >
              {starting ? (
                <>
                  <Icon.Loader className="h-4 w-4" /> Iniciando…
                </>
              ) : (
                <>
                  <Icon.Sparkles className="h-4 w-4" /> Investigar
                </>
              )}
            </button>
          </div>
        </form>

        {error && (
          <p role="alert" className="mt-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {error}
          </p>
        )}

        <div className="mt-5">
          <p className="mb-2 text-xs font-medium text-slate-400">Prueba con un ejemplo:</p>
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => pickExample(ex)}
                className="rounded-full border border-black/10 bg-white px-3 py-1.5 text-left text-xs font-medium text-slate-600 transition hover:border-indigo-200 hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                {ex}
              </button>
            ))}
          </div>
        </div>

        <div className="mt-6 rounded-2xl border border-dashed border-black/10 px-4 py-3 text-xs text-slate-500">
          <p className="mb-1.5 font-medium text-slate-600">Qué revisa el agente</p>
          <ul className="flex flex-wrap gap-x-4 gap-y-1">
            {SOURCES.map((s) => (
              <li key={s} className="flex items-center gap-1.5">
                <Icon.Check className="h-3.5 w-3.5 text-emerald-500" /> {s}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-slate-400">
            El CSV y GHL solo llevan datos de DENUE, OpenStreetMap o la web del negocio.
          </p>
        </div>
      </section>

      <ResearchHistory me={me} onOpen={open} />
    </div>
  );
}
