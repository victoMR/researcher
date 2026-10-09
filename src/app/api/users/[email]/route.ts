import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { updateUser } from "@/lib/users";
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

// Edita { name?, role?, active? }. Cambiar rol o desactivar corta las sesiones
// del usuario (≤ 60 s). Si te editas a ti mismo y sigues activo, se reemite tu
// cookie para no sacarte. `loggedOut` = te desactivaste.
export async function PATCH(req: NextRequest, { params }: Ctx) {
  const me = await requireAdmin(req);
  if (me instanceof NextResponse) return me;
  if (!hasDb()) return noDb();
  try {
    const email = await paramEmail(params);
    const body = ((await req.json().catch(() => null)) ?? {}) as {
      name?: unknown;
      role?: unknown;
      active?: unknown;
    };
    const r = await updateUser(email, { name: body.name, role: body.role, active: body.active }, me.email);
    const self = email === me.email;
    const res = NextResponse.json(
      { user: r.user, loggedOut: self && !r.active },
      { headers: NO_STORE }
    );
    if (self && r.active && me.source === "db") {
      await setDbSessionCookie(res, { email, v: r.version, role: r.role });
    }
    return res;
  } catch (e) {
    return errorResponse(e, "users PATCH");
  }
}
