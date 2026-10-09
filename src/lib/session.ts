// Validación de la sesión (cookie) para el proxy y los route handlers.
//
// - Usuarios de env (APP_USERS / APP_LOGIN_*): basta la firma y que el correo
//   siga en las variables. No dependen de la BD (si la BD cae, siguen entrando).
// - Usuarios de BD (tabla app_users): además, el usuario debe estar activo y su
//   session_version debe ser la de la cookie. Se lee con caché de 60 s por
//   instancia (users.ts getUserState). Si la BD falla: FALLA CERRADA (no se
//   puede saber si lo desactivaron) y se responde con un mensaje claro.
//
// El rol de admin se resuelve aquí (APP_ADMINS o role 'admin' en la tabla),
// con el mismo estado fresco (≤ 60 s): cambiar el rol sube session_version.
import { SESSION_COOKIE, envUserEmails, isEnvAdmin, verifySession, type Role, type Session, type UserSource } from "./auth";
import { getUserState, type UserState } from "./users";

export interface SessionUser {
  email: string;
  name: string;
  role: Role; // efectivo (incluye APP_ADMINS)
  isAdmin: boolean;
  source: UserSource;
  mustChangePassword: boolean;
}

export type SessionCheck =
  | { ok: true; user: SessionUser; session: Session }
  | { ok: false; reason: "none" | "invalid" | "db_error" };

export const SESSION_DB_ERROR =
  "No se pudo verificar tu sesión: la base de datos no responde. Intenta de nuevo en un momento.";

// Valida el token de la cookie (firma, expiración y estado del usuario).
export async function checkSessionToken(token: string | null | undefined): Promise<SessionCheck> {
  if (!token) return { ok: false, reason: "none" };
  const session = await verifySession(token);
  if (!session?.email) return { ok: false, reason: "invalid" };
  const email = session.email.toLowerCase();

  // Usuario de env (las cookies anteriores a la tabla de usuarios no traen `src`).
  if (session.src !== "db") {
    if (!envUserEmails().has(email)) return { ok: false, reason: "invalid" };
    const admin = isEnvAdmin(email);
    return {
      ok: true,
      session,
      user: {
        email,
        name: displayName(email),
        role: admin ? "admin" : "vendedor",
        isAdmin: admin,
        source: "env",
        mustChangePassword: false,
      },
    };
  }

  // Usuario de BD.
  if (typeof session.v !== "number") return { ok: false, reason: "invalid" };
  let st: UserState | null;
  try {
    st = await getUserState(email);
    // Cookie más nueva que la caché (p. ej. reemitida al cambiar la contraseña
    // en otra instancia): se consulta la BD sin caché.
    if (!st || st.version < session.v) st = await getUserState(email, { fresh: true });
  } catch (err) {
    console.error("[session] no se pudo validar el usuario en la BD", err);
    return { ok: false, reason: "db_error" };
  }
  if (!st || !st.active || st.version !== session.v) return { ok: false, reason: "invalid" };
  const admin = st.role === "admin" || isEnvAdmin(email);
  return {
    ok: true,
    session,
    user: {
      email,
      name: st.name || displayName(email),
      role: admin ? "admin" : "vendedor",
      isAdmin: admin,
      source: "db",
      mustChangePassword: st.mustChangePassword,
    },
  };
}

type WithCookies = { cookies: { get(name: string): { value: string } | undefined } };

// Usuario logueado (validado) según la cookie, o null.
export async function sessionUser(req: WithCookies): Promise<SessionUser | null> {
  const r = await checkSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  return r.ok ? r.user : null;
}

// Correo (en minúsculas) del usuario logueado según la cookie, o null.
export async function sessionEmail(req: WithCookies): Promise<string | null> {
  return (await sessionUser(req))?.email ?? null;
}

// "aldo.perez@ialeadshield.com.mx" -> "Aldo Perez"
export function displayName(email: string): string {
  return email
    .split("@")[0]
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}
