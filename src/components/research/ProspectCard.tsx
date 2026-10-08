"use client";

import { useState } from "react";
import type { ResearchProspect } from "@/lib/research-types";
import type { Me } from "@/lib/types";
import { buildWaText, logWhatsApp, waLink } from "@/lib/wa";
import { firstName, personName, scoreColor, shortDate, timeAgo } from "@/lib/format";
import { formatBreakdown, scoreLabel, type ScoreDeduction } from "@/lib/scoring";
import * as Icon from "@/components/icons";
import {
  SOURCE_LABEL,
  copyText,
  displayHost,
  isGoogle,
  mailHref,
  safeUrl,
  socialLabel,
  telHref,
} from "./util";

export const cardDomId = (id: string) => `rp-${id}`;

// Desglose del score POR RESTA (modelo de src/lib/scoring.ts): 10 = datos
// completos y activo; cada dato faltante o viejo resta. `deductions` es null si
// el agente no mandó el desglose.
function scoreInfo(p: ResearchProspect): {
  label: string;
  deductions: ScoreDeduction[] | null;
  text: string;
} {
  const label = scoreLabel(p.score);
  const deductions = p.scoreDeductions
    ? p.scoreDeductions
        .filter((d) => d && Number.isFinite(d.points) && d.points !== 0 && d.reason)
        .map((d) => ({ points: -Math.abs(d.points), reason: d.reason }))
    : null;
  let text: string;
  if (deductions?.length) text = formatBreakdown({ score: p.score, max: 10, deductions, label });
  else if (deductions && p.score === 10) text = "Datos completos y activo";
  else text = "Sin desglose del agente";
  return { label, deductions, text };
}

const chip =
  "inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium";
const btn =
  "flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50";

