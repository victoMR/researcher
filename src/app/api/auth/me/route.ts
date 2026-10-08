import { NextRequest, NextResponse } from "next/server";
import { displayName, isAdmin, sessionEmail } from "@/lib/session";

export const runtime = "nodejs";

// Quién está logueado: { email, name, isAdmin }.
export async function GET(req: NextRequest) {
  const email = await sessionEmail(req);
  if (!email) {
    return NextResponse.json({ error: "No autorizado." }, { status: 401 });
  }
  return NextResponse.json({
    email,
    name: displayName(email),
    isAdmin: isAdmin(email),
  });
}
