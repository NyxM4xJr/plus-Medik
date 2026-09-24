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
- Riesgo conocido: si un alias genérico (p. ej. «helicobacter») se asocia a una
  sola variante, `search_lab_catalog` lo devolverá como `exact_alias` y ocultará
  las otras variantes. Revisar al cargar alias.
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

## Pendientes

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
