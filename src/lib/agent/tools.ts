// Registro de herramientas de investigación (SOLO LECTURA), independiente del
// bucle del agente: las usa "Investigar con IA" y las podrá exponer un servidor
// MCP (/api/mcp) tal cual. Ninguna envía mensajes ni escribe en GHL/Prospectos.
import type { ResearchProgress } from "../research-types";
import { DenueError, denueByArea, denueNear, denueReady, type DenueEstablishment } from "../denue";
import { displayPhoneMx, extractContacts } from "../email-extract";
import { displayName } from "../session";
import { Evidence } from "./evidence";
import { lookupExisting, type ExistingQuery } from "./existing";
import { GeoError, geocodeZone, parseOsmTag, safeWord, searchOsmAround } from "./geo";
import { GoogleUnavailable, googleNearby } from "./google";
import { clampNum, cleanEmail, cleanUrl, clip, distanceM, fmtDistance, isNum } from "./normalize";

export interface ToolContext {
  userEmail: string | null;
  progress?: (p: ResearchProgress) => void;
  evidence?: Evidence; // solo el agente in-app: junta lo visto para validar el reporte
  signal?: AbortSignal;
}

// JSON Schema del input (objeto). Compatible con tools de la API de Claude y MCP.
export interface JsonSchemaObject {
  type: "object";
  properties: Record<string, unknown>;
  required?: string[];
  additionalProperties?: boolean;
  [key: string]: unknown;
}

