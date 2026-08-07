# 🎯 Prospector

Herramienta todo-en-uno para investigar clientes potenciales: busca negocios por **giro + ciudad**, los localiza en un **mapa**, saca su **correo** y te deja **mandarles propuesta** — con un mini-CRM de prospectos.

## Qué hace

- **Buscar** negocios por giro (agencias, seminuevos, inmobiliarias/corretaje, talleres) y ciudad de México.
  - Datos de **OpenStreetMap** (Nominatim + Overpass) — gratis, sin API key.
- **Mapa** con todos los negocios encontrados (Leaflet + tiles de OSM).
- **Sacar correo**: al negocio con página web, extrae correos de su home y páginas de contacto.
- **Prospectos**: guarda leads (en el navegador), cámbiales estado (nuevo / contactado / respondió / descartado), exporta a **CSV**.
- **Propuesta**: redacta y envía el correo con **Resend**, o ábrelo en tu cliente de correo, o copia el texto.

## Correr en local

```bash
npm run dev
```

Abre http://localhost:3000 (o el puerto que indique la consola).

## Envío de correo (Resend)

1. Acepta los términos de Resend (link que te dio el asistente, o `vercel integration open resend/resend-email`).
2. Instala la integración:
   ```bash
   vercel integration add resend/resend-email --no-claim
   ```
3. Trae las variables de entorno:
   ```bash
   vercel env pull
   ```
4. En Resend, **verifica tu dominio** y pon el remitente en `RESEND_FROM` (ej. `Ventas <ventas@tudominio.com>`).

Sin esto, el botón "Enviar con Resend" avisa que falta config; el botón "Abrir en mi correo" funciona siempre.

## Buenas prácticas de envío (¡importante!)

- Cold email masivo desde tu dominio principal **quema tu reputación**. Para lotes grandes, usa dominio aparte + calentamiento + herramienta dedicada (Instantly/Smartlead) — exporta el CSV desde aquí.
- Manda pocos y calientes. Incluye siempre la línea de baja ("responde BAJA").

## Stack

Next.js 16 (App Router) · TypeScript · Tailwind · Leaflet · Resend · OpenStreetMap.
