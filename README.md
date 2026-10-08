# AI Lead Shield · Prospector

Herramienta interna de prospección B2B en México. Un agente con IA investiga clientes potenciales en lenguaje natural ("clínicas dentales activas en El Refugio, Querétaro") y entrega un reporte con ranking, el porqué de cada negocio y un mensaje sugerido. Desde ahí se descarga el **CSV** o se manda a **GoHighLevel**, que es la base de clientes.

## Qué hace

- **Investigar con IA:** Claude con herramientas busca en DENUE (INEGI), OpenStreetMap, la web y Google (este último solo como referencia). Revisa los sitios de los negocios, cruza con los prospectos existentes y con las BAJAS, y califica.
- **Buscar:** búsqueda directa por giro y ciudad (DENUE, Google u OSM), con mapa y extracción de correos.
- **Prospectos:** mini-CRM por vendedor, con dueño, estados, notas, buscador, filtros, CSV y envío a GHL.
- **Calificación por resta (1–10):** 10 = datos completos y actividad reciente; cada dato que falta o está viejo resta puntos, y siempre se muestra el desglose.
- **Propuestas:** correo por GoHighLevel con el vendedor logueado como remitente, o WhatsApp. Antes de enviar se revisa la lista de BAJAS y queda registro de cada envío.
- **Servidor MCP:** las mismas herramientas para usarlas desde Claude Code o Claude Desktop.

## Correr en local

```bash
npm install
```

```bash
npm run dev
```

Necesita al menos `DATABASE_URL` (Postgres de Supabase), `AUTH_SECRET` y un usuario (`APP_LOGIN_EMAIL` y `APP_LOGIN_PASSWORD`). La lista completa de variables está en [docs/README.md](docs/README.md#variables-de-entorno).

## Documentación

- [docs/README.md](docs/README.md): qué está construido, la regla de datos de Google, las variables de entorno y el roadmap.
- [docs/fuentes-de-datos-mexico.md](docs/fuentes-de-datos-mexico.md): DENUE, Google, OSM y el marco legal.
- [docs/tiempo-real-y-arquitectura.md](docs/tiempo-real-y-arquitectura.md): señales, arquitectura y mapa nacional.
- [docs/mcp.md](docs/mcp.md): conectar Claude Code o Claude Desktop.

## Buenas prácticas de envío

- El cold email masivo desde el dominio principal **quema su reputación**. Para volumen, usa un dominio aparte con calentamiento, SPF, DKIM y DMARC.
- Manda pocos correos y bien dirigidos. La línea de baja ("responda BAJA") se agrega sola.

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind 4 · Supabase (Postgres) · Claude API · GoHighLevel · Leaflet · DENUE (INEGI) · OpenStreetMap.
