import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;

// Dominios/patrones que NO son el correo del negocio.
const JUNK = [
  "sentry.io",
  "sentry-next.wixpress",
  "wixpress.com",
  "example.com",
  "example.org",
  "domain.com",
  "yourdomain",
  "email.com",
  "company.com",
  "empresa.com",
  "tudominio",
  "test.com",
  "godaddy.com",
  "squarespace.com",
  "wix.com",
  "cloudflare",
  "schema.org",
  "w3.org",
  "googleapis.com",
  "gstatic.com",
  "jquery",
];
const JUNK_EXT = [".png", ".jpg", ".jpeg", ".gif", ".svg", ".webp", ".css", ".js"];

const SOCIAL_HOSTS = ["facebook.com", "fb.com", "instagram.com", "linktr.ee", "m.facebook.com"];

function isSocial(host: string) {
  return SOCIAL_HOSTS.some((s) => host.includes(s));
}

// Desofusca patrones típicos ("nombre [arroba] dominio", entidades HTML, %40).
function deobfuscate(html: string): string {
  return html
    .replace(/&#0*64;|&commat;|%40/gi, "@")
    .replace(/&#0*46;/g, ".")
    .replace(/\s*[[(]\s*(?:arroba|at)\s*[\])]\s*/gi, "@") // [arroba] (at)
    .replace(/\s+arroba\s+/gi, "@") // "nombre arroba dominio"
    .replace(/\s*[[(]\s*(?:punto|dot)\s*[\])]\s*/gi, ".");
}

function extractEmails(html: string): string[] {
  const out = new Set<string>();
  const scan = (text: string) => {
    for (const raw of text.match(EMAIL_RE) || []) {
      const email = raw.toLowerCase();
      if (JUNK.some((j) => email.includes(j))) continue;
      if (JUNK_EXT.some((e) => email.endsWith(e))) continue;
      if (email.length > 60) continue;
      if (/\.(png|jpg|jpeg|gif|svg|webp)$/i.test(email)) continue;
      out.add(email);
    }
  };
  // mailto: explícitos
  for (const m of html.matchAll(/mailto:([^"'?>\s]+)/gi)) {
    let decoded = m[1];
    try {
      decoded = decodeURIComponent(m[1]);
    } catch {
      /* mailto mal formado: usa el crudo */
    }
    scan(decoded);
  }
  scan(html);
  scan(deobfuscate(html));
  return [...out];
}

// Enlaces a redes sociales encontrados en la página.
function extractSocials(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/https?:\/\/(?:www\.)?(?:facebook|instagram|linkedin)\.com\/[^\s"'<>]+/gi)) {
    const url = m[0].replace(/[),.]+$/, "");
    if (url.length < 100) out.add(url);
  }
  return [...out].slice(0, 4);
}

function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

async function fetchText(url: string, signal: AbortSignal): Promise<string> {
  try {
    const res = await fetch(url, {
      signal,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; Prospector/1.0; lead research)",
        Accept: "text/html,*/*",
      },
      redirect: "follow",
    });
    if (!res.ok) return "";
    const type = res.headers.get("content-type") || "";
    if (!type.includes("text/html") && !type.includes("text/plain")) return "";
    return await res.text();
  } catch {
    return "";
  }
}

// Correos que NUNCA sirven como contacto comercial -> se EXCLUYEN por completo
// (privacidad/legal/ARCO/automáticos). Mejor no mostrar nada que mostrar esto.
const EXCLUDE_ROLE =
  /^(proteccion|datospersonales|datos\.personales|privacidad|aviso|avisodeprivacidad|avisoprivacidad|arco|legal|juridico|jur[ií]dico|derechos|no-?reply|noreply|newsletter|mailer|mailer-daemon|postmaster|webmaster|unsubscribe|baja|notificaciones|notificacion)/i;
// Correos de baja prioridad (existen, pero no son de ventas) -> al fondo.
const DEMOTE_ROLE =
  /^(soporte|support|facturacion|facturaci[oó]n|cobranza|rh|recursoshumanos|reclutamiento|empleo|vacantes|cv|curriculum|sistemas|it)/i;
// Correos útiles para prospectar (ventas / dirección / contacto general).
const GOOD_ROLE =
  /^(ventas|contacto|contact|info|hola|comercial|direccion|direcci[oó]n|gerencia|gerente|atencion|atenci[oó]n|clientes|citas|negocios|mkt|marketing)/i;

function isExcluded(email: string): boolean {
  const local = email.split("@")[0];
  // También excluye "proteccion.datospersonales", "datos.personales", etc.
  return EXCLUDE_ROLE.test(local) || /datospersonales|proteccion|privacidad|avisode?privacidad|arco/i.test(local);
}

// Ordena los correos ÚTILES: mismo dominio primero, luego rol de ventas.
function rankEmails(emails: string[], siteHost: string): string[] {
  const roleScore = (e: string) => {
    const local = e.split("@")[0];
    if (GOOD_ROLE.test(local)) return 3;
    if (DEMOTE_ROLE.test(local)) return -3;
    return 0;
  };
  const domainOf = siteHost.replace(/^www\./, "");
  return [...emails].sort((a, b) => {
    const sa = (a.endsWith(domainOf) ? 4 : 0) + roleScore(a);
    const sb = (b.endsWith(domainOf) ? 4 : 0) + roleScore(b);
    return sb - sa;
  });
}

export async function POST(req: NextRequest) {
  try {
    const { website } = (await req.json()) as { website?: string };
    if (!website) {
      return NextResponse.json({ error: "Falta 'website'." }, { status: 400 });
    }

    const base = normalizeUrl(website.trim());
    let origin: string;
    let host: string;
    try {
      const u = new URL(base);
      origin = u.origin;
      host = u.hostname;
    } catch {
      return NextResponse.json({ error: "URL inválida." }, { status: 400 });
    }

    // Rutas candidatas según sea sitio propio o red social.
    const candidates = isSocial(host)
      ? [base, `${base.replace(/\/$/, "")}/about`]
      : [
          base,
          `${origin}/contacto`,
          `${origin}/contactenos`,
          `${origin}/contactanos`,
          `${origin}/contact`,
          `${origin}/aviso-de-privacidad`,
          `${origin}/aviso-de-privacidad.html`,
          `${origin}/privacidad`,
          `${origin}/nosotros`,
          `${origin}/quienes-somos`,
        ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 14000);

    const emails = new Set<string>();
    const socials = new Set<string>();
    try {
      for (const url of candidates) {
        if (emails.size >= 6) break;
        const html = await fetchText(url, controller.signal);
        if (!html) continue;
        extractEmails(html).forEach((e) => emails.add(e));
        extractSocials(html).forEach((s) => socials.add(s));
      }
    } finally {
      clearTimeout(timeout);
    }

    // Excluye por completo los correos legales/privacidad/automáticos.
    const usable = [...emails].filter((e) => !isExcluded(e));
    return NextResponse.json({
      emails: rankEmails(usable, host),
      socials: [...socials].slice(0, 3),
    });
  } catch (err) {
    console.error("extract-email error", err);
    return NextResponse.json(
      { error: "No se pudo extraer el correo." },
      { status: 500 }
    );
  }
}
