import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE, sessionCookieOptions } from "@/lib/auth";
import { SESSION_DB_ERROR, checkSessionToken } from "@/lib/session";

// Proxy (antes "middleware"; renombrado en Next 16). Corre en runtime Node.js.
// Valida la sesión completa (firma + usuario activo y session_version, con
// caché de 60 s; ver src/lib/session.ts): desactivar a alguien, cambiarle el
// rol o restablecer su contraseña corta sus sesiones en ≤ 60 s.

// Rutas públicas (no requieren sesión).
const PUBLIC = ["/login", "/api/auth/"];
// Rutas con autenticación propia (coincidencia EXACTA): el servidor MCP valida
// su propio Bearer token por vendedor (tabla app_users o MCP_TOKENS) en vez de la cookie.
const SELF_AUTH = new Set(["/api/mcp"]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (SELF_AUTH.has(pathname)) return NextResponse.next();

  const token = req.cookies.get(SESSION_COOKIE)?.value;
  const check = await checkSessionToken(token);
  if (check.ok) return NextResponse.next();

  const isApi = pathname.startsWith("/api/");
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";

  // La BD no respondió al validar a un usuario de BD: falla cerrada, pero sin
  // borrar la cookie (vuelve a valer en cuanto la BD responda).
  if (check.reason === "db_error") {
    if (isApi) return NextResponse.json({ error: SESSION_DB_ERROR }, { status: 503 });
    url.searchParams.set("e", "bd");
    return NextResponse.redirect(url);
  }

  // API sin sesión -> 401; páginas -> redirige a /login. Una cookie que ya no
  // vale (expiró, desactivaron al usuario, cambió su rol o su contraseña) se borra.
  const stale = !!token;
  let res: NextResponse;
  if (isApi) {
    res = NextResponse.json(
      { error: stale ? "Tu sesión terminó. Vuelve a iniciar sesión." : "No autorizado." },
      { status: 401 }
    );
  } else {
    if (stale) url.searchParams.set("e", "sesion");
    res = NextResponse.redirect(url);
  }
  if (stale) res.cookies.set(SESSION_COOKIE, "", sessionCookieOptions(0));
  return res;
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)).*)",
  ],
};
