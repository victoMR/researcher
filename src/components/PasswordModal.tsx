"use client";

import { useState } from "react";
import type { Me } from "@/lib/types";
import { Modal, inputCls, primaryBtn, secondaryBtn } from "@/components/Modal";
import * as Icon from "@/components/icons";

const MIN_LEN = 12;

// "Cambiar mi contraseña". forced = entró con contraseña temporal (aviso al
// entrar; se puede posponer con "Más tarde", pero vuelve a salir).
export default function PasswordModal({
  me,
  forced = false,
  onClose,
  onChanged,
}: {
  me: Me;
  forced?: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [actual, setActual] = useState("");
  const [nueva, setNueva] = useState("");
  const [confirmar, setConfirmar] = useState("");
  const [show, setShow] = useState(false);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Usuarios definidos en Vercel (APP_USERS): no se cambia desde aquí.
  if (me.source === "env") {
    return (
      <Modal title="Cambiar mi contraseña" onClose={onClose}>
        <p className="mb-4 flex gap-2 rounded-xl bg-slate-50 px-3 py-3 text-sm text-slate-600">
          <Icon.Info className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />
          <span>
            Tu contraseña se administra en <b>Vercel</b> (variables de entorno <code>APP_USERS</code>{" "}
            / <code>APP_LOGIN_PASSWORD</code>). Para cambiarla hay que actualizar esa variable y
            volver a desplegar.
          </span>
        </p>
        <button onClick={onClose} className={secondaryBtn}>
          Entendido
        </button>
      </Modal>
    );
  }

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    if (nueva.length < MIN_LEN) return setErr(`La nueva contraseña debe tener al menos ${MIN_LEN} caracteres.`);
    if (nueva !== confirmar) return setErr("La confirmación no coincide con la nueva contraseña.");
    if (nueva === actual) return setErr("La nueva contraseña debe ser distinta de la actual.");
    setSaving(true);
    try {
      const res = await fetch("/api/auth/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ actual, nueva }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setErr(data.error || "No se pudo cambiar la contraseña.");
        return;
      }
      setDone(true);
      onChanged();
    } catch {
      setErr("Error de red. Intenta de nuevo.");
    } finally {
      setSaving(false);
    }
  }

  if (done) {
    return (
      <Modal title="Contraseña actualizada" onClose={onClose}>
        <p className="mb-4 flex gap-2 rounded-xl bg-emerald-50 px-3 py-3 text-sm text-emerald-800">
          <Icon.Check className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Listo. Esta sesión sigue abierta; las demás (otros navegadores o equipos) se cerraron.</span>
        </p>
        <button onClick={onClose} className={primaryBtn}>
          Cerrar
        </button>
      </Modal>
    );
  }

  return (
    <Modal title={forced ? "Cambia tu contraseña" : "Cambiar mi contraseña"} onClose={onClose}>
      {forced && (
        <p className="mb-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
          <Icon.AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            Entraste con una contraseña temporal que te dio el administrador. Elige una nueva que
            solo tú conozcas.
          </span>
        </p>
      )}
      <form onSubmit={save}>
        <label className="mb-1 block text-sm font-medium text-slate-700">Contraseña actual</label>
        <input
          type={show ? "text" : "password"}
          value={actual}
          onChange={(e) => setActual(e.target.value)}
          autoComplete="current-password"
          className={`${inputCls} mb-3`}
        />
        <label className="mb-1 block text-sm font-medium text-slate-700">Nueva contraseña</label>
        <input
          type={show ? "text" : "password"}
          value={nueva}
          onChange={(e) => setNueva(e.target.value)}
          autoComplete="new-password"
          placeholder={`Mínimo ${MIN_LEN} caracteres`}
          className={`${inputCls} mb-3`}
        />
        <label className="mb-1 block text-sm font-medium text-slate-700">Confirma la nueva</label>
        <input
          type={show ? "text" : "password"}
          value={confirmar}
          onChange={(e) => setConfirmar(e.target.value)}
          autoComplete="new-password"
          className={`${inputCls} mb-2`}
        />
        <label className="mb-3 flex items-center gap-2 text-xs text-slate-500">
          <input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} />
          Mostrar contraseñas
        </label>
        <p className="mb-3 text-xs text-slate-400">
          Al cambiarla se cierran tus sesiones en otros navegadores o equipos.
        </p>

        {err && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{err}</p>}

        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={saving || !actual || !nueva || !confirmar} className={primaryBtn}>
            {saving ? "Guardando…" : "Cambiar contraseña"}
          </button>
          <button type="button" onClick={onClose} className={secondaryBtn}>
            {forced ? "Más tarde" : "Cancelar"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
