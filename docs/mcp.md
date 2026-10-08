# Servidor MCP de AI Lead Shield

El servidor MCP permite que Claude (Claude Code o Claude Desktop) use las herramientas de la app para investigar prospectos. Claude puede combinarlas con su propia búsqueda web y su razonamiento. Al final regresa un Artifact con el reporte y el CSV, o manda los prospectos a GHL si el usuario lo confirma.

> "Busca clientes activos en El Refugio, Querétaro, nicho clínicas dentales"
> → Claude ubica la zona, busca en DENUE y OSM, revisa sitios, cruza con los prospectos y las BAJAS, guarda la investigación en la app y te entrega el Artifact.

## Cómo funciona

- **Endpoint:** `POST https://TU-DOMINIO/api/mcp` (el dominio de `APP_URL`), con transporte **Streamable HTTP sin estado**. No hay sesiones del lado del servidor; `GET` y `DELETE` responden 405.
- **Librería:** SDK oficial [`@modelcontextprotocol/server`](https://www.npmjs.com/package/@modelcontextprotocol/server) **2.3.1**, la línea estable v2. Su `createMcpHandler` es un handler web estándar (`Request` → `Response`) que se monta tal cual en una ruta de Next. Sirve la revisión **2026-07-28**, que no tiene estado, y responde con Streamable HTTP sin estado a los clientes de la era **2025** (2025-11-25, 2025-06-18…). Probado con el cliente oficial en ambas eras.
- **Autenticación:** cada vendedor usa su propio token Bearer (`MCP_TOKENS`). El token identifica al usuario: es el `created_by` de las investigaciones, el dueño de los prospectos guardados y el actor en la bitácora. El proxy deja pasar `/api/mcp` sin la cookie de sesión porque la ruta valida su propio token. Nada más del proxy cambió.
- **Código:** `src/app/api/mcp/route.ts` (autenticación y transporte), `src/lib/mcp/server.ts` (instrucciones, registro y límites), `src/lib/mcp/tools.ts` (herramientas), `src/lib/mcp/external.ts` (validación de `guardar_investigacion`) y `src/lib/mcp/evidence-store.ts` (sesión de evidencia).

## Variables de entorno

| Variable | Para qué | Default |
|---|---|---|
| `MCP_TOKENS` | `correo1:token1,correo2:token2`. Un correo puede tener varios tokens, lo que sirve para rotarlos. Los tokens de menos de 32 caracteres se ignoran. Sin ningún token válido, `/api/mcp` responde 503. | Requerida |
| `MCP_DAILY_CALLS` | Tope de llamadas a herramientas por vendedor y día (se cuenta en `api_usage` como `mcp:<correo>`) | `500` |
| `MCP_ALLOWED_ORIGINS` | Orígenes de navegador permitidos, separados por coma. Los clientes de escritorio no mandan `Origin`; si llega uno ajeno, se responde 403. | Solo `APP_URL` |
| `APP_URL` | Base de los enlaces (`/investigacion/<id>`, descarga del CSV) | Origen de la petición |

Además usa las variables de la app: `DATABASE_URL`, que casi todas las herramientas necesitan (sin ella solo funcionan las de lectura externa y `calificar_prospecto`), `DENUE_TOKEN`, `GOOGLE_PLACES_API_KEY` (opcional), `ANTHROPIC_API_KEY` (solo para `investigar_con_agente`) y `GHL_PIT` + `GHL_LOCATION_ID` (para `enviar_a_ghl`).

### Generar un token (32 bytes aleatorios)

```bash
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

Da 43 caracteres. Genera uno por vendedor y agrégalo en Vercel → Settings → Environment Variables:

```
MCP_TOKENS=aldo.perez@ialeadshield.com.mx:TOKEN_DE_ALDO,maria.lopez@ialeadshield.com.mx:TOKEN_DE_MARIA
```

Después vuelve a desplegar. El token se le entrega a cada vendedor por un canal privado (no por correo ni chat de grupo).

## Conectar desde Claude Code

```bash
claude mcp add --transport http ai-lead-shield https://TU-DOMINIO/api/mcp \
  --header "Authorization: Bearer TU_TOKEN" --scope user
```

- `--scope user` lo deja disponible en todos tus proyectos. El token queda en `~/.claude.json`, que es privado.
- Verifica con `/mcp` dentro de Claude Code o con `claude mcp list`. Con un token malo aparece `failed` (HTTP 401).
- Para compartirlo en un repo sin exponer el token, usa `.mcp.json` con una variable de entorno. No uses nombres como `ANTHROPIC_API_KEY`, porque Claude Code no expande esas:

```json
{
  "mcpServers": {
    "ai-lead-shield": {
      "type": "http",
      "url": "https://TU-DOMINIO/api/mcp",
      "headers": { "Authorization": "Bearer ${AILS_MCP_TOKEN}" }
    }
  }
}
```

- **Permisos:** Claude Code pide permiso antes de usar cada herramienta MCP. Puedes autorizar siempre las de solo lectura (`mcp__ai-lead-shield__buscar_denue`, etc.). Deja `enviar_a_ghl` y `guardar_en_prospectos` en "preguntar".

## Conectar desde Claude Desktop

Lo que dice la documentación oficial actual ([conectores personalizados](https://support.claude.com/en/articles/11175166-getting-started-with-custom-connectors-using-remote-mcp)):

- Los servidores remotos se agregan como **conector personalizado** en Settings → Connectors (o "+" → *Add custom connector*). Claude Desktop **no** conecta servidores remotos definidos en `claude_desktop_config.json`.
- Esos conectores soportan servidores **sin autenticación** u **OAuth**: hay campos para OAuth Client ID/Secret, pero **no** para un header `Authorization` fijo. Además, la conexión sale de los servidores de Anthropic, no de tu computadora.

Este servidor usa tokens Bearer fijos, así que **no se puede dar de alta como conector personalizado** mientras no implemente OAuth (queda en pendientes). La alternativa es [`mcp-remote`](https://www.npmjs.com/package/mcp-remote): un puente local por stdio que agrega el header. Necesitas Node.js instalado. Edita `claude_desktop_config.json`, que en Windows está en `%APPDATA%\Claude\` y en macOS en `~/Library/Application Support/Claude/`:

```json
{
  "mcpServers": {
    "ai-lead-shield": {
      "command": "npx",
      "args": [
        "-y", "mcp-remote@0.14.3",
        "https://TU-DOMINIO/api/mcp",
        "--transport", "http-only",
        "--header", "Authorization:${AUTH_HEADER}"
      ],
      "env": { "AUTH_HEADER": "Bearer TU_TOKEN" }
    }
  }
}
```

El `Authorization:${AUTH_HEADER}` sin espacios evita un error de Claude Desktop en Windows con los espacios dentro de `args`. Para que el token no quede en la lista de procesos, `mcp-remote` también acepta `--header-file ruta/headers.txt`, con una línea `Authorization: Bearer TU_TOKEN`. Reinicia Claude Desktop después de editar el archivo.

## Herramientas

| Herramienta | Tipo | Qué hace |
|---|---|---|
| `geocodificar_zona` | Lectura | Zona → centro, caja y radio sugerido (Nominatim) |
| `buscar_denue` | Lectura | DENUE del INEGI, por cercanía o por estado/municipio, por palabra o SCIAN. Es la fuente principal. |
| `buscar_osm` | Lectura | OpenStreetMap por etiquetas o palabras |
| `consultar_google` | Lectura | Solo como referencia de actividad (rating, reseñas). Máx. 3 por zona; los datos no se exportan. |
| `revisar_sitio` | Lectura | Lee hasta 8 sitios: correos, WhatsApp, teléfonos, redes y señales (chat, formulario, Meta Pixel, Google Ads, CRM, HTTPS) |
| `revisar_existentes` | Lectura (BD) | ¿Ya es prospecto, de qué vendedor, lo contactaron, tiene BAJA? |
| `calificar_prospecto` | Cálculo | Score 1–10 por resta (`computeScore`) con su desglose |
| `guardar_investigacion` | Escribe en la BD | Valida el reporte de Claude con el post-proceso de la app y lo guarda como investigación terminada. Devuelve `{ id, url, stats, omitidosGoogle, prospectos }`. |
| `investigar_con_agente` | Escribe; tiene costo | Lanza el agente interno (igual que el botón de la app, con el mismo tope diario) y devuelve `{ id }` |
| `estado_investigacion` | Lectura | Estado, últimos pasos y, si terminó, el resumen y los prospectos calificados |
| `listar_investigaciones` | Lectura | Las últimas 20, tuyas o de todo el equipo |
| `exportar_csv` | Lectura | El CSV de la app (todos o los `ids`), sin Google, más `omitidosGoogle` |
| `enviar_a_ghl` | **Efecto externo** | Crea o actualiza contactos en GHL con una nota. Salta Google, BAJAS y a quien no tenga correo ni teléfono. Claude debe confirmar con el usuario antes de usarla. |
| `guardar_en_prospectos` | Escribe en la BD | Guarda en Prospectos con el vendedor del token como dueño |
| `buscar_prospectos_guardados` | Lectura | Busca en Prospectos por texto, estado y dueño |

Las anotaciones MCP van así: `readOnlyHint` en las de lectura; `destructiveHint: false` en las que escriben, porque no borran nada; `openWorldHint` en las que tocan servicios externos. Las instrucciones del servidor, que el cliente recibe al conectarse, describen el flujo recomendado y las reglas.

## Reglas de datos

- **Google:** el CSV, GHL y Prospectos solo llevan datos de DENUE, OSM o la web del propio negocio. De Google solo se guarda el `place_id`. Las respuestas de `guardar_investigacion` y `estado_investigacion` no incluyen datos de Google, y las instrucciones le piden a Claude que no los ponga en el Artifact.
- **Sesión de evidencia:** en la app, el agente valida su reporte contra lo que devolvieron sus herramientas. Por MCP cada llamada es independiente, así que lo que devuelven `buscar_denue`, `buscar_osm`, `consultar_google` y `revisar_sitio` se guarda en la tabla `mcp_evidence`, una fila por vendedor. Esa evidencia expira tras 6 h sin actividad. Lo de Google se guarda solo ahí, de forma transitoria, para empatar y calificar, y nunca se exporta. Cuando `geocodificar_zona` ubica una zona nueva (a más de 3 km de la anterior), el contador de Google se reinicia.
- **`guardar_investigacion` (modo externo):**
  1. Cada prospecto se ancla al id exacto que devolvió una herramienta en la sesión (`denue/…`, `osm/…`, `place/…`). Los datos de contacto, la dirección y las coordenadas salen de esa fuente, no de lo que diga Claude. Se ignoran `score`, `address` y otros campos que Claude mande.
  2. Un negocio que solo está en la web usa el id `web/<dominio>` y necesita que su sitio se haya revisado con `revisar_sitio` o que aparezca en sus `fuentes`.
  3. Los datos que Claude encontró con su propia búsqueda web (correo, teléfono, WhatsApp, web, redes) se aceptan solo si trae la URL de la página en `fuentes`. El servidor relee esa página (máx. 15 por guardado, con protección anti-SSRF) y el dato tiene que estar ahí. Lo que no se puede verificar se descarta y se reporta en `descartados`.
  4. Las páginas de Google (google.\*, goo.gl, g.page, business.site…) nunca cuentan como fuente. Un prospecto marcado `source: "google"` no aporta datos de contacto.
  5. Luego se aplica el post-proceso de la app: deduplicación, `computeScore()`, el orden y el cruce con Prospectos y BAJAS (`attachExisting`).
- **BAJAS:** `registro.baja = true` significa no contactar. `enviar_a_ghl` los salta siempre.

## Ejemplo de conversación

> **Tú:** Busca clientes activos en El Refugio, Querétaro, nicho clínicas dentales. Quiero 15.
>
> **Claude:** *(geocodificar_zona → buscar_denue «dentista» y «consultorio dental» + buscar_osm amenity=dentist en paralelo → consultar_google «clínica dental» → revisar_sitio con los 8 mejores → su propia búsqueda web de vacantes y quejas → revisar_existentes → guardar_investigacion → exportar_csv)*
> Listo: 15 clínicas (9 con correo, 12 con teléfono). Te dejo el reporte en un Artifact con el ranking, el desglose del score y el CSV. Dos ya son prospectos de Aldo y una tiene BAJA (marcada «no contactar»). ¿Quieres que suba los 12 contactables a GHL o que los guarde en tus Prospectos?
>
> **Tú:** Súbelos a GHL, menos el 7.
>
> **Claude:** *(enviar_a_ghl con los ids elegidos)* Subí 11; salté 1 sin correo ni teléfono.

## Cómo regresar un Artifact con el CSV

1. `guardar_investigacion` (o `estado_investigacion` si se usó el agente) da los prospectos ya calificados y la `url` del reporte en la app.
2. `exportar_csv` da en su segundo bloque el CSV tal cual (sin BOM).
3. Claude arma un Artifact HTML con:
   - el resumen y los hallazgos;
   - una tabla de ranking con el score y su desglose (`10 − 3 (sin correo) − 1 (sin sitio web) = 6`), las razones, las señales y el mensaje sugerido;
   - los marcados como BAJA o prospecto de otro vendedor;
   - el enlace "Ver en AI Lead Shield" (`url`);
   - un botón "Descargar CSV" que genera un `Blob` con `"﻿" + csv` y `type: "text/csv;charset=utf-8"`. El BOM es para que Excel respete los acentos.
4. No se incluyen ratings ni reseñas de Google.

`csv_url` (`/api/research/<id>/csv`) también descarga el CSV desde la app, pero pide haber iniciado sesión.

## Seguridad

- **Tokens:** son de 32 bytes aleatorios, uno por vendedor, y viven solo en variables de entorno, nunca en la BD. Se comparan en tiempo constante: HMAC de ambos con `timingSafeEqual`, recorriendo todos sin cortar en el primero. Sin token, la respuesta es `401` con `WWW-Authenticate: Bearer realm=…`; con un token inválido, además lleva `error="invalid_token"`.
- **Rotación:** agrega el token nuevo junto al viejo (`correo:nuevo,correo:viejo`), despliega, actualiza el cliente y luego quita el viejo. Para revocar un token, quítalo de `MCP_TOKENS` y vuelve a desplegar. Si se filtra uno, revócalo de inmediato.
- **Límites:** 500 llamadas por vendedor y día (`MCP_DAILY_CALLS`). Además siguen aplicando el tope diario de Google (`GOOGLE_PLACES_DAILY_CAP`) y el de investigaciones del agente (`AGENT_DAILY_RUNS`, más una investigación en curso a la vez). Las peticiones de más de 4 MiB se rechazan.
- **Prompt injection:** el contenido de sitios web y búsquedas es no confiable y puede traer instrucciones escondidas. Las instrucciones del servidor y las descripciones de las herramientas le dicen a Claude que lo trate como datos y que **nunca** use `enviar_a_ghl` ni `guardar_en_prospectos` por algo que diga una página o un resultado, solo con un sí explícito del usuario. Además, ninguna herramienta envía mensajes. Lo más que hace una herramienta con efecto es subir a GHL, y para eso Claude Code pide permiso.
- **SSRF:** `revisar_sitio` y la relectura de `fuentes` pasan por `safeFetchText`: solo http/https públicos, sin IPs privadas, con redirecciones revalidadas y tamaño limitado.
- **Bitácora:** cada llamada queda en los logs (`[mcp] correo herramienta ok|error ms`). Las que tienen efecto (`guardar_investigacion`, `investigar_con_agente`, `enviar_a_ghl`, `guardar_en_prospectos`) también quedan en la tabla `events` como `mcp_<herramienta>`, con el actor.

## Prueba rápida con curl

```bash
curl -s https://TU-DOMINIO/api/mcp \
  -H "Authorization: Bearer $AILS_MCP_TOKEN" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"calificar_prospecto","arguments":{"telefono":"442 123 4567","correo":"ventas@clinica.mx"}}}'
```

## Pendientes

- **OAuth** (servidor de autorización con CIMD/DCR) para darlo de alta como conector personalizado en Claude Desktop, claude.ai y móvil sin `mcp-remote`.
- Probar `investigar_con_agente` en un preview de Vercel con `ANTHROPIC_API_KEY`: corre con `after()` dentro de la herramienta MCP.
- Opcional: una herramienta `nueva_sesion` para vaciar la evidencia sin esperar las 6 h.