export interface AgentTool {
  name: string;
  description: string;
  inputSchema: JsonSchemaObject;
  readOnly: boolean;
  run(input: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

// Error "esperado" con mensaje para el modelo (se devuelve como is_error).
export class ToolError extends Error {}

const now = () => new Date().toISOString();
function say(ctx: ToolContext, message: string, kind: ResearchProgress["kind"] = "tool") {
  ctx.progress?.({ at: now(), kind, message });
}

const MAX_GOOGLE_PER_RUN = 3;

// ---------- lectura de inputs ----------

function str(input: Record<string, unknown>, key: string, max = 200): string | undefined {
  return clip(input[key], max);
}
function num(input: Record<string, unknown>, key: string): number | undefined {
  const v = input[key];
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v) : NaN;
  return Number.isFinite(n) ? n : undefined;
}
function strList(input: Record<string, unknown>, key: string, maxItems: number, maxLen = 80): string[] {
  const v = input[key];
  const arr = Array.isArray(v) ? v : typeof v === "string" ? [v] : [];
  return arr
    .map((x) => clip(x, maxLen))
    .filter((x): x is string => !!x)
    .slice(0, maxItems);
}
function needLatLon(input: Record<string, unknown>): { lat: number; lon: number } {
  const lat = num(input, "lat");
  const lon = num(input, "lon");
  if (!isNum(lat) || !isNum(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new ToolError("Faltan lat/lon válidos. Usa primero geocodificar_zona.");
  }
  return { lat, lon };
}

function zoneLabel(ctx: ToolContext, lat?: number, lon?: number): string {
  const z = ctx.evidence?.zone;
  if (z && (!isNum(lat) || !isNum(lon) || distanceM(z, { lat, lon }) < 3000)) return z.shortName.split(",")[0];
  return "la zona";
}

// ---------- geocodificar_zona ----------

const geocodificarZona: AgentTool = {
  name: "geocodificar_zona",
  description:
    "Convierte una zona de México (colonia, fraccionamiento, municipio o ciudad; p. ej. 'El Refugio, Querétaro') en coordenadas: centro (lat/lon), caja (bbox), nombre oficial, tipo y un radio sugerido en metros que cubre la zona. Llámala al inicio, antes de buscar negocios. Si el resultado no es la zona correcta, vuelve a llamarla con más detalle (agrega municipio y estado).",
  inputSchema: {
    type: "object",
    properties: {
      zona: { type: "string", description: "Zona tal como la escribiría una persona, con municipio y estado si se conocen." },
    },
    required: ["zona"],
    additionalProperties: false,
  },
  readOnly: true,
  async run(input, ctx) {
    const zona = str(input, "zona", 160);
    if (!zona) throw new ToolError("Falta 'zona'.");
    say(ctx, `Ubicando «${zona}» en el mapa…`);
    try {
      const z = await geocodeZone(zona);
      if (ctx.evidence && !ctx.evidence.zone) {
        ctx.evidence.zone = { name: z.name, shortName: z.shortName, lat: z.lat, lon: z.lon, radiusM: z.radiusM };
      }
      say(ctx, `Zona: ${z.shortName} (radio sugerido ${fmtDistance(z.radiusM)}).`, "info");
      return {
        nombre: z.name,
        nombre_corto: z.shortName,
        tipo: z.type,
        lat: Number(z.lat.toFixed(6)),
        lon: Number(z.lon.toFixed(6)),
        bbox: z.bbox,
        radio_sugerido_m: z.radiusM,
        alternativas: z.alternatives,
      };
    } catch (e) {
      if (e instanceof GeoError) throw new ToolError(e.message);
      throw e;
    }
  },
};

// ---------- buscar_denue ----------

// e.address ya trae calle, colonia, C.P., municipio y estado (ver denue.ts);
// solo se arma aquí si no vino.
function denueAddress(e: DenueEstablishment): string | undefined {
  if (e.address) return e.address;
  const parts = [e.colonia ? `Col. ${e.colonia}` : undefined, e.cp ? `C.P. ${e.cp}` : undefined, e.municipio, e.entidad];
  return parts.filter(Boolean).join(", ") || undefined;
}

function denueOut(e: DenueEstablishment, center?: { lat: number; lon: number }) {
  const dir = denueAddress(e);
  return {
    id: `denue/${e.id}`,
    nombre: e.name,
    ...(e.legalName && e.legalName !== e.name ? { razon_social: e.legalName } : {}),
    giro: e.activity,
    ...(e.scianCode ? { scian: e.scianCode } : {}),
    ...(e.employees ? { personal: e.employees } : {}),
    ...(e.phone ? { telefono: displayPhoneMx(e.phone) ?? e.phone } : {}),
    ...(e.email ? { correo: e.email } : {}),
    ...(e.website ? { web: e.website } : {}),
    ...(dir ? { direccion: dir } : {}),
    lat: e.lat,
    lon: e.lon,
    ...(center ? { distancia_m: Math.round(distanceM(e, center)) } : {}),
    ...(e.since ? { desde: e.since } : {}),
  };
}

function collectDenue(ctx: ToolContext, list: DenueEstablishment[]) {
  const ev = ctx.evidence;
  if (!ev) return;
  for (const e of list) {
    const address = denueAddress(e);
    ev.addBusiness({
      id: `denue/${e.id}`,
      source: "denue",
      name: e.name,
      category: e.activity,
      address,
      lat: isNum(e.lat) ? e.lat : undefined,
      lon: isNum(e.lon) ? e.lon : undefined,
      phone: displayPhoneMx(e.phone),
      email: cleanEmail(e.email),
      website: cleanUrl(e.website),
      employees: e.employees,
      denueId: e.id,
    });
  }
}

// Errores de DENUE con mensaje para el usuario -> error para el modelo.
async function denueCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DenueError) throw new ToolError(`${e.message} Prueba otra palabra o sigue con OSM.`);
    throw e;
  }
}

