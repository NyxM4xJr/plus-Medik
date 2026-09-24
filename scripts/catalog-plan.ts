/**
 * Plan de importación del catálogo en dry-run.
 *   npm run catalog:plan -- ruta/al/catalogo.csv
 *
 * Solo lee lab_tests: no existe forma de escribir desde este comando.
 * Usa SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY de .env.local (service_role, solo servidor).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { EXIT_FAILED, parsePlanArgs, runCatalogPlanCommand } from '@/lib/catalog/plan-command';
import { createSupabaseLabTestReader } from '@/lib/catalog/supabase-reader';

const args = parsePlanArgs(process.argv.slice(2));
if ('error' in args) {
  console.error(args.error);
  process.exit(EXIT_FAILED);
}

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const env = z
  .object({ SUPABASE_URL: z.string().url(), SUPABASE_SERVICE_ROLE_KEY: z.string().min(1) })
  .safeParse(process.env);

if (!env.success) {
  console.error('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (en .env.local o en el entorno).');
  process.exit(EXIT_FAILED);
}

const supabase = createClient(env.data.SUPABASE_URL, env.data.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const exitCode = await runCatalogPlanCommand({
  csvPath: args.csvPath,
  readFile: (path) => readFile(path, 'utf8'),
  reader: createSupabaseLabTestReader(supabase),
  // Solo el ref del proyecto, para confirmar la base. Nunca la clave.
  target: new URL(env.data.SUPABASE_URL).hostname.split('.')[0],
  write: (line) => console.log(line),
});

process.exit(exitCode);
