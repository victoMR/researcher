// Cliente de GoHighLevel (LeadConnector) API v2.
// Usa el Private Integration Token (PIT) y el Location ID desde variables de entorno.
const BASE = "https://services.leadconnectorhq.com";
const VERSION = "2021-07-28";

export function ghlReady(): boolean {
  return !!process.env.GHL_PIT && !!process.env.GHL_LOCATION_ID;
}

function headers() {
  return {
    Authorization: `Bearer ${process.env.GHL_PIT}`,
    Version: VERSION,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function req(path: string, init?: RequestInit) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: headers() });
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { ok: res.ok, status: res.status, body };
}

// Prueba de conexión: lista 1 contacto (requiere contacts.readonly).
export async function ping() {
  const loc = process.env.GHL_LOCATION_ID;
  return req(`/contacts/?locationId=${loc}&limit=1`);
}

// Sube / actualiza un prospecto como contacto en GHL (contacts.write).
export async function upsertContact(input: {
  name: string;
  email?: string;
  phone?: string;
  companyName?: string;
  source?: string;
  tags?: string[];
}) {
  return req(`/contacts/upsert`, {
    method: "POST",
    body: JSON.stringify({
      locationId: process.env.GHL_LOCATION_ID,
      name: input.name,
      email: input.email,
      phone: input.phone,
      companyName: input.companyName,
      source: input.source ?? "AI Lead Shield",
      tags: input.tags,
    }),
  });
}
