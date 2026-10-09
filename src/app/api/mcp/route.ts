import { NextRequest } from "next/server";
import { bearerToken, emailForToken, mcpConfigured, originAllowed } from "@/lib/mcp/auth";
import { mcpHandler, type McpCaller } from "@/lib/mcp/server";

// Servidor MCP remoto (Streamable HTTP, sin estado) para Claude Code / Claude
// Desktop. No usa la cookie de sesión: cada vendedor manda su propio token
// (Authorization: Bearer <token>; se genera en la pestaña Equipo o va en
// MCP_TOKENS, ver docs/mcp.md). El proxy deja
// pasar /api/mcp sin cookie porque esta ruta valida su propio token.
export const runtime = "nodejs";
// investigar_con_agente sigue en segundo plano con after(): necesita los
// mismos 300 s que POST /api/research. Las demás herramientas duran segundos.
export const maxDuration = 300;

const REALM = 'realm="AI Lead Shield MCP"';

function jsonRpcError(status: number, message: string, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", error: { code: -32001, message }, id: null }), {
    status,
    headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...headers },
  });
}

// 401 con el desafío Bearer (RFC 6750): sin token -> solo realm; token malo -> invalid_token.
function unauthorized(hadToken: boolean): Response {
  const challenge = hadToken
    ? `Bearer ${REALM}, error="invalid_token", error_description="Token invalido o revocado"`
    : `Bearer ${REALM}`;
  return jsonRpcError(401, "No autorizado: manda tu token en 'Authorization: Bearer <token>'.", {
    "WWW-Authenticate": challenge,
  });
}

async function handle(req: NextRequest): Promise<Response> {
  const startedAt = Date.now();
  if (!originAllowed(req.headers.get("origin"), req.nextUrl.origin)) {
    return jsonRpcError(403, "Origen no permitido.");
  }
  if (!mcpConfigured()) {
    return jsonRpcError(503, "El servidor MCP no está configurado (no hay MCP_TOKENS ni base de datos).");
  }
  const token = bearerToken(req.headers.get("authorization"));
  let email: string | null = null;
  try {
    email = token ? await emailForToken(token) : null;
  } catch (e) {
    console.error("mcp auth", e);
    return jsonRpcError(503, "No se pudo validar el token: la base de datos no responde. Intenta en un momento.");
  }
  if (!token || !email) return unauthorized(!!token);

  const appUrl = (process.env.APP_URL?.trim() || req.nextUrl.origin).replace(/\/$/, "");
  const caller: McpCaller = { email, appUrl, startedAt };
  try {
    return await mcpHandler.fetch(req, {
      authInfo: { token, clientId: email, scopes: [], extra: { ...caller } },
    });
  } catch (e) {
    console.error("mcp route", e);
    return jsonRpcError(500, "Error interno del servidor MCP.");
  }
}

export const POST = handle;
// En la era 2025 (sin estado) GET/DELETE responden 405 desde el SDK.
export const GET = handle;
export const DELETE = handle;
