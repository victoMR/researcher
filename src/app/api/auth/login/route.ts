import { NextRequest, NextResponse } from "next/server";
import { checkCredentials, signSession, SESSION_COOKIE } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST(req: NextRequest) {
  try {
    const { email, password } = (await req.json()) as {
      email?: string;
      password?: string;
    };
    if (!email || !password) {
      return NextResponse.json({ error: "Faltan datos." }, { status: 400 });
    }
    if (!checkCredentials(email, password)) {
      return NextResponse.json(
        { error: "Correo o contraseña incorrectos." },
        { status: 401 }
      );
    }
    const token = await signSession(email);
    const res = NextResponse.json({ ok: true });
    res.cookies.set(SESSION_COOKIE, token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 7 * 86400,
    });
    return res;
  } catch {
    return NextResponse.json({ error: "Error al iniciar sesión." }, { status: 500 });
  }
}
