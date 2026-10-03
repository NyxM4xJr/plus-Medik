/**
 * Analiza en DRY-RUN todas las recetas de una carpeta de prueba.
 *   npm run prescription:batch -- imgsPrueba
 *
 * «pruebaX-1.jpeg» y «pruebaX-2.jpeg» son la misma cotización. Deja en
 * <carpeta>/resultados una planilla de revisión y un reporte con borradores.
 * Solo lectura en Supabase; no envía mensajes. La carpeta debe estar fuera del
 * repo o ignorada por git: las recetas tienen datos de pacientes.
 */
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { searchLabCatalog } from '@/lib/catalog/search';
import { PRESCRIPTION_SEARCH_LIMIT } from '@/lib/prescription/analyze';
import { parseMinConfidence } from '@/lib/prescription/analyze-command';
import { EXIT_FAILED, parseBatchArgs, runBatchCommand } from '@/lib/prescription/batch-command';
import { createSupabaseCatalogFingerprint } from '@/lib/prescription/catalog-fingerprint';
import { createReaderFromEnv } from '@/lib/prescription/providers';
import { createSupabaseCatalogOptions, createSupabaseLabTestDetails } from '@/lib/prescription/supabase-details';

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_FAILED);
}

const args = parseBatchArgs(process.argv.slice(2));
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

const exitCode = await runBatchCommand({
  dir: args.dir,
  minConfidence: minConfidence.value,
  provider: selected.provider,
  catalogFingerprint: createSupabaseCatalogFingerprint(supabase),
  stamp: new Date().toISOString().slice(0, 16).replace(/[-:T]/g, ''),
  listDir: (dir) => readdir(dir),
  readFile: async (path) => new Uint8Array(await readFile(path)),
  writeFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  },
  reader: selected.reader,
  search: (query) => searchLabCatalog(supabase, query, { limit: PRESCRIPTION_SEARCH_LIMIT }),
  details: createSupabaseLabTestDetails(supabase),
  catalog: createSupabaseCatalogOptions(supabase),
  write: (line) => console.log(line),
});

process.exit(exitCode);