const buscarDenue: AgentTool = {
  name: "buscar_denue",
  description:
    "Busca establecimientos en el DENUE de INEGI: padrón oficial de negocios de México, datos abiertos que SÍ se pueden exportar. Es la fuente principal: úsala antes que OSM o Google. Modo 'cercania': palabra clave + lat/lon + radio_m (máx. 5000). Modo 'area': entidad (nombre o clave del estado) y opcionalmente municipio, con palabra clave o código SCIAN (p. ej. 621211 consultorios dentales). Devuelve id, nombre, giro, estrato de personal ocupado, teléfono, correo, web, dirección y coordenadas. OJO: si la palabra clave trae varias palabras, el DENUE devuelve los negocios que tengan CUALQUIERA de ellas (O, no Y): 'agencia autos' trae también agencias de viajes y lavados de autos. Usa UNA palabra distintiva ('dental', 'inmobiliaria', 'seminuevos') y descarta por la columna giro; para un giro exacto usa modo 'area' con su código SCIAN. Si hay pocos resultados prueba otra palabra en singular.",
  inputSchema: {
    type: "object",
    properties: {
      modo: { type: "string", enum: ["cercania", "area"], description: "'cercania' (punto + radio) o 'area' (estado/municipio)." },
      palabra: { type: "string", description: "UNA palabra distintiva del giro, p. ej. 'dental', 'inmobiliaria', 'refaccionaria' (varias palabras = cualquiera de ellas)." },
      lat: { type: "number", description: "Latitud del centro (modo cercania)." },
      lon: { type: "number", description: "Longitud del centro (modo cercania)." },
      radio_m: { type: "number", description: "Radio en metros, 100 a 5000 (modo cercania). Por defecto 1500." },
      entidad: { type: "string", description: "Estado (nombre o clave INEGI) para modo area." },
      municipio: { type: "string", description: "Municipio (opcional, modo area)." },
      scian: { type: "string", description: "Código SCIAN de la actividad (opcional)." },
      limite: { type: "integer", description: "Máximo de resultados a devolver (por defecto 40, máx. 80)." },
    },
    required: ["modo"],
    additionalProperties: false,
  },
  readOnly: true,
  async run(input, ctx) {
    if (!denueReady()) {
      throw new ToolError(
        "DENUE no está configurado en el servidor (falta DENUE_TOKEN). Sigue con buscar_osm, revisar_sitio y la búsqueda web; menciónalo en el resumen."
      );
    }
    const modo = str(input, "modo", 20) === "area" ? "area" : "cercania";
    const palabra = str(input, "palabra", 60);
    const scian = str(input, "scian", 12)?.replace(/\D/g, "") || undefined;
    const limite = Math.round(clampNum(input.limite, 1, 80, 40));
    const ev = ctx.evidence;
    if (palabra) ev?.keywords.add(palabra);
    if (scian) ev?.scianCodes.add(scian);

    let list: DenueEstablishment[];
    let center: { lat: number; lon: number } | undefined;
    if (modo === "cercania") {
      if (!palabra) throw new ToolError("En modo 'cercania' falta 'palabra'.");
      center = needLatLon(input);
      const radiusM = Math.round(clampNum(input.radio_m, 100, 5000, 1500));
      if (ev) ev.radiusM = Math.max(ev.radiusM ?? 0, radiusM);
      say(ctx, `Buscando en DENUE «${palabra}» a ${fmtDistance(radiusM)} de ${zoneLabel(ctx, center.lat, center.lon)}…`);
      list = await denueCall(() => denueNear({ keyword: palabra, lat: center!.lat, lon: center!.lon, radiusM }));
    } else {
      const entidad = str(input, "entidad", 60);
      if (!entidad) throw new ToolError("En modo 'area' falta 'entidad'.");
      const municipio = str(input, "municipio", 80);
      const where = [municipio, entidad].filter(Boolean).join(", ");
      say(ctx, `Buscando en DENUE ${palabra ? `«${palabra}»` : `la clase SCIAN ${scian ?? "indicada"}`} en ${where}…`);
      list = await denueCall(() =>
        denueByArea({ entidad, municipio, scianCode: scian, keyword: palabra, limit: Math.min(200, limite * 2) })
      );
    }
    collectDenue(ctx, list);
    const shown = list.slice(0, limite);
    say(ctx, `DENUE: ${list.length} establecimiento${list.length === 1 ? "" : "s"}.`, "info");
    return {
      total: list.length,
      mostrados: shown.length,
      establecimientos: shown.map((e) => denueOut(e, center)),
    };
  },
};

// ---------- buscar_osm ----------

