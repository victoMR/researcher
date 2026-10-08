"use client";

import { useId, useState } from "react";
import type { Business, LeadMatch, Me } from "@/lib/types";
import { googleMapsUrl, isGoogleOnly, placeIdOf, sourceOf } from "@/lib/types";
import { buildWaText, logWhatsApp, waLink } from "@/lib/wa";
import {
  firstName,
  isRecent,
  personName,
  scoreColor,
  shortDate,
  sourceCredit,
  timeAgo,
} from "@/lib/format";
import { formatBreakdown, scoreLabel } from "@/lib/scoring";
import { CardShell } from "@/components/ui";
import * as Icon from "@/components/icons";

// Etiqueta del score (Completo/Bueno/Incompleto/Pobre) + "¿Por qué N?" con el
// desglose por resta: "10 − 3 (sin correo) − 1 (sin sitio web) = 6".
export function ScoreBadge({
  score,
  deductions,
}: {
  score: number;
  deductions?: { points: number; reason: string }[];
}) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const list = deductions ?? [];
  const label = scoreLabel(score);
  const text = formatBreakdown({ score, max: 10, deductions: list, label });
  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold ${scoreColor(score)}`}
          title={text}
        >
          {label}
        </span>
        {list.length > 0 ? (
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            aria-expanded={open}
            aria-controls={id}
            title={text}
            className="flex items-center gap-0.5 rounded-md px-1 text-[11px] font-medium text-indigo-600 hover:underline"
          >
            ¿Por qué {score}?
            <Icon.ChevronRight className={`h-3 w-3 transition ${open ? "rotate-90" : ""}`} />
          </button>
        ) : (
          <span className="text-[11px] text-emerald-700">Datos completos y activo</span>
        )}
      </div>
      {open && list.length > 0 && (
        <div
          id={id}
          className="mt-1.5 rounded-xl border border-black/5 bg-slate-50 px-3 py-2 text-[11px] text-slate-600"
        >
          <p className="font-medium tabular-nums text-slate-800">{text}</p>
          <ul className="mt-1 space-y-0.5">
            {list.map((d, i) => (
              <li key={`${d.reason}-${i}`} className="flex gap-2">
                <span className="w-5 shrink-0 text-right font-semibold tabular-nums text-rose-600">
                  −{-d.points}
                </span>
                <span>{d.reason}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

// Tarjeta de un resultado de búsqueda. Muestra si ya está guardado y con quién
// para que dos vendedores no le escriban al mismo negocio.
export default function BusinessCard({
  b,
  city,
  socials,
  guesses,
  waTemplateBody,
  me,
  match,
  extracting,
  onSave,
  onClaim,
  onExtract,
  onCompose,
  onPickEmail,
}: {
  b: Business;
  city: string;
  socials?: string[];
  guesses?: string[];
  waTemplateBody?: string;
  me: Me | null;
  match?: LeadMatch;
  extracting: boolean;
  onSave: () => void;
  onClaim: () => void;
  onExtract: () => void;
  onCompose: () => void;
  onPickEmail: (email: string) => void;
}) {
  const googleUrl = `https://www.google.com/search?q=${encodeURIComponent(
    `"${b.name}" ${city} correo OR contacto OR email`
  )}`;
  const wa = b.phone ? waLink(b.phone, buildWaText(b, waTemplateBody, me?.name)) : null;
  const recent = isRecent(b.lastReviewTime);
  const src = sourceOf(b);
  const google = isGoogleOnly(b);
  const placeId = placeIdOf(b);

  const owner = match?.ownerEmail ?? null;
  const mine = !!owner && owner === me?.email;
  const otherOwner = !!owner && !mine;
  // Aviso suave si otro vendedor ya lo trabaja (admins también lo ven).
  const othersLead = otherOwner ? personName(owner) : null;
  const confirmOthers = () =>
    !othersLead ||
    confirm(`Este negocio lo trabaja ${othersLead}. ¿Escribirle de todos modos?`);

  const contactedBy = match?.contactedBy ?? null;
  const contactedMine = !!contactedBy && contactedBy === me?.email;

  return (
    <CardShell>
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2">
          {b.score != null && (
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-lg text-sm font-bold ${scoreColor(b.score)}`}
              title={`Calificación de prospecto (1–10, por resta): ${formatBreakdown({
                score: b.score,
                max: 10,
                deductions: b.scoreDeductions ?? [],
                label: scoreLabel(b.score),
              })}`}
            >
              {b.score}
            </span>
          )}
          <div className="min-w-0">
            <h3 className="truncate font-semibold text-slate-900" title={b.name}>
              {b.name}
            </h3>
            {b.score != null && <ScoreBadge score={b.score} deductions={b.scoreDeductions} />}
          </div>
        </div>
        {b.lastReviewAgo && (
          <span
            className={`flex shrink-0 items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${
              recent
                ? "bg-emerald-100 text-emerald-700"
                : "bg-slate-100 text-slate-500"
            }`}
            title={`Reseña más reciente: ${b.lastReviewAgo}`}
          >
            {recent && <Icon.Flame className="h-3 w-3" />}
            {b.lastReviewAgo}
          </span>
        )}
      </div>
      {/* Rating y reseñas: contenido de Google, con su etiqueta y enlace a su ficha */}
      {(b.rating != null || b.reviewCount != null) && (
        <div className="mt-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
          <span className="rounded bg-slate-100 px-1 py-px text-[10px] font-semibold text-slate-500">
            Google
          </span>
          <Icon.Star className="h-3.5 w-3.5 text-amber-500" />
          <span className="font-medium text-slate-700">
            {b.rating?.toFixed(1) ?? "—"}
          </span>
          {b.reviewCount != null && <span>({b.reviewCount} reseñas)</span>}
          {placeId && (
            <a
              href={googleMapsUrl(placeId)}
              target="_blank"
              rel="noreferrer"
              className="ml-1 flex items-center gap-0.5 font-medium text-indigo-600 hover:underline"
            >
              Ver en Google Maps <Icon.ExternalLink className="h-3 w-3" />
            </a>
          )}
        </div>
      )}
      {google && placeId && b.rating == null && b.reviewCount == null && (
        <a
          href={googleMapsUrl(placeId)}
          target="_blank"
          rel="noreferrer"
          className="mt-1 flex items-center gap-0.5 text-xs font-medium text-indigo-600 hover:underline"
        >
          Ver en Google Maps <Icon.ExternalLink className="h-3 w-3" />
        </a>
      )}
      {b.address && (
        <p className="mt-0.5 line-clamp-2 text-xs text-slate-400">{b.address}</p>
      )}
      {b.employees && (
        <p
          className="mt-0.5 flex items-center gap-1 text-xs text-slate-500"
          title="Personal ocupado (DENUE)"
        >
          <Icon.Users className="h-3.5 w-3.5 text-slate-400" /> {b.employees}
        </p>
      )}

      {/* Ya lo contactó alguien / está descartado */}
      {match && (contactedBy || match.status === "descartado") && (
        <p
          className={`mt-2 flex items-center gap-1.5 rounded-lg px-2 py-1 text-[11px] font-medium ${
            match.status === "descartado"
              ? "bg-rose-50 text-rose-700"
              : contactedMine
                ? "bg-indigo-50 text-indigo-700"
                : "bg-amber-50 text-amber-800"
          }`}
          title={match.contactedAt ? shortDate(match.contactedAt) : undefined}
        >
          {match.status === "descartado" ? (
            <>
              <Icon.Ban className="h-3.5 w-3.5 shrink-0" /> Descartado / dado de baja
            </>
          ) : (
            <>
              <Icon.Clock className="h-3.5 w-3.5 shrink-0" />
              Contactado por {contactedMine ? "ti" : firstName(contactedBy!)}
              {match.contactedAt && ` · ${timeAgo(match.contactedAt)}`}
            </>
          )}
        </p>
      )}

      <div className="mt-2 flex flex-1 flex-col gap-1 text-xs text-slate-600">
        {b.distanceKm != null && (
          <span className="flex items-center gap-1.5 font-medium text-slate-500">
            <Icon.MapPin className="h-3.5 w-3.5" />a{" "}
            {b.distanceKm < 1
              ? `${Math.round(b.distanceKm * 1000)} m`
              : `${b.distanceKm.toFixed(1)} km`}{" "}
            de ti
          </span>
        )}
        {b.phone && (
          <span className="flex items-center gap-1.5">
            <Icon.Phone className="h-3.5 w-3.5 text-slate-400" />
            {b.phone}
          </span>
        )}
        {b.website && (
          <a
            href={b.website}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 truncate text-indigo-600 hover:underline"
          >
            <Icon.Globe className="h-3.5 w-3.5 shrink-0" />
            <span className="truncate">{b.website.replace(/^https?:\/\//, "")}</span>
          </a>
        )}
        {b.email ? (
          <span className="flex items-center gap-1.5 font-medium text-emerald-600">
            <Icon.Mail className="h-3.5 w-3.5" />
            {b.email}
          </span>
        ) : extracting ? (
          <span className="flex items-center gap-1.5 text-slate-400">
            <span className="h-1.5 w-1.5 animate-ping rounded-full bg-indigo-400" />
            buscando correo…
          </span>
        ) : b.email === "" ? (
          <div className="flex flex-wrap items-center gap-2 text-slate-400">
            <span>sin correo directo</span>
            <a
              href={googleUrl}
              target="_blank"
              rel="noreferrer"
              className="flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200"
            >
              <Icon.Search className="h-3 w-3" /> Google
            </a>
            {socials?.map((s) => (
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
            {guesses && guesses.length > 0 && (
              <div className="mt-1 flex w-full flex-wrap items-center gap-1">
                <span className="text-[11px] text-slate-400">sugeridos:</span>
                {guesses.slice(0, 3).map((g) => (
                  <button
                    key={g}
                    onClick={() => onPickEmail(g)}
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
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {b.website && b.email === undefined && !extracting && (
          <button
            onClick={onExtract}
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            Buscar correo
          </button>
        )}
        {b.email === "" && (
          <button
            onClick={onExtract}
            disabled={extracting}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50 disabled:opacity-50"
          >
            <Icon.Refresh className="h-3.5 w-3.5" /> Reintentar
          </button>
        )}
        {!match ? (
          <button
            onClick={onSave}
            className="flex items-center gap-1 rounded-lg border border-slate-200 px-2.5 py-1 text-xs font-medium text-slate-600 hover:bg-slate-50"
          >
            <Icon.Plus className="h-3.5 w-3.5" /> Guardar
          </button>
        ) : owner ? (
          <span
            className={`flex items-center gap-1 rounded-lg px-2.5 py-1 text-xs font-medium ${
              mine ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"
            }`}
            title={mine ? "Lo guardaste tú" : `Lo trabaja ${personName(owner)} (${owner})`}
          >
            <Icon.Check className="h-3.5 w-3.5" /> Guardado · {mine ? "Tú" : firstName(owner)}
          </span>
        ) : (
          <span className="flex items-center gap-1 rounded-lg bg-slate-100 py-1 pl-2.5 pr-1 text-xs font-medium text-slate-600">
            <Icon.Check className="h-3.5 w-3.5" /> Guardado · Sin asignar
            <button
              onClick={onClaim}
              title="Quedarte con este prospecto"
              className="ml-1 rounded-md bg-white px-1.5 py-0.5 text-[11px] font-semibold text-indigo-600 shadow-apple-sm hover:bg-indigo-50"
            >
              Tomar
            </button>
          </span>
        )}
        {b.phone && wa && (
          <a
            href={wa}
            target="_blank"
            rel="noreferrer"
            onClick={(e) => {
              if (!confirmOthers()) {
                e.preventDefault();
                return;
              }
              logWhatsApp({
                leadId: match?.id,
                phone: b.phone,
                name: b.name,
                email: b.email || undefined,
              });
            }}
            className="ml-auto flex items-center gap-1 rounded-lg bg-emerald-500 px-2.5 py-1 text-xs font-semibold text-white hover:bg-emerald-600"
          >
            <Icon.WhatsApp className="h-3.5 w-3.5" /> WhatsApp
          </a>
        )}
        <button
          onClick={() => confirmOthers() && onCompose()}
          className={`${b.phone && wa ? "" : "ml-auto "}rounded-lg bg-indigo-600 px-3 py-1 text-xs font-semibold text-white hover:bg-indigo-700`}
        >
          Propuesta
        </button>
      </div>
      {/* Atribución de la fuente */}
      <p
        className="mt-2 text-[10px] text-slate-400"
        title={
          google
            ? "Contenido de Google: solo para consultar. Al guardarlo se vincula con DENUE o se guarda lo mínimo; no se exporta."
            : undefined
        }
      >
        {sourceCredit(src)}
      </p>
    </CardShell>
  );
}