// Una fila del ranking: datos exportables (DENUE / OSM / web), lo de Google
// marcado como referencia, estado en el equipo y el mensaje sugerido.
export default function ProspectCard({
  p,
  rank,
  me,
  checked,
  onToggle,
  saved,
  saving,
  onSave,
  onCompose,
  highlighted,
}: {
  p: ResearchProspect;
  rank: number;
  me: Me | null;
  checked: boolean;
  onToggle: () => void;
  saved: boolean;
  saving: boolean;
  onSave: () => void;
  onCompose: () => void;
  highlighted: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [showWhy, setShowWhy] = useState(false);
  const sc = scoreInfo(p);
  const whyId = `${cardDomId(p.id)}-why`;
  const google = isGoogle(p);
  const ex = p.existing;
  const suppressed = !!ex?.suppressed;
  const owner = ex?.ownerEmail || null;
  const mineOwner = !!owner && owner === me?.email;
  const contactedBy = ex?.contactedBy || null;
  const contactedMine = !!contactedBy && contactedBy === me?.email;
  const isSaved = saved || !!ex?.leadId;

  const emails = [p.email, ...(p.emails ?? [])].filter(
    (e, i, a): e is string => !!e && !!mailHref(e) && a.indexOf(e) === i
  );
  const web = safeUrl(p.website);
  const socials = (p.socials ?? [])
    .map((s) => safeUrl(s))
    .filter((s, i, a): s is string => !!s && a.indexOf(s) === i && s !== web);
  const phoneHref = telHref(p.phone);
  const waNumber = p.whatsapp || p.phone;
  const waText = p.opener || buildWaText({ name: p.name, category: p.category ?? "" }, undefined, me?.name);
  const wa = waNumber ? waLink(waNumber, waText) : null;
  const hasContact = emails.length > 0 || !!phoneHref || !!p.whatsapp || !!web || socials.length > 0;

  const g = p.google;
  const showGoogle = !!g && (g.rating != null || g.reviewCount != null || !!g.lastReviewAgo);

  // Aviso suave si otro vendedor ya lo trabaja (como en Buscar).
  const confirmOthers = () =>
    !owner ||
    mineOwner ||
    confirm(`Este negocio lo trabaja ${personName(owner)}. ¿Escribirle de todos modos?`);

  async function copyOpener() {
    if (!p.opener) return;
    if (await copyText(p.opener)) {
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    }
  }

  return (
    <article
      id={cardDomId(p.id)}
      aria-label={`${rank}. ${p.name}`}
      className={`scroll-mt-24 rounded-2xl border bg-white p-4 shadow-apple-sm transition animate-[fadeIn_0.3s_ease] sm:p-5 ${
        highlighted ? "border-indigo-300 ring-2 ring-indigo-200" : "border-black/5 hover:shadow-apple"
      }`}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onChange={onToggle}
          disabled={google}
          aria-label={`Seleccionar ${p.name}`}
          title={
            google
              ? "Resultado de Google: solo referencia. No se exporta ni se envía a GHL."
              : "Seleccionar para CSV, GHL o Prospectos"
          }
          className="mt-2.5 h-4 w-4 shrink-0 cursor-pointer rounded accent-indigo-600 disabled:cursor-not-allowed disabled:opacity-40"
        />
        <span
          className={`grid h-10 w-10 shrink-0 place-items-center rounded-xl text-base font-bold ${scoreColor(p.score)}`}
          title={`${sc.label} · ${sc.text}`}
          aria-label={`Score ${p.score} de 10, ${sc.label}. ${sc.text}`}
          role="img"
        >
          {p.score}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h4 className="min-w-0 break-words font-semibold text-slate-900">
              <span className="mr-1 text-xs font-medium text-slate-400">#{rank}</span>
              {p.name}
            </h4>
            <span
              className={`${chip} ${
                google ? "bg-amber-50 text-amber-700" : "bg-slate-100 text-slate-500"
              }`}
              title={
                google
                  ? "Encontrado en Google: solo para ver. No se exporta, no va a GHL ni al mapa."
                  : `Datos de ${SOURCE_LABEL[p.source] ?? p.source}`
              }
            >
              {google ? "Google · solo referencia" : SOURCE_LABEL[p.source] ?? p.source}
            </span>
          </div>
          {/* Etiqueta del score y su desglose */}
          <div className="mt-1 flex flex-wrap items-center gap-1.5">
            <span className={`${chip} ${scoreColor(p.score)}`}>{sc.label}</span>
            {sc.deductions && sc.deductions.length === 0 && p.score === 10 ? (
              <span className="text-[11px] text-emerald-700">Datos completos y activo</span>
            ) : sc.deductions && sc.deductions.length > 0 ? (
              <button
                type="button"
                onClick={() => setShowWhy((v) => !v)}
                aria-expanded={showWhy}
                aria-controls={whyId}
                className="flex items-center gap-0.5 rounded-md px-1 text-[11px] font-medium text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
              >
                ¿Por qué {p.score}?
                <Icon.ChevronRight
                  className={`h-3 w-3 transition ${showWhy ? "rotate-90" : ""}`}
                  aria-hidden
                />
              </button>
            ) : null}
          </div>
          {showWhy && sc.deductions && sc.deductions.length > 0 && (
            <div
              id={whyId}
              className="mt-2 rounded-xl border border-black/5 bg-slate-50 px-3 py-2 text-xs text-slate-600"
            >
              <p className="font-medium tabular-nums text-slate-800">{sc.text}</p>
              <ul className="mt-1 space-y-0.5">
                {sc.deductions.map((d, i) => (
                  <li key={`${d.reason}-${i}`} className="flex gap-2">
                    <span className="w-6 shrink-0 text-right font-semibold tabular-nums text-rose-600">
                      −{-d.points}
                    </span>
                    <span>{d.reason}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-xs text-slate-500">
            {p.category && <span>{p.category}</span>}
            {p.lastActivityAt && timeAgo(p.lastActivityAt) && (
              <span className="flex items-center gap-1" title="Señal de actividad más reciente">
                <Icon.Flame className="h-3.5 w-3.5 text-slate-400" />
                Actividad {timeAgo(p.lastActivityAt)}
              </span>
            )}
            {p.employees && (
              <span className="flex items-center gap-1" title="Personal ocupado (DENUE)">
                <Icon.Users className="h-3.5 w-3.5 text-slate-400" />
                {p.employees}
              </span>
            )}
            {p.address && (
              <span className="flex min-w-0 items-center gap-1">
                <Icon.MapPin className="h-3.5 w-3.5 shrink-0 text-slate-400" />
                <span className="line-clamp-1">{p.address}</span>
              </span>
            )}
          </div>

          {/* Estado en el equipo */}
          {(suppressed || owner || contactedBy || ex?.status === "descartado") && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {suppressed && (
                <span className={`${chip} bg-rose-100 font-semibold text-rose-700`}>
                  <Icon.Ban className="h-3 w-3" /> BAJA · no contactar
                </span>
              )}
              {!suppressed && ex?.status === "descartado" && (
                <span className={`${chip} bg-rose-50 text-rose-700`}>Descartado</span>
              )}
              {owner && (
                <span
                  className={`${chip} ${mineOwner ? "bg-indigo-50 text-indigo-700" : "bg-slate-100 text-slate-600"}`}
                  title={owner}
                >
                  <Icon.User className="h-3 w-3" />
                  {mineOwner ? "Tu prospecto" : `Prospecto de ${firstName(owner)}`}
                </span>
              )}
              {contactedBy && (
                <span
                  className={`${chip} ${contactedMine ? "bg-indigo-50 text-indigo-700" : "bg-amber-50 text-amber-800"}`}
                  title={ex?.contactedAt ? shortDate(ex.contactedAt) : undefined}
                >
                  <Icon.Clock className="h-3 w-3" />
                  Contactado por {contactedMine ? "ti" : firstName(contactedBy)}
                  {ex?.contactedAt && ` · ${timeAgo(ex.contactedAt)}`}
                </span>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="mt-3 grid gap-3 sm:pl-20 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        {/* Contacto */}
        <div className="space-y-1.5 text-xs text-slate-600">
          {emails.map((e) => {
            const guess = !!p.emailIsGuess && e === p.email;
            return (
              <a
                key={e}
                href={mailHref(e)!}
                title={guess ? "Correo sugerido: el negocio no lo publica, confírmalo antes" : undefined}
                className={`flex items-center gap-1.5 break-all font-medium hover:underline ${
                  guess ? "text-amber-700" : "text-emerald-700"
                }`}
              >
                <Icon.Mail className="h-3.5 w-3.5 shrink-0" />
                {e}
                {guess && <span className="text-[11px] font-normal text-slate-400">(sugerido)</span>}
              </a>
            );
          })}
          {phoneHref && (
            <a href={phoneHref} className="flex items-center gap-1.5 hover:underline">
              <Icon.Phone className="h-3.5 w-3.5 shrink-0 text-slate-400" />
              {p.phone}
            </a>
          )}
          {p.whatsapp && (
            <span className="flex items-center gap-1.5 text-emerald-700">
              <Icon.WhatsApp className="h-3.5 w-3.5 shrink-0" />
              {p.whatsapp}
              <span className="text-[11px] text-slate-400">(acepta WhatsApp)</span>
            </span>
          )}
          {web && (
            <a
              href={web}
              target="_blank"
              rel="noopener noreferrer nofollow"
              className="flex items-center gap-1.5 text-indigo-600 hover:underline"
            >
              <Icon.Globe className="h-3.5 w-3.5 shrink-0" />
              <span className="truncate">{displayHost(web)}</span>
              {p.websiteOk === false && (
                <span className="shrink-0 text-[11px] text-amber-700">(no respondió)</span>
              )}
            </a>
          )}
          {socials.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {socials.map((s) => (
                <a
                  key={s}
                  href={s}
                  target="_blank"
                  rel="noopener noreferrer nofollow"
                  className="flex items-center gap-1 rounded-md bg-slate-100 px-1.5 py-0.5 text-[11px] font-medium text-slate-600 hover:bg-slate-200"
                >
                  <Icon.ExternalLink className="h-3 w-3" />
                  {socialLabel(s)}
                </a>
              ))}
            </div>
          )}
          {!hasContact && <p className="text-slate-400">Sin datos de contacto públicos.</p>}

          {p.signals.length > 0 && (
            <div className="flex flex-wrap gap-1 pt-1">
              {p.signals.map((s, i) => (
                <span key={`${s}-${i}`} className={`${chip} bg-indigo-50 text-indigo-700`}>
                  {s}
                </span>
              ))}
            </div>
          )}
        </div>

        {/* Por qué + Google */}
        <div className="space-y-2">
          {p.reasons.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                Por qué
              </p>
              <ul className="list-disc space-y-0.5 pl-4 text-xs leading-relaxed text-slate-600 marker:text-slate-300">
                {p.reasons.map((r, i) => (
                  <li key={i}>{r}</li>
                ))}
              </ul>
            </div>
          )}
          {showGoogle && (
            <div
              className="rounded-xl border border-dashed border-slate-200 px-3 py-2 text-xs text-slate-500"
              title="Dato de Google: solo para ver. No se exporta ni se guarda."
            >
              <p className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-400">
                Google · solo referencia
              </p>
              <span className="flex flex-wrap items-center gap-x-1.5">
                {g!.rating != null && (
                  <>
                    <Icon.Star className="h-3.5 w-3.5 text-amber-500" />
                    <span className="font-medium text-slate-700">{g!.rating.toFixed(1)}</span>
                  </>
                )}
                {g!.reviewCount != null && <span>({g!.reviewCount} reseñas)</span>}
                {g!.lastReviewAgo && <span>· última {g!.lastReviewAgo}</span>}
              </span>
            </div>
          )}
        </div>
      </div>

      {/* Mensaje sugerido */}
      {p.opener && (
        <div className="mt-3 rounded-xl bg-slate-50 px-3 py-2.5 sm:ml-20">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="flex items-center gap-1 text-[11px] font-semibold text-indigo-700">
              <Icon.Sparkles className="h-3 w-3" /> Mensaje sugerido
            </span>
            <button
              type="button"
              onClick={copyOpener}
              aria-label={`Copiar mensaje sugerido para ${p.name}`}
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium text-slate-500 hover:bg-white hover:text-slate-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
            >
              {copied ? (
                <>
                  <Icon.Check className="h-3 w-3 text-emerald-600" /> Copiado
                </>
              ) : (
                <>
                  <Icon.Copy className="h-3 w-3" /> Copiar
                </>
              )}
            </button>
          </div>
          <p className="whitespace-pre-line text-sm leading-relaxed text-slate-700">{p.opener}</p>
        </div>
      )}

      {/* Acciones */}
      <div className="mt-3 flex flex-wrap items-center justify-end gap-1.5 sm:pl-20">
        {isSaved ? (
          <span className={`${btn} bg-slate-100 text-slate-500`}>
            <Icon.Check className="h-3.5 w-3.5" /> Guardado
          </span>
        ) : (
          <button
            type="button"
            onClick={onSave}
            disabled={saving}
            title={
              google
                ? "Se guarda solo la referencia y lo que salió de su web; los datos de Google no se guardan."
                : "Guardar en Prospectos"
            }
            className={`${btn} border border-slate-200 bg-white text-slate-600 hover:bg-slate-50`}
          >
            {saving ? <Icon.Loader className="h-3.5 w-3.5" /> : <Icon.Plus className="h-3.5 w-3.5" />}
            Guardar
          </button>
        )}
        {wa &&
          (suppressed ? (
            <button
              type="button"
              disabled
              title="Pidió BAJA: no se le contacta"
              className={`${btn} bg-emerald-500 text-white`}
            >
              <Icon.WhatsApp className="h-3.5 w-3.5" /> WhatsApp
            </button>
          ) : (
            <a
              href={wa}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => {
                if (!confirmOthers()) {
                  e.preventDefault();
                  return;
                }
                logWhatsApp({
                  leadId: ex?.leadId,
                  phone: waNumber,
                  name: p.name,
                  email: emails[0],
                });
              }}
              className={`${btn} bg-emerald-500 text-white hover:bg-emerald-600`}
            >
              <Icon.WhatsApp className="h-3.5 w-3.5" /> WhatsApp
            </a>
          ))}
        <button
          type="button"
          onClick={() => confirmOthers() && onCompose()}
          disabled={suppressed}
          title={suppressed ? "Pidió BAJA: no se le puede escribir" : "Escribir propuesta por correo"}
          className={`${btn} bg-indigo-600 text-white hover:bg-indigo-700`}
        >
          <Icon.Mail className="h-3.5 w-3.5" /> Propuesta
        </button>
      </div>
    </article>
  );
}