const buscarOsm: AgentTool = {
  name: "buscar_osm",
  description:
    "Busca negocios en OpenStreetMap alrededor de un punto (datos abiertos, exportables). Úsala después de DENUE para completar teléfonos, sitios web y negocios que falten. 'etiquetas' son pares clave=valor de OSM (p. ej. 'amenity=dentist', 'healthcare=dentist', 'shop=car_repair', 'office=estate_agent'); 'palabras' busca texto en el nombre (p. ej. 'dental'). Da al menos una de las dos.",
  inputSchema: {
    type: "object",
    properties: {
      lat: { type: "number", description: "Latitud del centro." },
      lon: { type: "number", description: "Longitud del centro." },
      radio_m: { type: "number", description: "Radio en metros (100 a 10000; por defecto 1500)." },
      etiquetas: { type: "array", items: { type: "string" }, description: "Etiquetas OSM clave=valor (máx. 6)." },
      palabras: { type: "array", items: { type: "string" }, description: "Palabras a buscar en el nombre (máx. 4)." },
      limite: { type: "integer", description: "Máximo de resultados (por defecto 40, máx. 80)." },
    },
    required: ["lat", "lon"],
    additionalProperties: false,
  },
  readOnly: true,
  async run(input, ctx) {
    const { lat, lon } = needLatLon(input);
    const radiusM = Math.round(clampNum(input.radio_m, 100, 10000, 1500));
    const tags = strList(input, "etiquetas", 6)
      .map(parseOsmTag)
      .filter((t): t is [string, string] => !!t);
    const words = strList(input, "palabras", 4)
      .map(safeWord)
      .filter((w): w is string => !!w);
    if (!tags.length && !words.length) {
      throw new ToolError("Da al menos una etiqueta válida (clave=valor) o una palabra de 3+ letras.");
    }
    const limite = Math.round(clampNum(input.limite, 1, 80, 40));
    words.forEach((w) => ctx.evidence?.keywords.add(w));
    const what = [...tags.map(([k, v]) => `${k}=${v}`), ...words.map((w) => `«${w}»`)].join(", ");
    say(ctx, `Buscando en OpenStreetMap (${what}) a ${fmtDistance(radiusM)} de ${zoneLabel(ctx, lat, lon)}…`);
    let list;
    try {
      list = await searchOsmAround({ lat, lon, radiusM, tags, words, limit: limite });
    } catch (e) {
      if (e instanceof GeoError) throw new ToolError(e.message);
      throw e;
    }
    for (const p of list) {
      ctx.evidence?.addBusiness({
        id: `osm/${p.osmId}`,
        source: "osm",
        name: p.name,
        category: p.kind,
        address: p.address,
        lat: p.lat,
        lon: p.lon,
        phone: displayPhoneMx(p.phone),
        email: cleanEmail(p.email),
        website: cleanUrl(p.website),
        osmId: p.osmId,
      });
    }
    say(ctx, `OpenStreetMap: ${list.length} negocio${list.length === 1 ? "" : "s"}.`, "info");
    return {
      total: list.length,
      negocios: list.map((p) => ({
        id: `osm/${p.osmId}`,
        nombre: p.name,
        ...(p.kind ? { tipo: p.kind } : {}),
        ...(p.phone ? { telefono: displayPhoneMx(p.phone) ?? p.phone } : {}),
        ...(p.email ? { correo: p.email } : {}),
        ...(p.website ? { web: p.website } : {}),
        ...(p.address ? { direccion: p.address } : {}),
        lat: p.lat,
        lon: p.lon,
        distancia_m: p.distanceM,
      })),
    };
  },
};

// ---------- consultar_google ----------

const consultarGoogle: AgentTool = {
  name: "consultar_google",
  description:
    "Consulta Google Places SOLO como señal de actividad: rating, número de reseñas y antigüedad de la reseña más reciente de los negocios cercanos. Sus datos NO se pueden guardar ni exportar y no trae contactos: nunca los uses como correo, teléfono, web o dirección. Cuesta dinero y tiene tope diario: úsala 1 o 2 veces por investigación, con la palabra del giro y el centro de la zona.",
  inputSchema: {
    type: "object",
    properties: {
      consulta: { type: "string", description: "Giro a buscar, p. ej. 'clínica dental'." },
      lat: { type: "number" },
      lon: { type: "number" },
      radio_m: { type: "number", description: "Radio en metros (200 a 10000; por defecto 2000)." },
    },
    required: ["consulta", "lat", "lon"],
    additionalProperties: false,
  },
  readOnly: true,
  async run(input, ctx) {
    const consulta = str(input, "consulta", 120);
    if (!consulta) throw new ToolError("Falta 'consulta'.");
    const { lat, lon } = needLatLon(input);
    const radiusM = Math.round(clampNum(input.radio_m, 200, 10000, 2000));
    const ev = ctx.evidence;
    if (ev && ev.googleCalls >= MAX_GOOGLE_PER_RUN) {
      throw new ToolError(`Ya consultaste Google ${MAX_GOOGLE_PER_RUN} veces en esta investigación; sigue con lo que tienes.`);
    }
    say(ctx, `Consultando la actividad en Google de «${consulta}» cerca de ${zoneLabel(ctx, lat, lon)}…`);
    let list;
    try {
      if (ev) ev.googleCalls++;
      list = await googleNearby({ query: consulta, lat, lon, radiusM });
    } catch (e) {
      if (e instanceof GoogleUnavailable) throw new ToolError(`${e.message} Sigue sin Google.`);
      throw e;
    }
    for (const p of list) {
      ev?.addBusiness({
        id: `place/${p.placeId}`,
        source: "google",
        name: p.name,
        lat: p.lat, // solo en memoria, para empatar con DENUE/OSM
        lon: p.lon,
        placeId: p.placeId,
        google: { rating: p.rating, reviewCount: p.reviewCount, lastReviewAgo: p.lastReviewAgo },
        businessStatus: p.status,
        lastActivityAt: p.lastReviewAt,
      });
    }
    say(ctx, `Google: ${list.length} lugar${list.length === 1 ? "" : "es"} (solo como referencia).`, "info");
    return {
      aviso: "Datos de Google solo como referencia de actividad: no se exportan.",
      lugares: list.map((p) => ({
        id: `place/${p.placeId}`,
        nombre: p.name,
        ...(p.rating != null ? { rating: p.rating } : {}),
        ...(p.reviewCount != null ? { resenas: p.reviewCount } : {}),
        ...(p.lastReviewAgo ? { ultima_resena: p.lastReviewAgo } : {}),
        distancia_m: Math.round(distanceM(p, { lat, lon })),
      })),
    };
  },
};

