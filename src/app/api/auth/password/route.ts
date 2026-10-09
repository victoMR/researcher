import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import {
  checkLoginLimit,
  clientIp,
  recordLoginAttempt,
  tooManyAttemptsMessage,
} from "@/lib/rate-limit";
import { SESSION_DB_ERROR, checkSessionToken } from "@/lib/session";
import { SESSION_COOKIE } from "@/lib/auth";
import { UserError, changeOwnPassword } from "@/lib/users";
import { NO_STORE, errorResponse, jsonError, noDb, setDbSessionCookie } from "@/lib/users-api";

export const runtime = "nodejs";

// Cambiar mi contraseña: { actual, nueva } (usuarios dados de alta en la app).
// Cierra las demás sesiones (sube session_version) y reemite la cookie de esta.
// Los fallos de "actual" cuentan para el límite de intentos del login.
export async function POST(req: NextRequest) {
  const check = await checkSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!check.ok) {
    return check.reason === "db_error"
      ? jsonError(SESSION_DB_ERROR, 503)
      : jsonError("No autorizado.", 401);
  }
  const me = check.user;
  if (me.source === "env") {
    return jsonError(
      "Tu contraseña se administra en Vercel (variables de entorno): pídele al administrador que la cambie.",
      400
    );
  }
  if (!hasDb()) return noDb();

  const body = ((await req.json().catch(() => null)) ?? {}) as { actual?: unknown; nueva?: unknown };
  const { actual, nueva } = body;
  if (typeof actual !== "string" || typeof nueva !== "string" || !actual || !nueva) {
    return jsonError("Escribe tu contraseña actual y la nueva.", 400);
  }

  const ip = clientIp(req);
  const limit = await checkLoginLimit(me.email, ip);
  if (limit.blocked) {
    return NextResponse.json(
      { error: tooManyAttemptsMessage(limit.retryAfterSec) },
      { status: 429, headers: { ...NO_STORE, "Retry-After": String(limit.retryAfterSec) } }
    );
  }

  try {
    const r = await changeOwnPassword(me.email, actual, nueva);
    await recordLoginAttempt(me.email, ip, true);
    const res = NextResponse.json({ ok: true }, { headers: NO_STORE });
    await setDbSessionCookie(res, { email: me.email, v: r.version, role: r.role });
    return res;
  } catch (e) {
    if (e instanceof UserError && e.code === "wrong_password") {
      await recordLoginAttempt(me.email, ip, false);
    }
    return errorResponse(e, "auth password POST");
  }
}
