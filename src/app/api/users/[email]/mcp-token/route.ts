import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { createMcpToken, revokeMcpToken } from "@/lib/users";
import { NO_STORE, errorResponse, noDb, paramEmail, requireAdmin } from "@/lib/users-api";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ email: string }> };

// Genera (o reemplaza) el token MCP del usuario. Se guarda solo su sha256; el
// token y el comando para Claude Code se devuelven UNA vez.
export async function POST(req: NextRequest, { params }: Ctx) {
  const me = await requireAdmin(req);
  if (me instanceof NextResponse) return me;
  if (!hasDb()) return noDb();
  try {
    const email = await paramEmail(params);
    const { token, user } = await createMcpToken(email, me.email);
    const appUrl = (process.env.APP_URL?.trim() || req.nextUrl.origin).replace(/\/$/, "");
    const command = `claude mcp add --transport http ai-lead-shield ${appUrl}/api/mcp --header "Authorization: Bearer ${token}" --scope user`;
    return NextResponse.json({ user, token, command }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "users mcp-token POST");
  }
}

// Revoca el token MCP (deja de valer de inmediato).
export async function DELETE(req: NextRequest, { params }: Ctx) {
  const me = await requireAdmin(req);
  if (me instanceof NextResponse) return me;
  if (!hasDb()) return noDb();
  try {
    const email = await paramEmail(params);
    const { revoked, user } = await revokeMcpToken(email, me.email);
    return NextResponse.json({ user, revoked }, { headers: NO_STORE });
  } catch (e) {
    return errorResponse(e, "users mcp-token DELETE");
  }
}
