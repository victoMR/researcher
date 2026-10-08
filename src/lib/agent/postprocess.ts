// Post-proceso del reporte: no se le cree al modelo a ciegas.
// - Cada prospecto se ancla a algo que una herramienta devolvió (DENUE, OSM,
//   Google o un sitio revisado); los datos de contacto que "propone" el modelo
//   solo se aceptan si aparecen en evidencia que no es de Google.
// - Los prospectos de Google quedan solo con nombre, place_id, `google` y lo
//   que venga de la web del negocio (no se exportan).
// - Se deduplica, se normalizan teléfonos, se limitan longitudes y el score
//   sale de computeScore() (modelo por resta), no del modelo de IA.
import type { ResearchProspect, ResearchSource, ResearchSummary } from "../research-types";
import { computeScore } from "../scoring";
import { displayPhoneMx, phoneKey } from "../email-extract";
import { cleanPhone, type Evidence, type SeenBusiness } from "./evidence";
import {
  clip,
  clipList,
  clipMultiline,
  cleanEmail,
  cleanUrl,
  distanceM,
  hostOf,
  isNum,
  mergeLists,
  normText,
  ownDomain,
  similarNames,
} from "./normalize";

// ---------- Validación del input de entregar_reporte ----------

export interface DraftProspect {
  id: string;
  name: string;
  source?: string;
  category?: string;
  reasons: string[];
  signals: string[];
  opener?: string;
  email?: string;
  phone?: string;
  whatsapp?: string;
  website?: string;
  socials: string[];
  lastActivityAt?: string;
}

