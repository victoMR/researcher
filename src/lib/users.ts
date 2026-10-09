// Usuarios dados de alta desde la app (tabla app_users) + login combinado con
// los usuarios de variables de entorno (APP_USERS / APP_LOGIN_*, respaldo).
//
// Invalidación: cada usuario de BD tiene session_version; la cookie lleva la
// versión con la que se firmó. Desactivar, cambiar rol o restablecer/cambiar
// la contraseña sube la versión, y las sesiones viejas dejan de valer en
// ≤ 60 s (caché en memoria por instancia, ver getUserState).
import { ensureSchema, getSql, hasDb } from "./db";
import {
  checkEnvCredentials,
  dummyPasswordHash,
  envAdminEmails,
  envUserEmails,
  generatePassword,
  hashPassword,
  isEnvAdmin,
  verifyPassword,
  type Role,
} from "./auth";
import { envMcpTokenEmails, hashMcpToken, newMcpToken } from "./mcp/auth";
import { personName } from "./format";
import type { TeamMember } from "./types";

type Row = Record<string, unknown>;

export const ROLES: Role[] = ["admin", "vendedor"];
export const MIN_PASSWORD_LEN = 12;
const MAX_PASSWORD_LEN = 256;

// Error con mensaje para el usuario y código HTTP.
export class UserError extends Error {
  status: number;
  code?: string;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

// La BD no respondió al validar (login de usuario de BD, sesión, etc.).
export class UserDbError extends Error {
  constructor(cause?: unknown) {
    super("No se pudo consultar la base de datos de usuarios.", { cause });
  }
}

// ---------- Validación ----------

const EMAIL_RE = /^[a-z0-9._+-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/;

export function normalizeEmail(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const e = v.trim().toLowerCase();
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

function cleanName(v: unknown): string {
  if (typeof v !== "string") return "";
  return v
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function parseRole(v: unknown): Role {
  if (typeof v === "string" && (ROLES as string[]).includes(v)) return v as Role;
  throw new UserError(400, "Rol inválido (usa admin o vendedor).");
}

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

// ---------- Estado para validar sesiones (caché por instancia) ----------

export interface UserState {
  email: string;
  name: string;
  role: Role;
  active: boolean;
  version: number;
  mustChangePassword: boolean;
}

const STATE_TTL_MS = 60_000;
const MAX_CACHE = 2000;
const stateCache = new Map<string, { at: number; state: UserState | null }>();
const inflight = new Map<string, Promise<UserState | null>>();

async function fetchUserState(email: string): Promise<UserState | null> {
  try {
    const rows = (await getSql()`
      SELECT email, name, role, active, session_version, must_change_password
      FROM app_users WHERE email = ${email}
    `) as Row[];
    if (!rows.length) return null;
    const r = rows[0];
    return {
      email,
      name: String(r.name ?? ""),
      role: r.role === "admin" ? "admin" : "vendedor",
      active: r.active === true,
      version: Number(r.session_version),
      mustChangePassword: r.must_change_password === true,
    };
  } catch (e) {
    // La tabla aún no existe: no hay usuarios de BD.
    if ((e as { code?: string }).code === "42P01") return null;
    throw new UserDbError(e);
  }
}

/**
 * Estado de un usuario de BD (null si no existe). Usa una caché en memoria de
 * 60 s por instancia para no consultar la BD en cada request; `fresh` la
 * salta. Lanza UserDbError si la BD falla.
 */
export async function getUserState(
  email: string,
  opts: { fresh?: boolean } = {}
): Promise<UserState | null> {
  if (!hasDb()) return null;
  const hit = stateCache.get(email);
  if (!opts.fresh && hit && Date.now() - hit.at < STATE_TTL_MS) return hit.state;
  let p = inflight.get(email);
  if (!p) {
    p = fetchUserState(email)
      .then((state) => {
        if (stateCache.size >= MAX_CACHE) stateCache.clear();
        stateCache.set(email, { at: Date.now(), state });
        return state;
      })
      .finally(() => inflight.delete(email));
    inflight.set(email, p);
  }
  return p;
}

// Tras un cambio en esta instancia: la siguiente consulta va a la BD. (Las
// demás instancias, y el proxy, se enteran al vencer su caché: ≤ 60 s.)
export function invalidateUserState(email: string): void {
  stateCache.delete(email);
}

// ---------- Login (env + BD) ----------

export type LoginResult =
  | { email: string; source: "env" }
  | { email: string; source: "db"; version: number; role: Role; mustChangePassword: boolean };

async function checkDbCredentials(email: string, password: string): Promise<LoginResult | null> {
  if (!hasDb()) return null;
  let row: Row | undefined;
  try {
    await ensureSchema();
    const rows = (await getSql()`
      SELECT password_hash, active, session_version, role, must_change_password
      FROM app_users WHERE email = ${email}
    `) as Row[];
    row = rows[0];
  } catch (e) {
    throw new UserDbError(e);
  }
  // Siempre se calcula un scrypt (contra un hash de relleno si no existe) para
  // que el tiempo de respuesta no delate qué correos existen.
  const ok = await verifyPassword(
    password,
    row ? String(row.password_hash) : await dummyPasswordHash()
  );
  if (!row || !ok || row.active !== true) return null;
  try {
    await getSql()`UPDATE app_users SET last_login_at = now() WHERE email = ${email}`;
  } catch (e) {
    console.error("[users] no se pudo registrar el último acceso", e);
  }
  return {
    email,
    source: "db",
    version: Number(row.session_version),
    role: row.role === "admin" ? "admin" : "vendedor",
    mustChangePassword: row.must_change_password === true,
  };
}

/**
 * Login: usuarios de env (siempre activos, no dependen de la BD) y de la tabla
 * (solo activos). Env tiene prioridad. Si la BD falla y no es usuario de env,
 * lanza UserDbError (la ruta responde 503 con un mensaje claro).
 */
export async function checkCredentials(email: string, password: string): Promise<LoginResult | null> {
  const e = email.trim().toLowerCase();
  const [envOk, db] = await Promise.all([
    checkEnvCredentials(e, password),
    checkDbCredentials(e, password).catch((err: unknown) => {
      if (err instanceof UserDbError) {
        console.error("[users] login: la BD no respondió", err.cause);
        return "db_error" as const;
      }
      throw err;
    }),
  ]);
  if (envOk) return { email: e, source: "env" };
  if (db === "db_error") throw new UserDbError();
  // Un correo de env nunca entra con la fila de la BD (no se pueden duplicar).
  if (db && envUserEmails().has(e)) return null;
  return db;
}

// ---------- Equipo (solo admins) ----------

function dbMember(r: Row): TeamMember {
  const email = String(r.email);
  const envAdmin = isEnvAdmin(email);
  return {
    email,
    name: String(r.name || "") || personName(email),
    role: r.role === "admin" || envAdmin ? "admin" : "vendedor",
    envAdmin,
    active: r.active === true,
    source: "db",
    mustChangePassword: r.must_change_password === true,
    lastLoginAt: iso(r.last_login_at),
    createdAt: iso(r.created_at),
    createdBy: (r.created_by as string) ?? null,
    hasMcpToken: !!r.mcp_token_hash,
    mcpTokenCreatedAt: iso(r.mcp_token_created_at),
  };
}

function envMember(email: string, envTokens: Set<string>): TeamMember {
  const envAdmin = isEnvAdmin(email);
  return {
    email,
    name: personName(email),
    role: envAdmin ? "admin" : "vendedor",
    envAdmin,
    active: true,
    source: "env",
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: null,
    createdBy: null,
    hasMcpToken: envTokens.has(email),
    mcpTokenCreatedAt: null,
  };
}

const MEMBER_COLS = [
  "email",
  "name",
  "role",
  "active",
  "must_change_password",
  "last_login_at",
  "created_at",
  "created_by",
  "mcp_token_hash",
  "mcp_token_created_at",
  "session_version",
];

/** Todos: los de env (solo lectura) y los de la tabla. Admins primero. */
export async function listTeam(): Promise<TeamMember[]> {
  const envEmails = envUserEmails();
  const envTokens = envMcpTokenEmails();
  const out = [...envEmails].map((e) => envMember(e, envTokens));
  if (hasDb()) {
    await ensureSchema();
    const sql = getSql();
    const rows = (await sql`SELECT ${sql(MEMBER_COLS)} FROM app_users`) as Row[];
    for (const r of rows) if (!envEmails.has(String(r.email))) out.push(dbMember(r));
  }
  const rank = (m: TeamMember) => (m.active ? 0 : 2) + (m.role === "admin" ? 0 : 1);
  return out.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name, "es"));
}

function assertNotEnv(email: string) {
  if (envUserEmails().has(email)) {
    throw new UserError(
      409,
      "Este usuario está definido en Vercel (APP_USERS / APP_LOGIN_EMAIL): se edita allá, no desde la app."
    );
  }
}

// Bitácora (tabla events). El usuario afectado va en meta.user y no en
// target_email, que es el historial de contacto con prospectos.
export type UserEventType =
  | "user_created"
  | "user_updated"
  | "password_reset"
  | "password_changed"
  | "mcp_token_created"
  | "mcp_token_revoked";

async function logUserEvent(
  type: UserEventType,
  actor: string,
  user: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  try {
    await getSql()`
      INSERT INTO events (type, actor_email, meta)
      VALUES (${type}, ${actor}, ${JSON.stringify({ user, ...meta })}::jsonb)
    `;
  } catch (e) {
    console.error("[users] no se pudo registrar el evento", type, e);
  }
}

/** Alta: contraseña aleatoria que se devuelve UNA vez y debe cambiarse al entrar. */
export async function createUser(
  input: { email?: unknown; name?: unknown; role?: unknown },
  actor: string
): Promise<{ user: TeamMember; password: string }> {
  const email = normalizeEmail(input.email);
  if (!email) throw new UserError(400, "Correo inválido.");
  assertNotEnv(email);
  const role = parseRole(input.role ?? "vendedor");
  const name = cleanName(input.name) || personName(email);
  const password = generatePassword();
  const hash = await hashPassword(password);
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    INSERT INTO app_users (email, name, role, password_hash, must_change_password, created_by)
    VALUES (${email}, ${name}, ${role}, ${hash}, true, ${actor})
    ON CONFLICT (email) DO NOTHING
    RETURNING ${sql(MEMBER_COLS)}
  `) as Row[];
  if (!rows.length) throw new UserError(409, "Ya existe un usuario con ese correo.");
  invalidateUserState(email);
  await logUserEvent("user_created", actor, email, { role });
  return { user: dbMember(rows[0]), password };
}

export interface UpdateResult {
  user: TeamMember;
  version: number;
  role: Role; // rol guardado en la tabla
  active: boolean;
}

/**
 * Edita nombre, rol o estado. Cambiar rol o desactivar sube session_version
 * (corta sus sesiones). No deja la app sin administradores activos (con el
 * candado FOR UPDATE, dos admins no pueden quitarse el rol a la vez).
 */
export async function updateUser(
  emailRaw: string,
  patch: { name?: unknown; role?: unknown; active?: unknown },
  actor: string
): Promise<UpdateResult> {
  const email = normalizeEmail(emailRaw);
  if (!email) throw new UserError(404, "Usuario no encontrado.");
  assertNotEnv(email);
  const name = patch.name !== undefined ? cleanName(patch.name) : undefined;
  if (name === "") throw new UserError(400, "El nombre no puede ir vacío.");
  const role = patch.role !== undefined ? parseRole(patch.role) : undefined;
  if (patch.active !== undefined && typeof patch.active !== "boolean") {
    throw new UserError(400, "'active' debe ser true o false.");
  }
  const active = patch.active as boolean | undefined;
  if (name === undefined && role === undefined && active === undefined) {
    throw new UserError(400, "Nada que actualizar.");
  }

  await ensureSchema();
  const sql = getSql();
  const { row, changes } = (await sql.begin(async (tx) => {
    const cur = ((await tx`
      SELECT ${tx(MEMBER_COLS)} FROM app_users WHERE email = ${email} FOR UPDATE
    `) as Row[])[0];
    if (!cur) throw new UserError(404, "Usuario no encontrado.");
    const next = {
      name: name ?? String(cur.name),
      role: role ?? (cur.role as Role),
      active: active ?? cur.active === true,
    };
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    if (next.name !== cur.name) changes.name = { from: cur.name, to: next.name };
    if (next.role !== cur.role) changes.role = { from: cur.role, to: next.role };
    if (next.active !== cur.active) changes.active = { from: cur.active, to: next.active };
    if (!Object.keys(changes).length) return { row: cur, changes };

    // ¿Pierde el rol de admin? Debe quedar otro admin activo.
    const envAdmin = isEnvAdmin(email);
    const wasAdmin = cur.active === true && (cur.role === "admin" || envAdmin);
    const willBeAdmin = next.active && (next.role === "admin" || envAdmin);
    if (wasAdmin && !willBeAdmin) {
      const envOthers = [...envUserEmails()].filter((e) => e !== email && isEnvAdmin(e));
      const others = envOthers.length
        ? []
        : ((await tx`
            SELECT email FROM app_users
            WHERE active AND email <> ${email}
              AND (role = 'admin' OR email = ANY(${[...envAdminEmails()]}::text[]))
            FOR UPDATE
          `) as Row[]);
      if (!envOthers.length && !others.length) {
        throw new UserError(
          409,
          email === actor
            ? "Eres el último administrador activo: nombra a otro admin antes de quitarte el rol o desactivarte."
            : "No se puede: la app se quedaría sin administradores activos.",
          "last_admin"
        );
      }
    }

    const bump = changes.role || changes.active ? 1 : 0;
    const updated = ((await tx`
      UPDATE app_users
      SET name = ${next.name}, role = ${next.role}, active = ${next.active},
          session_version = session_version + ${bump}::int, updated_at = now()
      WHERE email = ${email}
      RETURNING ${tx(MEMBER_COLS)}
    `) as Row[])[0];
    return { row: updated, changes };
  })) as { row: Row; changes: Record<string, unknown> };

  invalidateUserState(email);
  if (Object.keys(changes).length) await logUserEvent("user_updated", actor, email, { changes });
  return {
    user: dbMember(row),
    version: Number(row.session_version),
    role: row.role === "admin" ? "admin" : "vendedor",
    active: row.active === true,
  };
}

/** Restablece la contraseña (la devuelve UNA vez) y corta sus sesiones. */
export async function resetPassword(
  emailRaw: string,
  actor: string
): Promise<UpdateResult & { password: string }> {
  const email = normalizeEmail(emailRaw);
  if (!email) throw new UserError(404, "Usuario no encontrado.");
  assertNotEnv(email);
  const password = generatePassword();
  const hash = await hashPassword(password);
  await ensureSchema();
  const sql = getSql();
  const rows = (await sql`
    UPDATE app_users
    SET password_hash = ${hash}, must_change_password = true,
        session_version = session_version + 1, updated_at = now()
    WHERE email = ${email}
    RETURNING ${sql(MEMBER_COLS)}
  `) as Row[];
  if (!rows.length) throw new UserError(404, "Usuario no encontrado.");
  invalidateUserState(email);
  await logUserEvent("password_reset", actor, email);
  const row = rows[0];
  return {
    user: dbMember(row),
    version: Number(row.session_version),
    role: row.role === "admin" ? "admin" : "vendedor",
    active: row.active === true,
    password,
  };
}

/**
 * Autoservicio: cambia la propia contraseña (usuarios de BD). Sube
 * session_version (cierra las otras sesiones); la ruta reemite la cookie.
 * Lanza UserError con code "wrong_password" si la actual no coincide.
 */
export async function changeOwnPassword(
  email: string,
  actual: string,
  nueva: string
): Promise<{ version: number; role: Role }> {
  if (nueva.length < MIN_PASSWORD_LEN) {
    throw new UserError(400, `La nueva contraseña debe tener al menos ${MIN_PASSWORD_LEN} caracteres.`);
  }
  if (nueva.length > MAX_PASSWORD_LEN || actual.length > 1024) {
    throw new UserError(400, "Contraseña demasiado larga.");
  }
  if (nueva === actual) {
    throw new UserError(400, "La nueva contraseña debe ser distinta de la actual.");
  }
  await ensureSchema();
  const sql = getSql();
  const row = ((await sql`
    SELECT password_hash, active FROM app_users WHERE email = ${email}
  `) as Row[])[0];
  if (!row || row.active !== true) throw new UserError(403, "Tu usuario no está activo.");
  if (!(await verifyPassword(actual, String(row.password_hash)))) {
    throw new UserError(400, "Tu contraseña actual no es correcta.", "wrong_password");
  }
  const hash = await hashPassword(nueva);
  const updated = ((await sql`
    UPDATE app_users
    SET password_hash = ${hash}, must_change_password = false,
        session_version = session_version + 1, updated_at = now()
    WHERE email = ${email} AND active
    RETURNING session_version, role
  `) as Row[])[0];
  if (!updated) throw new UserError(403, "Tu usuario no está activo.");
  invalidateUserState(email);
  await logUserEvent("password_changed", email, email);
  return {
    version: Number(updated.session_version),
    role: updated.role === "admin" ? "admin" : "vendedor",
  };
}

/** Genera (o reemplaza) el token MCP; se guarda solo su sha256 y se devuelve UNA vez. */
export async function createMcpToken(
  emailRaw: string,
  actor: string
): Promise<{ token: string; user: TeamMember }> {
  const email = normalizeEmail(emailRaw);
  if (!email) throw new UserError(404, "Usuario no encontrado.");
  if (envUserEmails().has(email)) {
    throw new UserError(
      409,
      "Este usuario está definido en Vercel: su token MCP va en la variable MCP_TOKENS."
    );
  }
  await ensureSchema();
  const sql = getSql();
  const cur = ((await sql`
    SELECT active, mcp_token_hash FROM app_users WHERE email = ${email}
  `) as Row[])[0];
  if (!cur) throw new UserError(404, "Usuario no encontrado.");
  if (cur.active !== true) {
    throw new UserError(409, "El usuario está desactivado: reactívalo antes de generar un token.");
  }
  const token = newMcpToken();
  const rows = (await sql`
    UPDATE app_users
    SET mcp_token_hash = ${hashMcpToken(token)}, mcp_token_created_at = now(), updated_at = now()
    WHERE email = ${email} AND active
    RETURNING ${sql(MEMBER_COLS)}
  `) as Row[];
  if (!rows.length) throw new UserError(409, "El usuario está desactivado.");
  await logUserEvent("mcp_token_created", actor, email, { replaced: !!cur.mcp_token_hash });
  return { token, user: dbMember(rows[0]) };
}

/** Revoca el token MCP (deja de valer de inmediato: no hay caché de tokens). */
export async function revokeMcpToken(
  emailRaw: string,
  actor: string
): Promise<{ revoked: boolean; user: TeamMember }> {
  const email = normalizeEmail(emailRaw);
  if (!email) throw new UserError(404, "Usuario no encontrado.");
  assertNotEnv(email);
  await ensureSchema();
  const sql = getSql();
  const prev = ((await sql`
    SELECT mcp_token_hash FROM app_users WHERE email = ${email}
  `) as Row[])[0];
  if (!prev) throw new UserError(404, "Usuario no encontrado.");
  const rows = (await sql`
    UPDATE app_users
    SET mcp_token_hash = NULL, mcp_token_created_at = NULL, updated_at = now()
    WHERE email = ${email}
    RETURNING ${sql(MEMBER_COLS)}
  `) as Row[];
  const revoked = !!prev.mcp_token_hash;
  if (revoked) await logUserEvent("mcp_token_revoked", actor, email);
  return { revoked, user: dbMember(rows[0]) };
}
