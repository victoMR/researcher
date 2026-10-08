import type { NextRequest } from "next/server";
import { SESSION_COOKIE, verifySession } from "./auth";

// Correo (en minúsculas) del usuario logueado según la cookie, o null.
export async function sessionEmail(req: NextRequest): Promise<string | null> {
  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  return session?.email?.toLowerCase() ?? null;
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

// Administradores: APP_ADMINS = "a@x.com,b@x.com". Si no está definida,
// el usuario de APP_LOGIN_EMAIL es el admin.
export function isAdmin(email: string | null | undefined): boolean {
  if (!email) return false;
  const raw = process.env.APP_ADMINS ?? process.env.APP_LOGIN_EMAIL ?? "";
  return raw
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .includes(email.toLowerCase());
}
