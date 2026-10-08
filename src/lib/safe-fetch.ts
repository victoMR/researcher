// Fetch del lado del servidor protegido contra SSRF: solo http/https a puertos
// 80/443, nada de hosts internos ni IPs privadas/reservadas (se revisan TODAS
// las IPs a las que resuelve el host), redirecciones seguidas a mano y
// revalidadas en cada salto, y tamaño de respuesta limitado.
// Riesgo residual: entre nuestra resolución DNS y la de fetch puede haber
// "DNS rebinding" (TTL muy corto); para cerrarlo habría que fijar la IP con un
// agente propio.
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const USER_AGENT = "Mozilla/5.0 (compatible; Prospector/1.0; lead research)";
const MAX_REDIRECTS = 5;
const MAX_BYTES = 1.5 * 1024 * 1024; // 1.5 MB
const REDIRECT_STATUS = new Set([301, 302, 303, 307, 308]);

// Sufijos de nombres que nunca son sitios públicos.
const BLOCKED_SUFFIXES = [".localhost", ".local", ".internal", ".home.arpa", ".lan"];

// ---------- Clasificación de IPs ----------

function parseIPv4(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  const out: number[] = [];
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const n = Number(p);
    if (n > 255) return null;
    out.push(n);
  }
  return out;
}

// IPv4 privada/reservada (no enrutable públicamente o de uso especial).
function isPrivateIPv4(b: number[]): boolean {
  const [a, c] = b;
  return (
    a === 0 || // 0.0.0.0/8 "esta red"
    a === 10 || // 10.0.0.0/8 privada
    (a === 100 && c >= 64 && c <= 127) || // 100.64.0.0/10 CGNAT
    a === 127 || // 127.0.0.0/8 loopback
    (a === 169 && c === 254) || // 169.254.0.0/16 link-local (incl. metadata 169.254.169.254)
    (a === 172 && c >= 16 && c <= 31) || // 172.16.0.0/12 privada
    (a === 192 && c === 0 && b[2] === 0) || // 192.0.0.0/24 IETF
    (a === 192 && c === 0 && b[2] === 2) || // 192.0.2.0/24 TEST-NET-1
    (a === 192 && c === 88 && b[2] === 99) || // 192.88.99.0/24 relay 6to4
    (a === 192 && c === 168) || // 192.168.0.0/16 privada
    (a === 198 && (c === 18 || c === 19)) || // 198.18.0.0/15 benchmarking
    (a === 198 && c === 51 && b[2] === 100) || // 198.51.100.0/24 TEST-NET-2
    (a === 203 && c === 0 && b[2] === 113) || // 203.0.113.0/24 TEST-NET-3
    a >= 224 // 224.0.0.0/4 multicast + 240.0.0.0/4 reservada + broadcast
  );
}

// Convierte IPv6 a 8 grupos de 16 bits (acepta "::" y IPv4 incrustada al final).
function parseIPv6(input: string): number[] | null {
  let ip = input.toLowerCase();
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone);
  // IPv4 incrustada al final (p. ej. ::ffff:127.0.0.1)
  const lastColon = ip.lastIndexOf(":");
  const tail = ip.slice(lastColon + 1);
  let v4tail: number[] | null = null;
  if (tail.includes(".")) {
    v4tail = parseIPv4(tail);
    if (!v4tail) return null;
    ip = `${ip.slice(0, lastColon + 1)}${((v4tail[0] << 8) | v4tail[1]).toString(16)}:${(
      (v4tail[2] << 8) |
      v4tail[3]
    ).toString(16)}`;
  }
  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const toGroups = (s: string) => (s === "" ? [] : s.split(":"));
  const head = toGroups(halves[0]);
  const rest = halves.length === 2 ? toGroups(halves[1]) : [];
  const missing = 8 - head.length - rest.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const all = [...head, ...Array(halves.length === 2 ? missing : 0).fill("0"), ...rest];
  const out: number[] = [];
  for (const g of all) {
    if (!/^[0-9a-f]{1,4}$/.test(g)) return null;
    out.push(parseInt(g, 16));
  }
  return out.length === 8 ? out : null;
}

function embeddedV4(g: number[], hi: number, lo: number): number[] {
  return [g[hi] >> 8, g[hi] & 0xff, g[lo] >> 8, g[lo] & 0xff];
}

