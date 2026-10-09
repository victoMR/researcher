// Utilidades HTTP de /api/users y /api/auth/password.
import { NextResponse, type NextRequest } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions, signSession, type Role } from "./auth";
import { sessionUser, type SessionUser } from "./session";
import { UserError } from "./users";

// Las respuestas con contraseñas o tokens no se guardan en ninguna caché.
export const NO_STORE = { "Cache-Control": "no-store" };

export function jsonError(error: string, status: number): NextResponse {
  return NextResponse.json({ error }, { status, headers: NO_STORE });
}

export function noDb(): NextResponse {
  return jsonError(
    "Sin base de datos (falta DATABASE_URL): los usuarios solo se pueden definir en Vercel (APP_USERS).",
    503
  );
}

// Admin logueado, o la respuesta 401/403 lista para devolver.
export async function requireAdmin(req: NextRequest): Promise<SessionUser | NextResponse> {
  const me = await sessionUser(req);
  if (!me) return jsonError("No autorizado.", 401);
  if (!me.isAdmin) return jsonError("Solo un administrador puede administrar el equipo.", 403);
  return me;
}

export function errorResponse(e: unknown, context: string): NextResponse {
  if (e instanceof UserError) return jsonError(e.message, e.status);
  console.error(context, e);
  return jsonError("Error del servidor. Intenta de nuevo.", 500);
}

// Correo del segmento [email] (llega codificado: "%40" en vez de "@").
export async function paramEmail(params: Promise<{ email: string }>): Promise<string> {
  const raw = (await params).email ?? "";
  try {
    return decodeURIComponent(raw).trim().toLowerCase();
  } catch {
    return raw.trim().toLowerCase();
  }
}

// Reemite la cookie de un usuario de BD con su nueva session_version (para no
// cerrar la sesión de quien hizo el cambio sobre sí mismo).
export async function setDbSessionCookie(
  res: NextResponse,
  claims: { email: string; v: number; role: Role }
): Promise<void> {
  const token = await signSession({ ...claims, src: "db" });
  res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
}
