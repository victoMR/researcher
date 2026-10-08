# Fuentes de datos para el mapa nacional de prospectos (México)

> Fecha: 2026-10-08. Alcance: fuentes base del universo de negocios, sus licencias y el marco legal.
> Las señales "en tiempo real", el enriquecimiento con IA, el mapa y la arquitectura de jobs están en [`tiempo-real-y-arquitectura.md`](./tiempo-real-y-arquitectura.md). Este documento alimenta su tabla `businesses`.
> Las cifras se verificaron en la fecha indicada. Lo que no se pudo confirmar dice **"por verificar"**. Los precios están en USD.

## 0. Resumen

1. **La columna vertebral debe ser DENUE (INEGI)**: es gratuito, cubre todo el país, permite uso comercial con atribución y trae SCIAN, estrato de personal, coordenadas y, cuando existen, teléfono, correo y web. La edición vigente es la **05/2026 (20-may-2026), con 6,138,075 establecimientos**. La siguiente está anunciada para el **25-nov-2026**.
2. **Universo objetivo según DENUE 05/2026**: 3,296 agencias de autos nuevos, 5,456 de usados, 8,243 inmobiliarias y corredores, 97,872 talleres de mecánica general y 41,199 refaccionarias de partes nuevas. Suman **156,066** en el núcleo y **≈388 mil** con giros afines. Con **6 o más empleados** solo quedan **≈17.7 mil** en las 6 clases clave, y ahí está el ICP.
3. **Google Places no puede ser la base**. Text Search devuelve como máximo 60 resultados, y barrer el país cuesta entre US$0.8k y 2.4k por pasada. Sobre todo, los términos prohíben *"copy and save business names, addresses"*: solo se puede guardar el `place_id`, y la lat/lng por 30 días. Sirve como enriquecimiento **bajo demanda**, y buscar el `place_id` con el SKU *IDs Only* es **gratis**.
4. **OSM tiene cobertura muy baja en estos giros**: `shop=car` = 1,580 contra 8,752 en DENUE (≈18%), `shop=car_repair` = 2,536 contra 97,872 (≈2.6%) y `office=estate_agent` = 255 contra 8,243 (≈3%). Es útil como capa complementaria y se procesa localmente desde Geofabrik (616 MB).
5. **Overture Maps Places** tiene ≈81 M POIs globales, se actualiza cada mes y usa licencias CDLA-Permissive-2.0 o Apache-2.0, sin share-alike. Es la mejor segunda fuente para web y teléfono. El conteo para México está **por verificar**.
6. **Ley**: la LFPDPPP vigente es la **nueva ley del DOF 20-mar-2025**, con última reforma del 14-nov-2025. La autoridad ahora es la **Secretaría Anticorrupción y Buen Gobierno**, porque el INAI se extinguió. La ley quitó "física" de la definición de dato personal. No se encontró un reglamento nuevo, y la exclusión de personas morales y comerciantes del reglamento de 2011 queda **incierta**. Conviene tratar de forma conservadora los datos de personas físicas con actividad empresarial.

---

## 1. DENUE (INEGI): prioridad máxima

### 1.1 Contenido

| Grupo | Campos (API / CSV) |
|---|---|
| Identificación | `Id` numérico, `CLEE` (clave estadística), nombre del establecimiento, razón social |
| Actividad | Clase SCIAN de 6 dígitos y su nombre. `BuscarAreaAct*` agrega sector, subsector, rama y subrama |
| Tamaño | Estrato de personal ocupado: 1 = 0–5, 2 = 6–10, 3 = 11–30, 4 = 31–50, 5 = 51–100, 6 = 101–250, 7 = 251 y más |
| Ubicación | Tipo y nombre de vialidad, número exterior e interior, colonia, CP, entidad, municipio, localidad, AGEB, manzana, centro comercial o corredor industrial, **latitud y longitud** |
| Contacto | Teléfono, correo electrónico, sitio de internet. Son opcionales: muchas fichas los traen vacíos, y el % de llenado por giro está **por verificar** (calcularlo al cargar) |
| Fechas | `Fecha_Alta` en formato AAAA-MM, solo en `BuscarAreaActEstr` y en el CSV |
| Tipo | Fijo o semifijo |

