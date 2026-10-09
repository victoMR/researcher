"use client";

import { useEffect, useState } from "react";
import type { Me, TeamMember } from "@/lib/types";
import { shortDate, timeAgo } from "@/lib/format";
import { Segmented } from "@/components/ui";
import { CopyField, Modal, inputCls, primaryBtn, secondaryBtn } from "@/components/Modal";
import { initials } from "@/components/UserMenu";
import * as Icon from "@/components/icons";

type Role = TeamMember["role"];

// Contraseña o token que se muestra UNA sola vez.
interface Secret {
  title: string;
  intro: string;
  label: string;
  value: string;
  command?: string;
}

interface ListResponse {
  users?: TeamMember[];
  dbAvailable?: boolean;
  error?: string;
}

async function fetchTeam(): Promise<ListResponse> {
  try {
    const res = await fetch("/api/users", { cache: "no-store" });
    const data = (await res.json().catch(() => ({}))) as ListResponse;
    return res.ok ? data : { error: data.error || "No se pudo cargar el equipo." };
  } catch {
    return { error: "Error de red al cargar el equipo." };
  }
}

// Llamada JSON a /api/users/...; devuelve los datos o { error }.
async function call<T>(
  url: string,
  method: string,
  body?: unknown
): Promise<(T & { error?: undefined }) | { error: string }> {
  try {
    const res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { error: data.error || "No se pudo completar la acción." };
    return data as T & { error?: undefined };
  } catch {
    return { error: "Error de red. Intenta de nuevo." };
  }
}

const userUrl = (email: string, rest = "") => `/api/users/${encodeURIComponent(email)}${rest}`;

const chip = "rounded-full px-2 py-0.5 text-[11px] font-medium";
const actionBtn =
  "rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50";
const dangerBtn =
  "rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-rose-600 hover:bg-rose-50 disabled:opacity-50";

