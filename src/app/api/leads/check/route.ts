import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { findMatches } from "@/lib/leads-repo";

export const runtime = "nodejs";

const MAX = 500;
const strings = (v: unknown) =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, MAX) : [];

// Recibe dedupe_keys (y opcionalmente ids) de resultados de búsqueda y responde
// cuáles YA están guardados y con quién: { existing, matches }.
export async function POST(req: NextRequest) {
  if (!hasDb()) return NextResponse.json({ existing: [], matches: [] });
  try {
    const body = ((await req.json().catch(() => null)) ?? {}) as {
      keys?: unknown;
      ids?: unknown;
    };
    const keys = strings(body.keys);
    const matches = await findMatches(keys, strings(body.ids));
    const asked = new Set(keys);
    const existing = [...new Set(matches.map((m) => m.key).filter((k) => asked.has(k)))];
    return NextResponse.json({ existing, matches });
  } catch (e) {
    console.error("leads check", e);
    return NextResponse.json({ existing: [], matches: [] });
  }
}
