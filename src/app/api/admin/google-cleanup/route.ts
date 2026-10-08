import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { googleCleanup } from "@/lib/leads-repo";
import { isAdmin, sessionEmail } from "@/lib/session";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * Limpieza de prospectos guardados ANTES desde Google con contenido completo
 * (sus términos solo permiten guardar place_id y lat/lng por 30 días).
 * Solo administradores.
 *
 *   POST /api/admin/google-cleanup            { "dryRun": true }   (por defecto: solo cuenta)
 *   POST /api/admin/google-cleanup            { "dryRun": false, "limit": 100 }
 *
 * Para cada prospecto solo-Google intenta el mismo negocio en DENUE (≤ 250 m y
 * nombre parecido): si aparece, sustituye sus datos por los de DENUE; si no,
 * borra teléfono, dirección, web, rating, reseñas y última reseña (conserva
 * place_id, nombre, correo hallado, dueño, estatus y notas). Al final borra las
 * coordenadas de Google con más de 30 días. Procesa en lotes (limit, máx. 500)
 * con tope de ~45 s: si "remaining" > 0, vuelve a llamar hasta que sea 0.
 * Con dryRun también consulta DENUE para estimar cuántos se vincularían.
 */
export async function POST(req: NextRequest) {
  if (!hasDb()) {
    return NextResponse.json(
      { error: "Base de datos no configurada (falta DATABASE_URL)." },
      { status: 503 }
    );
  }
  const me = await sessionEmail(req);
  if (!isAdmin(me)) {
    return NextResponse.json(
      { error: "Solo un administrador puede limpiar los datos de Google." },
      { status: 403 }
    );
  }
  try {
    const body = ((await req.json().catch(() => null)) ?? {}) as {
      dryRun?: unknown;
      limit?: unknown;
    };
    const dryRun = body.dryRun !== false; // por seguridad: solo con false explícito
    const limit = typeof body.limit === "number" && body.limit > 0 ? body.limit : 100;
    const report = await googleCleanup({ dryRun, limit, budgetMs: 45_000 });
    console.info("google-cleanup", { by: me, ...report });
    return NextResponse.json(report);
  } catch (e) {
    console.error("google-cleanup", e);
    return NextResponse.json({ error: "Error limpiando datos de Google." }, { status: 500 });
  }
}
