import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { clearLoginFailures } from "@/lib/rate-limit";
import { resetPassword } from "@/lib/users";
import {
  NO_STORE,
  errorResponse,
  noDb,
  paramEmail,
  requireAdmin,
  setDbSessionCookie,
} from "@/lib/users-api";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ email: string }> };

// Restablece la contraseña: devuelve la nueva UNA vez, obliga a cambiarla al
// entrar, corta sus sesiones (sube session_version) y limpia el bloqueo por
// intentos fallidos de ese correo.
export async function POST(req: NextRequest, { params }: Ctx) {
  const me = await requireAdmin(req);
  if (me instanceof NextResponse) return me;
  if (!hasDb()) return noDb();
  try {
    const email = await paramEmail(params);
    const r = await resetPassword(email, me.email);
    await clearLoginFailures(email);
    const res = NextResponse.json({ user: r.user, password: r.password }, { headers: NO_STORE });
    if (email === me.email && r.active && me.source === "db") {
      await setDbSessionCookie(res, { email, v: r.version, role: r.role });
    }
    return res;
  } catch (e) {
    return errorResponse(e, "users password POST");
  }
}
