"use client";

import { useRef, useState } from "react";
import type { Lead, LeadStatus, Me } from "@/lib/types";
import { LEAD_STATUSES, googleMapsUrl, isGoogleOnly, placeIdOf, sourceOf } from "@/lib/types";
import { buildWaText, logWhatsApp, waLink } from "@/lib/wa";
import {
  firstName,
  personName,
  scoreColor,
  shortDate,
  sourceCredit,
  timeAgo,
} from "@/lib/format";
import { formatBreakdown, scoreLabel } from "@/lib/scoring";
import { lookupEmails } from "@/lib/useLeads";
import Select from "@/components/Select";
import { ScoreBadge } from "@/components/BusinessCard";
import { CardShell, STATUS_META } from "@/components/ui";
import * as Icon from "@/components/icons";

// Quién puede tocar un prospecto: su dueño, un admin, o cualquiera si no tiene dueño.
export function canEditLead(l: Lead, me: Me | null): boolean {
  if (!l.ownerEmail) return true;
  if (!me) return false;
  return me.isAdmin || l.ownerEmail === me.email;
}

type NoteState = "idle" | "saving" | "saved" | "error";

export default function LeadCard({
  l,
  me,
  waTemplateBody,
  onStatus,
  onNote,
  onEmail,
  onClaim,
  onReassign,
  onSuppress,
  onRemove,
  onCompose,
  onGhl,
  onLinkDenue,
}: {
  l: Lead;
  me: Me | null;
  waTemplateBody?: string;
  onStatus: (s: LeadStatus) => void;
  onNote: (note: string) => Promise<boolean>;
  onEmail: (email: string) => Promise<boolean>;
  onClaim: () => void;
  onReassign?: () => void; // solo admin
  onSuppress: () => void;
  onRemove: () => void;
  onCompose: () => void;
  onGhl: () => void;
  onLinkDenue?: () => Promise<void>; // solo-Google: buscarlo en DENUE
}) {
  const owner = l.ownerEmail ?? null;
  const mine = !!owner && owner === me?.email;
  const canEdit = canEditLead(l, me);
  const lockMsg = canEdit || !owner ? undefined : `Este prospecto lo trabaja ${personName(owner)}.`;
  const contactedMine = !!l.contactedBy && l.contactedBy === me?.email;
  const wa = l.phone ? waLink(l.phone, buildWaText(l, waTemplateBody, me?.name)) : null;
  // Solo-Google: no se exporta (CSV/GHL) hasta vincularlo con DENUE.
  const googleOnly = isGoogleOnly(l);
  const placeId = placeIdOf(l);
  const [linking, setLinking] = useState(false);

  async function linkDenue() {
    if (!onLinkDenue || linking) return;
    setLinking(true);
    try {
      await onLinkDenue();
    } finally {
      setLinking(false);
    }
  }

  // Nota inline: se guarda al salir del campo.
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [noteState, setNoteState] = useState<NoteState>("idle");
  const cancelNote = useRef(false);

  function startNote() {
    if (!canEdit) return;
    cancelNote.current = false;
    setDraft(l.note ?? "");
    setEditing(true);
  }

  async function saveNote() {
    if (cancelNote.current) {
      cancelNote.current = false;
      return;
    }
    setEditing(false);
    const next = draft.trim();
    if (next === (l.note ?? "")) return;
    setNoteState("saving");
    const ok = await onNote(next);
    setNoteState(ok ? "saved" : "error");
    if (ok) setTimeout(() => setNoteState((s) => (s === "saved" ? "idle" : s)), 2000);
  }

  // Buscar correo en la web del prospecto.
  const [finding, setFinding] = useState(false);
  const [found, setFound] = useState<{
    guesses: string[];
    socials: string[];
    msg: string | null;
  } | null>(null);

  async function findEmail() {
    if (!l.website) return;
    setFinding(true);
    setFound(null);
    const r = await lookupEmails(l.website);
    if (r.emails[0]) {
      const ok = await onEmail(r.emails[0]);
      setFinding(false);
      if (!ok) setFound({ guesses: [], socials: r.socials, msg: "No se pudo guardar el correo." });
      return;
    }
    setFinding(false);
    setFound({
      guesses: r.guesses,
      socials: r.socials,
      msg: r.error ?? (r.guesses.length ? null : "No encontré correo en su web."),
    });
  }

  async function pickGuess(g: string) {
    const ok = await onEmail(g);
    if (ok) setFound(null);
  }

  const btn =
    "flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50";

  return (
    <CardShell>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {l.score != null && (
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-bold ${scoreColor(l.score)}`}
              title={`Calificación de prospecto (1–10, por resta): ${formatBreakdown({
                score: l.score,
                max: 10,
                deductions: l.scoreDeductions ?? [],
                label: scoreLabel(l.score),
              })}`}
            >
              {l.score}
            </span>
          )}
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-slate-900" title={l.name}>
              {l.name}
            </h3>
            {(l.category || l.city) && (
              <p className="truncate text-xs text-slate-400">
                {[l.category, l.city].filter(Boolean).join(" · ")}
              </p>
            )}
            {l.score != null && <ScoreBadge score={l.score} deductions={l.scoreDeductions} />}
          </div>
        </div>
        <span
          className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_META[l.status]?.cls ?? STATUS_META.nuevo.cls}`}
        >
          {STATUS_META[l.status]?.label ?? l.status}
        </span>
      </div>

      {/* Dueño y contacto */}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
        {mine ? (
          <span className="flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 font-medium text-indigo-700">
            <Icon.User className="h-3 w-3" /> Tú
          </span>
        ) : owner ? (
          <span
            className="flex items-center gap-1 rounded-full bg-slate-100 px-2 py-0.5 font-medium text-slate-600"
            title={owner}
          >
            <Icon.User className="h-3 w-3" /> {personName(owner)}
          </span>
        ) : (
          <>
            <span className="rounded-full border border-dashed border-slate-300 px-2 py-0.5 font-medium text-slate-500">
              Sin asignar
            </span>
            <button
              onClick={onClaim}
              title="Quedarte con este prospecto"
              className="rounded-full bg-indigo-600 px-2 py-0.5 font-semibold text-white transition hover:bg-indigo-700"
            >
              Tomar
            </button>
          </>
        )}
        {onReassign && (
          <button
            onClick={onReassign}
            title="Asignar a otro vendedor (admin)"
            className="rounded-full px-1.5 py-0.5 font-medium text-slate-400 transition hover:bg-slate-100 hover:text-slate-700"
          >
            Reasignar
          </button>
        )}
        {l.contactedBy && (
          <span
            className="flex items-center gap-1 text-slate-500"
            title={l.contactedAt ? shortDate(l.contactedAt) : undefined}
          >
            <Icon.Clock className="h-3 w-3" />
            Contactado por {contactedMine ? "ti" : firstName(l.contactedBy)}
            {l.contactedAt && ` · ${timeAgo(l.contactedAt)}`}
          </span>
        )}
      </div>

      <div className="mt-2 flex flex-1 flex-col gap-1 text-xs text-slate-600">
        {l.phone && (
          <span className="flex items-center gap-1.5">
            <Icon.Phone className="h-3.5 w-3.5 text-slate-400" />
            {l.phone}
          </span>
        )}
        {l.website && (
          <a
            href={l.website}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 truncate text-indigo-600 hover:underline"
          >
            <Icon.Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{l.website.replace(/^https?:\/\//, "")}</span>
          </a>
        )}
        {l.email ? (
          <span className="flex items-center gap-1.5 font-medium text-emerald-600">
            <Icon.Mail className="h-3.5 w-3.5" />
            <span className="truncate">{l.email}</span>
          </span>
        ) : l.website ? (
          <div className="flex flex-wrap items-center gap-1.5 text-slate-400">
            {finding ? (
              <span className="flex items-center gap-1.5">
                <span className="h-1.5 w-1.5 animate-ping rounded-full bg-indigo-400" />
                buscando correo…
              </span>
            ) : (
              <button
                onClick={findEmail}
                disabled={!canEdit}
                title={lockMsg ?? "Buscar el correo en su sitio web"}
                className="flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Icon.Search className="h-3 w-3" /> Buscar correo
              </button>
            )}
            {found?.msg && <span>{found.msg}</span>}
            {found?.socials.map((s) => (
              <a
                key={s}
                href={s}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200"
              >
                <Icon.ExternalLink className="h-3 w-3" />
                {s.includes("facebook")
                  ? "Facebook"
                  : s.includes("instagram")
                    ? "Instagram"
                    : "Red"}
              </a>
            ))}
            {found && found.guesses.length > 0 && (
              <div className="mt-1 flex w-full flex-wrap items-center gap-1">
                <span className="text-[11px] text-slate-400">sugeridos:</span>
                {found.guesses.slice(0, 4).map((g) => (
                  <button
                    key={g}
                    onClick={() => pickGuess(g)}
                    title="Usar este correo sugerido (dominio de la empresa)"
                    className="rounded-md bg-indigo-50 px-1.5 py-0.5 text-[11px] font-medium text-indigo-700 hover:bg-indigo-100"
                  >
                    {g}
                  </button>
                ))}
              </div>
            )}
          </div>
        ) : null}
        {l.address && <span className="line-clamp-2 text-slate-400">{l.address}</span>}
      </div>

      {/* Solo-Google: sus términos no dejan guardar ni exportar sus datos */}
      {googleOnly && (
        <div className="mt-2 rounded-lg bg-amber-50 px-2 py-1.5 text-[11px] text-amber-800">
          <p>
            De Google: solo se guardó lo mínimo. No se exporta a CSV ni a GHL hasta
            vincularlo con DENUE.
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            {onLinkDenue && (
              <button
                onClick={linkDenue}
                disabled={!canEdit || linking}
                title={lockMsg ?? "Buscar este negocio en DENUE (INEGI) y completar sus datos"}
                className="flex items-center gap-1 rounded-md bg-white px-1.5 py-0.5 font-semibold text-indigo-700 shadow-apple-sm hover:bg-indigo-50 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {linking ? (
                  <Icon.Loader className="h-3 w-3" />
                ) : (
                  <Icon.LinkIcon className="h-3 w-3" />
                )}
                {linking ? "Buscando en DENUE…" : "Vincular con DENUE"}
              </button>
            )}
            {placeId && (
              <a
                href={googleMapsUrl(placeId)}
                target="_blank"
                rel="noreferrer"
                className="flex items-center gap-0.5 font-medium text-indigo-600 hover:underline"
              >
                Ver en Google Maps <Icon.ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
      )}

      {/* Nota */}
      <div className="mt-2">
        {editing ? (
          <textarea
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={saveNote}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                cancelNote.current = true;
                setEditing(false);
              } else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.currentTarget.blur();
              }
            }}
            rows={3}
            maxLength={2000}
            placeholder="Ej. Hablar con el gerente el lunes…"
            className="w-full resize-y rounded-xl border-0 bg-slate-50 px-3 py-2 text-xs text-slate-800 outline-none focus:ring-2 focus:ring-indigo-500"
          />
        ) : l.note ? (
          <button
            onClick={startNote}
            disabled={!canEdit}
            title={lockMsg ?? "Editar nota"}
            className="line-clamp-3 w-full whitespace-pre-wrap rounded-xl bg-amber-50/70 px-3 py-2 text-left text-xs text-slate-700 transition hover:bg-amber-50 disabled:cursor-default"
          >
            {l.note}
          </button>
        ) : (
          <button
            onClick={startNote}
            disabled={!canEdit}
            title={lockMsg}
            className="flex items-center gap-1 text-xs text-slate-400 transition hover:text-slate-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Icon.Pencil className="h-3.5 w-3.5" /> Agregar nota
          </button>
        )}
        {noteState !== "idle" && (
          <span
            className={`mt-1 flex items-center gap-1 text-[11px] ${
              noteState === "error" ? "text-rose-600" : "text-slate-400"
            }`}
          >
            {noteState === "saving" && "Guardando…"}
            {noteState === "saved" && (
              <>
                <Icon.Check className="h-3 w-3 text-emerald-500" /> Guardado
              </>
            )}
            {noteState === "error" && "No se pudo guardar la nota."}
          </span>
        )}
      </div>

      {lockMsg && (
        <p className="mt-2 flex items-center gap-1.5 rounded-lg bg-slate-50 px-2 py-1 text-[11px] text-slate-500">
          <Icon.Lock className="h-3 w-3 shrink-0" /> {lockMsg} Solo lectura.
        </p>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        <Select
          value={l.status}
          onChange={(v) => onStatus(v as LeadStatus)}
          compact
          disabled={!canEdit}
          title={lockMsg}
          className="w-32"
          options={LEAD_STATUSES.map((s) => ({
            value: s,
            label: STATUS_META[s].label,
          }))}
        />
        {wa &&
          (canEdit ? (
            <a
              href={wa}
              target="_blank"
              rel="noreferrer"
              onClick={() =>
                logWhatsApp({
                  leadId: l.id,
                  phone: l.phone,
                  name: l.name,
                  email: l.email || undefined,
                })
              }
              className={`${btn} bg-emerald-500 font-semibold text-white hover:bg-emerald-600`}
            >
              <Icon.WhatsApp className="h-3.5 w-3.5" /> WhatsApp
            </a>
          ) : (
            <span
              title={lockMsg}
              className={`${btn} cursor-not-allowed bg-emerald-500 font-semibold text-white opacity-50`}
            >
              <Icon.WhatsApp className="h-3.5 w-3.5" /> WhatsApp
            </span>
          ))}
        <button
          onClick={onCompose}
          disabled={!canEdit}
          title={lockMsg}
          className={`${btn} bg-indigo-600 px-3 font-semibold text-white hover:bg-indigo-700`}
        >
          Propuesta
        </button>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1 border-t border-black/5 pt-2">
        <button
          onClick={onGhl}
          disabled={!canEdit || googleOnly}
          title={
            lockMsg ??
            (googleOnly
              ? "De Google: no se envía a GHL por sus términos. Vincúlalo con DENUE."
              : "Enviar este contacto a GHL")
          }
          className={`${btn} text-slate-500 hover:bg-slate-50 hover:text-slate-800`}
        >
          <Icon.Send className="h-3.5 w-3.5" /> GHL
        </button>
        {l.email && (
          <button
            onClick={onSuppress}
            disabled={!canEdit}
            title={lockMsg ?? "No volver a contactar este correo (lista de baja)"}
            className={`${btn} text-slate-500 hover:bg-rose-50 hover:text-rose-700`}
          >
            <Icon.Ban className="h-3.5 w-3.5" /> Dar de baja
          </button>
        )}
        <button
          onClick={onRemove}
          disabled={!canEdit}
          title={lockMsg ?? "Quitar de mis prospectos"}
          className={`${btn} ml-auto text-rose-600 hover:bg-rose-50`}
        >
          <Icon.Trash className="h-3.5 w-3.5" /> Quitar
        </button>
      </div>
      <p className="mt-1 text-[10px] text-slate-400">{sourceCredit(sourceOf(l))}</p>
    </CardShell>
  );
}
