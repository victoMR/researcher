# AI Lead Shield · Documentación

Plan y referencia para pasar de "listas y CSV" a **prospección viva en todo México**: un agente con IA que investiga en lenguaje natural, una base nacional de negocios y señales de que un negocio necesita AI Lead Shield *ahora*.

| Documento | Qué contiene |
|---|---|
| [fuentes-de-datos-mexico.md](fuentes-de-datos-mexico.md) | DENUE (INEGI) como columna vertebral, API y descargas, códigos SCIAN y conteos por giro, por qué Google no sirve como base, OSM, otras fuentes y marco legal (LFPDPPP 2025) |
| [tiempo-real-y-arquitectura.md](tiempo-real-y-arquitectura.md) | Qué significa "tiempo real", catálogo de señales, enriquecimiento con Claude y costos, arquitectura (cola, PostGIS/H3, feed, alertas), mapa nacional y roadmap con KPIs |
| [mcp.md](mcp.md) | Servidor MCP de la app: cómo conectarlo a Claude Code/Desktop y herramientas disponibles |

> La base de datos es **Supabase** (Postgres) vía postgres.js. Donde los documentos de investigación dicen "Neon", aplica igual a Supabase, que también soporta PostGIS.

## Lo que ya está construido

### Investigar con IA (pestaña principal)
El vendedor escribe, por ejemplo, *"clínicas dentales activas en El Refugio, Querétaro"*. Un agente (Claude) investiga en varios pasos:

1. Ubica la zona.
2. Busca en DENUE, OpenStreetMap y Google (este último solo como referencia).
3. Revisa los sitios web de los negocios: correos, WhatsApp, chat, píxeles.
4. Busca en la web señales de actividad y de "dolor".
5. Cruza con los prospectos que ya existen y con la lista de BAJAS.
6. Entrega un reporte.

El reporte trae:
- resumen de la zona;
- mapa;
- ranking con el porqué de cada negocio;
- mensaje sugerido;
- las acciones **Descargar CSV**, **Enviar a GHL** (con etiquetas y una nota con el análisis) y **Guardar en Prospectos**.

Cada reporte queda guardado y se puede compartir en `/investigacion/<id>`.

### Calificación por resta (1–10)
Un prospecto con todos sus datos de contacto y actividad reciente vale **10**, y se restan puntos por lo que falta o está viejo. Siempre se muestra el desglose, por ejemplo "10 − 3 (sin correo) − 1 (sin sitio web) = 6". Código: `src/lib/scoring.ts`.

| Falta / problema | Resta |
|---|---|
| Sin teléfono | −3 |
| Teléfono incompleto | −1 |
| Sin correo | −3 |
| Correo sugerido, sin confirmar | −2 |
| Correo de área (facturación, RH…) | −1 |
| Cerrado temporalmente | −3 |
| Sin actividad en más de un año | −2 |
| Sin actividad reciente (6–12 meses) | −1 |
| Sin señales de actividad | −2 |
| Datos sin revisar en más de 6 meses | −1 |
| Sin dirección | −1 |
| Sin sitio web | −1 |

Etiquetas: 9–10 Completo · 7–8 Bueno · 4–6 Incompleto · 1–3 Pobre.

### Buscar, Prospectos y envíos
- **Búsqueda:** modo **México · DENUE** (por defecto si hay token), Google (solo consulta) o mundial con OSM.
- **Prospectos por vendedor:** cada uno tiene dueño. Hay "Tomar" y reasignación por un admin, buscador, filtros, paginación, notas, "Buscar correo", "Dar de baja" y "Vincular con DENUE".
- **Correo:** todo sale por GoHighLevel con el vendedor logueado como remitente, y se firma con su nombre. Antes de enviar se revisa la lista de BAJAS, siempre va la línea de baja, queda registro de cada envío y se avisa si a ese correo ya se le escribió en los últimos 30 días.
- **Seguridad:** `AUTH_SECRET` obligatorio, límite de intentos de login, contraseñas con hash scrypt y protección SSRF.

## Regla de datos (términos de Google)
Lo que se **guarda o exporta** (Prospectos, CSV, GHL) sale de **DENUE, OpenStreetMap o la web del propio negocio**.

De Google solo se guarda el `place_id`, y las coordenadas por un máximo de 30 días. Su rating y sus reseñas se muestran como referencia. Los negocios que solo aparecen en Google no se pintan en el mapa (que es de OpenStreetMap) ni se exportan; se pueden "Vincular con DENUE".

