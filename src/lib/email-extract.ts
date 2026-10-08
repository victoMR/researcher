// Extracción de contactos y señales del sitio web de un negocio.
// Lo usan /api/extract-email y el agente "Investigar con IA" (revisar_sitio).
// Todo lo que sale de aquí viene de la web del propio negocio, así que se puede
// exportar (CSV / GHL). Las descargas pasan por safeFetchText (anti-SSRF).
import { safeFetchText } from "./safe-fetch";

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

export function isSocialHost(host: string): boolean {
  return SOCIAL_HOSTS.some((s) => host.includes(s));
}

// ---------- Teléfonos (México) ----------

// Normaliza un teléfono a E.164 ("+52XXXXXXXXXX"). Acepta lada nacional de 10
// dígitos, prefijos viejos (01, 044, 045, 521) y números extranjeros con "+".
// Devuelve undefined si no parece un teléfono.
export function normalizePhoneMx(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const text = String(raw).trim();
  let d = text.replace(/\D/g, "");
  if (!d) return undefined;
  const hadPlus = text.startsWith("+") || text.startsWith("00");
  if (d.startsWith("00")) d = d.slice(2);
  if (d.length === 13 && d.startsWith("521")) d = "52" + d.slice(3);
  if (d.length === 13 && (d.startsWith("044") || d.startsWith("045"))) d = d.slice(3);
  if (d.length === 12 && d.startsWith("01")) d = d.slice(2);
  if (d.length === 12 && d.startsWith("52")) d = d.slice(2);
  if (d.length === 10) return /^[1-9]/.test(d) ? `+52${d}` : undefined;
  // Extranjero (solo si venía con prefijo internacional).
  if (hadPlus && d.length >= 8 && d.length <= 15) return `+${d}`;
  return undefined;
}

