import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { createUser, listTeam } from "@/lib/users";
import { NO_STORE, errorResponse, noDb, requireAdmin } from "@/lib/users-api";

export const runtime = "nodejs";

// Equipo (solo admins): los de Vercel (APP_USERS, solo lectura) y los de la tabla.
export async function GET(req: NextRequest) {
  const me = await requireAdmin(req);
  if (me instanceof NextResponse) return me;
  try {
    const users = await listTeam();
    return NextResponse.json({ users, me: me.email, dbAvailable: hasDb() }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "users GET");
  }
}

// Alta: { email, name, role } -> { user, password }. La contraseña (temporal,
// debe cambiarse al entrar) se devuelve UNA sola vez.
export async function POST(req: NextRequest) {
  const me = await requireAdmin(req);
  if (me instanceof NextResponse) return me;
  if (!hasDb()) return noDb();
  try {
    const body = ((await req.json().catch(() => null)) ?? {}) as {
      email?: unknown;
      name?: unknown;
      role?: unknown;
    };
    const { user, password } = await createUser(body, me.email);
    return NextResponse.json({ user, password }, { status: 201, headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "users POST");
  }
}
