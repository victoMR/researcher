import type { Business, GoogleLivePatch, KnownResult } from "./types";
import { googleLive, hasCoords, placeIdOf, sourceOf } from "./types";
import { computeScore } from "./scoring";
import { distanceM, nameSimilarity } from "./denue";

// Búsqueda mixta: DENUE + Google en paralelo para la misma ciudad y giro.
// Aquí solo hay funciones puras (fusión, orden y token); las llamadas están en
// src/app/api/search/route.ts.
//
// Un resultado de Google es el mismo negocio que uno de DENUE si:
//  - el nombre se parece (nameSimilarity ≥ 0.6, el umbral con el que saveLead
//    vincula con DENUE) y están a ≤ 250 m, o
//  - tienen el mismo teléfono (10 dígitos) a ≤ 3 km, y ese teléfono no se repite
//    en su lista (un conmutador o un 800 de cadena no sirve para emparejar).
// Pareo uno a uno, primero los pares más fuertes (teléfono + nombre > nombre).
// Emparejado -> UN negocio con los datos de DENUE (id "denue/…", se guarda y
// exporta) + placeId y las señales de Google (rating, reseñas, última reseña,
// businessStatus) SOLO para ver en vivo. Sin pareja -> queda solo-Google.
// Un segundo resultado de Google que empata con un DENUE ya emparejado se toma
// como ficha repetida del mismo negocio y se descarta (al guardarlo se vincularía
// con el mismo prospecto de todos modos).

export const MATCH_MAX_M = 250;
export const MATCH_MIN_NAME = 0.6;
export const PHONE_MAX_M = 3000;

// Teléfono MX a 10 dígitos para comparar (undefined si no sirve para emparejar).
export function phoneKey(phone?: string | null): string | undefined {
  if (!phone) return undefined;
  let d = phone.replace(/\D/g, "");
  if (d.length === 13 && /^(521|044|045)/.test(d)) d = d.slice(3);
  else if (d.length === 12 && /^(52|01)/.test(d)) d = d.slice(2);
  if (d.length !== 10 || /^(\d)\1+$/.test(d)) return undefined;
  if (/^(800|900|300|500)/.test(d)) return undefined; // números nacionales compartidos
  return d;
}

type MatchItem = Pick<Business, "id" | "name" | "lat" | "lon" | "phone">;

interface Pair {
  d: number; // índice en la lista DENUE
  g: number; // índice en la lista Google
  strength: number;
}

