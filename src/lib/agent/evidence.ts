// "Evidencia" de una investigación: todo lo que las herramientas devolvieron.
// El reporte del modelo se valida y se completa contra esto (no se le cree a
// ciegas): datos de contacto solo si salieron de DENUE, OSM o la web.
import type { ResearchSource } from "../research-types";
import type { SiteContacts } from "../email-extract";
import { displayPhoneMx, phoneKey } from "../email-extract";
import { hostOf } from "./normalize";

// Un negocio visto en alguna fuente.
export interface SeenBusiness {
  id: string; // "denue/<id>" | "osm/node/1" | "place/<place_id>" | "web/<dominio>"
  source: ResearchSource;
  name: string;
  category?: string;
  address?: string;
  lat?: number;
  lon?: number;
  phone?: string;
  email?: string;
  website?: string;
  employees?: string;
  denueId?: string;
  osmId?: string; // "node/123" (mismo formato que leads.id de OSM)
  placeId?: string;
  google?: { rating?: number; reviewCount?: number; lastReviewAgo?: string };
  // Solo para calificar (computeScore); vienen de Google.
  businessStatus?: string;
  lastActivityAt?: string; // ISO de la reseña más reciente
}

export interface ZoneInfo {
  name: string; // display_name de Nominatim
  shortName: string; // "El Refugio, Querétaro"
  lat: number;
  lon: number;
  radiusM: number;
}

const MAX_WEB_TEXT = 1_500_000; // tope de texto web guardado para verificar datos

export class Evidence {
  businesses = new Map<string, SeenBusiness>();
  sites = new Map<string, SiteContacts>(); // por host
  zone?: ZoneInfo;
  keywords = new Set<string>();
  scianCodes = new Set<string>();
  radiusM?: number;
  googleCalls = 0;
  // Valores de contacto con fuente aceptable (DENUE/OSM/web del negocio).
  private okEmails = new Set<string>();
  private okPhones = new Set<string>();
  private okHosts = new Set<string>();
  private okUrls = new Set<string>();
  private webText = "";
  private webDigits = "";

  addBusiness(b: SeenBusiness): void {
    const prev = this.businesses.get(b.id);
    const merged: SeenBusiness = prev ? { ...b, ...stripUndef(prev), ...stripUndef(b) } : b;
    this.businesses.set(b.id, merged);
    if (b.source !== "google") {
      if (b.email) this.okEmails.add(b.email.toLowerCase());
      if (b.phone) this.okPhones.add(phoneKey(b.phone));
      const h = hostOf(b.website);
      if (h) this.okHosts.add(h);
    }
  }

  addSite(site: SiteContacts): void {
    const h = hostOf(site.url);
    if (!h) return;
    this.sites.set(h, site);
    if (!site.reachable) return;
    this.okHosts.add(h);
    site.emails.forEach((e) => this.okEmails.add(e.toLowerCase()));
    site.phones.forEach((p) => this.okPhones.add(phoneKey(p)));
    if (site.whatsapp) this.okPhones.add(phoneKey(site.whatsapp));
    site.socials.forEach((s) => this.okUrls.add(s.toLowerCase()));
  }

  // URLs y textos de web_search / web_fetch (resultados del servidor).
  addWeb(urls: string[], texts: string[]): void {
    for (const u of urls) {
      this.okUrls.add(u.toLowerCase());
      const h = hostOf(u);
      if (h) this.okHosts.add(h);
    }
    for (const t of texts) {
      if (this.webText.length >= MAX_WEB_TEXT) break;
      const piece = t.slice(0, MAX_WEB_TEXT - this.webText.length).toLowerCase();
      this.webText += "\n" + piece;
      this.webDigits += " " + piece.replace(/[^\d]/g, "");
    }
  }

  siteFor(url: string | undefined): SiteContacts | undefined {
    const h = hostOf(url);
    return h ? this.sites.get(h) : undefined;
  }

  // --- Verificación de datos que propone el modelo ---

  emailOk(email: string): boolean {
    const e = email.toLowerCase();
    return this.okEmails.has(e) || this.webText.includes(e);
  }

  phoneOk(phone: string): boolean {
    const k = phoneKey(phone);
    if (k.length < 10) return false;
    return this.okPhones.has(k) || this.webDigits.includes(k);
  }

  hostOk(url: string): boolean {
    const h = hostOf(url);
    return !!h && this.okHosts.has(h);
  }

  urlOk(url: string): boolean {
    const u = url.toLowerCase().replace(/\/$/, "");
    if (this.okUrls.has(u) || this.okUrls.has(u + "/")) return true;
    return this.webText.includes(u.replace(/^https?:\/\/(www\.)?/, ""));
  }

  hasData(): boolean {
    return [...this.businesses.values()].some((b) => b.source !== "google");
  }
}

function stripUndef<T extends object>(o: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(o)) {
    if (v !== undefined && v !== null && v !== "") (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

// Normaliza el teléfono al formato de la app ("442 123 4567") o lo descarta.
export function cleanPhone(v: unknown): string | undefined {
  return typeof v === "string" ? displayPhoneMx(v) : undefined;
}