// ---------- revisar_sitio ----------

const revisarSitio: AgentTool = {
  name: "revisar_sitio",
  description:
    "Lee el sitio web de uno o varios negocios (hasta 8 por llamada, en paralelo) y devuelve correos, WhatsApp, teléfonos, redes sociales y señales: botón de WhatsApp, chat en vivo, formulario de contacto, Meta Pixel, etiqueta de Google Ads, CRM que ya usan, agenda en línea y si no tiene HTTPS. Úsala con los mejores candidatos que tengan web. Los datos que devuelve vienen de la web del propio negocio y sí se pueden exportar.",
  inputSchema: {
    type: "object",
    properties: {
      sitios: {
        type: "array",
        description: "Sitios a revisar (máx. 8).",
        items: {
          type: "object",
          properties: {
            url: { type: "string", description: "URL o dominio del sitio." },
            nombre: { type: "string", description: "Nombre del negocio (para el progreso)." },
          },
          required: ["url"],
          additionalProperties: false,
        },
      },
    },
    required: ["sitios"],
    additionalProperties: false,
  },
  readOnly: true,
  async run(input, ctx) {
    const raw = Array.isArray(input.sitios) ? input.sitios : [];
    const sitios = raw
      .map((s) => {
        const o = (s && typeof s === "object" ? s : { url: s }) as Record<string, unknown>;
        const url = cleanUrl(o.url);
        return url ? { url, nombre: clip(o.nombre, 80) } : null;
      })
      .filter((s): s is { url: string; nombre: string | undefined } => !!s)
      .slice(0, 8);
    if (!sitios.length) throw new ToolError("Da al menos una URL válida en 'sitios'.");
    const names = sitios.map((s) => s.nombre ?? new URL(s.url).hostname.replace(/^www\./, ""));
    say(
      ctx,
      names.length === 1
        ? `Leyendo el sitio de ${names[0]}…`
        : `Leyendo ${names.length} sitios web: ${names.slice(0, 2).join(", ")}${names.length > 2 ? ` y ${names.length - 2} más` : ""}…`
    );
    const results = await Promise.all(
      sitios.map(async (s) => {
        const r = await extractContacts(s.url, { timeoutMs: 15000, signal: ctx.signal });
        ctx.evidence?.addSite(r);
        return {
          url: r.url,
          ...(s.nombre ? { nombre: s.nombre } : {}),
          abre: r.reachable,
          ...(r.https !== undefined ? { https: r.https } : {}),
          correos: r.emails.slice(0, 5),
          ...(r.guesses.length ? { correos_sugeridos_no_verificados: r.guesses } : {}),
          ...(r.whatsapp ? { whatsapp: r.whatsapp } : {}),
          telefonos: r.phones,
          redes: r.socials,
          senales: r.signals,
        };
      })
    );
    const ok = results.filter((r) => r.abre).length;
    const withEmail = results.filter((r) => r.correos.length).length;
    say(ctx, `Sitios: ${ok} de ${results.length} abrieron; ${withEmail} con correo.`, "info");
    return { sitios: results };
  },
};