Fuente: [API DENUE](https://www.inegi.org.mx/servicios/api_denue.html).

**Cobertura**: todos los establecimientos activos del país salvo el sector agropecuario. Las localidades rurales muy pequeñas están parcialmente cubiertas ([portal DENUE](https://www.inegi.org.mx/app/mapa/denue/default.aspx)). Se clasifica con **SCIAN México 2023**, el mismo de los Censos Económicos 2024 ([SCIAN](https://www.inegi.org.mx/scian/)).

**Ediciones y actualización**:

- La edición 05/2025 se cortó con datos a marzo de 2025, sobre la base de los Censos Económicos 2024. **Incorporó 168,676 unidades y dio de baja 129,549**, una rotación de ≈2–3% por edición ([catálogo INEGI](https://www.inegi.org.mx/rnm/index.php/catalog/1103)).
- La edición 05/2026 tiene 6,138,075 establecimientos y "actualiza… en especial los más grandes". La próxima es el 25-nov-2026 ([boletín 27/26](https://www.inegi.org.mx/contenidos/saladeprensa/boletines/2026/denue/DENUE2026_05.pdf)).
- La cadencia es **irregular**: hubo 11/2022 y luego 11/2023, sin edición 05/2023. Tampoco se localizó una 11/2025: la ruta del boletín no existe y el cubo de DataMéxico salta de 2025-05 a 2026-05 (**por verificar**). Los negocios grandes se actualizan de forma continua. Las micro y pymes se actualizan parcialmente, y por completo solo con el censo quinquenal.

**Licencia**: los [Términos de Libre Uso del INEGI](https://www.inegi.org.mx/inegi/terminos.html) permiten copiar, adaptar y **explotar comercialmente**. A cambio exigen:

- citar "Fuente: INEGI, DENUE 05/2026";
- avisar que hubo transformaciones propias;
- no dar a entender que el INEGI respalda el producto.

### 1.2 API

- **URL base**: `https://www.inegi.org.mx/app/api/denue/v1/consulta/`. Responde en JSON. El token va siempre al final de la ruta.
- **Token**: es gratuito y se pide con un correo electrónico en el formulario "Obtener Token" de la [página del API](https://www.inegi.org.mx/servicios/api_denue.html) (iframe `/app/api/denue/tokenVerify/tokenverify.html`). Sin token, la API responde `"No autorizado. Utilice una clave válida."`, lo que se verificó el 2026-10-08.
- **Límites**: `Buscar` admite un radio de hasta 5,000 m. No hay cuota ni rate limit documentados (**por verificar**), así que conviene paginar con registro inicial y final en bloques de ≤1,000.
- **Verificado con token real (2026-10-08)**:
  - **No mandar `Accept: application/json`**. Con ese encabezado, `Buscar` y `BuscarEntidad` responden JSON *doblemente codificado* (un string que contiene el arreglo); `BuscarAreaAct` no cambia. `src/lib/denue.ts` ya no lo manda y además desempaca el string si llega así.
  - **Palabras separadas por coma = O (unión)**, no Y: «dental» (26) + «taller» (23) = «dental,taller» (49). Conviene una sola palabra distintiva o, para un giro exacto, `BuscarAreaAct` con SCIAN.
  - **Niveles SCIAN de `BuscarAreaAct`**: el orden sector/subsector/rama/clase es correcto. Con `62/621/6212/621211` solo regresa "Consultorios dentales del sector privado".
  - **Sin resultados**: responde 200 con el texto `"No hay resultados. "`, no un 404.
  - **La CLEE puede traer un SCIAN viejo**. Comparada con `CLASE_ACTIVIDAD_ID`, difiere en 1.7–7% de los registros. Solo `BuscarAreaAct` regresa `CLASE_ACTIVIDAD_ID` y `Fecha_Alta`; `Buscar` no.
  - **Campos de `Buscar`**: CLEE, Id, Nombre, Razon_social, Clase_actividad, Estrato, Tipo_vialidad, Calle, Num_Exterior, Num_Interior, Colonia, CP, Ubicacion, Telefono, Correo_e, Sitio_internet, Tipo, Longitud, Latitud, CentroComercial, TipoCentroComercial, NumLocal.
  - **Llenado real en el municipio de Querétaro**. Dentistas (621211, 300): 64% con teléfono, 53% con correo, 7% con web. Agencias de autos nuevos (468111, 52): 40% con teléfono, 69% con correo, 73% con web.

| Método | Parámetros en orden | Uso |
|---|---|---|
| `Buscar` | condición (`todos` = todo), `lat,lon`, metros (≤5000), token | Negocios alrededor de un punto |
| `BuscarEntidad` | condición, entidad (`00` = todas), reg. inicial, reg. final, token | Texto libre por estado |
| `Nombre` | nombre o razón social, entidad, reg. inicial, reg. final, token | Buscar grupos o marcas |
| `Ficha` | Id, token | Refrescar un registro |
| `BuscarAreaAct` | entidad, municipio, localidad, AGEB, manzana, sector, subsector, rama, clase, nombre, reg. ini, reg. fin, Id, token (`0` = todos) | Extracción por SCIAN y área |
| `BuscarAreaActEstr` | lo mismo que `BuscarAreaAct` + **estrato** antes del token | Igual, filtrando tamaño. Trae `Fecha_Alta` |
| `Cuantificar` | actividad (2–6 dígitos, separadas por comas; `0` = todas), área (`0` = país, 2/5/9 dígitos), estrato, token | Conteos para dashboards y mapas de calor |

Ejemplos:

```bash
T=TU_TOKEN; B=https://www.inegi.org.mx/app/api/denue/v1/consulta
# Conteo nacional de agencias de autos nuevos y usados
curl "$B/Cuantificar/468111,468112/0/0/$T"
# Conteo de inmobiliarias en CDMX, Jalisco y Nuevo León
curl "$B/Cuantificar/531210/09,14,19/0/$T"
# Agencias de autos nuevos en Jalisco con 11–30 empleados (estrato 3), registros 1–1000
curl "$B/BuscarAreaActEstr/14/0/0/0/0/0/0/0/468111/0/1/1000/0/3/$T"
# Talleres de mecánica general en Guadalajara (14039), todos los estratos
curl "$B/BuscarAreaAct/14/039/0/0/0/0/0/0/811111/0/1/1000/0/$T"
# Todos los negocios a 1 km de un punto de Monterrey
curl "$B/Buscar/todos/25.6866,-100.3161/1000/$T"
# Sucursales de un grupo o marca en todo el país
curl "$B/Nombre/toyota/00/1/100/$T"
curl "$B/Ficha/34185/$T"
```

El formato de 3 dígitos para municipio está **por verificar**: la documentación usa `0` en sus ejemplos.

### 1.3 Descarga masiva

En la [página de descarga](https://www.inegi.org.mx/app/descarga/?ti=6) hay archivos ZIP directos, todos con `Last-Modified: 20-may-2026`. Se verificaron por HEAD sin descargarlos.

- Por sector, a nivel nacional: `https://www.inegi.org.mx/contenidos/masiva/denue/denue_00_{SECTOR}_csv.zip`.
- Por entidad: `denue_{EE}_csv.zip`, por ejemplo `denue_09_csv.zip` (45 MB). También hay `_shp.zip`, por ejemplo `denue_09_shp.zip` (90 MB). Algunas entidades grandes vienen partidas: `denue_15_csv.zip` no existe como archivo único (**por verificar** su nombre).
- Todo el país, sumando los 25 archivos sectoriales, pesa **≈545 MB** comprimido.

| Giro | Archivo nacional | Tamaño |
|---|---|---|
| Autos, refacciones, llantas, motos (4681–4684) | `denue_00_46591-46911_csv.zip` (rango inferido, **por verificar**) | 60.2 MB |
| Inmobiliarias (53) | `denue_00_53_csv.zip` | 8.3 MB |
| Talleres (8111) | `denue_00_81_1_csv.zip` (**por verificar** si 8111 está en `_1` o en `_2`) | 50.2 MB |
| Mayoreo de camiones y refacciones (43) | `denue_00_43_csv.zip` | 18.3 MB |
| Financieras y seguros (52) | `denue_00_52_csv.zip` | 4.9 MB |
| Desarrolladoras (23) | `denue_00_23_csv.zip` | 2.7 MB |

Cada ZIP incluye un diccionario de datos. Hay que revisar los nombres de columna y la codificación, que históricamente es Latin-1.

### 1.4 Códigos SCIAN y conteos nacionales (DENUE 05/2026)

Los conteos salen del cubo `inegi_denue` de DataMéxico (Secretaría de Economía), que se alimenta del DENUE. La consulta usada fue `https://www.economia.gob.mx/apidatamexico/tesseract/data.jsonrecords?cube=inegi_denue&drilldowns=National+Industry&measures=Companies&Month=20260520&National+Industry=468111`.

Ese endpoint no está documentado y puede cambiar. Para cifras oficiales, validar con `Cuantificar`. Los totales por rama coinciden con los [perfiles de DataMéxico](https://www.economia.gob.mx/datamexico/es/profile/industry/real-estate-agents-and-brokers): 4681 = 8,752, 4682 = 57,835, 5312 = 8,243 y 8111 = 262,437.

| SCIAN | Clase | Establecimientos | Con 6+ personas |
|---|---|---:|---:|
| **468111** | Comercio al por menor de automóviles y camionetas **nuevos** | **3,296** | 2,545 (77%) |
| **468112** | … automóviles y camionetas **usados** | **5,456** | 566 (10%) |
| **531210** | Inmobiliarias y corredores de bienes raíces | **8,243** | 2,655 (32%) |
| **811111** | Reparación mecánica en general de automóviles y camiones | **97,872** | 4,196 (4%) |
| **468211** | Partes y refacciones **nuevas** | **41,199** | 5,855 (14%) |
| 468212 | Partes y refacciones usadas | 9,144 | — |
| 468213 | Llantas y cámaras | 7,492 | — |
| 468311 / 468319 | Motocicletas / otros vehículos de motor | 10,931 / 188 | — |
| 468420 | Aceites, lubricantes y aditivos | 8,978 | — |
| 436111 / 436112 | Mayoreo de camiones / de refacciones nuevas | 741 / 3,549 | — |
| 811121 | Hojalatería y pintura | 35,997 | 1,904 (5%) |
| 811112–811119 | Eléctrico, rectificación, transmisiones, suspensiones, alineación y balanceo, otras | 52,607 | — |
| 811191 / 811192 | Reparación menor de llantas (llanteras) / lavado y lubricado | 29,574 / 32,271 | — |
| 811122 / 811129 / 811199 | Tapicería / cristales y carrocería / otros | 2,415 / 2,867 / 8,748 | — |
| 531311 / 531319 | Administración de bienes raíces / otros servicios inmobiliarios | 4,587 / 2,215 | — |
| 236111 / 236112 | Edificación de vivienda unifamiliar / multifamiliar (desarrolladoras) | 5,221 / 891 | — |
| 522460 / 522440 | SOFOM (financieras automotrices incluidas) / autofinanciamiento | 4,358 / 260 | — |
| 524110 / 524210 | Compañías de seguros / agentes y gestores de seguros | 1,877 / 5,214 | — |
| 532110 | Alquiler de automóviles sin chofer | 1,793 | — |

Las agencias de autos nuevos son medianas: el 67% tiene 11 o más empleados. Los talleres son casi todos micro: el 95.7% tiene de 0 a 5. Como validación externa, AMDA calcula **≈3 mil distribuidores** en México ([AMDA, feb-2025](https://amda.mx/wp-content/uploads/Informe-Presidencia-Ejecutiva-febrero-2025.pdf)), cifra consistente con los 3,296 de la clase 468111.

---

## 2. Google Places API (New)

### 2.1 Por qué no sirve como base nacional

- **Tope técnico**:
  - Text Search devuelve *"a maximum of 60 results across all pages"*, en páginas de 20, y cada página es una solicitud facturable.
  - Nearby Search devuelve como máximo 20 resultados en un radio ≤50 km.
  - `locationRestriction` en Text Search solo acepta rectángulos.

  Nunca se sabe si se obtuvo todo ([Text Search](https://developers.google.com/maps/documentation/places/web-service/text-search), [Nearby](https://developers.google.com/maps/documentation/places/web-service/nearby-search)).
- **Términos**:
  - §3.2.3(a) prohíbe *"pre-fetch, index, store"* y *"copy and save business names, addresses, or user reviews"*.
  - §3.2.3(c)(iv) prohíbe usar lat/lng de Places *"as an input for point-in-polygon analysis"*, así que no se puede asignar un territorio con coordenadas de Google.
  - Los términos específicos §14.3 permiten guardar lat/lng **30 días**.
  - §14.2 dice *"must not use… Places API in conjunction with a non-Google map"* (vigente al 2026-10-08).
  - El `place_id` está exento y puede guardarse indefinidamente. Se recomienda refrescarlo si tiene más de 12 meses, y ese refresco es gratis.

  Fuentes: [ToS](https://cloud.google.com/maps-platform/terms), [Service Specific Terms](https://cloud.google.com/maps-platform/terms/maps-service-terms), [Place IDs](https://developers.google.com/maps/documentation/places/web-service/place-id).

  Esto aplica directamente al código actual, que guarda rating, teléfono y lat/lon de Google en `leads` y los pinta sobre Leaflet/OSM. Ver los hallazgos en el doc hermano.
- **Costo de barrer México** con la [lista global de precios](https://developers.google.com/maps/billing-and-pricing/pricing). Los precios son por 1,000 solicitudes en el primer tramo: Text Search Pro cuesta US$32 con 5,000 gratis al mes, Enterprise US$35 y Enterprise + Atmosphere US$40, estos dos con 1,000 gratis. Desde 100,001 solicitudes baja a US$25.60, 28 y 32 respectivamente.

| Escenario | Solicitudes | Pro | Ent.+Atmos. |
|---|---:|---:|---:|
| Mínimo teórico (156k negocios ÷ 20 por página) | ~7,800 | ~US$90 | ~US$270 |
| ≈2,475 municipios × 5 giros, ~1.5 páginas en promedio | ~18,600 | ~US$435 | ~US$705 |
| Realista: subdividir metros donde talleres y refacciones saturan el tope de 60 | 30k–60k | US$800–1,760 | US$1,160–2,360 |

Como la lat/lng caduca a los 30 días y los nombres no se pueden guardar, habría que repetir el barrido cada mes: **≈US$10k–28k al año** por datos que no se pueden conservar. El número de municipios está **por verificar**: según la fuente va de 2,469 a 2,478.

### 2.2 Cómo usarla bien: enriquecimiento puntual por `place_id`

1. **Vincular gratis**. Para cada negocio DENUE que se vaya a trabajar, hacer un Text Search con `textQuery = "<nombre> <colonia> <municipio>"`, `locationBias` en un círculo de 300 m alrededor de la coordenada DENUE y `X-Goog-FieldMask: places.id,nextPageToken`. Eso dispara el SKU **Text Search Essentials (IDs Only), que es ilimitado y gratis**. Guardar solo `place_id` y `place_id_checked_at`.
2. **Enriquecer bajo demanda**. Cuando el vendedor abre la ficha, llamar Place Details (`GET /v1/places/{id}`) con `displayName,location,rating,userRatingCount,regularOpeningHours,nationalPhoneNumber,websiteUri`. Cuesta US$20 por 1,000 en el SKU Enterprise, con 1,000 gratis al mes. Con 5,000 fichas al mes son ≈US$80, y con 10,000, ≈US$180. Si `displayName` y la distancia no coinciden, se descarta el vínculo.
3. **Mostrar sin persistir**: en la tarjeta del lead, con atribución de Google, y no sobre el mapa MapLibre/Leaflet. Las reseñas (`reviews`, SKU Atmosphere, US$25 por 1,000) van solo en el flujo de señales del doc hermano.
4. **No usar `places.reviews`** en búsquedas masivas, porque cobra *cada página* como Atmosphere.

---

## 3. OpenStreetMap: cobertura, licencia y uso

**Cobertura en México**. Los conteos vienen de [taginfo Geofabrik México](https://taginfo.geofabrik.de/north-america:mexico/), con datos hasta el 2026-10-06, y suman nodos, vías y relaciones:

| Etiqueta OSM | OSM MX | DENUE equivalente | Cobertura |
|---|---:|---:|---:|
| `shop=car` | 1,580 | 8,752 (4681) | ≈18% |
| `shop=car_repair` | 2,536 | 97,872 (811111) / 262,437 (8111) | ≈1–3% |
| `shop=car_parts` | 1,589 | 57,835 (4682) | ≈3% |
| `shop=tyres` | 599 | 7,492 (468213) | ≈8% |
| `shop=motorcycle` | 227 | 10,931 | ≈2% |
| `office=estate_agent` | 255 | 8,243 | ≈3% |
| `amenity=car_rental` | 452 | 1,793 | ≈25% |
| `office=insurance` | 147 | 7,091 | ≈2% |

En todo México hay 31,443 objetos con `phone`, 21,640 con `website` y 11,884 con `email`, de todos los giros. Conclusión: OSM sirve para validar ubicación y conseguir web o teléfono de algunas agencias, pero no para el universo.

**Licencia ODbL 1.0**:

- **Atribución**: "© OpenStreetMap contributors" con liga a [openstreetmap.org/copyright](https://www.openstreetmap.org/copyright), en el mapa y en cualquier producto.
- **Share-alike**: solo se activa si una *Derivative Database* se usa de forma pública ("Publicly Used"). Un CRM interno no lo es.
- **Al combinar con otras fuentes**: si se publica o distribuye la base combinada, hay que mantener separadas las partes OSM y no OSM. Así cuenta como *Collective Database* y el share-alike aplica solo a la parte OSM. Usar OSM como llave de cruce puede contaminar el resultado ([guía Collective Database](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Collective_Database_Guideline_Guideline)).
- **Recomendación**: guardar los atributos OSM en `business_sources` (fuente `osm`) sin copiarlos a los campos canónicos cuando DENUE ya los tiene.

**Políticas de uso**:

- [Nominatim](https://operations.osmfoundation.org/policies/nominatim/): máximo 1 solicitud por segundo y User-Agent propio. **Prohíbe consultas sistemáticas en cuadrícula y "downloading all POIs in an area"**.
- [Overpass](https://wiki.openstreetmap.org/wiki/Overpass_API): menos de 10,000 consultas y menos de 1 GB al día para uso puntual, y ÷100 para uso recurrente.
- **Para un país completo hay que usar el extracto**: [Geofabrik `mexico-latest.osm.pbf`](https://download.geofabrik.de/north-america/mexico.html) pesa 616 MB, se actualiza a diario y existe una versión SHP de 1.2 GB. Se filtra con `osmium tags-filter mexico-latest.osm.pbf nwr/shop=car,car_repair,car_parts,tyres,motorcycle nwr/office=estate_agent,insurance -o autos.pbf` y se carga con `ogr2ogr` o `osm2pgsql`.

---

## 4. Otras fuentes

| Fuente | Qué aporta | API oficial | Riesgo legal y ToS |
|---|---|---|---|
| **Overture Maps Places** ([docs](https://docs.overturemaps.org/guides/places/)) | ≈81 M POIs globales (Meta, Foursquare, AllThePlaces, entre otras), con web, teléfono, redes, marca, `confidence` y release mensual | Descarga GeoParquet desde S3 o Azure. Filtro por bbox con DuckDB | **Bajo**: CDLA-P-2.0 o Apache-2.0, sin OSM. El conteo en MX está **por verificar** |
| **Foursquare OS Places** ([docs](https://docs.foursquare.com/data-products/docs/access-fsq-os-places)) | POIs con `date_refreshed` y `date_closed` | Catálogo Iceberg, que requiere cuenta y token del portal | Bajo (Apache-2.0). Como requiere registro, queda para el dueño |
| **AMDA** | Validación de ≈3,000 distribuidores y de grupos automotrices | No hay directorio público localizado | Pedir el directorio, no extraerlo |
| **AMPI** ([ampi.org](https://ampi.org/)) | ≈5,000 socios y más de 100 secciones. Los directorios están por sección | No | Medio: los datos son de personas físicas (asesores). Usarlo solo como validación |
| **Padrones inmobiliarios estatales** | Asesores acreditados en Jalisco ([ley](https://mexico.justia.com/estatales/jalisco/leyes/ley-que-establece-el-registro-y-acreditacion-de-los-prestadores-de-servicios-en-materia-inmobiliaria-del-estado-de-jalisco/)), Quintana Roo ([ley, ref. 16-dic-2025](https://documentos.congresoqroo.gob.mx/leyes/L308-XVIII-20251216-L1820251216186-Ley-Servicios-Inmobiliarios.pdf), ≈1,721 acreditaciones), Sonora, BC (331–400 registrados), BCS y [NL](https://www.hcnl.gob.mx/trabajo_legislativo/leyes/leyes/ley_que_crea_el_registro_estatal_de_asesores_inmobiliarios_del_estado_de_nuevo_leon/) | Consulta web | Medio: son públicos por ley (podrían contar como "fuente de acceso público"), pero contienen datos de personas físicas |
| **SIEM** ([siem.economia.gob.mx](https://siem.economia.gob.mx/)) | Registro obligatorio de establecimientos ante las cámaras. Su cobertura es menor que la de DENUE | No documentada | Bajo valor. Una columna de Forbes lo describe como recaudatorio y recomienda DENUE para contar negocios |
| **Mercado Libre** | Vendedores activos en Autos y Camionetas (`MLM1744`, **69,878** publicaciones) e Inmuebles (`MLM1459`, **315,072**), consultados vía `/categories` el 2026-10-08. Es una señal de intención | Sí. Desde 2026-10-08 `/sites/MLM/search` responde **403 sin OAuth**, así que hace falta una app y un token | Medio: aplican los [términos de desarrolladores](https://developers.mercadolibre.com.ar/es-ar-terminos-y-condiciones). No expone el contacto del vendedor y el cruce con el negocio es manual |
| **Inmuebles24, Lamudi, Vivanuncios, Propiedades.com** | Inmobiliarias con inventario activo | Sin API pública para terceros | **Alto**: Inmuebles24 respondió con un *challenge* de Cloudflare (403) y Lamudi y Propiedades bloquearon el cliente. El ToS específico está **por verificar**. No hacer scraping |
| **Seminuevos.com, Kavak** | Lotes de seminuevos que publican en línea. Kavak es comprador y competidor, no prospecto | No | **Alto**: el `robots.txt` tiene `Disallow` amplios |
| **Sección Amarilla** | Directorio pagado de anunciantes | No | Alto: base comercial de un tercero, con ToS **por verificar** |
| **Localizadores de marca** (Nissan, GM, Toyota, VW, Kia…) | Lista oficial de distribuidores por marca y grupo | JSON interno no documentado | Medio: usarlo en volumen bajo solo para validar y asignar `group_name` |
| **PSM (Publicaciones de Sociedades Mercantiles, SE)** | Constituciones de sociedades nuevas | Consulta web | Bajo. Es una **señal** de negocio nuevo y está en el doc hermano (URL **por verificar**) |

---

## 5. Marco legal (resumen informativo, **no es asesoría legal**)

**Ley vigente**:

- La [LFPDPPP](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPDPPP.pdf) es una ley nueva, publicada en el DOF el 20-mar-2025 y vigente desde el 21-mar-2025. Abrogó la de 2010 y su última reforma es del 14-nov-2025.
- La autoridad es la **Secretaría Anticorrupción y Buen Gobierno** (art. 2, fr. XV), porque el INAI se extinguió.
- No se localizó un reglamento nuevo. El [Reglamento de 2011](https://www.gob.mx/cms/uploads/attachment/file/724929/Reg._Ley_Fed._Protecc._Datos_Personales_21-12-2011.pdf) se emitió para la ley abrogada, así que su vigencia está **por verificar**.

**Qué es dato personal**:

- La ley lo define como *"cualquier información concerniente a una persona identificada o identificable"* (art. 2, fr. V). Ya no dice "física", y [hay quien lee](https://idconline.mx/corporativo/2025/03/28/lfpdppp-5-cambios-clave-en-el-manejo-de-datos-personales) que podría alcanzar a personas morales.
- El art. 5 del reglamento de 2011 excluía tres casos:
  - los datos de personas morales;
  - los de personas físicas "en su calidad de comerciantes y profesionistas";
  - los datos laborales de empleados usados para representar al empleador.
- Hoy esa exclusión es **incierta**.

| Caso | Tratamiento recomendado |
|---|---|
| Persona moral, con razón social que termina en S.A. de C.V., S. de R.L., S.C., SAPI, etc. | Riesgo bajo. Usar nombre comercial, teléfono de conmutador y correos genéricos (`ventas@`) |
| Persona física con actividad empresarial: taller o lote cuya razón social es el nombre del dueño | **Tratar como dato personal**: guardar el nombre comercial, no el del dueño; minimizar; registrar fuente y fecha |
| Empleado (`juan.perez@agencia.com`, celular personal) | Dato personal. Usarlo solo para fines B2B, con aviso y opción de baja |

**Bases del tratamiento**:

- El consentimiento tácito es válido como regla general cuando se pone a disposición el aviso y el titular no se opone (art. 7).
- No se necesita consentimiento si los datos están en una **fuente de acceso público** (art. 9, fr. II).
- La ley define fuente de acceso público como la que se puede consultar *"por disposición de ley"* (art. 2, fr. X). DENUE (publicado conforme a la LSNIEG) y los padrones inmobiliarios estatales *podrían* encajar, lo que está **por verificar con abogado**. El sitio web del negocio o Google probablemente no encajan.
- Cuando los datos no se obtuvieron del titular, hay que darle a conocer el aviso (art. 17).
- El aviso integral tiene contenido mínimo (art. 15) y existe una versión simplificada para medios electrónicos, con las fracciones I a IV más una liga (art. 16).
- El titular tiene derecho de oposición (art. 26).
- Las multas van de 100 a 320,000 UMA (art. 59). Con la UMA 2025 de $113.14, el tope es ≈$36 millones de pesos.

**REPEP (PROFECO)**:

- El REPEP está en los arts. 18 y 18 Bis de la [LFPC](https://www.diputados.gob.mx/LeyesBiblio/pdf/LFPC.pdf) y protege a **consumidores**: quien adquiere *"como destinatario final"* (art. 2).
- Las empresas que compran para integrar el servicio a su negocio solo cuentan como consumidores para los arts. 99 y 117, y solo si son microempresas. Por eso la prospección B2B queda en principio fuera.
- Aun así, el REPEP registra **números telefónicos**, y un taller micro suele usar el celular de su dueño. Recomendación: **cruzar contra el [REPEP](https://repep.profeco.gob.mx/) los móviles de personas físicas** antes de llamar o enviar SMS o WhatsApp, y respetar cualquier "no me contacten" (art. 17 LFPC).
- El REUS de CONDUSEF no aplica, porque AI Lead Shield no es entidad financiera.

**Prácticas mínimas**:

1. Publicar el aviso integral y poner la liga al simplificado en *cada* primer contacto: correo, pie de WhatsApp y guion de llamada.
2. Guardar, por cada dato de contacto, la fuente, la URL, la fecha y si es genérico o personal, para responder "¿de dónde sacaron mis datos?".
3. Ofrecer baja en un clic, aplicada a una supresión global (la tabla `suppression` existente) en todas las fuentes y campañas.
4. No guardar datos sensibles ni nombres de autores de reseñas, y no comprar listas.
5. Purgar los prospectos sin interacción después de 12 a 18 meses.
6. Respetar el opt-in que exige la plataforma de WhatsApp Business para mensajes iniciados por la empresa.
7. Validar con un abogado tres puntos: si DENUE cuenta como fuente pública, si las personas morales caen bajo la nueva ley y si sigue aplicando el art. 5 del reglamento de 2011.

---

## 6. Recomendación

### 6.1 Rol de cada fuente

| Capa | Fuente | Rol |
|---|---|---|
| Universo y geometría canónica | **DENUE** | Alta y baja de negocios, SCIAN, estrato, coordenadas, `fecha_alta` |
| Complemento abierto | Overture → OSM | Web, teléfono, redes, `confidence`. Agencias no captadas por DENUE |
| Validación del ICP | AMDA, marcas, padrones inmobiliarios, Mercado Libre | `group_name`, distribuidor oficial, inventario activo |
| Enriquecimiento efímero | Google (`place_id` guardado; lo demás en vivo) | Rating, reseñas, horario, teléfono actual |
| Contacto | Sitio web propio del negocio (el extractor actual) | Correos con fuente y fecha |

### 6.2 Cruce de fuentes

Como en el §3.3 del doc hermano:

1. **Llaves fuertes**: `denue_id`/`clee`, `place_id`, `osm_type/osm_id`, `overture_id`, teléfono E.164 (+52 y 10 dígitos) y dominio registrable.
2. **Coincidencia difusa**:
   - `name_norm`: minúsculas, sin acentos, sin sufijos societarios, sin palabras genéricas ("agencia", "taller", "automotriz"), con `similarity ≥ 0.6` de pg_trgm;
   - `ST_DWithin` ≤150 m en zona urbana o ≤500 m en zona rural;
   - misma familia SCIAN.
3. **Puntaje** = 0.45·nombre + 0.25·cercanía + 0.20·teléfono + 0.10·dominio. Si es ≥0.9 se une sola; entre 0.6 y 0.9 va a revisión.

### 6.3 Esquema (extiende `businesses` y `business_sources` del doc hermano)

```sql
-- Staging inmutable por edición del DENUE (permite diff entre ediciones)
CREATE TABLE denue_snapshot (
  edition     text      NOT NULL,          -- '2026-05'
  denue_id    bigint    NOT NULL,
  clee        text,
  nom_estab   text NOT NULL, raz_social text,
  scian       char(6)   NOT NULL,
  estrato     smallint,                    -- 1..7
  calle text, num_ext text, num_int text, colonia text, cp char(5),
  cve_ent char(2), cve_mun char(5), cve_loc char(9), ageb text, manzana text,
  telefono text, correo text, www text, tipo_unidad text,
  fecha_alta  date,                        -- AAAA-MM -> día 1
  geom        geography(Point,4326) NOT NULL,
  row_hash    bytea     NOT NULL,          -- sha256(campos normalizados)
  PRIMARY KEY (edition, denue_id)
);

ALTER TABLE businesses
  ADD COLUMN razon_social      text,
  ADD COLUMN persona_tipo      text CHECK (persona_tipo IN ('moral','fisica','desconocido')),
  ADD COLUMN estrato           smallint,
  ADD COLUMN denue_clee        text,
  ADD COLUMN denue_fecha_alta  date,
  ADD COLUMN denue_status      text DEFAULT 'activo',  -- activo|baja
  ADD COLUMN first_edition     text,
  ADD COLUMN last_edition      text,
  ADD COLUMN content_hash      bytea,                  -- detecta cambios
  ADD COLUMN place_id_checked_at timestamptz;          -- refrescar si > 12 meses

ALTER TABLE business_sources
  ADD COLUMN license  text,   -- inegi-libre-uso|odbl|cdla-p-2.0|apache-2.0|google-placeid
  ADD COLUMN raw      jsonb;  -- NUNCA para google

CREATE TABLE contact_points (
  id          bigserial PRIMARY KEY,
  business_id bigint NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
  kind        text NOT NULL,             -- email|phone|whatsapp
  value       text NOT NULL,
  is_generic  boolean,                   -- ventas@, conmutador
  is_personal boolean,                   -- dato personal (persona física)
  source      text NOT NULL, source_url text,
  seen_at     timestamptz NOT NULL DEFAULT now(),
  repep_checked_at timestamptz, opted_out_at timestamptz,
  UNIQUE (business_id, kind, value)
);

CREATE TABLE business_changes (
  business_id bigint REFERENCES businesses(id) ON DELETE CASCADE,
  source text, edition text, field text, old_value text, new_value text,
  changed_at timestamptz NOT NULL DEFAULT now()
);
```

### 6.4 Carga inicial (≈1 semana de trabajo)

1. Descargar los 6 ZIP sectoriales de §1.3 (≈145 MB).
2. Filtrar las clases SCIAN de §1.4 (≈388 mil filas) con `COPY` hacia `denue_snapshot` (edición `2026-05`).
3. Hacer upsert a `businesses`: `persona_tipo` se obtiene con una regex de sufijo societario, `geom` sale de DENUE y `h3_r7` se calcula en el ETL.
4. Medir el porcentaje de teléfono, correo y web por clase. Es la línea base que hoy está **por verificar**.
5. Cargar Overture (bbox de México con las categorías equivalentes) y el extracto OSM filtrado, y cruzarlos con §6.2.
6. Buscar `place_id` (IDs Only, gratis) **solo** para el ICP: las ≈17.7 mil empresas con 6 o más empleados y las cuentas que se van a trabajar. Hacerlo como job con rate limit, respetando las cuotas por minuto de la consola de Google, que están **por verificar**.

### 6.5 Actualización incremental

| Fuente | Cadencia | Mecanismo |
|---|---|---|
| DENUE | En cada edición (próxima 25-nov-2026). Revisar `Last-Modified` de los ZIP con un cron semanal | Nueva `edition` → diff por `denue_id`: altas (señal `new_business` si la `fecha_alta` es reciente), bajas (`denue_status='baja'`) y cambios de `row_hash` (`business_changes`). La estabilidad de `denue_id`/`clee` entre ediciones está **por verificar** comparando 05/2025 contra 05/2026 |
| DENUE API | A diario o bajo demanda | `Ficha` para refrescar una cuenta caliente, `Cuantificar` para mapas de calor |
| Overture | Mensual | Diff por `id` y `confidence` |
| OSM | Mensual | Nuevo pbf → diff por `osm_id` y versión |
| Google | Bajo demanda | Details en vivo. `place_id` con más de 12 meses → refresco IDs Only gratis |
| Webs de negocio | Mensual (top cuentas) | Extractor actual → `contact_points` con fuente y fecha |

### 6.6 Costos estimados

| Concepto | Costo |
|---|---|
| DENUE (descarga + API), OSM, Overture | US$0 |
| Almacenamiento: ≈400k negocios + snapshots semestrales (<2 GB con índices) | Dentro de planes bajos de Neon (**por verificar**) |
| Google: vínculo `place_id` (IDs Only) | US$0 |
| Google: Place Details Enterprise bajo demanda (5k–10k fichas al mes) | ≈US$80–180 al mes |
| *Alternativa descartada*: barrido Google mensual | ≈US$800–2,400 al mes, sin poder conservar los datos |
