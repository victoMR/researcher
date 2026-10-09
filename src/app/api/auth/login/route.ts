import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_SECRET_ERROR,
  authConfigured,
  sessionCookieOptions,
  signSession,
  SESSION_COOKIE,
} from "@/lib/auth";
import {
  checkLoginLimit,
  clientIp,
  recordLoginAttempt,
  tooManyAttemptsMessage,
} from "@/lib/rate-limit";
import { UserDbError, checkCredentials } from "@/lib/users";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json().catch(() => null)) as {
      email?: unknown;
      password?: unknown;
    } | null;
    const { email, password } = body ?? {};
    if (typeof email !== "string" || typeof password !== "string" || !email.trim() || !password) {
      return NextResponse.json({ error: "Faltan datos." }, { status: 400 });
    }
    if (email.length > 254 || password.length > 1024) {
      return NextResponse.json({ error: "Datos inválidos." }, { status: 400 });
    }

    // Sin AUTH_SECRET válido en producción no se puede firmar la sesión.
    if (!authConfigured()) {
      return NextResponse.json({ error: AUTH_SECRET_ERROR }, { status: 500 });
    }

    const normEmail = email.trim().toLowerCase();
    const ip = clientIp(req);

    // Límite de intentos fallidos por correo y por IP.
    const limit = await checkLoginLimit(normEmail, ip);
    if (limit.blocked) {
      return NextResponse.json(
        { error: tooManyAttemptsMessage(limit.retryAfterSec) },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } }
      );
    }

    // Usuarios de env (respaldo, no dependen de la BD) y de la tabla app_users.
    let user: Awaited<ReturnType<typeof checkCredentials>>;
    try {
      user = await checkCredentials(normEmail, password);
    } catch (err) {
      if (err instanceof UserDbError) {
        return NextResponse.json(
          {
            error:
              "No se pudo verificar tu usuario: la base de datos no responde. Intenta de nuevo en un momento.",
          },
          { status: 503 }
        );
      }
      throw err;
    }
    await recordLoginAttempt(normEmail, ip, !!user);
    if (!user) {
      return NextResponse.json(
        { error: "Correo o contraseña incorrectos." },
        { status: 401 }
      );
    }

    const token =
      user.source === "db"
        ? await signSession({ email: user.email, src: "db", v: user.version, role: user.role })
        : await signSession({ email: user.email, src: "env" });
    const res = NextResponse.json({
      ok: true,
      mustChangePassword: user.source === "db" && user.mustChangePassword,
    });
    res.cookies.set(SESSION_COOKIE, token, sessionCookieOptions());
    return res;
  } catch (err) {
    console.error("login error", err);
    return NextResponse.json({ error: "Error al iniciar sesión." }, { status: 500 });
  }
}
