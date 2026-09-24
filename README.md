# Lab WhatsApp Agent

Agente de WhatsApp para laboratorio clínico.

## Fase actual: Message Observer

Esta fase **no responde a pacientes**. Su único objetivo es conectar el número de WhatsApp mediante Kapso y construir un historial confiable para analizar conversaciones reales antes de encender la IA.

### Qué registra

- `whatsapp.message.received` → `actor=customer`.
- `whatsapp.message.sent` + `direction=outbound` + `origin=business_app` → `actor=human` y pausa observada de 30 minutos.
- `whatsapp.message.sent` + `direction=outbound` + `origin=cloud_api` → `actor=automation`.
- `delivered/read/failed` se reconocen como lifecycle y nunca disparan takeover.
- Los eventos se deduplican por `x-idempotency-key` y los mensajes por WAMID. Un evento marcado `failed`, o atascado en `processing` más de `WEBHOOK_PROCESSING_STALE_SECONDS`, se vuelve a procesar cuando Kapso lo reintenta.
- Los mensajes entrantes seguidos de un cliente se agrupan en un bloque (`agent_message_blocks`), para que una respuesta futura consolide texto, imágenes y documentos juntos. Una receta de varias fotos queda en un solo bloque con sus páginas en orden (`block_sequence`).
- Imágenes, documentos, audios, videos y stickers se registran en `agent_message_attachments` sin descargarlos ni interpretarlos.

Decisiones, valores de tiempo y pendientes: [docs/BITACORA.md](docs/BITACORA.md).

El patrón de procedencia y takeover está basado en el comportamiento ya probado en `rochayoan/la-fija-orders`.

## Variables de entorno

Copia `.env.example` a `.env.local` y configura exclusivamente en servidor:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
KAPSO_WEBHOOK_SECRET=...
HUMAN_TAKEOVER_PAUSE_MINUTES=30
ATTRIBUTION_DEBUG_ENABLED=true
INBOUND_BLOCK_GAP_SECONDS=60
INBOUND_BLOCK_MAX_SECONDS=600
WEBHOOK_PROCESSING_STALE_SECONDS=120
```

El significado de cada valor de tiempo y cómo afinarlo está en [docs/BITACORA.md](docs/BITACORA.md#valores-de-tiempo).

Nunca subas `.env.local` ni la service role key al repositorio.

## Base de datos

Aplica, en orden, todas las migraciones de `supabase/migrations/` en el proyecto Supabase destinado a este laboratorio. El código del webhook necesita `20260924064500_message_blocks.sql` y `20260924093000_webhook_event_reclaim.sql`: sin ellas, el webhook falla con 500. Aplica siempre las migraciones **antes** de desplegar el código.

La primera migración (`0001_message_observer.sql`) crea:

- `webhook_events`
- `agent_conversations`
- `agent_messages`
- `agent_control_events`
- RPC `apply_observed_human_takeover`

`20260924064500_message_blocks.sql` agrega `agent_message_blocks`, `agent_message_attachments` y los RPC `attach_inbound_message_to_block` y `close_open_block_on_human_outbound`.

RLS queda habilitado y el runtime trabaja con `service_role` desde servidor.

## Tests

```bash
npm run lint
npm test
npm run build
```

Los tests de SQL (`*.sql.test.ts`) aplican todas las migraciones en un Postgres en memoria (PGlite). No se conectan a Supabase.

## Catálogo

Para ver qué haría una importación del catálogo, sin escribir nada:

```bash
npm run catalog:plan -- ruta/al/catalogo.csv
```

Formato del CSV, reglas y clasificación del plan: [docs/BITACORA.md](docs/BITACORA.md#catálogo-formato-csv).

## Webhook Kapso

Una vez desplegado, configura el webhook de Kapso hacia:

```text
https://TU-DOMINIO/api/kapso/webhook
```

La ruta valida `x-webhook-signature` con HMAC SHA-256 antes de persistir cualquier evento.

## Validación inicial

1. Enviar un texto desde otro teléfono al WhatsApp del laboratorio.
2. Confirmar una fila `actor=customer` en `agent_messages`.
3. Responder manualmente desde WhatsApp Business.
4. Confirmar una fila `actor=human` y `agent_conversations.state='paused'`.
5. Verificar que `pause_expires_at` sea aproximadamente 30 minutos después del mensaje humano.
6. Reentregar el mismo webhook y confirmar que no duplica mensaje ni evento.
7. Enviar texto y luego tres fotos seguidas: deben compartir `agent_message_block_id` con `block_sequence` 1 a 4, y las fotos deben aparecer en `agent_message_attachments` con `download_status='not_requested'`.
8. Responder desde WhatsApp Business: el bloque abierto debe quedar `closed` con `close_reason='human_outbound'`.

## Siguiente fase

Cuando el observer esté recibiendo correctamente mensajes reales, se incorpora el Agent Core de respuesta, seguido por el catálogo de laboratorio y la interpretación de recetas.