// IPv6 privada/reservada. Solo se permite unicast global (2000::/3) menos
// rangos especiales, y las formas que incrustan una IPv4 pública.
function isPrivateIPv6(g: number[]): boolean {
  const zeros = (from: number, to: number) => g.slice(from, to).every((x) => x === 0);
  // ::ffff:a.b.c.d (IPv4 mapeada) -> se juzga la IPv4.
  if (zeros(0, 5) && g[5] === 0xffff) return isPrivateIPv4(embeddedV4(g, 6, 7));
  // 64:ff9b::/96 (NAT64) -> se juzga la IPv4.
  if (g[0] === 0x64 && g[1] === 0xff9b && zeros(2, 6)) return isPrivateIPv4(embeddedV4(g, 6, 7));
  // Fuera de 2000::/3 todo es especial: ::, ::1, ::/96 compatibles, 64:ff9b:1::/48,
  // 100::/64, fc00::/7 (ULA), fe80::/10 (link-local), fec0::/10, ff00::/8 (multicast)...
  if ((g[0] & 0xe000) !== 0x2000) return true;
  if (g[0] === 0x2001 && g[1] < 0x200) return true; // 2001::/23 IETF (Teredo, benchmarking, ORCHID)
  if (g[0] === 0x2001 && g[1] === 0x0db8) return true; // 2001:db8::/32 documentación
  if (g[0] === 0x2002) return true; // 2002::/16 6to4 (obsoleto, incrusta IPv4)
  if ((g[0] & 0xfff0) === 0x3ff0) return true; // 3fff::/20 documentación
  return false;
}

// true si la IP (v4 o v6, sin corchetes) es privada/reservada o no se reconoce.
export function isPrivateIp(ip: string): boolean {
  const kind = isIP(ip);
  if (kind === 4) {
    const b = parseIPv4(ip);
    return !b || isPrivateIPv4(b);
  }
  if (kind === 6 || ip.includes(":")) {
    const g = parseIPv6(ip);
    return !g || isPrivateIPv6(g);
  }
  return true; // formato desconocido -> se bloquea
}

// ---------- Validación de URLs ----------

export type UrlCheck =
  | { ok: true; url: URL }
  | { ok: false; reason: "invalid" | "blocked" | "dns" };

// Revisa esquema, puerto y host (sin DNS). null si pasa.
function staticCheck(u: URL): "invalid" | "blocked" | null {
  if (u.protocol !== "http:" && u.protocol !== "https:") return "blocked";
  if (u.port && u.port !== "80" && u.port !== "443") return "blocked";
  if (u.username || u.password) return "blocked";
  const host = u.hostname.toLowerCase().replace(/\.+$/, "");
  if (!host) return "invalid";
  const bare = host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (isIP(bare) || bare.includes(":")) return isPrivateIp(bare) ? "blocked" : null;
  if (host === "localhost" || BLOCKED_SUFFIXES.some((s) => host.endsWith(s))) return "blocked";
  // Nombres de una sola etiqueta ("intranet", "metadata") -> red interna.
  if (!host.includes(".")) return "blocked";
  return null;
}

// Valida una URL para pedirla desde el servidor: esquema/puerto/host y que
// TODAS las IPs a las que resuelve sean públicas. reason "dns" = no resolvió.
export async function checkPublicUrl(input: string | URL): Promise<UrlCheck> {
  let u: URL;
  try {
    u = new URL(input);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  const bad = staticCheck(u);
  if (bad) return { ok: false, reason: bad };

  const host = u.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return { ok: true, url: u };

  let addrs: { address: string }[];
  try {
    addrs = await lookup(host, { all: true, verbatim: true });
  } catch {
    return { ok: false, reason: "dns" };
  }
  if (!addrs.length) return { ok: false, reason: "dns" };
  if (addrs.some((a) => isPrivateIp(a.address))) return { ok: false, reason: "blocked" };
  return { ok: true, url: u };
}

// Lee el cuerpo hasta maxBytes (corta el stream si se pasa) y lo decodifica UTF-8.
async function readLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      const room = maxBytes - total;
      const piece = value.byteLength > room ? value.subarray(0, room) : value;
      chunks.push(piece);
      total += piece.byteLength;
    }
  } finally {
    if (total >= maxBytes) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

// Descarga una página (text/html o text/plain) de forma segura. Devuelve "" si
// la URL o algún salto de redirección no está permitido, o si algo falla.
export async function safeFetchText(
  url: string,
  signal: AbortSignal,
  maxBytes = MAX_BYTES
): Promise<string> {
  let current = url;
  try {
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const check = await checkPublicUrl(current);
      if (!check.ok) return "";
      const res = await fetch(check.url, {
        signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,*/*" },
        redirect: "manual",
      });
      if (REDIRECT_STATUS.has(res.status)) {
        const loc = res.headers.get("location");
        await res.body?.cancel().catch(() => {});
        if (!loc) return "";
        current = new URL(loc, check.url).toString();
        continue;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return "";
      }
      const type = res.headers.get("content-type") || "";
      if (!type.includes("text/html") && !type.includes("text/plain")) {
        await res.body?.cancel().catch(() => {});
        return "";
      }
      return await readLimited(res, maxBytes);
    }
    return ""; // demasiadas redirecciones
  } catch {
    return "";
  }
}