Para limpiar los datos de Google guardados antes de este cambio existe `POST /api/admin/google-cleanup` (solo admin):
1. Correr primero `{"dryRun": true}`, que solo cuenta.
2. Después `{"dryRun": false, "limit": 100}`, repitiendo mientras `remaining` sea mayor que 0.

## Variables de entorno

| Variable | Para qué | Requerida |
|---|---|---|
| `DATABASE_URL` | Postgres de **Supabase**: cadena del *Transaction pooler* (puerto 6543), en Project Settings → Database → Connection string. También sirve `POSTGRES_URL` si se conecta con la integración de Supabase en Vercel. Las tablas se crean solas con RLS activo (la API pública de Supabase no las ve). Si ya existe una tabla con el mismo nombre que no es de esta app, se detiene sin modificar nada: conviene un proyecto de Supabase **dedicado** | Sí |
| `DB_POOL_MAX` | Conexiones por instancia (3) | No |
| `AUTH_SECRET` | Firma de sesiones, ≥ 32 caracteres. Generar: `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` | Sí (en producción) |
| `APP_LOGIN_EMAIL` + `APP_LOGIN_PASSWORD` o `APP_USERS` | Usuarios (`correo:clave,correo2:clave2`); acepta hashes `scrypt:<salt>:<hash>` | Sí |
| `APP_ADMINS` | Correos admin, separados por coma (si falta, el admin es `APP_LOGIN_EMAIL`) | No |
| `ANTHROPIC_API_KEY` | Agente "Investigar con IA" | Para el agente |
| `AGENT_MODEL` / `AGENT_EFFORT` / `AGENT_DAILY_RUNS` | Modelo (default `claude-opus-5-5`; `claude-sonnet-5-5` cuesta más o menos la mitad), esfuerzo (`medium`) e investigaciones por vendedor al día (15) | No |
| `APP_URL` | URL pública de la app (enlaces en notas de GHL y en el MCP) | Recomendada |
| `DENUE_TOKEN` | API del DENUE. Gratis: se registra un correo en la [página de la API de INEGI](https://www.inegi.org.mx/servicios/api_denue.html) | Muy recomendada |
| `GOOGLE_PLACES_API_KEY` | Google como referencia | No |
| `GOOGLE_PLACES_DAILY_CAP` / `PLACES_ACTIVITY_SIGNAL` | Tope diario de llamadas (300; 0 apaga Google) y si se piden reseñas (`on`/`off`) | No |
| `GHL_PIT`, `GHL_LOCATION_ID` | GoHighLevel: contactos, notas y envío de correo. El remitente **no se configura**: siempre es el vendedor logueado ("Aldo Perez (AI Lead Shield) <aldo@…>"), que debe estar dado de alta como remitente en GHL | Sí |
| `MCP_TOKENS` / `MCP_DAILY_CALLS` / `MCP_ALLOWED_ORIGINS` | Servidor MCP: tokens por vendedor (`correo:token`, ≥ 32 caracteres; los genera `scripts/generar-credenciales.mjs`), tope diario de llamadas (500) y orígenes permitidos (ver [mcp.md](mcp.md)) | Para MCP |

El agente usa `after()` con `maxDuration = 300`, así que requiere **Fluid compute** en Vercel. En el plan Pro se puede subir a 800 s.

## Siguientes pasos (resumen del roadmap)

1. **Fase 0 (≈ 4 días-persona):**
   - Webhooks de GHL (respuestas, citas, aperturas) para actualizar estados al instante.
   - Vista "Oportunidades de hoy" y resumen diario.
   - Tiles de mapa con licencia, como OpenFreeMap.
2. **Fase 1 (≈ 12–15 d-p):**
   - Importar DENUE de los giros objetivo (≈156 mil negocios; ≈17.7 mil con 6 o más empleados).
   - PostGIS/H3 y mapa nacional agregado por municipio.
   - Rastreo periódico de sitios.
3. **Fase 2 (≈ 20–25 d-p):**
   - Barridos periódicos y detección de negocios nuevos y de quejas de atención.
   - Feed de oportunidades con alertas al vendedor.
   - Territorios por vendedor.
4. **Fase 3 (≈ 25–30 d-p):**
   - Diferencias entre ediciones de DENUE (la próxima sale el 25-nov-2026) y dominios nuevos.
   - Recalibrar el modelo con resultados reales y hacer pruebas A/B de mensajes.

Los detalles, costos y KPIs están en [tiempo-real-y-arquitectura.md](tiempo-real-y-arquitectura.md).