// Formato de la app (igual que DENUE): "442 123 4567" / "55 1234 5678".
// Números extranjeros quedan en E.164.
export function displayPhoneMx(raw: string | null | undefined): string | undefined {
  const e = normalizePhoneMx(raw);
  if (!e) return undefined;
  if (!e.startsWith("+52") || e.length !== 13) return e;
  const d = e.slice(3);
  return /^(55|56|33|81)/.test(d)
    ? `${d.slice(0, 2)} ${d.slice(2, 6)} ${d.slice(6)}`
    : `${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
}

// Últimos 10 dígitos (para comparar teléfonos escritos de distinta forma).
export function phoneKey(raw: string | null | undefined): string {
  const d = String(raw ?? "").replace(/\D/g, "");
  return d.length >= 10 ? d.slice(-10) : d;
}

// ---------- Correos ----------

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
  for (const m of html.matchAll(
    /https?:\/\/(?:www\.)?(?:facebook|instagram|linkedin|tiktok)\.com\/[^\s"'<>]+/gi
  )) {
    const url = m[0].replace(/[),.]+$/, "");
    // Descarta enlaces de "compartir", plugins y píxeles (no son el perfil).
    if (/sharer|share\.php|\/plugins\/|\/tr\?|\/dialog\/|intent\//i.test(url)) continue;
    if (url.length < 100) out.add(url);
  }
  return [...out].slice(0, 4);
}

// Teléfonos de enlaces tel:
function extractPhones(html: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']{6,40})["']/gi)) {
    let raw = m[1];
    try {
      raw = decodeURIComponent(raw);
    } catch {
      /* usa el crudo */
    }
    const p = displayPhoneMx(raw);
    if (p) out.add(p);
  }
  return [...out].slice(0, 3);
}

// Número de WhatsApp de enlaces wa.me / api.whatsapp.com / whatsapp://.
// found = hay botón/enlace aunque no traiga número (wa.link, wa.me/message/...).
function extractWhatsapp(html: string): { found: boolean; number?: string } {
  const decoded = html.replace(/%2B/gi, "+").replace(/%20/g, " ");
  const patterns = [
    /wa\.me\/(\+?\d[\d\s-]{6,20})/i,
    /(?:api|web)\.whatsapp\.com\/send\/?\?(?:[^"'\s<>]*?&(?:amp;)?)?phone=(\+?\d[\d\s-]{6,20})/i,
    /whatsapp:\/\/send\/?\?(?:[^"'\s<>]*?&(?:amp;)?)?phone=(\+?\d[\d\s-]{6,20})/i,
  ];
  for (const re of patterns) {
    const m = decoded.match(re);
    if (m) {
      // wa.me lleva el número internacional sin "+"; 10 dígitos = MX sin lada país.
      const n = displayPhoneMx(m[1].startsWith("+") ? m[1] : `+${m[1].replace(/\D/g, "")}`);
      if (n) return { found: true, number: n };
    }
  }
  const found =
    /wa\.me\/|wa\.link\/|api\.whatsapp\.com|whatsapp:\/\/|joinchat|click-to-chat|ht-ctc|qlwapp|getbutton\.io/i.test(
      html
    );
  return { found };
}

// ---------- Señales del sitio ----------

const CHAT_WIDGETS: [RegExp, string][] = [
  [/embed\.tawk\.to|tawk\.to\//i, "Tawk.to"],
  [/code\.tidio\.co|tidio/i, "Tidio"],
  [/widget\.intercom\.io|intercomcdn/i, "Intercom"],
  [/client\.crisp\.chat/i, "Crisp"],
  [/static\.zdassets\.com|zopim/i, "Zendesk Chat"],
  [/cdn\.livechatinc\.com|livechatinc/i, "LiveChat"],
  [/js\.driftt\.com/i, "Drift"],
  [/js\.usemessages\.com/i, "HubSpot Chat"],
  [/manychat/i, "ManyChat"],
  [/jivosite|jivochat/i, "JivoChat"],
  [/smartsupp/i, "Smartsupp"],
  [/freshchat|wchat\.freshworks/i, "Freshchat"],
  [/olark/i, "Olark"],
  [/widgets\.leadconnectorhq\.com|leadconnectorhq\.com\/.*chat|msgsndr\.com/i, "chat de GoHighLevel"],
  [/landbot/i, "Landbot"],
  [/chatwoot/i, "Chatwoot"],
  [/botmaker/i, "Botmaker"],
  [/respond\.io/i, "respond.io"],
  [/salesiq\.zoho/i, "Zoho SalesIQ"],
];

// Herramientas de CRM / automatización (competencia o cliente maduro).
const CRM_TOOLS: [RegExp, string][] = [
  [/leadconnectorhq|msgsndr\.com|gohighlevel/i, "GoHighLevel"],
  [/js\.hs-scripts\.com|hsforms|hs-analytics/i, "HubSpot"],
  [/zohopublic|zoho\.com\/crm|salesiq\.zoho/i, "Zoho"],
  [/pardot|salesforce\.com/i, "Salesforce"],
  [/kommo\.com|amocrm/i, "Kommo"],
  [/trackcmp\.net|activecampaign/i, "ActiveCampaign"],
];

const BOOKING: [RegExp, string][] = [
  [/calendly\.com/i, "Calendly"],
  [/doctoralia\.com/i, "Doctoralia"],
  [/agendapro/i, "AgendaPro"],
  [/setmore\.com/i, "Setmore"],
  [/simplybook/i, "SimplyBook"],
  [/acuityscheduling/i, "Acuity"],
  [/booksy\.com/i, "Booksy"],
  [/fresha\.com/i, "Fresha"],
];

const FORM_PLUGINS =
  /wpcf7|contact-form-7|wpforms|gform_|elementor-form|hbspt\.forms|hs-form|jotform|typeform|forms\.gle|docs\.google\.com\/forms|formspree|ninja-forms|fluentform|form-contacto|contact-form/i;

function hasContactForm(html: string): boolean {
  if (FORM_PLUGINS.test(html)) return true;
  for (const m of html.matchAll(/<form[\s>][\s\S]{0,4000}?<\/form>/gi)) {
    const f = m[0];
    if (/<textarea|type\s*=\s*["']?(?:email|tel)|name\s*=\s*["']?(?:email|correo|mensaje|message|telefono|phone)/i.test(f)) {
      return true;
    }
  }
  return false;
}

function detectSignals(html: string, opts: { https?: boolean; whatsapp: boolean }): string[] {
  const s: string[] = [];
  if (opts.whatsapp) s.push("Botón o enlace de WhatsApp en su web");
  else s.push("Sin WhatsApp en su web");

  const chats = CHAT_WIDGETS.filter(([re]) => re.test(html)).map(([, n]) => n);
  if (chats.length) s.push(`Chat en su web (${[...new Set(chats)].slice(0, 2).join(", ")})`);
  else s.push("Sin chat en su web");

  s.push(hasContactForm(html) ? "Formulario de contacto" : "Sin formulario de contacto");

  if (/fbq\(\s*['"]init|connect\.facebook\.net\/[^"']*fbevents\.js|facebook\.com\/tr\?id=/i.test(html)) {
    s.push("Meta Pixel (invierte en anuncios de Facebook/Instagram)");
  }
  if (/AW-\d{6,}|googleadservices\.com\/pagead\/conversion|google_conversion_id/i.test(html)) {
    s.push("Etiqueta de Google Ads (invierte en anuncios de Google)");
  }
  if (/analytics\.tiktok\.com|ttq\.load/i.test(html)) s.push("Píxel de TikTok (anuncios en TikTok)");
  if (/GTM-[A-Z0-9]{4,}/.test(html)) s.push("Google Tag Manager");

  const crm = CRM_TOOLS.filter(([re]) => re.test(html)).map(([, n]) => n);
  if (crm.length) s.push(`Ya usa ${[...new Set(crm)].slice(0, 2).join(" y ")} (CRM/automatización)`);

  const booking = BOOKING.filter(([re]) => re.test(html)).map(([, n]) => n);
  if (booking.length) s.push(`Agenda en línea (${[...new Set(booking)].slice(0, 2).join(", ")})`);

  if (opts.https === false) s.push("Sin HTTPS (su sitio solo abre sin candado)");
  return s;
}

// ---------- Clasificación de correos ----------

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

export function normalizeUrl(url: string): string {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`;
}

