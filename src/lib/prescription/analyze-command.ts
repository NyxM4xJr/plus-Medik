import { extname } from 'node:path';
import {
  analyzePrescription,
  DEFAULT_MIN_CONFIDENCE,
  type PrescriptionAnalysis,
  type PrescriptionDeps,
} from '@/lib/prescription/analyze';
import type { ImageMediaType, PrescriptionImage, PrescriptionReader } from '@/lib/prescription/reader';
import { composeReply } from '@/lib/prescription/reply';

/**
 * Comando local de análisis de recetas. DRY-RUN siempre: lee imágenes del
 * disco, las analiza y muestra el borrador de respuesta. No escribe en la base
 * ni envía mensajes. Ver docs/BITACORA.md, «Recetas: comando».
 */

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

export const ANALYZE_USAGE = 'Uso: npm run prescription:analyze -- <imagen1> [imagen2 ...]';

const MEDIA_TYPES: Record<string, ImageMediaType> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export function mediaTypeOf(path: string): ImageMediaType | null {
  return MEDIA_TYPES[extname(path).toLowerCase()] ?? null;
}

/** Solo rutas de imágenes (varias = páginas de la misma orden). Ninguna opción. */
export function parseAnalyzeArgs(args: readonly string[]): { paths: string[] } | { error: string } {
  if (args.length === 0) return { error: ANALYZE_USAGE };
  const flag = args.find((arg) => arg.startsWith('-'));
  if (flag) return { error: `Opción no admitida: ${flag}. ${ANALYZE_USAGE}` };
  const unsupported = args.find((path) => mediaTypeOf(path) === null);
  if (unsupported) return { error: `Formato no admitido: ${unsupported}. Usa JPG, PNG, WEBP o GIF.` };
  return { paths: [...args] };
}

/** PRESCRIPTION_MIN_CONFIDENCE: sin definir = 0.6; definida debe ser un número en (0, 1]. */
export function parseMinConfidence(raw: string | undefined): { value: number } | { error: string } {
  if (raw === undefined) return { value: DEFAULT_MIN_CONFIDENCE };
  const value = Number(raw.trim());
  if (raw.trim() === '' || !Number.isFinite(value) || value <= 0 || value > 1) {
    return {
      error: `PRESCRIPTION_MIN_CONFIDENCE inválido: «${raw}». Debe ser un número mayor que 0 y hasta 1 (sin definir = ${DEFAULT_MIN_CONFIDENCE}).`,
    };
  }
  return { value };
}

export const PROVIDERS = ['openai', 'anthropic'] as const;
export type Provider = (typeof PROVIDERS)[number];

/** PRESCRIPTION_PROVIDER: sin definir = openai (GPT-5 mini); también anthropic (Claude). */
export function parseProvider(raw: string | undefined): { value: Provider } | { error: string } {
  if (raw === undefined) return { value: 'openai' };
  const value = raw.trim().toLowerCase();
  if ((PROVIDERS as readonly string[]).includes(value)) return { value: value as Provider };
  return { error: `PRESCRIPTION_PROVIDER inválido: «${raw}». Usa ${PROVIDERS.join(' o ')} (sin definir = openai).` };
}

const pct = (value: number) => `${Math.round(value * 100)}%`;

export function formatAnalysis(analysis: PrescriptionAnalysis): string[] {
  return [
    `Decisión: ${analysis.decision}`,
    `Umbral de confianza: ${pct(analysis.minConfidence)}`,
    `Calidad de imagen: ${pct(analysis.imageQuality)}${analysis.lowImageQuality ? ' (baja)' : ''}`,
    ...(analysis.issues.length > 0 ? [`Problemas: ${analysis.issues.join('; ')}`] : []),
    '',
    'Exámenes leídos:',
    ...(analysis.exams.length === 0 ? ['  (ninguno)'] : []),
    ...analysis.exams.map(
      (exam) =>
        `  [${exam.status}] «${exam.text}»${exam.interpretation ? ` (${exam.interpretation})` : ''}` +
        ` marca ${exam.mark}, imagen ${exam.image}` +
        ` | lectura ${pct(exam.readingConfidence)}, identificación ${pct(exam.identificationConfidence)} (${exam.basis})` +
        (exam.labTestName ? ` → ${exam.labTestName}` : '') +
        (exam.options.length > 0 ? ` | opciones: ${exam.options.map((o) => `${o.code ?? '?'} ${o.name}`).join('; ')}` : '') +
        (exam.reason !== 'ok' ? ` (${exam.reason})` : ''),
    ),
  ];
}

export interface AnalyzeCommandDeps extends PrescriptionDeps {
  paths: string[];
  minConfidence: number;
  readFile: (path: string) => Promise<Uint8Array>;
  reader: PrescriptionReader;
  write: (line: string) => void;
}

export async function runAnalyzeCommand(deps: AnalyzeCommandDeps): Promise<number> {
  const { write } = deps;
  const images: PrescriptionImage[] = [];
  for (const path of deps.paths) {
    try {
      images.push({ data: await deps.readFile(path), mediaType: mediaTypeOf(path) as ImageMediaType });
    } catch (error) {
      write(`Error: no se pudo leer ${path}: ${error instanceof Error ? error.message : 'desconocido'}`);
      return EXIT_FAILED;
    }
  }

  write('DRY-RUN: análisis de receta. No se escribe en la base ni se envía ningún mensaje.');
  write(`Imágenes: ${deps.paths.length}`);

  let outcome;
  try {
    outcome = await deps.reader.read(images);
  } catch (error) {
    write(`Error: falló la lectura con el modelo: ${error instanceof Error ? error.message : 'desconocido'}`);
    return EXIT_FAILED;
  }
  if (!outcome.ok) {
    write(`La lectura no se completó (${outcome.reason}): ${outcome.detail}.`);
    write('En producción esta receta pasaría a una persona.');
    return EXIT_FAILED;
  }
  write(`Modelo: ${outcome.model}`);

  let analysis: PrescriptionAnalysis;
  try {
    analysis = await analyzePrescription(outcome.reading, deps, { minConfidence: deps.minConfidence });
  } catch (error) {
    write(`Error: falló la búsqueda en el catálogo: ${error instanceof Error ? error.message : 'desconocido'}`);
    return EXIT_FAILED;
  }

  write('');
  for (const line of formatAnalysis(analysis)) write(line);
  write('');
  write('Borrador de respuesta (NO enviado):');
  write('----------------------------------------');
  write(composeReply(analysis));
  write('----------------------------------------');
  return EXIT_OK;
}
