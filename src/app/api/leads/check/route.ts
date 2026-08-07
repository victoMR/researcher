import { NextRequest, NextResponse } from "next/server";
import { hasDb } from "@/lib/db";
import { existingKeys } from "@/lib/leads-repo";

export const runtime = "nodejs";

// Recibe dedupe_keys y responde cuáles YA están guardadas (para marcar repetidos).
export async function POST(req: NextRequest) {
  if (!hasDb()) return NextResponse.json({ existing: [] });
  try {
    const { keys } = (await req.json()) as { keys?: string[] };
    const existing = await existingKeys(keys || []);
    return NextResponse.json({ existing });
  } catch (e) {
    console.error("leads check", e);
    return NextResponse.json({ existing: [] });
  }
}