// ---------- Rastreo ----------

export interface SiteContacts {
  url: string; // URL que se leyó (o se intentó)
  reachable: boolean; // se pudo leer al menos la página principal
  https?: boolean; // abre con https (undefined si no se pudo leer)
  emails: string[]; // correos útiles, ordenados
  guesses: string[]; // correos típicos sugeridos (no verificados)
  socials: string[];
  whatsapp?: string; // número del botón ("442 123 4567"), si lo trae
  phones: string[]; // de enlaces tel: ("442 123 4567")
  signals: string[]; // "Sin chat en su web", "Meta Pixel (...)", ...
}

export interface ExtractOptions {
  signal?: AbortSignal; // cancelación externa
  timeoutMs?: number; // tope total (por defecto 22 s)
}

// Corre fn sobre items con concurrencia limitada; `stop` corta lo pendiente.
async function eachLimited<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
  stop: () => boolean
): Promise<void> {
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length && !stop()) {
      const item = items[i++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

// Enlaces del mismo sitio que parecen página de contacto (máx. 2).
function contactLinks(html: string, origin: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/href\s*=\s*["']([^"'#]{1,200})["']/gi)) {
    if (!/contact|contacto|cont[aá]ct/i.test(m[1])) continue;
    try {
      const u = new URL(m[1], origin);
      if (u.origin === origin) out.add(u.toString());
    } catch {
      /* ignora */
    }
    if (out.size >= 2) break;
  }
  return [...out];
}

/**
 * Lee el sitio de un negocio (home + páginas de contacto) y devuelve correos,
 * redes, WhatsApp, teléfonos y señales (chat, formulario, píxeles, HTTPS...).
 * Nunca lanza: si el sitio no abre devuelve reachable=false.
 */
