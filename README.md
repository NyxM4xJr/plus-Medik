# Lab WhatsApp Agent

Agente de WhatsApp para laboratorio clínico.

## Fase actual: Message Observer

Esta fase **no responde a pacientes**. Su único objetivo es conectar el número de WhatsApp mediante Kapso y construir un historial confiable para analizar conversaciones reales antes de encender la IA.

### Qué registra

- `whatsapp.message.received` → `actor=customer`.
- `whatsapp.message.sent` + `direction=outbound` + `origin=business_app` → `actor=human` y pausa observada de 30 minutos.
- `whatsapp.message.sent` + `direction=outbound` + `origin=cloud_api` → `actor=automation`.
- `delivered/read/failed` se reconocen como lifecycle y nunca disparan takeover.
- Los eventos se deduplican por `x-idempotency-key` y los mensajes por WAMID.

El patrón de procedencia y takeover está basado en el comportamiento ya probado en `rochayoan/la-fija-orders`.

## Variables de entorno

Copia `.env.example` a `.env.local` y configura exclusivamente en servidor:

```bash
SUPABASE_URL=...
SUPABASE_SERVICE_ROLE_KEY=...
KAPSO_WEBHOOK_SECRET=...
HUMAN_TAKEOVER_PAUSE_MINUTES=30
```

Nunca subas `.env.local` ni la service role key al repositorio.

## Base de datos

Ejecuta en el proyecto Supabase destinado a este laboratorio:

```text
supabase/migrations/0001_message_observer.sql
```

La migración crea:

- `webhook_events`
- `agent_conversations`
- `agent_messages`
- `agent_control_events`
- RPC `apply_observed_human_takeover`

RLS queda habilitado y el runtime trabaja con `service_role` desde servidor.

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

## Siguiente fase

Cuando el observer esté recibiendo correctamente mensajes reales, se incorpora el Agent Core de respuesta, seguido por el catálogo de laboratorio y la interpretación de recetas.
