"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

export interface SelectOption {
  value: string;
  label: string;
  icon?: ReactNode;
}

/** Dropdown 100% custom (nada de <select> nativo). */
export default function Select({
  value,
  options,
  onChange,
  className = "",
  align = "left",
  compact = false,
}: {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  className?: string;
  align?: "left" | "right";
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const current = options.find((o) => o.value === value);

  useEffect(() => {
    function onDoc(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onEsc(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onEsc);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onEsc);
    };
  }, []);

  return (
    <div ref={ref} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={`flex w-full items-center justify-between gap-2 rounded-xl text-left font-medium text-slate-700 outline-none transition focus:ring-2 focus:ring-indigo-500 ${
          compact
            ? "border border-slate-200 bg-white px-3 py-1.5 text-xs hover:bg-slate-50"
            : "bg-slate-50 px-4 py-3 text-sm hover:bg-slate-100"
        }`}
      >
        <span className="flex min-w-0 items-center gap-2 truncate">
          {current?.icon}
          <span className="truncate">{current?.label ?? "Selecciona…"}</span>
        </span>
        <svg
          className={`h-4 w-4 shrink-0 text-slate-400 transition ${open ? "rotate-180" : ""}`}
          viewBox="0 0 20 20"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M6 8l4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>

      {open && (
        <ul
          className={`absolute z-30 mt-1 max-h-72 min-w-full overflow-auto rounded-xl border border-slate-200 bg-white p-1 shadow-lg animate-[fadeIn_0.15s_ease] ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          {options.map((o) => {
            const active = o.value === value;
            return (
              <li key={o.value}>
                <button
                  type="button"
                  onClick={() => {
                    onChange(o.value);
                    setOpen(false);
                  }}
                  className={`flex w-full items-center justify-between gap-2 rounded-lg px-3 py-2 text-left text-sm transition ${
                    active
                      ? "bg-indigo-50 font-medium text-indigo-700"
                      : "text-slate-700 hover:bg-slate-50"
                  }`}
                >
                  <span className="flex min-w-0 items-center gap-2 truncate">
                    {o.icon}
                    <span className="truncate">{o.label}</span>
                  </span>
                  {active && (
                    <svg className="h-4 w-4 shrink-0" viewBox="0 0 20 20" fill="currentColor">
                      <path
                        fillRule="evenodd"
                        d="M16.7 5.3a1 1 0 010 1.4l-7 7a1 1 0 01-1.4 0l-3-3a1 1 0 011.4-1.4l2.3 2.29 6.3-6.29a1 1 0 011.4 0z"
                        clipRule="evenodd"
                      />
                    </svg>
                  )}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
