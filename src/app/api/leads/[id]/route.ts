import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import {
  claimLead,
  getLead,
  linkLeadToDenue,
  logLeadEvent,
  removeLead,
  updateLead,
  type LeadPatch,
} from "@/lib/leads-repo";
import { displayName, sessionUser } from "@/lib/session";
import { LEAD_STATUSES } from "@/lib/types";
import type { Lead, LeadStatus } from "@/lib/types";

export const runtime = "nodejs";
// Guardar/vincular un resultado de Google consulta DENUE (hasta ~20 s).
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const err = (error: string, status: number, extra?: object) =>
  NextResponse.json({ error, ...extra }, { status });

// Puede editar/borrar: el dueño, un admin, o cualquiera si no tiene dueño.
function forbidden(lead: Lead, me: string, admin: boolean) {
  if (admin || !lead.ownerEmail || lead.ownerEmail === me) return null;
  return err(`Este prospecto lo trabaja ${displayName(lead.ownerEmail)}.`, 403, {
    ownerEmail: lead.ownerEmail,
  });
}

export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!hasDb()) return err("Sin base de datos.", 503);
  try {
    const user = await sessionUser(req);
    if (!user) return err("No autorizado.", 401);
    const me = user.email;
    const admin = user.isAdmin;
    const { id } = await params;
    const body = ((await req.json().catch(() => null)) ?? {}) as {
      status?: LeadStatus;
      note?: string;
      email?: string;
      claim?: boolean;
      owner?: string | null;
      linkDenue?: boolean; // "Vincular con DENUE" (prospectos solo-Google)
    };

    let lead = await getLead(id);
    if (!lead) return err("Prospecto no encontrado.", 404);

    // Vincular con DENUE: busca el mismo negocio y completa con datos abiertos.
    if (body.linkDenue) {
      const denied = forbidden(lead, me, admin);
      if (denied) return denied;
      const r = await linkLeadToDenue(id);
      if (r.matched && r.lead) {
        await logLeadEvent("denue_linked", {
          leadId: id,
          actor: me,
          meta: { denueId: r.lead.denueId },
        }).catch((e) => console.error("lead PATCH event", e));
      }
      return NextResponse.json({
        ok: true,
        matched: r.matched,
        message: r.message,
        lead: r.lead ?? lead,
      });
    }

    // Tomar un prospecto sin dueño.
    if (body.claim) {
      if (lead.ownerEmail && lead.ownerEmail !== me) {
        return err(`Este prospecto ya lo trabaja ${displayName(lead.ownerEmail)}.`, 409, {
          lead,
        });
      }
      if (!lead.ownerEmail) {
        const claimed = await claimLead(id, me);
        if (!claimed) {
          const now = await getLead(id);
          const who = now?.ownerEmail ? displayName(now.ownerEmail) : "otro vendedor";
          return err(`Este prospecto ya lo trabaja ${who}.`, 409, { lead: now });
        }
        lead = claimed;
      }
    }

    const patch: LeadPatch = {};
    if (body.status !== undefined) {
      if (!LEAD_STATUSES.includes(body.status)) return err("Estatus inválido.", 400);
      patch.status = body.status;
    }
    if (body.note !== undefined) patch.note = String(body.note ?? "").slice(0, 2000);
    if (body.email !== undefined) {
      const email = String(body.email ?? "").trim().toLowerCase();
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return err("Correo inválido.", 400);
      patch.email = email;
    }
    if (body.owner !== undefined) {
      if (!admin) return err("Solo un administrador puede reasignar prospectos.", 403);
      const owner = body.owner ? String(body.owner).trim().toLowerCase() : null;
      if (owner && !owner.includes("@")) return err("Correo de vendedor inválido.", 400);
      patch.owner = owner;
    }

    if (!Object.keys(patch).length) {
      if (body.claim) return NextResponse.json({ ok: true, lead });
      return err("Nada que actualizar.", 400);
    }

    const denied = forbidden(lead, me, admin);
    if (denied) return denied;

    const updated = await updateLead(id, patch, { actor: me, admin });
    if (!updated) {
      // Alguien lo tomó entre la lectura y la escritura.
      const now = await getLead(id);
      if (!now) return err("Prospecto no encontrado.", 404);
      return forbidden(now, me, admin) ?? err("No se pudo actualizar. Recarga la lista.", 409);
    }

    if (patch.status && patch.status !== lead.status) {
      await logLeadEvent("status_changed", {
        leadId: id,
        actor: me,
        meta: { from: lead.status, to: patch.status },
      }).catch((e) => console.error("lead PATCH event", e));
    }

    return NextResponse.json({ ok: true, lead: updated });
  } catch (e) {
    console.error("lead PATCH", e);
    return err("Error actualizando.", 500);
  }
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!hasDb()) return err("Sin base de datos.", 503);
  try {
    const user = await sessionUser(req);
    if (!user) return err("No autorizado.", 401);
    const { id } = await params;
    const lead = await getLead(id);
    if (!lead) return NextResponse.json({ ok: true });
    const denied = forbidden(lead, user.email, user.isAdmin);
    if (denied) return denied;
    await removeLead(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    console.error("lead DELETE", e);
    return err("Error eliminando.", 500);
  }
}
