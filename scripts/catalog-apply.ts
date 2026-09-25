/**
 * Carga del catálogo. Sin --apply es dry-run (predeterminado).
 *   npm run catalog:apply -- ruta/al/catalogo.csv
 *   npm run catalog:apply -- ruta/al/catalogo.csv --apply --operator=NOMBRE \
 *     [--confirm-deactivations=COD1,COD2] [--allow-mass-deactivation]
 *
 * Solo en una máquina local controlada: nunca en Vercel, CI ni un endpoint.
 * Usa SUPABASE_URL y SUPABASE_SERVICE_ROLE_KEY de .env.local (service_role, solo servidor).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import {
  EXIT_FAILED,
  localExecutionError,
  parseApplyArgs,
  parseMaxDeactivations,
  runCatalogApplyCommand,
} from '@/lib/catalog/apply-command';
import { createSupabaseLabTestReader } from '@/lib/catalog/supabase-reader';

// Antes de leer .env.local: cuenta el entorno real del proceso.
const notLocal = localExecutionError(process.env);
if (notLocal) {
  console.error(notLocal);
  process.exit(EXIT_FAILED);
}

const options = parseApplyArgs(process.argv.slice(2));
if ('error' in options) {
  console.error(options.error);
  process.exit(EXIT_FAILED);
}

if (options.apply && !(process.stdin.isTTY && process.stdout.isTTY)) {
  console.error('--apply necesita una terminal interactiva: la confirmación se escribe a mano.');
  process.exit(EXIT_FAILED);
}

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const max = parseMaxDeactivations(process.env.CATALOG_MAX_DEACTIVATIONS);
if ('error' in max) {
  console.error(max.error);
  process.exit(EXIT_FAILED);
}

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

const exitCode = await runCatalogApplyCommand({
  options,
  maxDeactivations: max.value,
  readFile: (path) => readFile(path),
  reader: createSupabaseLabTestReader(supabase),
  // retry(false): la carga nunca se repite sola, aunque la red falle.
  rpc: async (args) => supabase.rpc('apply_lab_catalog_import', args).retry(false),
  confirm: async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      return await rl.question(question);
    } finally {
      rl.close();
    }
  },
  // Solo el ref del proyecto, para confirmar la base. Nunca la clave.
  target: new URL(env.data.SUPABASE_URL).hostname.split('.')[0],
  write: (line) => console.log(line),
});

process.exit(exitCode);
