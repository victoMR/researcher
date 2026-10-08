import { NextRequest, NextResponse } from "next/server";
import { verifySession, SESSION_COOKIE } from "@/lib/auth";

// Proxy (antes "middleware"; renombrado en Next 16). Corre en runtime Node.js.

// Rutas públicas (no requieren sesión).
const PUBLIC = ["/login", "/api/auth/"];
// Rutas con autenticación propia (coincidencia EXACTA): el servidor MCP valida
// su propio Bearer token por vendedor (MCP_TOKENS) en vez de la cookie.
const SELF_AUTH = new Set(["/api/mcp"]);

export async function proxy(req: NextRequest) {
  const { pathname } = req.nextUrl;

  if (PUBLIC.some((p) => pathname === p || pathname.startsWith(p))) {
    return NextResponse.next();
  }
  if (SELF_AUTH.has(pathname)) return NextResponse.next();

  const session = await verifySession(req.cookies.get(SESSION_COOKIE)?.value);
  if (session) return NextResponse.next();

  // API sin sesión -> 401; páginas -> redirige a /login.
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  return NextResponse.redirect(url);
}

export const config = {
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|.*\\.(?:png|jpg|jpeg|gif|svg|ico|webp)).*)",
  ],
};
