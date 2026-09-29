/**
 * Analiza fotos de una receta en DRY-RUN.
 *   npm run prescription:analyze -- ruta/foto1.jpg [ruta/foto2.jpg ...]
 *
 * Lee la imagen con el modelo elegido y busca los exámenes en el catálogo de
 * Supabase. Solo lectura: no escribe en la base ni envía mensajes de WhatsApp.
 * Usa SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY y, según PRESCRIPTION_PROVIDER,
 * OPENAI_API_KEY (openai, predeterminado) o ANTHROPIC_API_KEY (anthropic).
 */
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { searchLabCatalog } from '@/lib/catalog/search';
import { PRESCRIPTION_SEARCH_LIMIT } from '@/lib/prescription/analyze';
import {
  EXIT_FAILED,
  parseAnalyzeArgs,
  parseMinConfidence,
  runAnalyzeCommand,
} from '@/lib/prescription/analyze-command';
import { createReaderFromEnv } from '@/lib/prescription/providers';
import { createSupabaseCatalogOptions, createSupabaseLabTestDetails } from '@/lib/prescription/supabase-details';

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_FAILED);
}

const args = parseAnalyzeArgs(process.argv.slice(2));
if ('error' in args) fail(args.error);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const env = z
  .object({ SUPABASE_URL: z.string().url(), SUPABASE_SERVICE_ROLE_KEY: z.string().min(1) })
  .safeParse(process.env);
if (!env.success) fail('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (en .env.local o en el entorno).');

const minConfidence = parseMinConfidence(process.env.PRESCRIPTION_MIN_CONFIDENCE);
if ('error' in minConfidence) fail(minConfidence.error);

const selected = createReaderFromEnv(process.env);
if ('error' in selected) fail(selected.error);

const supabase = createClient(env.data.SUPABASE_URL, env.data.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log(`Proveedor: ${selected.provider}`);

const exitCode = await runAnalyzeCommand({
  paths: args.paths,
  minConfidence: minConfidence.value,
  readFile: async (path) => new Uint8Array(await readFile(path)),
  reader: selected.reader,
  search: (query) => searchLabCatalog(supabase, query, { limit: PRESCRIPTION_SEARCH_LIMIT }),
  details: createSupabaseLabTestDetails(supabase),
  catalog: createSupabaseCatalogOptions(supabase),
  write: (line) => console.log(line),
});

process.exit(exitCode);
