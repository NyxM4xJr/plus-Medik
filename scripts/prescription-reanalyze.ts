/**
 * Reanaliza lecturas ya guardadas sin llamar al modelo.
 *   npm run prescription:reanalyze -- imgsPrueba/resultados/lecturas-<sello>.json
 *   npm run prescription:reanalyze -- imgsPrueba/resultados/revision-<sello>.csv
 *   npm run prescription:reanalyze -- imgsPrueba/resultados/lecturas-<sello>.json --review <planilla-revisada>.csv
 *
 * Solo consulta el catálogo de Supabase. Los archivos de entrada y salida
 * contienen datos de recetas: deben permanecer fuera del repo o ignorados por git.
 */
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { z } from 'zod';
import { searchLabCatalog } from '@/lib/catalog/search';
import { PRESCRIPTION_SEARCH_LIMIT } from '@/lib/prescription/analyze';
import { parseMinConfidence } from '@/lib/prescription/analyze-command';
import { EXIT_FAILED } from '@/lib/prescription/batch-command';
import { createSupabaseCatalogCodes, createSupabaseCatalogFingerprint } from '@/lib/prescription/catalog-fingerprint';
import { parseReanalyzeArgs, runReanalyzeCommand } from '@/lib/prescription/reanalyze-command';
import { createSupabaseCatalogOptions, createSupabaseLabTestDetails } from '@/lib/prescription/supabase-details';

function fail(message: string): never {
  console.error(message);
  process.exit(EXIT_FAILED);
}

const args = parseReanalyzeArgs(process.argv.slice(2));
if ('error' in args) fail(args.error);

if (existsSync('.env.local')) process.loadEnvFile('.env.local');

const env = z
  .object({ SUPABASE_URL: z.string().url(), SUPABASE_SERVICE_ROLE_KEY: z.string().min(1) })
  .safeParse(process.env);
if (!env.success) fail('Faltan SUPABASE_URL o SUPABASE_SERVICE_ROLE_KEY (en .env.local o en el entorno).');

const minConfidence = parseMinConfidence(process.env.PRESCRIPTION_MIN_CONFIDENCE);
if ('error' in minConfidence) fail(minConfidence.error);

let sourceText: string;
try {
  sourceText = await readFile(args.sourcePath, 'utf8');
} catch (error) {
  fail(`No se pudo leer ${args.sourcePath}: ${error instanceof Error ? error.message : 'desconocido'}`);
}

let reviewText: string | undefined;
if (args.reviewPath) {
  try {
    reviewText = await readFile(args.reviewPath, 'utf8');
  } catch (error) {
    fail(`No se pudo leer ${args.reviewPath}: ${error instanceof Error ? error.message : 'desconocido'}`);
  }
}

const supabase = createClient(env.data.SUPABASE_URL, env.data.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '');
const exitCode = await runReanalyzeCommand({
  sourcePath: args.sourcePath,
  sourceText,
  reviewPath: args.reviewPath,
  reviewText,
  minConfidence: minConfidence.value,
  stamp,
  catalogFingerprint: createSupabaseCatalogFingerprint(supabase),
  validCatalogCodes: createSupabaseCatalogCodes(supabase),
  search: (query) => searchLabCatalog(supabase, query, { limit: PRESCRIPTION_SEARCH_LIMIT }),
  details: createSupabaseLabTestDetails(supabase),
  catalog: createSupabaseCatalogOptions(supabase),
  writeFile: async (path, text) => {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, text, 'utf8');
  },
  write: (line) => console.log(line),
});

process.exit(exitCode);
