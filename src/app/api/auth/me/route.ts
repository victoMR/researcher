import { NextRequest, NextResponse } from "next/server";
import { SESSION_COOKIE } from "@/lib/auth";
import { SESSION_DB_ERROR, checkSessionToken } from "@/lib/session";

export const runtime = "nodejs";

// Quién está logueado: { email, name, isAdmin, role, source, mustChangePassword }.
// (Ruta pública en el proxy: valida la sesión aquí mismo.)
export async function GET(req: NextRequest) {
  const check = await checkSessionToken(req.cookies.get(SESSION_COOKIE)?.value);
  if (!check.ok) {
    return check.reason === "db_error"
      ? NextResponse.json({ error: SESSION_DB_ERROR }, { status: 503 })
      : NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  const { email, name, isAdmin, role, source, mustChangePassword } = check.user;
  return NextResponse.json(
    { email, name, isAdmin, role, source, mustChangePassword },
    { headers: { "Cache-Control": "no-store" } }
  );
}