export interface Draft {
  summary: { title?: string; niche?: string; zone?: string; overview?: string; insights: string[]; nextSteps: string[] };
  prospects: DraftProspect[];
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => !!v && typeof v === "object" && !Array.isArray(v);

/** Valida la forma del reporte. Error = mensaje para que el modelo lo reintente. */
export function parseReport(input: unknown): { ok: true; draft: Draft } | { ok: false; error: string } {
  if (!isObj(input)) return { ok: false, error: "El input debe ser un objeto { summary, prospects }." };
  const s = input.summary;
  const list = input.prospects;
  if (!isObj(s)) return { ok: false, error: "Falta 'summary' (objeto con title, niche, zone, overview, insights, nextSteps)." };
  if (!Array.isArray(list)) return { ok: false, error: "Falta 'prospects' (arreglo)." };
  const prospects: DraftProspect[] = [];
  for (const raw of list) {
    if (!isObj(raw)) continue;
    const id = clip(raw.id, 200);
    const name = clip(raw.name, 140);
    if (!id || !name) continue;
    prospects.push({
      id,
      name,
      source: clip(raw.source, 10),
      category: clip(raw.category, 80),
      reasons: clipList(raw.reasons, 4, 260),
      signals: clipList(raw.signals, 8, 140),
      opener: clipMultiline(raw.opener, 800),
      email: clip(raw.email, 120),
      phone: clip(raw.phone, 40),
      whatsapp: clip(raw.whatsapp, 40),
      website: clip(raw.website, 300),
      socials: clipList(raw.socials, 4, 200),
      lastActivityAt: clip(raw.lastActivityAt, 40),
    });
  }
  if (list.length && !prospects.length) {
    return { ok: false, error: "Ningún prospecto trae 'id' y 'name'. Revisa el formato." };
  }
  return {
    ok: true,
    draft: {
      summary: {
        title: clip(s.title, 140),
        niche: clip(s.niche, 80),
        zone: clip(s.zone, 120),
        overview: clipMultiline(s.overview, 3000),
        insights: clipList(s.insights, 6, 320),
        nextSteps: clipList(s.nextSteps, 5, 320),
      },
      prospects,
    },
  };
}

// ---------- Armado de prospectos ----------

const PRIORITY: Record<ResearchSource, number> = { denue: 4, osm: 3, web: 2, google: 1 };

// Prospecto en construcción (+ datos internos que no se guardan).
interface Work {
  p: ResearchProspect;
  pos?: { lat: number; lon: number }; // también de Google (solo para empatar)
  status?: string; // businessStatus de Google
}

export interface BuildStats {
  unanchored: string[]; // prospectos del modelo sin evidencia (descartados)
  rejectedClaims: number; // datos de contacto sin fuente verificable (descartados)
  merged: number; // duplicados fusionados
}

function validIsoDate(v: string | undefined, nowMs: number): string | undefined {
  if (!v) return undefined;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return undefined;
  if (ms > nowMs + 2 * 86400000 || ms < Date.parse("2005-01-01")) return undefined;
  return new Date(ms).toISOString();
}

function latest(...v: (string | undefined)[]): string | undefined {
  const ok = v.filter((x): x is string => !!x && Number.isFinite(Date.parse(x)));
  if (!ok.length) return undefined;
  return ok.reduce((a, b) => (Date.parse(a) >= Date.parse(b) ? a : b));
}

// Busca la entidad de un id del modelo (acepta variantes comunes).
function resolveEntity(d: DraftProspect, ev: Evidence): SeenBusiness | undefined {
  const id = d.id.trim();
  const tries = [id];
  if (/^(node|way|relation)\/\d+$/.test(id)) tries.push(`osm/${id}`);
  if (/^\d+$/.test(id)) tries.push(`denue/${id}`);
  if (!id.includes("/")) tries.push(`place/${id}`);
  for (const t of tries) {
    const hit = ev.businesses.get(t);
    if (hit) return hit;
  }
  // Por nombre exacto (normalizado), prefiriendo fuentes abiertas.
  const n = normText(d.name);
  const byName = [...ev.businesses.values()]
    .filter((b) => normText(b.name) === n)
    .sort((a, b) => PRIORITY[b.source] - PRIORITY[a.source]);
  return byName[0];
}

// Google del mismo negocio (nombre parecido y a menos de 150 m).
function googleTwin(b: { name: string; lat?: number; lon?: number }, ev: Evidence): SeenBusiness | undefined {
  let best: SeenBusiness | undefined;
  let bestD = 150;
  for (const g of ev.businesses.values()) {
    if (g.source !== "google") continue;
    const d = distanceM(b, g);
    if (d < bestD && similarNames(b.name, g.name)) {
      best = g;
      bestD = d;
    }
  }
  return best;
}

// Fuente abierta del mismo negocio que un lugar de Google.
function openTwin(g: SeenBusiness, ev: Evidence): SeenBusiness | undefined {
  let best: SeenBusiness | undefined;
  let bestD = 150;
  for (const b of ev.businesses.values()) {
    if (b.source === "google") continue;
    const d = distanceM(b, g);
    if (d < bestD && similarNames(b.name, g.name)) {
      best = b;
      bestD = d;
    }
  }
  return best;
}

function fromEntity(ent: SeenBusiness, d: DraftProspect | null, niche?: string): Work {
  const open = ent.source !== "google";
  const name = d && similarNames(d.name, ent.name) ? d.name : ent.name;
  const p: ResearchProspect = {
    id: ent.id,
    source: ent.source,
    name: clip(name, 140) ?? ent.name,
    // En OSM la "categoría" es una etiqueta técnica (amenity=dentist): mejor el nicho.
    category:
      clip(d?.category, 80) ??
      (ent.source !== "osm" ? clip(ent.category, 80) : undefined) ??
      clip(niche, 80) ??
      clip(ent.category, 80),
    ...(open && ent.address ? { address: clip(ent.address, 220) } : {}),
    ...(open && isNum(ent.lat) && isNum(ent.lon) ? { lat: ent.lat, lon: ent.lon } : {}),
    ...(open && ent.phone ? { phone: displayPhoneMx(ent.phone) ?? clip(ent.phone, 40) } : {}),
    ...(open && ent.email ? { email: ent.email } : {}),
    ...(open && ent.website ? { website: ent.website } : {}),
    ...(ent.employees ? { employees: clip(ent.employees, 60) } : {}),
    ...(ent.denueId ? { denueId: ent.denueId } : {}),
    ...(ent.osmId ? { osmId: ent.osmId } : {}),
    ...(ent.placeId ? { placeId: ent.placeId } : {}),
    ...(ent.google ? { google: ent.google } : {}),
    ...(ent.lastActivityAt ? { lastActivityAt: ent.lastActivityAt } : {}),
    score: 1,
    reasons: d?.reasons ?? [],
    signals: d?.signals ?? [],
    ...(d?.opener ? { opener: d.opener } : {}),
  };
  return {
    p,
    pos: isNum(ent.lat) && isNum(ent.lon) ? { lat: ent.lat, lon: ent.lon } : undefined,
    status: ent.businessStatus,
  };
}

// Aplica Google (place_id + referencia) a un prospecto de fuente abierta.
function attachGoogle(w: Work, g: SeenBusiness | undefined) {
  if (!g) return;
  w.p.placeId ??= g.placeId;
  w.p.google ??= g.google;
  w.p.lastActivityAt = latest(w.p.lastActivityAt, g.lastActivityAt);
  w.status ??= g.businessStatus;
}

// Datos de la web del negocio (revisar_sitio) y marca de sitio vivo.
function attachSite(w: Work, ev: Evidence) {
  const site = ev.siteFor(w.p.website);
  if (!site) return;
  const p = w.p;
  p.websiteOk = site.reachable;
  if (!site.reachable) return;
  const emails = [...(p.email ? [p.email] : []), ...(p.emails ?? []), ...site.emails];
  const uniq = [...new Set(emails.map((e) => e.toLowerCase()))].slice(0, 5);
  if (uniq.length) {
    p.email ??= uniq[0];
    p.emails = uniq;
    delete p.emailIsGuess;
  } else if (site.guesses.length && !p.email) {
    p.email = site.guesses[0];
    p.emailIsGuess = true;
  }
  p.whatsapp ??= site.whatsapp;
  p.phone ??= site.phones[0];
  p.socials = clipList([...(p.socials ?? []), ...site.socials], 4, 200);
  p.signals = mergeLists(p.signals, site.signals, 8);
}

// Datos que propone el modelo: solo si hay evidencia no-Google.
function applyClaims(w: Work, d: DraftProspect, ev: Evidence): number {
  let rejected = 0;
  const p = w.p;
  const email = cleanEmail(d.email);
  if (d.email) {
    if (email && ev.emailOk(email)) {
      if (!p.email || p.emailIsGuess) {
        p.email = email;
        delete p.emailIsGuess;
      }
      p.emails = [...new Set([...(p.emails ?? []), email])].slice(0, 5);
    } else rejected++;
  }
  for (const key of ["phone", "whatsapp"] as const) {
    if (!d[key]) continue;
    const ph = cleanPhone(d[key]);
    if (ph && ev.phoneOk(ph)) p[key] ??= ph;
    else rejected++;
  }
  if (d.website) {
    const url = cleanUrl(d.website);
    if (url && ev.hostOk(url)) p.website ??= url;
    else rejected++;
  }
  const socials = d.socials.map(cleanUrl).filter((u): u is string => !!u);
  const okSocials = socials.filter((u) => ev.urlOk(u));
  rejected += socials.length - okSocials.length;
  if (okSocials.length) p.socials = clipList([...(p.socials ?? []), ...okSocials], 4, 200);
  return rejected;
}

// Un prospecto solo-Google con web propia verificada pasa a fuente "web".
function promoteGoogle(w: Work, ev: Evidence) {
  const p = w.p;
  if (p.source !== "google") return;
  const host = p.website && ev.hostOk(p.website) ? hostOf(p.website) : undefined;
  if (host && ownDomain(p.website)) {
    p.source = "web";
    p.id = `web/${host}`;
    return;
  }
  // Se queda como Google: fuera todo lo que no venga de la web del negocio.
  delete p.address;
  delete p.lat;
  delete p.lon;
  delete p.website;
  delete p.websiteOk;
}

function sameBusiness(a: Work, b: Work): boolean {
  const pa = a.p;
  const pb = b.p;
  if (pa.id === pb.id) return true;
  if (pa.denueId && pa.denueId === pb.denueId) return true;
  if (pa.osmId && pa.osmId === pb.osmId) return true;
  if (pa.placeId && pa.placeId === pb.placeId) return true;
  const phonesA = [pa.phone, pa.whatsapp].map(phoneKey).filter((k) => k.length === 10);
  const phonesB = [pb.phone, pb.whatsapp].map(phoneKey).filter((k) => k.length === 10);
  if (phonesA.some((k) => phonesB.includes(k))) return true;
  const da = ownDomain(pa.website);
  if (da && da === ownDomain(pb.website)) return true;
  if (pa.email && !pa.emailIsGuess && pa.email === pb.email && !pb.emailIsGuess) return true;
  if (a.pos && b.pos && distanceM(a.pos, b.pos) < 150 && similarNames(pa.name, pb.name)) return true;
  return false;
}

function mergeInto(base: Work, other: Work) {
  const p = base.p;
  const o = other.p;
  const openOther = o.source !== "google";
  p.address ??= openOther ? o.address : undefined;
  if (!isNum(p.lat) && openOther && isNum(o.lat) && isNum(o.lon)) {
    p.lat = o.lat;
    p.lon = o.lon;
  }
  if (!p.email || (p.emailIsGuess && o.email && !o.emailIsGuess)) {
    if (o.email) {
      p.email = o.email;
      p.emailIsGuess = o.emailIsGuess;
      if (!p.emailIsGuess) delete p.emailIsGuess;
    }
  }
  p.emails = [...new Set([...(p.emails ?? []), ...(o.emails ?? [])])].slice(0, 5);
  if (!p.emails.length) delete p.emails;
  p.phone ??= o.phone;
  p.whatsapp ??= o.whatsapp;
  p.website ??= o.website;
  p.websiteOk ??= o.websiteOk;
  p.employees ??= o.employees;
  p.denueId ??= o.denueId;
  p.osmId ??= o.osmId;
  p.placeId ??= o.placeId;
  p.google ??= o.google;
  p.category ??= o.category;
  p.lastActivityAt = latest(p.lastActivityAt, o.lastActivityAt);
  p.socials = clipList([...(p.socials ?? []), ...(o.socials ?? [])], 4, 200);
  p.reasons = mergeLists(p.reasons, o.reasons, 4);
  p.signals = mergeLists(p.signals, o.signals, 8);
  p.opener ??= o.opener;
  base.pos ??= other.pos;
  base.status ??= other.status;
}

function dedupe(list: Work[]): { out: Work[]; merged: number } {
  const sorted = [...list].sort((a, b) => PRIORITY[b.p.source] - PRIORITY[a.p.source]);
  const out: Work[] = [];
  let merged = 0;
  // Conserva el orden del modelo para lo que no se fusiona.
  const order = new Map(list.map((w, i) => [w, i]));
  for (const w of sorted) {
    const twin = out.find((x) => sameBusiness(x, w));
    if (twin) {
      mergeInto(twin, w);
      order.set(twin, Math.min(order.get(twin) ?? 0, order.get(w) ?? 0));
      merged++;
    } else out.push(w);
  }
  out.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return { out, merged };
}

function score(w: Work, nowIso: string) {
  const p = w.p;
  const r = computeScore({
    phone: p.phone,
    whatsapp: p.whatsapp,
    email: p.email,
    emailIsGuess: p.emailIsGuess,
    website: p.website,
    address: p.address,
    businessStatus: w.status,
    lastActivityAt: p.lastActivityAt,
    websiteOk: p.websiteOk,
    dataCheckedAt: nowIso,
  });
  p.score = r.score;
  p.scoreDeductions = r.deductions;
}

// Ordena por score y, en empate, por cantidad de señales + razones.
function rankAndCut(list: Work[], max: number): ResearchProspect[] {
  return list
    .map((w, i) => ({ w, i }))
    .sort((a, b) => {
      const ds = b.w.p.score - a.w.p.score;
      if (ds) return ds;
      const dr = b.w.p.signals.length + b.w.p.reasons.length - (a.w.p.signals.length + a.w.p.reasons.length);
      return dr || a.i - b.i;
    })
    .slice(0, max)
    .map(({ w }) => tidy(w.p));
}

// Quita vacíos y normaliza teléfonos para guardar.
function tidy(p: ResearchProspect): ResearchProspect {
  if (p.phone) p.phone = displayPhoneMx(p.phone) ?? p.phone;
  if (p.whatsapp) p.whatsapp = displayPhoneMx(p.whatsapp) ?? p.whatsapp;
  if (p.emails && !p.emails.length) delete p.emails;
  if (p.socials && !p.socials.length) delete p.socials;
  for (const k of Object.keys(p) as (keyof ResearchProspect)[]) {
    if (p[k] === undefined) delete p[k];
  }
  return p;
}

/** Prospectos finales a partir del reporte del modelo + la evidencia. */
export function buildProspects(
  draft: Draft,
  ev: Evidence,
  o: { max: number; nowIso: string }
): { prospects: ResearchProspect[]; stats: BuildStats } {
  const nowMs = Date.parse(o.nowIso);
  const stats: BuildStats = { unanchored: [], rejectedClaims: 0, merged: 0 };
  const works: Work[] = [];
  for (const d of draft.prospects) {
    let ent = resolveEntity(d, ev);
    if (!ent) {
      // Negocio encontrado solo en la web: exige que su sitio se haya visto.
      const url = cleanUrl(d.website) ?? (d.id.startsWith("web/") ? cleanUrl(d.id.slice(4)) : undefined);
      const host = url && ev.hostOk(url) ? ownDomain(url) : undefined;
      if (!host) {
        stats.unanchored.push(d.name);
        continue;
      }
      ent = { id: `web/${host}`, source: "web", name: d.name, website: ev.siteFor(url)?.url ?? url };
    }
    // Un lugar de Google que también está en DENUE/OSM se trabaja con la fuente abierta.
    let google: SeenBusiness | undefined;
    if (ent.source === "google") {
      const twin = openTwin(ent, ev);
      if (twin) {
        google = ent;
        ent = twin;
      }
    } else {
      google = googleTwin(ent, ev);
    }
    const w = fromEntity(ent, d, draft.summary.niche);
    if (ent.source === "google") {
      w.p.google = ent.google;
      w.p.placeId = ent.placeId;
    }
    attachGoogle(w, google);
    stats.rejectedClaims += applyClaims(w, d, ev);
    w.p.lastActivityAt = latest(w.p.lastActivityAt, validIsoDate(d.lastActivityAt, nowMs));
    promoteGoogle(w, ev);
    attachSite(w, ev);
    if (!w.p.reasons.length) w.p.reasons = autoReasons(w.p);
    works.push(w);
  }
  const { out, merged } = dedupe(works);
  stats.merged = merged;
  out.forEach((w) => score(w, o.nowIso));
  return { prospects: rankAndCut(out, o.max), stats };
}

// ---------- Resumen ----------

const SOURCE_LABEL: Record<ResearchSource, string> = {
  denue: "DENUE (INEGI)",
  osm: "OpenStreetMap",
  web: "Web del negocio",
  google: "Google (solo referencia)",
};

export function sourceLabel(s: ResearchSource): string {
  return SOURCE_LABEL[s];
}

export function buildSummary(
  draft: Draft["summary"],
  prospects: ResearchProspect[],
  fallback: { niche?: string; zone?: string; prompt: string }
): ResearchSummary {
  const niche = draft.niche ?? fallback.niche ?? "Negocios";
  const zone = draft.zone ?? fallback.zone ?? "";
  const counts = new Map<ResearchSource, number>();
  prospects.forEach((p) => counts.set(p.source, (counts.get(p.source) ?? 0) + 1));
  return {
    title: draft.title ?? (zone ? `${niche} en ${zone}` : clip(fallback.prompt, 100) ?? "Investigación"),
    niche,
    zone,
    overview: draft.overview ?? "",
    insights: draft.insights,
    nextSteps: draft.nextSteps,
    sources: (["denue", "osm", "web", "google"] as ResearchSource[])
      .filter((s) => counts.get(s))
      .map((s) => ({ name: SOURCE_LABEL[s], count: counts.get(s)! })),
    stats: {
      total: prospects.length,
      withEmail: prospects.filter((p) => p.email && !p.emailIsGuess).length,
      withPhone: prospects.filter((p) => p.phone).length,
      withWhatsapp: prospects.filter((p) => p.whatsapp).length,
    },
  };
}

// ---------- Reporte de respaldo (si la IA no terminó) ----------

function autoReasons(p: ResearchProspect): string[] {
  const r: string[] = [];
  if (p.employees) r.push(`Personal ocupado: ${p.employees}.`);
  const contact = [p.email && !p.emailIsGuess ? "correo" : null, p.whatsapp ? "WhatsApp" : null, p.phone ? "teléfono" : null]
    .filter(Boolean)
    .join(", ");
  if (contact) r.push(`Tiene ${contact} publicado${contact.includes(",") ? "s" : ""}.`);
  const pain = p.signals.find((s) => /meta pixel|google ads|tiktok/i.test(s));
  const gap = p.signals.find((s) => /^sin (whatsapp|chat|formulario)/i.test(s));
  if (pain && gap) r.push(`${pain}, pero: ${gap.toLowerCase()}.`);
  if (p.google?.reviewCount) r.push(`${p.google.reviewCount} reseñas en Google (activo).`);
  return r.slice(0, 3);
}

function genericOpener(name: string, niche: string, vendor: string): string {
  return `Hola, equipo de ${name}. Le escribo de AI Lead Shield: ayudamos a ${niche.toLowerCase()} a responder al instante por WhatsApp y en su web, dar seguimiento automático y agendar citas sin perder prospectos. ¿Le interesaría ver cómo funcionaría en su negocio en una llamada de 15 minutos esta semana? — ${vendor}, AI Lead Shield`;
}

/** Arma un reporte con lo reunido cuando el modelo no entregó a tiempo. */
export function fallbackReport(
  ev: Evidence,
  o: { max: number; nowIso: string; vendorName: string; prompt: string }
): { prospects: ResearchProspect[]; summary: ResearchSummary } {
  const niche = [...ev.keywords][0] ?? "negocios";
  const works: Work[] = [];
  for (const b of ev.businesses.values()) {
    if (b.source === "google") continue;
    const w = fromEntity(b, null, niche);
    attachGoogle(w, googleTwin(b, ev));
    attachSite(w, ev);
    w.p.reasons = autoReasons(w.p);
    w.p.opener = genericOpener(w.p.name, niche, o.vendorName);
    works.push(w);
  }
  const { out } = dedupe(works);
  out.forEach((w) => score(w, o.nowIso));
  const prospects = rankAndCut(out, o.max);
  const zone = ev.zone?.shortName;
  const summary = buildSummary(
    {
      title: zone ? `${niche.charAt(0).toUpperCase() + niche.slice(1)} en ${zone}` : undefined,
      niche,
      zone,
      overview:
        "**Reporte automático.** La IA no alcanzó a terminar el análisis a tiempo, así que esta lista se armó con los datos que ya se habían reunido (DENUE, OpenStreetMap y sitios revisados), sin análisis detallado ni mensajes personalizados.",
      insights: [`Se reunieron ${prospects.length} negocios con datos abiertos.`],
      nextSteps: [
        "Revisa a mano los primeros de la lista.",
        "Vuelve a lanzar la investigación con una zona o un nicho más acotado para obtener el análisis completo.",
      ],
    },
    prospects,
    { niche, zone, prompt: o.prompt }
  );
  return { prospects, summary };
}