// Pestaña Equipo (solo admins): alta de vendedores, roles, accesos y tokens MCP.
export default function Team({ me, onSelfChanged }: { me: Me | null; onSelfChanged: () => void }) {
  const [users, setUsers] = useState<TeamMember[]>([]);
  const [dbAvailable, setDbAvailable] = useState(true);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<TeamMember | null>(null);
  const [secret, setSecret] = useState<Secret | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  function apply(d: ListResponse) {
    if (d.error) setError(d.error);
    else {
      setError(null);
      setUsers(d.users ?? []);
      setDbAvailable(d.dbAvailable !== false);
    }
    setLoading(false);
  }
  const reload = () => fetchTeam().then(apply);
  // Carga inicial: el setState va en el callback de la promesa.
  useEffect(() => {
    fetchTeam().then((d) => {
      if (d.error) setError(d.error);
      else {
        setUsers(d.users ?? []);
        setDbAvailable(d.dbAvailable !== false);
      }
      setLoading(false);
    });
  }, []);

  // Reemplaza una fila con lo que devolvió el servidor.
  const replace = (u: TeamMember) => setUsers((list) => list.map((x) => (x.email === u.email ? u : x)));

  async function run<T extends { user?: TeamMember }>(
    u: TeamMember,
    fn: () => Promise<(T & { error?: undefined }) | { error: string }>
  ): Promise<T | null> {
    setBusy(u.email);
    const r = await fn();
    setBusy(null);
    if (r.error !== undefined) {
      alert(r.error);
      return null;
    }
    const ok = r as T;
    if (ok.user) replace(ok.user);
    return ok;
  }

  async function toggleActive(u: TeamMember) {
    const msg = u.active
      ? `¿Desactivar a ${u.name}? No podrá entrar, sus sesiones abiertas se cerrarán en menos de un minuto y su token MCP dejará de funcionar.`
      : `¿Reactivar a ${u.name}? Podrá entrar de nuevo con su contraseña actual.`;
    if (!confirm(msg)) return;
    const r = await run<{ user: TeamMember; loggedOut?: boolean }>(u, () =>
      call(userUrl(u.email), "PATCH", { active: !u.active })
    );
    // Te desactivaste: recarga completa al login (como al cerrar sesión).
    // eslint-disable-next-line @next/next/no-location-assign-relative-destination
    if (r?.loggedOut) window.location.href = "/login";
    else if (r && u.email === me?.email) onSelfChanged();
  }

  async function resetPassword(u: TeamMember) {
    if (
      !confirm(
        `¿Restablecer la contraseña de ${u.name}? La actual dejará de servir y sus sesiones abiertas se cerrarán. Se generará una temporal que deberá cambiar al entrar.`
      )
    )
      return;
    const r = await run<{ user: TeamMember; password: string }>(u, () =>
      call(userUrl(u.email, "/password"), "POST")
    );
    if (r)
      setSecret({
        title: "Contraseña restablecida",
        intro: `Nueva contraseña temporal de ${u.name} (${u.email}). Al entrar se le pedirá cambiarla.`,
        label: "Contraseña temporal",
        value: r.password,
      });
  }

  async function newToken(u: TeamMember) {
    if (
      u.hasMcpToken &&
      !confirm(`${u.name} ya tiene un token MCP. ¿Generar uno nuevo? El actual dejará de funcionar de inmediato.`)
    )
      return;
    const r = await run<{ user: TeamMember; token: string; command: string }>(u, () =>
      call(userUrl(u.email, "/mcp-token"), "POST")
    );
    if (r)
      setSecret({
        title: "Token MCP generado",
        intro: `Token para que ${u.name} conecte Claude Code con la app. Que lo corra en su terminal; el token queda solo en su equipo.`,
        label: "Token",
        value: r.token,
        command: r.command,
      });
  }

  async function revokeToken(u: TeamMember) {
    if (!confirm(`¿Revocar el token MCP de ${u.name}? Claude dejará de poder usar la app con ese token.`)) return;
    await run<{ user: TeamMember }>(u, () => call(userUrl(u.email, "/mcp-token"), "DELETE"));
  }

  const admins = users.filter((u) => u.active && u.role === "admin").length;

  return (
    <div>
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-slate-900">Equipo</h2>
          <p className="text-sm text-slate-500">
            Da de alta vendedores y administra sus accesos y tokens de Claude (MCP).
          </p>
        </div>
        <button
          onClick={() => setAdding(true)}
          disabled={!dbAvailable}
          title={dbAvailable ? undefined : "Requiere la base de datos (DATABASE_URL)"}
          className="flex items-center gap-1.5 rounded-full bg-indigo-600 px-4 py-2 text-sm font-semibold text-white shadow-apple-sm transition hover:bg-indigo-700 active:scale-[0.98] disabled:opacity-50"
        >
          <Icon.Plus className="h-4 w-4" /> Agregar vendedor
        </button>
      </div>

      {!dbAvailable && (
        <p className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          Sin base de datos (falta <code>DATABASE_URL</code>): solo se ven los usuarios definidos en
          Vercel y no se pueden agregar nuevos.
        </p>
      )}
      {error && (
        <p className="mb-4 flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>{error}</span>
          <button onClick={reload} className="shrink-0 font-semibold underline">
            Reintentar
          </button>
        </p>
      )}

      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-20 animate-pulse rounded-2xl bg-white" />
          ))}
        </div>
      ) : (
        <ul className="space-y-2">
          {users.map((u) => {
            const isMe = u.email === me?.email;
            const isBusy = busy === u.email;
            return (
              <li
                key={u.email}
                className={`flex flex-col gap-3 rounded-2xl border border-black/5 bg-white p-4 shadow-apple-sm sm:flex-row sm:items-center ${
                  u.active ? "" : "opacity-70"
                }`}
              >
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span
                    className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-sm font-semibold ${
                      u.role === "admin" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"
                    }`}
                  >
                    {initials(u.name)}
                  </span>
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="truncate font-semibold text-slate-900">{u.name}</span>
                      {isMe && <span className="text-xs text-slate-400">(tú)</span>}
                      <span
                        className={`${chip} ${
                          u.role === "admin" ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"
                        }`}
                        title={u.envAdmin ? "Admin por APP_ADMINS en Vercel" : undefined}
                      >
                        {u.role === "admin" ? "Admin" : "Vendedor"}
                      </span>
                      <span
                        className={`${chip} ${
                          u.active ? "bg-emerald-50 text-emerald-700" : "bg-rose-50 text-rose-700"
                        }`}
                      >
                        {u.active ? "Activo" : "Desactivado"}
                      </span>
                      {u.mustChangePassword && u.active && (
                        <span className={`${chip} bg-amber-50 text-amber-700`}>Contraseña temporal</span>
                      )}
                      {u.source === "env" && (
                        <span
                          className={`${chip} flex items-center gap-1 bg-slate-100 text-slate-500`}
                          title="Definido en las variables de entorno de Vercel (APP_USERS / APP_LOGIN_EMAIL): se edita allá"
                        >
                          <Icon.Lock className="h-3 w-3" /> Definido en Vercel
                        </span>
                      )}
                    </div>
                    <p className="truncate text-sm text-slate-500">{u.email}</p>
                    <p className="mt-0.5 flex flex-wrap gap-x-3 text-xs text-slate-400">
                      <span>
                        Último acceso:{" "}
                        {u.lastLoginAt ? (
                          <span title={shortDate(u.lastLoginAt)}>{timeAgo(u.lastLoginAt)}</span>
                        ) : u.source === "env" ? (
                          "—"
                        ) : (
                          "nunca"
                        )}
                      </span>
                      <span>
                        MCP:{" "}
                        {u.hasMcpToken
                          ? u.mcpTokenCreatedAt
                            ? `token desde ${shortDate(u.mcpTokenCreatedAt)}`
                            : "token en MCP_TOKENS"
                          : "sin token"}
                      </span>
                    </p>
                  </div>
                </div>

                {u.source === "env" ? (
                  <p className="text-xs text-slate-400 sm:max-w-[13rem] sm:text-right">
                    Se administra en Vercel (variables de entorno).
                  </p>
                ) : (
                  <div className="flex flex-wrap gap-1.5 sm:max-w-[22rem] sm:justify-end">
                    {isBusy && <Icon.Loader className="h-4 w-4 self-center text-slate-400" />}
                    <button onClick={() => setEditing(u)} disabled={isBusy} className={actionBtn}>
                      Editar
                    </button>
                    {u.active && (
                      <button onClick={() => resetPassword(u)} disabled={isBusy} className={actionBtn}>
                        Restablecer contraseña
                      </button>
                    )}
                    {u.active && (
                      <button onClick={() => newToken(u)} disabled={isBusy} className={actionBtn}>
                        {u.hasMcpToken ? "Nuevo token MCP" : "Generar token MCP"}
                      </button>
                    )}
                    {u.hasMcpToken && (
                      <button onClick={() => revokeToken(u)} disabled={isBusy} className={dangerBtn}>
                        Revocar token
                      </button>
                    )}
                    <button
                      onClick={() => toggleActive(u)}
                      disabled={isBusy}
                      className={u.active ? dangerBtn : actionBtn}
                    >
                      {u.active ? "Desactivar" : "Reactivar"}
                    </button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      {!loading && !error && (
        <p className="mt-4 text-xs text-slate-400">
          {admins} admin{admins === 1 ? "" : "s"} activo{admins === 1 ? "" : "s"}. Desactivar, cambiar el
          rol o restablecer la contraseña cierra las sesiones de esa persona en menos de un minuto.
        </p>
      )}

      {adding && (
        <AddUserModal
          onClose={() => setAdding(false)}
          onCreated={(u, password) => {
            setAdding(false);
            setUsers((list) => [...list, u]);
            setSecret({
              title: "Vendedor agregado",
              intro: `Contraseña temporal de ${u.name} (${u.email}). Entrégasela por un canal privado; al entrar se le pedirá cambiarla.`,
              label: "Contraseña temporal",
              value: password,
            });
          }}
        />
      )}
      {editing && (
        <EditUserModal
          user={editing}
          isMe={editing.email === me?.email}
          onClose={() => setEditing(null)}
          onSaved={(u, loggedOut) => {
            setEditing(null);
            replace(u);
            // eslint-disable-next-line @next/next/no-location-assign-relative-destination
            if (loggedOut) window.location.href = "/login";
            else if (u.email === me?.email) onSelfChanged();
          }}
        />
      )}
      {secret && <SecretModal secret={secret} onClose={() => setSecret(null)} />}
    </div>
  );
}

const ROLE_OPTS: { value: Role; label: React.ReactNode }[] = [
  { value: "vendedor", label: "Vendedor" },
  { value: "admin", label: "Administrador" },
];

function AddUserModal({
  onClose,
  onCreated,
}: {
  onClose: () => void;
  onCreated: (u: TeamMember, password: string) => void;
}) {
  const [email, setEmail] = useState("");
  const [name, setName] = useState("");
  const [role, setRole] = useState<Role>("vendedor");
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setErr(null);
    const r = await call<{ user: TeamMember; password: string }>("/api/users", "POST", { email, name, role });
    setSaving(false);
    if (r.error !== undefined) setErr(r.error);
    else onCreated(r.user, r.password);
  }

  return (
    <Modal title="Agregar vendedor" onClose={onClose}>
      <form onSubmit={save}>
        <label className="mb-1 block text-sm font-medium text-slate-700">Correo</label>
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="nombre@ialeadshield.com.mx"
          autoComplete="off"
          autoFocus
          className={`${inputCls} mb-3`}
        />
        <label className="mb-1 block text-sm font-medium text-slate-700">Nombre</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Ej. María López"
          maxLength={80}
          className={`${inputCls} mb-3`}
        />
        <span className="mb-1 block text-sm font-medium text-slate-700">Rol</span>
        <div className="mb-2 w-fit">
          <Segmented<Role> value={role} onChange={setRole} options={ROLE_OPTS} />
        </div>
        <p className="mb-4 text-xs text-slate-400">
          {role === "admin"
            ? "Un administrador ve la pestaña Equipo, reasigna prospectos y quita BAJAS."
            : "Un vendedor trabaja sus prospectos, investiga y envía correos."}{" "}
          Se generará una contraseña temporal que se mostrará una sola vez.
        </p>
        {err && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={saving || !email.trim()} className={primaryBtn}>
            {saving ? "Creando…" : "Crear y generar contraseña"}
          </button>
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}

function EditUserModal({
  user,
  isMe,
  onClose,
  onSaved,
}: {
  user: TeamMember;
  isMe: boolean;
  onClose: () => void;
  onSaved: (u: TeamMember, loggedOut: boolean) => void;
}) {
  const [name, setName] = useState(user.name);
  const [role, setRole] = useState<Role>(user.envAdmin ? "admin" : user.role);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    const patch: { name?: string; role?: Role } = {};
    if (name.trim() !== user.name) patch.name = name.trim();
    if (!user.envAdmin && role !== user.role) patch.role = role;
    if (!Object.keys(patch).length) return onClose();
    if (patch.role) {
      const msg = isMe
        ? "Te quitarás el rol de administrador y dejarás de ver Equipo. ¿Continuar?"
        : `¿Cambiar el rol de ${user.name} a ${role === "admin" ? "administrador" : "vendedor"}? Sus sesiones abiertas se cerrarán y tendrá que volver a entrar.`;
      if (!confirm(msg)) return;
    }
    setSaving(true);
    setErr(null);
    const r = await call<{ user: TeamMember; loggedOut?: boolean }>(userUrl(user.email), "PATCH", patch);
    setSaving(false);
    if (r.error !== undefined) setErr(r.error);
    else onSaved(r.user, !!r.loggedOut);
  }

  return (
    <Modal title={`Editar — ${user.name}`} onClose={onClose}>
      <form onSubmit={save}>
        <p className="mb-3 text-sm text-slate-500">{user.email}</p>
        <label className="mb-1 block text-sm font-medium text-slate-700">Nombre</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={80}
          className={`${inputCls} mb-3`}
        />
        <span className="mb-1 block text-sm font-medium text-slate-700">Rol</span>
        {user.envAdmin ? (
          <p className="mb-4 rounded-xl bg-slate-50 px-3 py-2 text-xs text-slate-500">
            Es administrador por <code>APP_ADMINS</code> en Vercel; ese rol no se quita desde la app.
          </p>
        ) : (
          <div className="mb-4 w-fit">
            <Segmented<Role> value={role} onChange={setRole} options={ROLE_OPTS} />
          </div>
        )}
        {err && <p className="mb-3 rounded-lg bg-amber-50 px-3 py-2 text-sm text-amber-800">{err}</p>}
        <div className="flex flex-wrap gap-2">
          <button type="submit" disabled={saving || !name.trim()} className={primaryBtn}>
            {saving ? "Guardando…" : "Guardar"}
          </button>
          <button type="button" onClick={onClose} className={secondaryBtn}>
            Cancelar
          </button>
        </div>
      </form>
    </Modal>
  );
}

// Muestra una contraseña o token UNA vez. No se cierra con clic fuera ni Esc.
function SecretModal({ secret, onClose }: { secret: Secret; onClose: () => void }) {
  return (
    <Modal title={secret.title} onClose={onClose} dismissable={false} size={secret.command ? "lg" : "md"}>
      <p className="mb-3 text-sm text-slate-600">{secret.intro}</p>
      <CopyField label={secret.label} value={secret.value} />
      {secret.command && (
        <CopyField label="Comando para Claude Code" value={secret.command} multiline />
      )}
      <p className="mb-4 flex gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2.5 text-sm text-amber-800">
        <Icon.AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span>
          <b>No se volverá a mostrar.</b> Cópialo ahora y compártelo solo por un canal privado (no por
          correo ni chats de grupo).
        </span>
      </p>
      <button onClick={onClose} className={primaryBtn}>
        Listo, ya lo copié
      </button>
    </Modal>
  );
}
