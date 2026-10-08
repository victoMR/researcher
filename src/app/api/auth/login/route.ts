import { NextRequest, NextResponse } from "next/server";
import {
  AUTH_SECRET_ERROR,
  authConfigured,
  checkCredentials,
  signSession,
  SESSION_COOKIE,
} from "@/lib/auth";
import {
  checkLoginLimit,
  clientIp,
  recordLoginAttempt,
  tooManyAttemptsMessage,
} from "@/lib/rate-limit";

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

    const ok = await checkCredentials(normEmail, password);
    await recordLoginAttempt(normEmail, ip, ok);
    if (!ok) {
      return NextResponse.json(
        { error: "Correo o contraseña incorrectos." },
        { status: 401 }
      );
    }

    const token = await signSession(normEmail);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 7 * 86400,
    });
    return res;
  } catch (err) {
    console.error("login error", err);
    return NextResponse.json({ error: "Error al iniciar sesión." }, { status: 500 });
  }
}