export async function extractContacts(
  website: string,
  opts: ExtractOptions = {}
): Promise<SiteContacts> {
  const base = normalizeUrl(website.trim());
  let parsed: URL;
  try {
    parsed = new URL(base);
  } catch {
    return { url: base, reachable: false, emails: [], guesses: [], socials: [], phones: [], signals: [] };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), opts.timeoutMs ?? 22000);
  const onAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  const signal = controller.signal;

  try {
    const path = parsed.pathname + parsed.search;
    // 1) Página principal: primero https; si no abre, http (señal "Sin HTTPS").
    let origin = `https://${parsed.host}`;
    let homeUrl = `${origin}${path}`;
    let home = await safeFetchText(homeUrl, signal);
    let https: boolean | undefined = home ? true : undefined;
    if (!home && !signal.aborted) {
      const httpUrl = `http://${parsed.host}${path}`;
      const viaHttp = await safeFetchText(httpUrl, signal);
      if (viaHttp) {
        home = viaHttp;
        https = false;
        origin = `http://${parsed.host}`;
        homeUrl = httpUrl;
      }
    }

    const siteHost = parsed.hostname;
    const social = isSocialHost(siteHost);
    const emails = new Set<string>();
    const socials = new Set<string>();
    const phones = new Set<string>();
    let html = home;

    const absorb = (page: string) => {
      extractEmails(page).forEach((e) => emails.add(e));
      extractSocials(page).forEach((s) => socials.add(s));
      extractPhones(page).forEach((p) => phones.add(p));
    };
    if (home) absorb(home);

    // 2) Páginas de contacto/aviso del mismo sitio (en paralelo, de 4 en 4).
    if (home) {
      const pages = social
        ? [`${homeUrl.replace(/\/$/, "")}/about`]
        : [
            ...contactLinks(home, origin),
            `${origin}/contacto`,
            `${origin}/contactenos`,
            `${origin}/contactanos`,
            `${origin}/contact`,
            `${origin}/aviso-de-privacidad`,
            `${origin}/privacidad`,
            `${origin}/nosotros`,
            `${origin}/quienes-somos`,
          ];
      const unique = [...new Set(pages)].filter((p) => p !== homeUrl);
      await eachLimited(
        unique,
        4,
        async (url) => {
          const page = await safeFetchText(url, signal);
          if (!page) return;
          absorb(page);
          if (html.length < 3_000_000) html += "\n" + page;
        },
        () => emails.size >= 8 || signal.aborted
      );
    }

    let usable = [...emails].filter((e) => !isExcluded(e));
    let guesses: string[] = [];
    const bareHost = siteHost.replace(/^www\./, "");

    // 3) Dominios "de verdad" de los correos (p. ej. la matriz): si no hubo
    //    correo útil, rastrea esos dominios; si aún nada, sugiere correos típicos.
    const domains = [...new Set([...emails].map((e) => e.split("@")[1]?.toLowerCase()))].filter(
      (d): d is string => !!d && !isSocialHost(d)
    );
    const otherDomains = domains.filter((d) => d !== bareHost);
    if (!usable.length && !signal.aborted) {
      for (const d of otherDomains.slice(0, 2)) {
        const more = new Set<string>();
        for (const url of [`https://${d}`, `https://${d}/contacto`, `https://${d}/contact`]) {
          if (signal.aborted) break;
          const page = await safeFetchText(url, signal);
          if (!page) continue;
          extractEmails(page).forEach((e) => more.add(e));
          extractSocials(page).forEach((s) => socials.add(s));
        }
        const u = [...more].filter((e) => !isExcluded(e));
        if (u.length) {
          usable = u;
          break;
        }
      }
    }
    if (!usable.length) {
      const guessDomain = otherDomains[0] || (domains.length ? domains[0] : null);
      if (guessDomain) {
        guesses = ["contacto", "ventas", "direccion", "info"].map((r) => `${r}@${guessDomain}`);
      }
    }

    const wa = extractWhatsapp(html);
    let signals: string[] = [];
    if (home) {
      signals = social
        ? ["Solo tiene página en redes sociales (sin sitio web propio)"]
        : detectSignals(html, { https, whatsapp: wa.found });
    }

    return {
      url: home ? homeUrl : base,
      reachable: !!home,
      ...(https !== undefined ? { https } : {}),
      emails: rankEmails(usable, bareHost),
      guesses,
      socials: [...socials].slice(0, 4),
      ...(wa.number ? { whatsapp: wa.number } : {}),
      phones: [...phones].slice(0, 3),
      signals,
    };
  } catch {
    return { url: base, reachable: false, emails: [], guesses: [], socials: [], phones: [], signals: [] };
  } finally {
    clearTimeout(timeout);
    opts.signal?.removeEventListener("abort", onAbort);
  }
}
