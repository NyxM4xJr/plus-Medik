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
  });
  return cached;
}
