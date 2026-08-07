// Cliente de GoHighLevel (LeadConnector) API v2.
// Usa el Private Integration Token (PIT) y el Location ID desde variables de entorno.
const BASE = "https://services.leadconnectorhq.com";
// Cada familia de endpoints pide su propia versión de API.
const V_CONTACTS = "2021-07-28";
const V_CONVERSATIONS = "2021-04-15";

export function ghlReady(): boolean {
  return !!process.env.GHL_PIT && !!process.env.GHL_LOCATION_ID;
}

function headers(version: string) {
  return {
    Authorization: `Bearer ${process.env.GHL_PIT}`,
    Version: version,
    Accept: "application/json",
    "Content-Type": "application/json",
  };
}

async function req(path: string, init?: RequestInit, version = V_CONTACTS) {
  const res = await fetch(`${BASE}${path}`, { ...init, headers: headers(version) });
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

// Saca el id del contacto de la respuesta de /contacts/upsert (la forma del
// body ha cambiado entre versiones: unas veces viene en `contact`, otras plano).
export function contactIdFrom(body: unknown): string | null {
  const b = body as
    | { contact?: { id?: string; contactId?: string }; id?: string; contactId?: string }
    | undefined;
  return b?.contact?.id ?? b?.contact?.contactId ?? b?.id ?? b?.contactId ?? null;
}

// ¿Podemos mandar correo por GHL? El remitente lo pone quien esté logueado,
// así que basta con tener token y location.
export function ghlEmailReady(): boolean {
  return ghlReady();
}

// Manda un correo por Conversations (queda en el hilo del contacto en GHL).
// Requiere el scope `conversations/message.write` en el Private Integration.
// `from` es el correo del usuario logueado y debe estar verificado en GHL.
export async function sendEmail(input: {
  contactId: string;
  subject: string;
  html: string;
  from: string;
  to?: string;
}) {
  return req(
    `/conversations/messages`,
    {
      method: "POST",
      body: JSON.stringify({
        type: "Email",
        contactId: input.contactId,
        subject: input.subject,
        html: input.html,
        emailFrom: input.from,
        ...(input.to ? { emailTo: input.to } : {}),
      }),
    },
    V_CONVERSATIONS
  );
}

// Busca un contacto por correo dentro de la subcuenta.
export async function findContactByEmail(email: string) {
  const loc = process.env.GHL_LOCATION_ID;
  return req(
    `/contacts/?locationId=${loc}&query=${encodeURIComponent(email)}&limit=1`
  );
}

// Devuelve el contactId de un correo: lo busca y si no existe lo crea.
export async function ensureContactId(input: {
  email: string;
  name?: string;
  phone?: string;
}): Promise<{ id: string } | { error: string; status: number }> {
  const found = await findContactByEmail(input.email);
  if (found.ok) {
    const list = (found.body as { contacts?: { id: string; email?: string }[] })
      ?.contacts;
    const hit = list?.find(
      (c) => c.email?.toLowerCase() === input.email.toLowerCase()
    );
    if (hit?.id) return { id: hit.id };
  } else if (found.status === 401) {
    return { error: "El token de GHL no tiene el scope contacts.readonly.", status: 401 };
  }

  const up = await upsertContact({
    name: input.name || input.email,
    email: input.email,
    phone: input.phone,
    source: "AI Lead Shield",
  });
  const id = contactIdFrom(up.body);
  if (!up.ok || !id) {
    return {
      error: `No se pudo crear el contacto en GHL (HTTP ${up.status}).`,
      status: up.status || 502,
    };
  }
  return { id };
}
