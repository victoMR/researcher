"use client";

import { useEffect, useRef, useState } from "react";
import type { Me } from "@/lib/types";
import * as Icon from "@/components/icons";

// Iniciales para el avatar: "Aldo Pérez" -> "AP".
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

// Menú del usuario en el encabezado: Equipo (admins), Cambiar mi contraseña y Cerrar sesión.
export default function UserMenu({
  me,
  onTeam,
  onPassword,
  onLogout,
}: {
  me: Me | null;
  onTeam?: () => void;
  onPassword: () => void;
  onLogout: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Cierra al hacer clic fuera o con Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = (fn?: () => void) => () => {
    setOpen(false);
    fn?.();
  };
  const item =
    "flex w-full items-center gap-2.5 rounded-xl px-3 py-2 text-left text-sm text-slate-700 transition hover:bg-slate-100";

  return (
    <div ref={ref} className="relative shrink-0">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        title={me ? `${me.name} (${me.email})` : "Mi cuenta"}
        className="relative grid h-9 w-9 place-items-center rounded-full bg-gradient-to-b from-slate-100 to-slate-200 text-xs font-semibold text-slate-700 ring-1 ring-black/5 transition hover:from-slate-200 hover:to-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
      >
        {me ? initials(me.name) : <Icon.User className="h-4 w-4" />}
        {me?.mustChangePassword && (
          <span
            aria-label="Debes cambiar tu contraseña"
            className="absolute -right-0.5 -top-0.5 h-2.5 w-2.5 rounded-full bg-amber-500 ring-2 ring-white"
          />
        )}
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-11 z-30 w-64 rounded-2xl border border-black/5 bg-white p-1.5 shadow-apple animate-[fadeIn_0.15s_ease]"
        >
          {me && (
            <div className="border-b border-black/5 px-3 pb-2.5 pt-2">
              <p className="truncate text-sm font-semibold text-slate-900">{me.name}</p>
              <p className="truncate text-xs text-slate-500">{me.email}</p>
              <span
                className={`mt-1.5 inline-block rounded-full px-2 py-0.5 text-[11px] font-medium ${
                  me.isAdmin ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"
                }`}
              >
                {me.isAdmin ? "Administrador" : "Vendedor"}
              </span>
            </div>
          )}
          <div className="pt-1.5">
            {me?.isAdmin && onTeam && (
              <button role="menuitem" onClick={pick(onTeam)} className={item}>
                <Icon.Users className="h-4 w-4 text-slate-400" /> Equipo
              </button>
            )}
            <button role="menuitem" onClick={pick(onPassword)} className={item}>
              <Icon.Lock className="h-4 w-4 text-slate-400" />
              <span className="flex-1">Cambiar mi contraseña</span>
              {me?.mustChangePassword && <span className="h-2 w-2 rounded-full bg-amber-500" />}
            </button>
            <button role="menuitem" onClick={pick(onLogout)} className={item}>
              <Icon.LogOut className="h-4 w-4 text-slate-400" /> Cerrar sesión
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
