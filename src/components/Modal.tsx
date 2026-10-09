"use client";

import { useEffect, useState } from "react";
import * as Icon from "@/components/icons";

// Ventana modal con el mismo estilo que las de Plantillas. `dismissable=false`
// evita cerrarla por accidente (clic fuera / Esc), p. ej. al mostrar una
// contraseña que no se volverá a ver.
export function Modal({
  title,
  onClose,
  children,
  dismissable = true,
  size = "md",
}: {
  title: string;
  onClose: () => void;
  children: React.ReactNode;
  dismissable?: boolean;
  size?: "md" | "lg";
}) {
  useEffect(() => {
    if (!dismissable) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dismissable, onClose]);

  return (
    <div
      className="fixed inset-0 z-[1000] flex items-center justify-center bg-black/40 p-4"
      onClick={dismissable ? onClose : undefined}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={`max-h-[90vh] w-full ${
          size === "lg" ? "max-w-xl" : "max-w-md"
        } overflow-auto rounded-[22px] bg-white p-6 shadow-apple animate-[fadeIn_0.2s_ease]`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-start justify-between gap-3">
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">{title}</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          >
            <Icon.X className="h-4 w-4" />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

// Valor en monoespaciado con botón Copiar.
export function CopyField({ label, value, multiline = false }: { label: string; value: string; multiline?: boolean }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* el navegador no dejó copiar: queda el texto para seleccionarlo */
    }
  }
  return (
    <div className="mb-3">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-slate-700">{label}</span>
        <button
          type="button"
          onClick={copy}
          className="flex items-center gap-1 rounded-full border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
        >
          {copied ? <Icon.Check className="h-3.5 w-3.5 text-emerald-600" /> : <Icon.Copy className="h-3.5 w-3.5" />}
          {copied ? "Copiado" : "Copiar"}
        </button>
      </div>
      <code
        className={`block select-all rounded-xl bg-slate-50 px-3 py-2.5 font-mono text-sm text-slate-900 ${
          multiline ? "whitespace-pre-wrap break-all text-xs leading-relaxed" : "break-all"
        }`}
      >
        {value}
      </code>
    </div>
  );
}

export const inputCls =
  "w-full rounded-xl border-0 bg-slate-50 px-3 py-2 text-sm text-slate-900 outline-none placeholder:text-slate-400 focus:ring-2 focus:ring-indigo-500";
export const primaryBtn =
  "rounded-full bg-indigo-600 px-5 py-2 text-sm font-semibold text-white transition hover:bg-indigo-700 active:scale-[0.98] disabled:opacity-50";
export const secondaryBtn =
  "rounded-full border border-slate-200 px-5 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50";