function countPhones(list: MatchItem[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const b of list) {
    const k = phoneKey(b.phone);
    if (k) m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

// Todos los pares candidatos (DENUE, Google), del más fuerte al más débil.
function candidatePairs(denue: MatchItem[], google: MatchItem[]): Pair[] {
  const dPhones = countPhones(denue);
  const gPhones = countPhones(google);
  const pairs: Pair[] = [];
  google.forEach((g, gi) => {
    const gp = phoneKey(g.phone);
    const gUnique = !!gp && gPhones.get(gp) === 1;
    denue.forEach((d, di) => {
      const dist = hasCoords(g) && hasCoords(d) ? distanceM(g.lat, g.lon, d.lat, d.lon) : undefined;
      const dp = phoneKey(d.phone);
      const phoneOk =
        gUnique && gp === dp && dPhones.get(dp) === 1 && (dist === undefined || dist <= PHONE_MAX_M);
      const near = dist !== undefined && dist <= MATCH_MAX_M;
      if (!phoneOk && !near) return; // descarte barato antes de comparar nombres
      const sim = nameSimilarity(g.name, d.name);
      const nameOk = near && sim >= MATCH_MIN_NAME;
      if (!phoneOk && !nameOk) return;
      pairs.push({
        d: di,
        g: gi,
        // Teléfono y nombre > solo uno; luego nombre más parecido; luego más cerca.
        strength: (phoneOk ? 1 : 0) + (nameOk ? 1 : 0) + sim - (dist ?? PHONE_MAX_M) / 1e6,
      });
    });
  });
  return pairs.sort((a, b) => b.strength - a.strength);
}

/* ---------- Orden ---------- */

// El mismo score que muestra la UI (sin "sitio leído": eso se sabe después).
export function mixedScore(b: Business): number {
  return computeScore({
    phone: b.phone,
    email: b.email,
    emailIsGuess: b.emailIsGuess,
    website: b.website,
    address: b.address,
    businessStatus: b.status,
    lastActivityAt: b.lastReviewTime,
  }).score;
}

// Más accionables primero: correo, web, teléfono; luego más empleados (DENUE).
export function contactRank(b: Business): number {
  const size = Number(/^(\d+)/.exec(b.employees ?? "")?.[1] ?? 0);
  return (b.email ? 4 : 0) + (b.website ? 2 : 0) + (b.phone ? 1 : 0) + Math.min(size, 251) / 1000;
}

// DENUE + Google > DENUE > solo-Google (lo exportable primero).
function sourceRank(b: Business): number {
  if (sourceOf(b) !== "denue") return 0;
  return b.placeId ? 2 : 1;
}

export function sortMixed(list: Business[]): Business[] {
  const key = new Map(list.map((b) => [b, { s: mixedScore(b), c: contactRank(b) }]));
  return [...list].sort((a, b) => {
    const ka = key.get(a)!;
    const kb = key.get(b)!;
    return (
      kb.s - ka.s ||
      kb.c - ka.c ||
      sourceRank(b) - sourceRank(a) ||
      a.name.localeCompare(b.name, "es")
    );
  });
}

/* ---------- Fusión ---------- */

export interface MixedPage {
  results: Business[]; // nuevos para agregar, ya ordenados
  updates: GoogleLivePatch[]; // señales de Google para tarjetas DENUE ya mostradas
  mergedIds: string[]; // tarjetas solo-Google ya mostradas que se quitan (unidas a un DENUE nuevo o repetidas)
  stats: { denue: number; google: number; merged: number; duplicates: number };
}

const fromKnown = (k: KnownResult): Business => ({
  id: k.id,
  name: k.name,
  category: "",
  phone: k.phone,
  lat: k.lat ?? NaN,
  lon: k.lon ?? NaN,
  placeId: k.placeId,
});

/**
 * Une una página de DENUE con una de Google. `known` = tarjetas ya mostradas
 * (solo en "Cargar más"): lo nuevo también se empareja contra ellas para no
 * duplicar:
 *  - Google nuevo = DENUE ya mostrado -> `updates` (sus señales a esa tarjeta).
 *  - DENUE nuevo = solo-Google ya mostrado -> el DENUE llega con su placeId y la
 *    tarjeta de Google va en `mergedIds` (el cliente la quita; ver applyPage).
 *  - Lo que ya se mostró (mismo id o place_id) no se repite.
 */
export function mergeMixed(
  denue: Business[],
  google: Business[],
  known: KnownResult[] = []
): MixedPage {
  const knownIds = new Set(known.map((k) => k.id));
  const knownPlaces = new Set(known.map((k) => placeIdOf(k)).filter(Boolean));
  let duplicates = 0;

  // Sin duplicados internos ni contra lo ya mostrado.
  const newDenue: Business[] = [];
  const seenDenue = new Set<string>();
  for (const d of denue) {
    if (knownIds.has(d.id) || seenDenue.has(d.id)) {
      duplicates++;
      continue;
    }
    seenDenue.add(d.id);
    newDenue.push(d);
  }
  const newGoogle: Business[] = [];
  const seenPlaces = new Set<string>();
  for (const g of google) {
    const p = placeIdOf(g) ?? g.id;
    if (knownIds.has(g.id) || knownPlaces.has(p) || seenPlaces.has(p)) {
      duplicates++;
      continue;
    }
    seenPlaces.add(p);
    newGoogle.push(g);
  }

  // Pools: nuevos + ya mostrados. Un DENUE ya mostrado con placeId está "tomado".
  const knownDenue = known.filter((k) => k.id.startsWith("denue/"));
  const knownGoogle = known.filter((k) => k.id.startsWith("place/"));
  const D = [
    ...newDenue.map((b) => ({ b, known: false, taken: false })),
    ...knownDenue.map((k) => ({ b: fromKnown(k), known: true, taken: !!k.placeId })),
  ];
  const G = [
    ...newGoogle.map((b) => ({ b, known: false })),
    ...knownGoogle.map((k) => ({ b: fromKnown(k), known: true })),
  ];

  const pairs = candidatePairs(
    D.map((x) => x.b),
    G.map((x) => x.b)
  ).filter((p) => !(D[p.d].known && G[p.g].known)); // ya se compararon antes

  const dPair = new Map<number, number>(); // D -> G
  const gPair = new Map<number, number>(); // G -> D
  const gHasCandidate = new Set<number>();
  for (const p of pairs) {
    gHasCandidate.add(p.g);
    if (D[p.d].taken || dPair.has(p.d) || gPair.has(p.g)) continue;
    dPair.set(p.d, p.g);
    gPair.set(p.g, p.d);
  }

  const results: Business[] = [];
  const updates: GoogleLivePatch[] = [];
  const mergedIds: string[] = [];
  let merged = 0;

  D.forEach((d, di) => {
    const gi = dPair.get(di);
    const g = gi === undefined ? undefined : G[gi];
    if (!g) {
      if (!d.known) results.push(d.b);
      return;
    }
    merged++;
    const placeId = placeIdOf(g.b);
    if (d.known) {
      // Google nuevo = tarjeta DENUE ya mostrada: solo sus señales en vivo.
      updates.push({ id: d.b.id, placeId, ...googleLive(g.b) });
      return;
    }
    results.push({ ...d.b, placeId, ...googleLive(g.b) });
    if (g.known) mergedIds.push(g.b.id); // la tarjeta solo-Google se une a este DENUE
  });

  G.forEach((g, gi) => {
    if (gPair.has(gi)) return;
    if (gHasCandidate.has(gi)) {
      // Empata con un DENUE que ya tiene su ficha de Google: ficha repetida.
      duplicates++;
      if (g.known) mergedIds.push(g.b.id);
      return;
    }
    if (!g.known) results.push(g.b);
  });

  return {
    results: sortMixed(results),
    updates,
    mergedIds,
    stats: {
      denue: newDenue.length,
      google: newGoogle.length,
      merged,
      duplicates,
    },
  };
}

/* ---------- Token de página combinado ---------- */

// Opaco para el cliente: base64url de { v:1, s:"mixta", d?, g?, c, q }.
// d = token propio de DENUE, g = token propio de Google (cada uno se valida
// con su decodificador); c = giro, q = ciudad normalizada (normalizeKeyPart).
export interface MixedCursor {
  d?: string;
  g?: string;
  c: string;
  q: string;
}

export function encodeMixedCursor(cur: MixedCursor): string {
  const o: Record<string, unknown> = { v: 1, s: "mixta" };
  if (cur.d) o.d = cur.d;
  if (cur.g) o.g = cur.g;
  o.c = cur.c;
  o.q = cur.q;
  return Buffer.from(JSON.stringify(o)).toString("base64url");
}

export function decodeMixedCursor(token: string): MixedCursor | null {
  try {
    const o = JSON.parse(Buffer.from(token, "base64url").toString("utf8")) as Record<string, unknown>;
    if (!o || o.v !== 1 || o.s !== "mixta") return null;
    if (typeof o.c !== "string" || typeof o.q !== "string" || !o.c || !o.q) return null;
    const d = typeof o.d === "string" && o.d ? o.d : undefined;
    const g = typeof o.g === "string" && o.g ? o.g : undefined;
    if (!d && !g) return null;
    return { c: o.c, q: o.q, ...(d ? { d } : {}), ...(g ? { g } : {}) };
  } catch {
    return null;
  }
}

/* ---------- Entrada del cliente ---------- */

const MAX_KNOWN = 3000;
const str = (v: unknown, max: number) =>
  typeof v === "string" && v.length > 0 && v.length <= max ? v : undefined;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);

// Valida `known` (tarjetas ya mostradas) del cuerpo de "Cargar más".
export function parseKnown(v: unknown): KnownResult[] {
  if (!Array.isArray(v)) return [];
  const out: KnownResult[] = [];
  for (const x of v.slice(0, MAX_KNOWN)) {
    if (!x || typeof x !== "object") continue;
    const r = x as Record<string, unknown>;
    const id = str(r.id, 300);
    const name = str(r.name, 300);
    if (!id || !name) continue;
    const phone = str(r.phone, 60);
    const placeId = str(r.placeId, 300);
    out.push({
      id,
      name,
      lat: num(r.lat),
      lon: num(r.lon),
      ...(phone ? { phone } : {}),
      ...(placeId ? { placeId } : {}),
    });
  }
  return out;
}
