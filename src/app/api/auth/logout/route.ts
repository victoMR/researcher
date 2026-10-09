import { NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";

export const runtime = "nodejs";

export async function POST() {
  const res = NextResponse.json({ ok: true });
  // Mismos atributos que al crearla para que el navegador la reemplace.
  res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return res;
}
