import { z } from 'zod';

const schema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  KAPSO_WEBHOOK_SECRET: z.string().min(1),
  HUMAN_TAKEOVER_PAUSE_MINUTES: z.coerce.number().int().min(1).max(1440).default(30),
  // Diagnóstico temporal de atribución. Apagar con 'false' cuando ya no haga falta.
  ATTRIBUTION_DEBUG_ENABLED: z
    .enum(['true', 'false'])
    .default('true')
    .transform((value) => value === 'true'),
  // Ventanas de agrupación de mensajes entrantes. Ver docs/BITACORA.md antes de cambiarlas.
  INBOUND_BLOCK_GAP_SECONDS: z.coerce.number().int().min(5).max(3600).default(60),
  INBOUND_BLOCK_MAX_SECONDS: z.coerce.number().int().min(30).max(86_400).default(600),
  // Segundos tras los cuales un evento en 'processing' se da por muerto y se
  // reclama. Debe superar el maxDuration del webhook (30 s). Ver docs/BITACORA.md.
  WEBHOOK_PROCESSING_STALE_SECONDS: z.coerce.number().int().min(60).max(3600).default(120),
}).refine((env) => env.INBOUND_BLOCK_MAX_SECONDS >= env.INBOUND_BLOCK_GAP_SECONDS, {
  message: 'INBOUND_BLOCK_MAX_SECONDS debe ser >= INBOUND_BLOCK_GAP_SECONDS',
  path: ['INBOUND_BLOCK_MAX_SECONDS'],
});

export type ServerEnv = z.infer<typeof schema>;

let cached: ServerEnv | null = null;

export function getServerEnv(): ServerEnv {
  if (cached) return cached;
  cached = schema.parse({
    SUPABASE_URL: process.env.SUPABASE_URL,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
    KAPSO_WEBHOOK_SECRET: process.env.KAPSO_WEBHOOK_SECRET,
    HUMAN_TAKEOVER_PAUSE_MINUTES: process.env.HUMAN_TAKEOVER_PAUSE_MINUTES ?? 30,
    ATTRIBUTION_DEBUG_ENABLED: process.env.ATTRIBUTION_DEBUG_ENABLED ?? 'true',
    INBOUND_BLOCK_GAP_SECONDS: process.env.INBOUND_BLOCK_GAP_SECONDS ?? 60,
    INBOUND_BLOCK_MAX_SECONDS: process.env.INBOUND_BLOCK_MAX_SECONDS ?? 600,
    WEBHOOK_PROCESSING_STALE_SECONDS: process.env.WEBHOOK_PROCESSING_STALE_SECONDS ?? 120,
  });
  return cached;
}