// ---------- revisar_existentes ----------

const revisarExistentes: AgentTool = {
  name: "revisar_existentes",
  description:
    "Revisa en la base de AI Lead Shield si estos negocios ya son prospectos (y de qué vendedor), en qué estado están, quién los contactó y si pidieron BAJA (no contactar). Úsala con los finalistas antes de entregar el reporte. Acepta nombre, correo, teléfono y/o el id que devolvieron las otras herramientas (hasta 40).",
  inputSchema: {
    type: "object",
    properties: {
      negocios: {
        type: "array",
        description: "Negocios a revisar (máx. 40).",
        items: {
          type: "object",
          properties: {
            id: { type: "string" },
            nombre: { type: "string" },
            correo: { type: "string" },
            telefono: { type: "string" },
          },
          additionalProperties: false,
        },
      },
    },
    required: ["negocios"],
    additionalProperties: false,
  },
  readOnly: true,
  async run(input, ctx) {
    const raw = Array.isArray(input.negocios) ? input.negocios.slice(0, 40) : [];
    const items = raw
      .map((x) => (x && typeof x === "object" ? (x as Record<string, unknown>) : null))
      .filter((x): x is Record<string, unknown> => !!x);
    if (!items.length) throw new ToolError("Da al menos un negocio en 'negocios'.");
    say(ctx, `Revisando si ya son prospectos de algún vendedor (${items.length} negocio${items.length === 1 ? "" : "s"})…`);
    const zone = ctx.evidence?.zone;
    const queries: ExistingQuery[] = items.map((x, i) => {
      const id = clip(x.id, 120);
      const seen = id ? ctx.evidence?.businesses.get(id) : undefined;
      const email = cleanEmail(x.correo) ?? seen?.email;
      const phone = displayPhoneMx(clip(x.telefono, 40)) ?? seen?.phone;
      return {
        key: String(i),
        name: clip(x.nombre, 120) ?? seen?.name,
        emails: email ? [email] : [],
        phones: phone ? [phone] : [],
        leadIds: id ? [id.startsWith("osm/") ? id.slice(4) : id] : [],
        denueId: seen?.denueId,
        placeId: seen?.placeId,
        lat: seen?.lat,
        lon: seen?.lon,
        city: zone?.shortName,
        allowNameOnly: true,
      };
    });
    let found;
    try {
      found = await lookupExisting(queries);
    } catch (e) {
      console.error("revisar_existentes", e);
      throw new ToolError("No se pudo consultar la base de prospectos ahora; sigue sin esta revisión.");
    }
    const out = queries.map((q, i) => {
      const m = found.get(q.key);
      const label = clip(items[i].nombre, 120) ?? clip(items[i].correo, 120) ?? clip(items[i].id, 120) ?? `#${i + 1}`;
      if (!m) return { negocio: label, ya_es_prospecto: false, baja: false };
      return {
        negocio: label,
        ya_es_prospecto: !!m.leadId,
        ...(m.leadId
          ? {
              prospecto: {
                nombre: m.leadName,
                ciudad: m.leadCity,
                vendedor: m.ownerEmail ? displayName(m.ownerEmail) : "sin asignar",
                es_mio: !!ctx.userEmail && m.ownerEmail === ctx.userEmail,
                estado: m.status,
                ...(m.contactedBy ? { contactado_por: displayName(m.contactedBy), contactado_en: m.contactedAt } : {}),
                coincidencia: m.matchedBy,
              },
            }
          : {}),
        baja: !!m.suppressed,
        ...(m.lastEmailAt
          ? { ultimo_correo: { fecha: m.lastEmailAt, por: m.lastEmailBy ? displayName(m.lastEmailBy) : undefined } }
          : {}),
      };
    });
    const known = out.filter((o) => o.ya_es_prospecto).length;
    const bajas = out.filter((o) => o.baja).length;
    say(ctx, `Ya en la base: ${known}; con BAJA: ${bajas}.`, "info");
    return { resultados: out };
  },
};

// Orden fijo (estable para el prompt caching).
export const RESEARCH_TOOLS: AgentTool[] = [
  geocodificarZona,
  buscarDenue,
  buscarOsm,
  consultarGoogle,
  revisarSitio,
  revisarExistentes,
];

export function findTool(name: string): AgentTool | undefined {
  return RESEARCH_TOOLS.find((t) => t.name === name);
}
