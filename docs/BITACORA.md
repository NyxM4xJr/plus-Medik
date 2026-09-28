# Bitácora del proyecto

Registro compartido de decisiones, valores de tiempo y comportamientos no obvios.
Existe para que cualquier persona del equipo (y su asistente de IA) pueda
diagnosticar fallos sin reconstruir el contexto desde cero.

Este archivo **se versiona en git**. No lo agregues a `.gitignore`.

## Protocolo

Quien haga un cambio (persona o asistente de IA) actualiza esta bitácora
**en el mismo cambio**, cuando:

1. Agrega o modifica una variable de entorno, sobre todo si es de tiempo
   (ventanas, pausas, expiraciones, timeouts). Se actualiza la tabla de
   [Valores de tiempo](#valores-de-tiempo).
2. Toma una decisión de diseño que no se deduce leyendo el código.
3. Descubre un comportamiento sorprendente, un fallo o su causa.
4. Deja algo pendiente o sin confirmar.

Formato de las entradas del [registro](#registro): fecha absoluta
(`AAAA-MM-DD`), qué cambió, por qué, y cómo verificarlo. No borrar entradas
antiguas: si algo deja de ser cierto, se agrega una entrada nueva que lo corrige.

No anotar aquí secretos, teléfonos, nombres de pacientes ni contenido clínico.

## Valores de tiempo

| Variable / valor | Default | Dónde se usa | Efecto | Síntoma si está mal |
|---|---|---|---|---|
| `HUMAN_TAKEOVER_PAUSE_MINUTES` | `30` | `store.ts` → RPC `apply_observed_human_takeover` | Minutos que el agente queda pausado tras un mensaje humano desde WhatsApp Business. Se mide desde el `timestamp` del mensaje humano, no desde la llegada del webhook. | Muy bajo: la IA responde encima de una persona. Muy alto: conversaciones quedan sin atención automática. |
| `INBOUND_BLOCK_GAP_SECONDS` | `60` | RPC `attach_inbound_message_to_block` | Silencio máximo entre dos mensajes del cliente para que sigan en el mismo bloque. Se mide contra el **último** mensaje del bloque. El límite es inclusivo (60 s exactos siguen en el bloque). | Muy bajo: una receta de varias fotos se parte en varios bloques. Muy alto: preguntas distintas se mezclan en una sola respuesta. |
| `INBOUND_BLOCK_MAX_SECONDS` | `600` | RPC `attach_inbound_message_to_block` | Duración máxima de un bloque desde su primer mensaje, aunque el cliente no haga silencio. Debe ser ≥ `INBOUND_BLOCK_GAP_SECONDS` (se valida en `env.ts` y en SQL). | Muy bajo: bloques cortados a mitad de una ráfaga. Muy alto: un cliente que escribe sin parar nunca recibe respuesta. |
| `maxDuration` del webhook | `30` s | `route.ts` | Tiempo máximo de ejecución en Vercel. Pasado este tiempo la función muere y el evento queda en `processing`. | Si se sube, `WEBHOOK_PROCESSING_STALE_SECONDS` debe seguir siendo mayor. |
| `WEBHOOK_PROCESSING_STALE_SECONDS` | `120` | RPC `claim_webhook_event` | Segundos tras los cuales un evento en `processing` se da por muerto y un reintento de Kapso lo vuelve a reclamar. Se mide desde `claimed_at` (o `received_at` en filas anteriores a la migración). Mínimo 60, y siempre mayor que `maxDuration`. | Muy bajo: un intento vivo y su reintento procesan el mismo evento a la vez. Muy alto: si Kapso deja de reintentar antes, el mensaje se pierde. |
| `webhook_attribution_debug.expires_at` | `now() + 7 días` | Migración `20260923013716` | Marca de expiración del diagnóstico. **Nada borra esas filas todavía.** | La tabla crece indefinidamente. |
| `CATALOG_MAX_DEACTIVATIONS` (límite, no tiempo) | `10` | `catalog:apply` → `p_max_deactivations` de `apply_lab_catalog_import` | Desactivaciones permitidas en una carga sin `--allow-mass-deactivation`. Entero ≥ 0; sin definir = 10; vacía o con otro formato, el comando no arranca. Queda en `lab_catalog_imports.max_deactivations`. Solo se lee en la máquina local (`.env.local`), no en Vercel. | Muy bajo: cualquier carga pide la bandera y se vuelve rutina. Muy alto: un CSV incompleto desactiva medio catálogo sin autorización especial. |

Los valores 60 s / 600 s son iniciales y deben ajustarse en las pruebas previas
a producción con ráfagas reales (receta de varias fotos, texto + fotos, etc.).

## Reglas de dominio

- Las recetas son centrales: se agrupan las imágenes del mismo bloque
  (`block_sequence` da el orden de páginas), se detectan exámenes y se marcan
  ambigüedades.
- No crear una tabla paralela `exams`. Las detecciones deben apuntar a
  `lab_tests(id)`.
- No fusionar variantes de exámenes por nombre.
- Helicobacter se mantiene como variantes separadas (cada una su fila en
  `lab_tests`), nunca como un panel combinado.
- Un alias genérico (p. ej. «helicobacter») debe asociarse a **todas** sus
  variantes. Si se asocia a una sola, la búsqueda devuelve solo esa como
  coincidencia exacta: es un error de carga de datos, no de la búsqueda.
  Revisar al cargar alias (ver [Catálogo: búsqueda](#catálogo-búsqueda)).
- Toda respuesta está en modo observer/dry-run. No existe código que envíe
  mensajes. No se construye worker ni envío real hasta decidirlo en las pruebas
  previas a producción.
- Se conservan takeover humano e idempotencia en cualquier cambio.

## Comportamiento de los bloques de mensajes

- Un bloque agrupa los mensajes **entrantes** consecutivos de un cliente.
  Solo hay un bloque `open` por conversación (índice único parcial).
- Un bloque se cierra únicamente cuando ocurre algo:
  - llega un mensaje después de la ventana → `close_reason = 'gap'`;
  - llega un mensaje pasada la duración máxima → `'max_duration'`;
  - responde una persona desde WhatsApp Business → `'human_outbound'`.
- **No hay worker**: un bloque puede quedar `open` indefinidamente si el
  cliente deja de escribir. Un bloque se considera «listo» cuando está `open` y
  `last_message_at + INBOUND_BLOCK_GAP_SECONDS < now()`. Esa lectura la hará el
  futuro worker.
- Los tiempos usan `message_timestamp` de WhatsApp, no la hora de llegada del
  webhook.
- Un mensaje atrasado (timestamp anterior al último del bloque) siempre se suma
  al bloque abierto y puede adelantar `opened_at`.
- El cierre por mensaje humano solo afecta bloques con
  `opened_at <= timestamp del mensaje humano`, para que una reentrega tardía del
  webhook humano no cierre un bloque posterior.
- La asignación serializa por conversación con `select ... for update` sobre
  `agent_conversations`, para que fotos que llegan en paralelo caigan en el
  mismo bloque.

## Catálogo: formato CSV

Validador: `src/lib/catalog/validate.ts` (`validateCatalogCsv`). Solo lee texto
y devuelve un reporte; no toca la base.

Encabezado obligatorio (cualquier orden, sin distinguir mayúsculas):

```text
code,name,category,sample_type,price_bs,active,notes,price_convenio_bs,price_medicos_bs,price_emergencia_bs
```

- **Cuatro tarifas por examen** (desde el 2026-09-28): `price_bs` es la tarifa
  **Paciente**; `price_convenio_bs`, `price_medicos_bs` y
  `price_emergencia_bs` son las otras tres. Son columnas de la misma fila, no
  filas aparte: un examen tiene un solo código. Las cuatro siguen las reglas
  de `price_bs` (abajo). Un CSV con el formato anterior (sin las tres
  columnas nuevas) se rechaza entero, para que un archivo viejo no pueda
  borrar tarifas.
- Separador: coma. Si el archivo viene con `;` (Excel en español) se rechaza
  con `wrong_delimiter`. Se aceptan comillas, comas dentro de comillas, CRLF y
  BOM. Columnas desconocidas: advertencia, se ignoran.
- `name`: obligatorio. Si normaliza a vacío, bloquea.
- `price_bs`: obligatorio, mayor que 0, hasta 2 decimales, **punto** decimal,
  sin «Bs» ni separador de miles. Máximo 99 999 999.99 (`numeric(10,2)`).
  Vacío, 0, negativo, con coma decimal o con formato inválido: **bloquea la
  fila**.
- `active`: `true/false`, `si/sí/no`, `1/0` (sin distinguir mayúsculas).
  Vacío = `true`. Cualquier otro valor bloquea.
- `category`, `sample_type`, `notes`: opcionales.
- Filas completamente vacías: advertencia, se ignoran.

Severidades: `blocking` (la fila no se puede importar), `review` (requiere
aprobación humana) y `warning` (informativa). `autoImportAllowed` es `true`
solo si no hay problemas de archivo y **todas** las filas están `ok`.

- **Códigos duplicados** (sin distinguir mayúsculas): bloquean todas las
  filas involucradas.
- **Nombres que normalizan igual** (`normalizeLabText`, copia exacta de
  `normalize_lab_text`): nunca se fusionan. Todas las filas involucradas
  quedan en `review`, porque pueden ser variantes legítimas (p. ej. glucosa en
  sangre y en orina).
- **Código faltante** (estrategia provisional): la fila queda en `review` con
  `proposedCode = AUTO-XXXXXXXX`, los primeros 8 hex de
  `sha256(nombre normalizado | tipo de muestra normalizado)`. No depende del
  orden de las filas ni del precio o la categoría. La propuesta **nunca** se
  inserta sola: el código definitivo lo aprueba el usuario. Dos filas con
  igual nombre y muestra producen la misma propuesta, pero ya están marcadas
  como colisión de nombre. Una propuesta que choca con un código real del
  archivo se marca `proposed_code_conflict`.

## Catálogo: importador

Código: `src/lib/catalog/import.ts`. `planCatalogImport(report, lab_tests)` es
una función pura; `runCatalogImport(report, repository, { mode })` planifica
contra el estado actual y solo escribe con `mode: 'apply'`. El modo por
defecto es `dry-run`. El acceso a datos va detrás de `LabTestRepository`
(`list`, `insert`, `update`): el importador no conoce Supabase.

Clasificación de cada fila:

| Clase | Cuándo |
|---|---|
| `create` | Fila `ok` cuyo código no existe en `lab_tests`. |
| `update` | Fila `ok` con código existente y algún cambio en nombre, categoría, muestra, precio, `active` o notas. El patch lleva solo lo que cambió. |
| `unchanged` | Fila `ok` idéntica a la existente. Los precios se comparan en centavos (45 = 45.00). |
| `deactivate` | Examen **activo** en `lab_tests` cuyo código no aparece en **ninguna** fila del archivo. Se pone `active = false`; nunca se borra. |
| `blocked` | Fila `blocked` o `needs_review` del validador, código que difiere solo en mayúsculas del existente, o código repetido en `lab_tests` sin distinguir mayúsculas. |
| `unmanaged` | Examen de `lab_tests` sin código. No se puede emparejar (buscar por nombre está prohibido), así que nunca se toca. |
| `conflicts` | Inconsistencia global de `lab_tests`: varias filas con el mismo código sin distinguir mayúsculas (`HEM01` y `hem01`). Se detecta **siempre**, aunque el CSV no use ese código o el archivo esté roto. Esas filas no se desactivan ni se tocan, y el plan no se puede aplicar hasta corregirlas a mano. |

Reglas de seguridad:

- Se empareja **solo por código**. Mismo nombre con otro código crea un examen
  nuevo y desactiva el viejo; nunca se actualiza por nombre.
- `proposedCode` nunca se convierte en código: esas filas salen `blocked`.
- Un archivo con errores de formato no produce ninguna acción. Así un CSV
  roto no puede desactivar el catálogo entero.
- El código de una fila bloqueada no se desactiva: solo se desactiva lo que no
  aparece en ninguna fila.
- `apply` se rechaza (`CatalogImportRefusedError`, sin escribir nada) si el
  plan tiene cualquier fila bloqueada, cualquier conflicto en `lab_tests` o si
  el validador no permite la carga automática.
- `apply` no es transaccional: si falla a mitad, repetir la importación
  converge, porque lo ya aplicado sale como `unchanged`.

## Catálogo: comando

```bash
npm run catalog:plan -- ruta/al/catalogo.csv
```

- **Siempre dry-run.** Acepta exactamente una ruta; cualquier opción
  (`--apply`, `--mode=apply`, `-a`) se rechaza. No existe ninguna bandera
  para aplicar.
- Lee `SUPABASE_URL` y `SUPABASE_SERVICE_ROLE_KEY` de `.env.local` (o del
  entorno). Imprime solo el ref del proyecto (`Base: ...`) para confirmar
  contra qué base compara; nunca la clave.
- Lee `lab_tests` con `createSupabaseLabTestReader`
  (`src/lib/catalog/supabase-reader.ts`), que implementa **solo**
  `LabTestReader` (`list`). No tiene ningún método de escritura. Lee solo las
  columnas necesarias, pagina de a 1000 filas (límite de PostgREST) y falla
  si Supabase devuelve error o una fila con forma inesperada. Los errores
  nombran el id y la columna, nunca los valores.
- Código de salida: `0` el plan se podría aplicar; `2` el plan no se puede
  aplicar (bloqueadas, conflictos o archivo con errores); `1` falló la lectura
  del archivo o de Supabase.
- Se ejecuta con `tsx` (devDependency), que resuelve los alias `@/`.

## Catálogo: carga

```bash
# Dry-run (predeterminado): muestra el plan y comprueba las opciones.
npm run catalog:apply -- ruta/al/catalogo.csv --confirm-deactivations=OLD01,OLD02

# Carga: mismas opciones más --apply y --operator.
npm run catalog:apply -- ruta/al/catalogo.csv --confirm-deactivations=OLD01,OLD02   --apply --operator=NOMBRE [--allow-mass-deactivation]
```

Código: `src/lib/catalog/apply-command.ts` (lógica, probada con mocks y
PGlite) y `scripts/catalog-apply.ts` (conexión a Supabase). Llama a
`apply_lab_catalog_import` (migración `20260924180000`), que repite todas las
validaciones en una transacción.

- **Solo máquina local.** Se niega si el proceso tiene `VERCEL`,
  `VERCEL_ENV`, `NEXT_RUNTIME` o `CI` (se comprueba antes de leer
  `.env.local`). `--apply` exige una terminal interactiva. Ninguna ruta de
  `src/app` importa el comando (lo comprueba un test).
- **Dry-run por defecto.** Sin `--apply` nunca llama al RPC ni pide
  confirmación. Informa qué opciones faltan, con la lista exacta de
  desactivaciones para copiar.
- **Qué se envía.** Solo filas `ok` de `validateCatalogCsv`, con claves
  explícitas (`code`, `name`, `category`, `sample_type`, las cuatro tarifas
  `price_bs`, `price_convenio_bs`, `price_medicos_bs` y `price_emergencia_bs`
  como texto con 2 decimales, `active`, `notes`, `status`). `proposedCode`
  nunca viaja.
  `p_expected_counts` son los conteos del plan mostrado. `p_source` lleva
  `csv_sha256` (de los **bytes** del archivo, con BOM y CRLF incluidos),
  `operator`, `filename` (sin la ruta local) y `tool`.
- **Rechazos antes del RPC** (código 2): plan no aplicable (filas bloqueadas o
  en revisión, conflictos en `lab_tests`, archivo con errores); falta
  `--confirm-deactivations` cuando el plan desactiva; la lista no coincide
  exactamente (sin distinguir mayúsculas, sin repetidos ni vacíos); más
  desactivaciones que `CATALOG_MAX_DEACTIVATIONS` sin
  `--allow-mass-deactivation`; `--allow-mass-deactivation` sin necesidad (para
  que no se vuelva un hábito); falta `--operator` con `--apply`. Opciones
  desconocidas, repetidas o mal formadas: código 1.
- **Confirmación.** Muestra el resumen y pide escribir `aplicar <ref del
  proyecto>`. Cualquier otra respuesta cancela (código 3). Escribir el ref
  obliga a mirar contra qué base se aplica.
- **Plan cambiado.** Después de confirmar vuelve a leer `lab_tests` y compara
  una huella del plan completo (no solo conteos). Si difiere, no llama al RPC.
  Entre esa lectura y el RPC, la función detecta los cambios con
  `p_expected_counts` y la lista de desactivaciones.
- **Nada que aplicar** (sin create, update ni deactivate): no llama al RPC. Así,
  ejecutar dos veces el mismo archivo no genera una segunda carga.
- **Una sola llamada.** Sin reintentos: `.retry(false)` en supabase-js (que de
  todos modos solo reintenta GET/HEAD/OPTIONS). Error con código de Postgres =
  la transacción se revirtió. Error sin código, excepción o respuesta con otro
  formato = **resultado desconocido**: revisar `lab_catalog_imports`
  (`applied_at`, `source->>'csv_sha256'`) antes de volver a ejecutar.
- **UTF-8 obligatorio.** Un CSV en Windows-1252 (Excel «CSV» sin UTF-8) se
  rechaza en lugar de guardar nombres con caracteres rotos.
- Códigos de salida: `0` dry-run aplicable, nada que aplicar o carga aplicada;
  `1` error (archivo, Supabase, RPC, opciones); `2` rechazado; `3` cancelado.

## Catálogo: búsqueda

SQL: `search_lab_catalog(p_query, p_limit)`, migración
`20260924140000_catalog_search_candidates.sql` (reemplaza la de
`20260918043714`). TypeScript: `src/lib/catalog/search.ts`
(`searchLabCatalog`, `classifyCandidates`).

**Modelo de alias genérico.** No hay tabla nueva. Un alias genérico es el
mismo texto asociado a varias filas de `lab_tests` en `lab_test_aliases`, una
fila por variante (la tabla ya lo permite: la unicidad es
`(lab_test_id, normalized_alias)`). Ejemplo: «helicobacter» asociado a
antígeno en heces, IgG, IgM y test del aliento. Un alias específico apunta a
una sola fila («helicobacter igg» → IgG). La ambigüedad se define con los
datos, no con la búsqueda.

**Niveles del SQL.**

1. Exactos: nombre normalizado igual **unido** a alias normalizado igual.
   Ninguno oculta al otro (la versión anterior ocultaba los alias cuando
   había nombre exacto).
2. Difusos (`pg_trgm`, similitud ≥ **0.35**): solo si el nivel 1 no encontró
   nada. Es intencional: si alguien escribe el nombre exacto de una variante,
   las variantes parecidas no aparecen.

Cada `lab_test_id` aparece una sola vez (si coincide por nombre y por alias,
queda `exact_name`). Solo exámenes activos. `p_limit` se acota a 1–20 (5 por
defecto). `total_candidates` cuenta los candidatos antes del límite. Orden:
puntaje, nombre, id. Permisos: solo `service_role`.

**Clasificación en TypeScript.**

| Estado | Motivo | Cuándo |
|---|---|---|
| `unmatched` | `empty_query` | Consulta vacía (no se llama al RPC). |
| `unmatched` | `no_candidates` | El RPC no devolvió candidatos. |
| `ambiguous` | `truncated` | `total_candidates` > candidatos devueltos: el límite dejó variantes afuera. |
| `matched` | `single_exact` | Exactamente un candidato y es exacto. |
| `ambiguous` | `multiple_exact` | Más de un candidato exacto. |
| `matched` | `fuzzy_clear` | Solo difusos, el mejor tiene puntaje ≥ **0.6** y supera al segundo por ≥ **0.1**. |
| `ambiguous` | `fuzzy_low_score` | Solo difusos y el mejor tiene puntaje < 0.6 (aunque sea el único). |
| `ambiguous` | `fuzzy_close_scores` | Solo difusos y los dos mejores están a menos de 0.1. |

`match` solo existe con `matched` y siempre es uno de los candidatos del RPC.
`candidates` trae siempre todos los devueltos, con `matchType` y
`similarityScore` sin tocar.

Umbrales (`FUZZY_MIN_SCORE` 0.35 en SQL, `FUZZY_CONFIDENT_SCORE` 0.6 y
`CLOSE_SCORE_DELTA` 0.1 en TypeScript) son **provisionales**: se calibran con
el catálogo real y consultas reales de pacientes.

## Pendientes

- **La bienvenida automática de WhatsApp Business activa el takeover.** Ver
  registro 2026-09-26. Hay que resolverlo **antes de activar respuestas
  automáticas**: hoy cada cliente que recibe ese mensaje pausa al agente 30
  minutos. Falta saber si el payload de Kapso distingue un mensaje automático
  de la app de uno escrito a mano.
- **Calibrar umbrales de búsqueda** (0.35 / 0.6 / 0.1) con el catálogo real.
- **Definir quién y cómo carga los alias.** El importador todavía no maneja
  alias. Hay una propuesta local fuera del repositorio, aún no revisada ni
  cargada; los alias genéricos deben asociarse a todas sus variantes.
- **Muestra de los códigos 7 y 410.** Vacía en la fuente; se carga vacía (el
  campo es opcional). Si un paciente pregunta, el agente debe derivar a una
  persona. Completar cuando el laboratorio la informe.
- **Aplicar la migración `20260928120000_lab_test_tariffs.sql`.** Sin ella,
  `catalog:plan` contra Supabase falla: el lector pide columnas que todavía no
  existen. Requiere autorización explícita; nunca con `supabase db push`
  sin revisarla.
- **Carga real del catálogo.** `catalog:apply` construido y probado solo con
  mocks y PGlite. **Nunca se ejecutó contra Supabase.** Requiere la migración
  de tarifas, resolver las revisiones, verificar el plan final y autorización
  explícita.
- **Tarifa que cotiza el agente.** Por ahora, Precio Paciente (`price_bs`)
  para todos. Falta definir si alguna conversación usa otra tarifa y cómo se
  decide.
- **Probar la concurrencia de la carga** con dos sesiones reales en un entorno
  de pruebas.

- **`sha256` y `file_size` de Kapso sin confirmar.** El formato base ya está
  confirmado (ver registro 2026-09-24), pero el parser anterior no guardaba
  estos dos campos. Revisar en `agent_message_attachments` tras el despliegue:
  si siempre vienen null, Kapso no los envía (no es un error).
- **Mensajes históricos sin bloque ni adjunto.** Los mensajes guardados antes
  de la migración tienen `agent_message_block_id = null` y no están en
  `agent_message_attachments`. No hay backfill previsto.
- **Validar la fase 1 con mensajes reales** (pasos 7 y 8 del README): texto
  + varias fotos seleccionadas juntas deben caer en un solo bloque; esa misma
  prueba verifica la concurrencia real.
- **Calendario de reintentos de Kapso desconocido.** El reclamo de eventos
  atascados solo sirve si Kapso sigue reintentando después de
  `WEBHOOK_PROCESSING_STALE_SECONDS`. Revisar `webhook_events.attempts > 1`
  tras unos días en producción.
- **Concurrencia real no probada.** Los tests SQL usan PGlite (una sola
  conexión). El `for update` se verificará en las pruebas previas a producción.
- **Sin limpieza de `webhook_attribution_debug`**, aunque tiene `expires_at`.

## Registro

### 2026-09-28 — Decisiones de la lista confirmadas; CSV listo para cargar

Confirmado por el responsable del proyecto. Corrige el registro anterior de
este mismo día, donde el sufijo « II» era provisional.

- 193 «Renina II» y 194 «Serotonina II»: variantes distintas de 188 y 189. El
  sufijo es definitivo.
- ADN de paternidad 337-340: cada par difiere en tipo de muestra y precio. El
  nombre lleva el tipo de muestra de la fuente
  («… - Sangre con EDTA, Hisopado Bucal» / «… - Cabellos y uñas»). No se
  fusionan.
- 126 (factor VIII): Convenio (330) y Paciente (320) estaban invertidos en la
  fuente; Paciente se queda con el mayor. Médicos y Emergencia se recalculan
  con las fórmulas del Excel (Médicos = Convenio / 0.7, Emergencia =
  Paciente / 0.85): 457.14 y 388.24.
- 7 y 410: se cargan sin tipo de muestra, que no bloquea la carga.
- Validación local (sin Supabase, contra catálogo vacío): 542 filas `ok`,
  542 `create`, 0 bloqueadas, `canApply` verdadero. Los archivos (CSV,
  decisiones y validación) están fuera del repo.

### 2026-09-28 — Cuatro tarifas por examen (migración sin aplicar)

- La lista de PlusMedik trae cuatro tarifas por examen: Convenio, Paciente,
  Médicos y Emergencia particular. **Decisión:** columnas de `lab_tests`
  (`price_convenio_bs`, `price_medicos_bs`, `price_emergencia_bs`, más
  `price_bs` = Paciente), no filas ni una tabla aparte. Así un examen sigue
  siendo una fila con un código y las cuatro tarifas se cargan, comparan y
  auditan juntas en la transacción de `apply_lab_catalog_import`, sin lógica
  nueva de diferencias entre tablas. Costo: una quinta tarifa exige otra
  migración.
- Migración `20260928120000_lab_test_tariffs.sql`: agrega las tres columnas
  (`numeric(10,2)`, `> 0`; admiten null solo por exámenes anteriores) y
  reemplaza `apply_lab_catalog_import` con la misma firma para exigir,
  comparar y auditar las cuatro. **No se aplicó en Supabase.**
- Validador, importador, lector y `catalog:apply` exigen las cuatro tarifas.
  Un examen existente con tarifas nulas sale como `update` y las recibe.
- El agente cotizará con **Precio Paciente** para todos por ahora.
- Médicos y Emergencia son fórmulas en el Excel (Paciente / 0.85, etc.) con
  más de dos decimales, que el Excel muestra como enteros. **Decisión:**
  guardarlas redondeadas al centavo (mitad hacia arriba), no a enteros.
- Se regeneró el CSV privado desde el Excel original (fuera del repo). Tres
  errores del CSV anterior: el prefijo de notas salía «Preparaci?n» (ahora
  «Preparacion», solo en el texto generado; el texto clínico de la fuente no
  se modificó); el código 453 tenía «Suero 500 ul» aunque la fuente dice
  «Heces fecales»; y la categoría HORMONAS no se detectaba porque su
  encabezado está en la columna A, así que esos exámenes quedaban en
  HEMATOLOGIA. El Excel no tiene caracteres dañados.
- 193 y 194 llevan « II» en el nombre del borrador, **provisional**, para
  separarlos de 188 (Renina) y 189 (Serotonina); difieren en tiempo de
  entrega y en algunas tarifas.
- Validación local del CSV nuevo (sin Supabase, contra catálogo vacío): 542
  filas, 538 `ok`, 4 en revisión (pares de ADN de paternidad), 0 bloqueadas
  por formato. Pendientes en «Pendientes».
- Verificación: `npm test` (tests de tarifas en validador, importador,
  lector y SQL con PGlite), `npm run lint`, `npm run build`.

### 2026-09-28 — Primera lista de precios preparada (sin aplicar)

- Se preparó localmente, fuera del repositorio público, un CSV UTF-8 con 542
  filas y una propuesta separada de alias. No agregar el Excel, el CSV, la
  propuesta ni la salida detallada del plan al repositorio.
- Decisiones: conservar los códigos proporcionados por la lista y usar la
  columna de precio para pacientes, porque el catálogo está destinado a
  cotizaciones a pacientes. Se conservaron por separado las filas cuyos
  nombres normalizan igual; no se inventaron códigos. No se incluyeron los
  otros niveles de precio.
- Dry-run de `catalog:plan`: 534 `create`, 0 `update`, 0 `unchanged`,
  0 `deactivate`, 8 filas en revisión (cuatro pares con nombre normalizado
  repetido), 0 errores de formato y 0 conflictos en `lab_tests`. El comando
  terminó con código 2 porque las revisiones impiden aplicar. Dos filas no
  tienen tipo de muestra en el origen; el campo es opcional, pero queda por
  confirmar.
- La propuesta de alias no se cargó. El alias genérico de Helicobacter apunta
  a todas las variantes encontradas en la lista; una asociación de variante
  en heces queda marcada para revisión por discrepancia en el tipo de muestra.
- Verificación: volver a ejecutar
  `npm run catalog:plan -- <ruta-local-al-csv>` y confirmar el conteo anterior;
  la salida detallada, los datos de origen y los archivos preparados quedan
  fuera del repositorio. No se ejecutó `catalog:apply --apply` ni se modificó
  Supabase.

### 2026-09-27 — Nuevo repositorio y proyecto de Vercel

- El proyecto de Vercel conectado a `NyxM4x/lab-whatsapp-agent` llegó al
  límite del plan gratuito. Se sube el mismo historial a
  `NyxM4xJr/plus-Medik` (rama `main`) para desplegarlo desde el proyecto de
  Vercel `plusmedik` (equipo `nyx-m4x-jr`, dominio `plusmedik.vercel.app`).
- En el clon local, `origin` pasa a ser `NyxM4xJr/plus-Medik` y se quitó el
  remoto de `NyxM4x/lab-whatsapp-agent`: ese repo ya no se usa. Corrige la
  entrada del 2026-09-24 «Repositorio y despliegue propios».
- **El repo `NyxM4xJr/plus-Medik` es público** (decisión explícita). No
  contiene secretos: `.env.local` está ignorado y el historial solo tiene
  valores de ejemplo. Nunca subir claves ni datos de pacientes a este repo.
- Pasos del nuevo despliegue: cargar en Vercel las 3 variables obligatorias
  (`SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `KAPSO_WEBHOOK_SECRET`); las
  opcionales, solo si se usan y **nunca vacías** (ver 2026-09-24). Luego
  mover la URL del webhook en Kapso al nuevo dominio
  (`https://<dominio>/api/kapso/webhook`).
- Verificar: `POST` sin firma responde **401** `invalid_signature`; `GET`,
  405. Después, un mensaje de prueba debe dar `POST 200` en los logs del
  proyecto nuevo.
- El primer despliegue repitió el fallo del 2026-09-24: `POST` 500 con
  `ZodError` en `ATTRIBUTION_DEBUG_ENABLED`, `INBOUND_BLOCK_GAP_SECONDS`,
  `INBOUND_BLOCK_MAX_SECONDS` y `WEBHOOK_PROCESSING_STALE_SECONDS` (valores
  vacíos o fuera de rango). Tras corregir las variables y redesplegar:
  `GET` 405, `POST` sin firma 401. Kapso ya apunta a
  `plusmedik.vercel.app/api/kapso/webhook`.
- Pendiente: confirmar un `POST 200` de un mensaje real de Kapso y apagar o
  borrar el proyecto de Vercel anterior.

### 2026-09-26 — La bienvenida automática de WhatsApp Business cuenta como humano

Prueba con un teléfono del equipo contra el número de PlusMedik (observer,
sin respuestas de nuestro sistema):

- Fotos enviadas juntas: un bloque, `block_sequence` 1 y 2. Correcto.
- Texto y fotos separados por 102 s: bloques distintos (`gap`). Correcto.
- **Hallazgo:** 2 s después del primer «Hola», la app WhatsApp Business de
  PlusMedik envió sola su mensaje de bienvenida/ausencia («Gracias por
  comunicarte con LABORATORIO…»). Llegó como `outbound` con
  `kapso.origin = business_app`, así que se guardó como `actor = human`:
  cerró el bloque del «Hola» con `human_outbound` y pausó la conversación 30
  minutos (`pause_source = business_app`). Por eso el segundo texto, 46 s
  después, abrió un bloque nuevo en lugar de sumarse al primero.
- El código hace lo que dice su regla (`business_app` = persona); la regla no
  contempla los mensajes automáticos de la app. No afecta hoy porque nada
  responde, pero con IA activa pausaría al agente en cada primer contacto.
- Opciones a decidir: un campo del payload que distinga lo automático (por
  confirmar); reconocer el texto exacto de la bienvenida configurada;
  desactivar la bienvenida en la app cuando el agente salude. Sin cambios de
  código todavía.

### 2026-09-24 — `catalog:apply` (sin ejecutar contra Supabase)

- Nuevo comando `npm run catalog:apply`, reglas en
  [Catálogo: carga](#catálogo-carga). Nueva variable
  `CATALOG_MAX_DEACTIVATIONS` en la tabla de valores.
- `formatCatalogPlan` se separó en `formatCatalogPlanDetails` (el detalle) y el
  encabezado/cierre de `catalog:plan`, para que ambos comandos muestren el
  mismo plan. La salida de `catalog:plan` no cambió.
- Pruebas: `apply-command.test.ts` (mocks: opciones, límite, entorno local,
  hash, `p_source`, filas enviadas, confirmación, plan cambiado, errores del
  RPC) y `apply-command.sql.test.ts` (el comando contra la función real en
  PGlite: dry-run sin escrituras, carga con auditoría, segunda ejecución,
  `plan_changed` y `deactivation_confirmation_mismatch` provocados justo antes
  del RPC). Mutaciones comprobadas: quitar la re-planificación, enviar
  `proposedCode`, quitar la guarda masiva, hashear el texto en vez de los
  bytes, reintentar el RPC, aceptar una confirmación laxa, aceptar códigos de
  más y enviar filas en revisión hacen fallar los tests.
- No se ejecutó ninguna carga ni se leyó ni escribió Supabase.

### 2026-09-24 — Migración de carga aplicada; git con la cuenta correcta

- `20260924180000_catalog_import_apply.sql` se ejecutó manualmente en el SQL
  Editor del proyecto `cvokrtrdzxfchntwwslz`. Verificado por la API REST:
  `lab_catalog_imports` y `lab_catalog_import_changes` existen (vacías), y
  `apply_lab_catalog_import` con `p_rows = null` responde
  `invalid_input: p_rows no puede ser null` (llamada que no puede escribir).
  `lab_tests` sigue vacío.
- Verificado en el SQL Editor: índice `lab_tests_code_upper_unique`
  presente; RLS activo en ambas tablas de auditoría; una sola
  `apply_lab_catalog_import`, `security invoker`; ejecutable solo por
  `service_role` (no `anon` ni `authenticated`); `anon` no puede leer la
  auditoría; marcadores `[check:mass_flag]` presentes.
- `8f0695e` (Next 16.3.6) está en `origin/main` y Vercel lo desplegó en
  producción (`success`); webhook `GET` 405 y `POST` sin firma 401.
- **Git en Windows con varias cuentas:** el administrador de credenciales
  tiene guardadas `NyxM4x`, `rochayoan` y `x-access-token`. Elegir la
  equivocada da `Repository not found`. Este clon fija la cuenta con
  `git config --local credential.https://github.com.username NyxM4x`. Es un
  ajuste local: cada compañero hace lo mismo en su clon con su cuenta.
- El repo **no** tiene todavía la migración, sus tests ni estos documentos:
  la base quedó adelantada al repositorio hasta el próximo commit.

### 2026-09-24 — Carga transaccional del catálogo: migración (sin aplicar)

- Nueva migración `20260924180000_catalog_import_apply.sql`, **no aplicada**
  en Supabase: función `apply_lab_catalog_import`, índice único
  `lab_tests_code_upper_unique` sobre `upper(code)` y tablas de auditoría
  `lab_catalog_imports` y `lab_catalog_import_changes` (RLS, sin acceso para
  `anon`/`authenticated`). Diseño: [docs/diseno/carga-catalogo.md](diseno/carga-catalogo.md).
- Detalle de plpgsql que importa al revisar: cada `null` de parámetro se
  comprueba en su propio `if`. `if x is null or x < 0` con `x = null` da
  `null` y **no entra** en la rama: el parámetro pasaría sin rechazo.
- Un código vacío (`''`) en `lab_tests` cuenta como «sin código», igual que
  en `planCatalogImport`; si no, SQL lo desactivaría y TypeScript no.
- `lab_catalog_import_changes.lab_test_id` no tiene `on delete cascade`: un
  examen con historial de cargas ya no se puede borrar (defensa extra de
  «nunca borrar»).
- **Límite conocido y probado:** `p_expected_counts` no detecta dos cambios
  manuales que se compensan exactamente; el CSV sobrescribe y el valor previo
  queda en `before`. Hay un test que lo demuestra a propósito.
- 82 tests en `src/lib/catalog/apply.sql.test.ts`. Verificado con 4
  mutaciones de la migración (quitar `plan_changed`, quitar la confirmación,
  usar `= false` en lugar de `is not true`, desactivar inactivos): todas
  hacen fallar tests.
- La concurrencia (advisory lock) no se puede probar en PGlite: una sola
  conexión y el lock es reentrante en la misma sesión. Queda para las
  pruebas previas a producción con dos sesiones reales, nunca contra el
  catálogo de producción.

### 2026-09-24 — Actualización de seguridad: Next 16.3.6

- `next` y `eslint-config-next` 16.2.10 → **16.3.6**, juntos y con versión
  exacta. Sin `npm audit fix --force`.
- Arrastra `postcss` 8.4.31 → 8.5.23 y `sharp` 0.34.5 → 0.35.4
  (dependencias de Next). `npm audit` y `npm audit --omit=dev`: **0
  vulnerabilidades** (antes 1 crítica y 2 altas).
- Sin cambios de código. Lint, 256 tests y build pasan; `next start` local:
  webhook `GET` 405 y `POST` sin firma 401.
- Aviso conocido, **anterior** a esta actualización y sin efecto: `npm ls`
  marca `picomatch@2.3.2` como `invalid` para la peer **opcional**
  `picomatch ^3 || ^4` de `fdir` (solo la usa `vitest`, en desarrollo). No es
  un error de instalación.

### 2026-09-24 — Migración de búsqueda aplicada en Supabase

- `20260924140000_catalog_search_candidates.sql` se ejecutó manualmente en el
  SQL Editor del proyecto `cvokrtrdzxfchntwwslz`.
- Verificado en la base: una sola `search_lab_catalog(text, integer)`, con
  `total_candidates`; ejecutable por `service_role`, no por `anon` ni
  `authenticated`; `security invoker`; sin los `NOT EXISTS` globales.
- Verificado por la API REST (`rpc/search_lab_catalog`): responde 200 y lista
  vacía, esperado con el catálogo sin filas.
- El código del commit `9710dcb` ya estaba desplegado en Vercel antes de
  aplicarla; no hubo desalineación visible porque nada en producción llama a
  la búsqueda todavía.

### 2026-09-24 — Fase 2, pasos 1 a 4 aprobados en revisión

- Aprobadas: la búsqueda difusa solo corre sin coincidencias exactas, y un
  único candidato difuso con puntaje bajo queda `ambiguous`.
- Umbrales aprobados **como provisionales**: mínimo difuso 0.35, confianza
  0.60, diferencia mínima 0.10. No son definitivos hasta probarlos con los
  nombres reales del catálogo.
- Siguen separados de estos pasos: aplicar la migración de búsqueda, la
  carga real del catálogo y el `apply` transaccional.

### 2026-09-24 — Fase 2, paso 4: alias genéricos y búsqueda por candidatos

- Nueva migración `20260924140000_catalog_search_candidates.sql` (no
  aplicada): reemplaza `search_lab_catalog` con `drop` + `create` porque
  cambia el tipo de retorno (se agrega `total_candidates`). Mismos permisos.
  No se modificó ninguna migración anterior ni se creó tabla nueva.
- Fallo corregido: la versión anterior usaba `NOT EXISTS` globales; un
  nombre exacto ocultaba los alias exactos de otros exámenes. Verificado
  corriendo los tests nuevos contra la función anterior: fallan 11, entre
  ellos «un nombre exacto no oculta los alias exactos».
- Decisión: la búsqueda difusa solo corre si no hay ninguna coincidencia
  exacta. Las coincidencias exactas nunca se suprimen entre sí.
- Nuevo `src/lib/catalog/search.ts`. Reglas y umbrales en
  [Catálogo: búsqueda](#catálogo-búsqueda).
- Tests con catálogo inventado en PGlite (`search.sql.test.ts`), incluido el
  módulo TypeScript ejecutado contra el SQL real: «helicobacter» → ambiguous
  con 4 variantes; «helicobacter igg» → matched IgG; «hemograma» → matched;
  «glucosa» con dos nombres iguales → ambiguous con ambos; consulta sin
  relación → unmatched.

### 2026-09-24 — Fase 2, paso 3: lector de Supabase y comando de plan

- `LabTestRepository` se separó: `LabTestReader` (`list`) para planificar, y
  `LabTestRepository` que lo extiende con `insert`/`update` (solo lo usa el
  repositorio en memoria de los tests). El adaptador de Supabase implementa
  únicamente la lectura.
- Nuevos: `src/lib/catalog/supabase-reader.ts`,
  `src/lib/catalog/plan-command.ts`, `scripts/catalog-plan.ts` y el script
  `npm run catalog:plan`. Reglas en [Catálogo: comando](#catálogo-comando).
- Prueba de humo contra la base real (`cvokrtrdzxfchntwwslz`, solo lectura)
  con un CSV inventado de 5 filas: 3 `create` (incluidas dos variantes de
  Helicobacter separadas), 1 en revisión (sin código, con propuesta
  `AUTO-...`), 1 bloqueada (precio 0), salida `2`. `lab_tests` siguió con 0
  filas después. `--apply` se rechaza con salida `1`.
- Se agregó `tsx` como devDependency para ejecutar el script.

### 2026-09-24 — Importador: conflictos globales de códigos en lab_tests

- Fallo encontrado en revisión: si `lab_tests` tenía `HEM01` y `hem01` y el
  CSV no usaba ese código, el plan proponía desactivar ambos. Solo se
  bloqueaban cuando el CSV intentaba usar el código.
- Corrección: el plan tiene una colección `conflicts`
  (`duplicate_existing_code`, con las filas involucradas), calculada siempre.
  Los códigos en conflicto se excluyen de las desactivaciones; el motivo se
  agrega a `notApplicableReasons`, `canApply` queda en `false` y `apply` se
  rechaza sin escribir. Los demás exámenes ausentes se siguen mostrando en el
  plan como desactivaciones.
- Las cuatro decisiones del paso 2 quedaron aprobadas en revisión: archivo
  roto sin acciones, fila bloqueada no desactiva su código, `unmanaged` sin
  tocar, diferencia de mayúsculas bloqueante.
- Verificado con mutación: si se quita la exclusión de los conflictos en las
  desactivaciones, fallan 2 tests.

### 2026-09-24 — Fase 2, paso 2: importador del catálogo en dry-run

- Nuevo `src/lib/catalog/import.ts` y el repositorio simulado
  `src/test/memory-lab-tests.ts`. Reglas en la sección
  [Catálogo: importador](#catálogo-importador).
- Decisiones propias de este paso, no pedidas explícitamente: un archivo roto
  no genera desactivaciones; el código de una fila bloqueada no se desactiva;
  los `lab_tests` sin código quedan como `unmanaged`; un código que difiere
  solo en mayúsculas del existente se bloquea en vez de crear un duplicado.
- Formato aprobado provisionalmente: CSV con coma y precios con punto. No se
  aceptan `;` ni coma decimal de forma silenciosa: si la lista real viene de
  Excel en español, el validador se adapta explícitamente en ese momento.
- Verificado con mutaciones: si se quita la protección de archivo roto, o si
  las filas en revisión dejan de bloquearse, los tests fallan.
- Sin adaptador de Supabase ni script de línea de comandos todavía: nada en
  el repo puede escribir en `lab_tests` real.

### 2026-09-24 — Fase 2, paso 1: validador del catálogo CSV

- Nuevo `src/lib/catalog/`: `csv.ts` (parser sin dependencias),
  `normalize.ts` (copia de `normalize_lab_text`) y `validate.ts` (validador).
  Reglas en la sección [Catálogo: formato CSV](#catálogo-formato-csv).
- `normalize.sql.test.ts` compara la normalización de TypeScript con la de
  Postgres (PGlite) en 16 casos (tildes, `ü`, `ñ`, signos, `à`/`ç` que SQL no
  traduce y elimina). Si alguien cambia una de las dos, ese test falla.
- Sin importador, sin migraciones y sin llamadas a Supabase en este paso.
- Aún no se sabe si la lista real de PlusMedik trae códigos, qué separador
  usa ni cómo escribe los precios: el formato puede requerir ajustes al
  recibirla.

### 2026-09-24 — Primer tráfico real con la fase 1

- Entre 08:22 y 08:27 UTC llegaron mensajes reales procesados con el código
  nuevo: 4 textos seguidos quedaron en un bloque (`#1`–`#4`) y se cerró con
  `human_outbound` al responder una persona; un mensaje aislado cerró por
  `gap`. Los mensajes humanos quedan sin bloque, como corresponde.
- Kapso **sí envía** `sha256` y `file_size` (confirmado en un audio entrante).
- Ese tráfico lo procesó el despliegue anterior (Vercel de `rochayoan`, que
  se redesplegó con el push a su `main`): el proyecto nuevo
  `lab-whatsapp-agent.vercel.app` recién respondió bien a las 09:17 UTC.
  Mientras Kapso tenga webhooks hacia ambos, los dos procesan; el reclamo de
  eventos evita duplicados. Confirmar cuál recibe con `vercel logs` (POST 200).
- El catálogo está **vacío**: `lab_tests` y `lab_test_aliases` con 0 filas.
  Bloquea la detección de exámenes y las cotizaciones.
- Se borraron de Vercel las 4 variables opcionales vacías; producción usa los
  defaults (60 / 600 / 120 / `true`). `TEST_PHONE` existe en Vercel pero el
  código no la usa.

### 2026-09-24 — Variables vacías en Vercel: todos los webhooks daban 500

- Síntoma: `POST /api/kapso/webhook` sin firma respondía **500** en lugar de
  401. `GET` respondía 405 (la ruta existía).
- Causa: las 8 variables estaban creadas en Vercel pero con valor vacío. En
  los logs (`vercel logs --status-code 500 --expand`) aparece un `ZodError`
  con `SUPABASE_URL: Invalid URL`, `too_small` en las demás y números en 0.
- Detalle: los defaults de `env.ts` usan `??`, que no cubre la cadena vacía.
  Una variable opcional creada vacía **no** toma su default: rompe el arranque.
  Si no se usa, se borra en lugar de dejarla vacía.
- Verificación rápida tras cualquier cambio de variables (y redeploy):
  `POST` sin firma debe responder **401** `invalid_signature`.

### 2026-09-24 — Repositorio y despliegue propios

- Repositorio principal: `NyxM4x/lab-whatsapp-agent` (privado), con todo el
  historial. En el clon local es el remoto `origin`; el repo original
  `rochayoan/lab-whatsapp-agent` queda como remoto `rochayoan`.
- El despliegue de producción pasa a un proyecto de Vercel en la cuenta
  propia, conectado a `NyxM4x/lab-whatsapp-agent` (rama `main`).
- Al cambiar de despliegue hay que mover la URL del webhook en Kapso al nuevo
  dominio. Si Kapso sigue apuntando al despliegue anterior, el nuevo no recibe
  nada.

### 2026-09-24 — Migración de reclamo aplicada; despliegue de la fase 1

- `20260924093000_webhook_event_reclaim.sql` se ejecutó manualmente en el SQL
  Editor del proyecto `cvokrtrdzxfchntwwslz`. Verificado: 2 columnas
  (`claimed_at`, `attempts`) y `claim_webhook_event(text,text,text,integer)`.
  La API REST expone las columnas nuevas.
- Las filas anteriores quedaron con `claimed_at = null` y `attempts = 1`.
- Con ambas migraciones aplicadas, el código de la fase 1 se sube por push a
  `main` de `rochayoan/lab-whatsapp-agent`. El proyecto de Vercel no está en
  la cuenta de quien hizo el push; se asume que Vercel despliega desde `main`.
  Confirmar el despliegue con el primer mensaje entrante: solo el código
  nuevo llena `agent_messages.agent_message_block_id`. (`claimed_at` no sirve
  como señal: su default `now()` también se llena con el código viejo.)

### 2026-09-24 — Reclamo de eventos atascados

- Migración `20260924093000_webhook_event_reclaim.sql`: columnas
  `webhook_events.claimed_at` y `attempts`, y RPC `claim_webhook_event`.
- El reclamo es una sola sentencia (`insert ... on conflict do update ...
  where`): se reclama un evento `failed` o un `processing` con
  `claimed_at` más antiguo que `WEBHOOK_PROCESSING_STALE_SECONDS` (120 s por
  defecto, mayor que el `maxDuration` de 30 s). Dos reintentos simultáneos no
  pueden reclamarlo ambos: el segundo ve el `claimed_at` recién actualizado.
- Reemplaza el insert + update condicionado que se agregó antes el mismo día.
- **Orden de despliegue:** aplicar esta migración antes que el código. Sin el
  RPC, todos los webhooks fallan con 500.
- Para diagnosticar: `select * from webhook_events where attempts > 1 or
  status <> 'processed'`.

### 2026-09-24 — Formato de archivos de Kapso confirmado

- Kapso envía el formato de Meta: `message.<tipo>.id`, `mime_type`,
  `filename` (documentos) y `caption`. Confirmado sin leer valores, revisando
  qué claves guardó el parser anterior en `agent_messages.metadata`: 88
  imágenes, 34 documentos y 17 audios entrantes; todos traen `media_id` y
  `mime_type`, los documentos también `filename`, y el `media_id` es numérico
  (id de Meta).
- Los stickers (15 entrantes) quedaron sin metadata porque el parser anterior
  no reconocía el tipo `sticker`. El parser de la fase 1 ya lo reconoce.
- `webhook_attribution_debug` tenía solo 5 filas porque se activó después; no
  sirve para medir el tráfico histórico.
- `webhook_events`: 1000 eventos revisados, todos `processed`; ninguno atascado
  en `processing` a la fecha.

### 2026-09-24 — Migración de bloques aplicada en Supabase

- `20260924064500_message_blocks.sql` se ejecutó manualmente en el SQL Editor
  del proyecto `cvokrtrdzxfchntwwslz` (no con `supabase db push`).
- Verificado con `to_regclass`, `information_schema.columns` y `pg_proc`:
  2 tablas, 2 columnas en `agent_messages` y 2 funciones. La API REST ya
  expone las tablas nuevas.
- Todas las migraciones anteriores ya estaban aplicadas en ese proyecto.
- Si se crea otro entorno (pruebas, otro laboratorio), aplicar **todas** las
  migraciones de `supabase/migrations/` en orden.

### 2026-09-24 — Fase 1: bloques de mensajes y registro de adjuntos

- Migración nueva `20260924064500_message_blocks.sql` (no aplicada):
  - tabla `agent_message_blocks`;
  - columnas `agent_messages.agent_message_block_id` y `block_sequence`;
  - tabla `agent_message_attachments` con `download_status` e
    `interpretation_status` en `not_requested` (no se descarga ni interpreta);
  - RPCs `attach_inbound_message_to_block` y
    `close_open_block_on_human_outbound`.
- Parser: `src/lib/kapso/media.ts` extrae datos técnicos del adjunto. Nunca
  guarda URLs de descarga. Se reconoce `sticker`.
- Idempotencia:
  - `claimWebhookEvent` ahora reclama eventos `failed` (antes un reintento de
    Kapso tras un 500 se descartaba como duplicado);
  - ante un mensaje repetido se completan los pasos pendientes (bloque, adjunto,
    takeover si no existe su evento `pause`, cierre de bloque).
- Tests SQL con PGlite (`src/test/pglite.ts`) aplican **todas** las
  migraciones del repo en memoria. Si una migración nueva no carga en PGlite,
  los tests fallan.
- Se agregó `eslint.config.mjs` (antes `npm run lint` no ejecutaba nada) y lint
  al CI.
- Verificación: `npm run lint && npm test && npm run build`.
