import { extname, join } from 'node:path';
import { analyzePrescription, type PrescriptionAnalysis, type PrescriptionDeps } from '@/lib/prescription/analyze';
import { formatAnalysis, mediaTypeOf } from '@/lib/prescription/analyze-command';
import type { ImageMediaType, PrescriptionImage, PrescriptionReader } from '@/lib/prescription/reader';
import { composeReply } from '@/lib/prescription/reply';

/**
 * Análisis por lotes de una carpeta de recetas de prueba. DRY-RUN: no escribe
 * en la base ni envía mensajes. Deja en <carpeta>/resultados una planilla de
 * revisión (para marcar aciertos y errores) y un reporte con cada borrador.
 * La consola solo muestra totales, nunca el contenido de las recetas.
 * Ver docs/BITACORA.md, «Recetas: evaluación por lotes».
 */

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;

export const BATCH_USAGE = 'Uso: npm run prescription:batch -- <carpeta-con-imagenes>';

export interface ImageGroup {
  id: string;
  files: string[];
}

/**
 * Agrupa las imágenes de una misma cotización: «prueba7-1.jpeg» y
 * «prueba7-2.jpeg» forman «prueba7». Sin sufijo es una sola imagen. Orden
 * natural (prueba2 antes que prueba10) y páginas por su número.
 */
export function groupImageFiles(names: readonly string[]): ImageGroup[] {
  const groups = new Map<string, Array<{ file: string; page: number }>>();
  for (const file of names) {
    if (mediaTypeOf(file) === null) continue;
    const base = file.slice(0, file.length - extname(file).length);
    const match = /^(.*)-(\d+)$/.exec(base);
    const id = match ? match[1] : base;
    const page = match ? Number(match[2]) : 0;
    groups.set(id, [...(groups.get(id) ?? []), { file, page }]);
  }
  const natural = (a: string, b: string) => a.localeCompare(b, 'es', { numeric: true });
  return [...groups]
    .sort(([a], [b]) => natural(a, b))
    .map(([id, files]) => ({
      id,
      files: files.sort((a, b) => a.page - b.page || natural(a.file, b.file)).map((f) => f.file),
    }));
}

export function parseBatchArgs(args: readonly string[]): { dir: string } | { error: string } {
  if (args.length !== 1) return { error: BATCH_USAGE };
  if (args[0].startsWith('-')) return { error: `Opción no admitida: ${args[0]}. ${BATCH_USAGE}` };
  return { dir: args[0] };
}

export type BatchResult =
  | { id: string; files: string[]; ok: true; model: string; analysis: PrescriptionAnalysis }
  | { id: string; files: string[]; ok: false; error: string };

const pct = (value: number) => `${Math.round(value * 100)}`;

/** Campo CSV con «;» (Excel en español abre así las columnas). */
function cell(value: string | number | null): string {
  const text = value === null ? '' : String(value);
  return /[";\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export const REVIEW_HEADER = [
  'cotizacion',
  'imagenes',
  'decision',
  'calidad_imagen_pct',
  'examen_leido',
  'interpretacion',
  'marca',
  'imagen',
  'confianza_lectura_pct',
  'estado',
  'base_identificacion',
  'codigo_catalogo',
  'examen_catalogo',
  'opciones',
  'correcto_si_no',
  'examen_correcto',
  'notas',
] as const;

/**
 * Una fila por examen leído, con columnas vacías para el revisor
 * (correcto_si_no, examen_correcto, notas). Los exámenes que el lector no vio
 * se agregan como filas nuevas con la misma cotización.
 */
export function reviewCsv(results: readonly BatchResult[]): string {
  const rows: Array<Array<string | number | null>> = [];
  for (const result of results) {
    const images = result.files.join(' + ');
    if (!result.ok) {
      rows.push([result.id, images, 'error', null, null, null, null, null, null, result.error, null, null, null, null, null, null, null]);
      continue;
    }
    const { analysis } = result;
    const head = [result.id, images, analysis.decision, pct(analysis.imageQuality)];
    if (analysis.exams.length === 0) {
      rows.push([...head, null, null, null, null, null, null, null, null, null, null, null, null, analysis.issues.join('; ') || null]);
      continue;
    }
    for (const exam of analysis.exams) {
      const code = exam.labTestId
        ? (analysis.quote ?? analysis.partialQuote)?.lines.find((line) => line.labTestId === exam.labTestId)?.code ?? null
        : null;
      rows.push([
        ...head,
        exam.text,
        exam.interpretation,
        exam.mark,
        exam.image,
        pct(exam.readingConfidence),
        exam.status === 'identified' ? 'identificado' : exam.reason,
        exam.basis,
        code,
        exam.labTestName,
        exam.options.map((option) => `${option.code ?? '?'} ${option.name}`).join(' | ') || null,
        null,
        null,
        null,
      ]);
    }
  }
  return '﻿' + [REVIEW_HEADER, ...rows].map((row) => row.map(cell).join(';')).join('\r\n') + '\r\n';
}

export function reportText(results: readonly BatchResult[]): string {
  const blocks = results.map((result) => {
    const title = `=== ${result.id} (${result.files.join(', ')}) ===`;
    if (!result.ok) return [title, `Error: ${result.error}`].join('\n');
    return [
      title,
      `Modelo: ${result.model}`,
      ...formatAnalysis(result.analysis),
      '',
      'Borrador (NO enviado):',
      composeReply(result.analysis),
    ].join('\n');
  });
  return ['DRY-RUN: nada de esto se envió ni se guardó en la base.', '', ...blocks].join('\n\n') + '\n';
}

export interface BatchSummary {
  cotizaciones: number;
  errores: number;
  decisiones: Record<string, number>;
  examenes: number;
  identificados: number;
  porConfirmar: number;
  noIdentificados: number;
}

export function summarize(results: readonly BatchResult[]): BatchSummary {
  const ok = results.flatMap((r) => (r.ok ? [r.analysis] : []));
  const exams = ok.flatMap((analysis) => analysis.exams);
  const decisiones: Record<string, number> = {};
  for (const analysis of ok) decisiones[analysis.decision] = (decisiones[analysis.decision] ?? 0) + 1;
  return {
    cotizaciones: results.length,
    errores: results.length - ok.length,
    decisiones,
    examenes: exams.length,
    identificados: exams.filter((exam) => exam.status === 'identified').length,
    porConfirmar: exams.filter((exam) => exam.status === 'needs_confirmation').length,
    noIdentificados: exams.filter((exam) => exam.status === 'not_identified').length,
  };
}

export interface BatchCommandDeps extends PrescriptionDeps {
  dir: string;
  minConfidence: number;
  /** Sufijo de los archivos de salida, por ejemplo la fecha y hora. */
  stamp: string;
  listDir: (dir: string) => Promise<string[]>;
  readFile: (path: string) => Promise<Uint8Array>;
  writeFile: (path: string, text: string) => Promise<void>;
  reader: PrescriptionReader;
  write: (line: string) => void;
}

async function analyzeGroup(group: ImageGroup, deps: BatchCommandDeps): Promise<BatchResult> {
  const fail = (error: string): BatchResult => ({ id: group.id, files: group.files, ok: false, error });
  const message = (error: unknown) => (error instanceof Error ? error.message : 'desconocido');

  let images: PrescriptionImage[];
  try {
    images = await Promise.all(
      group.files.map(async (file) => ({
        data: await deps.readFile(join(deps.dir, file)),
        mediaType: mediaTypeOf(file) as ImageMediaType,
      })),
    );
  } catch (error) {
    return fail(`no se pudo leer la imagen: ${message(error)}`);
  }

  let outcome;
  try {
    outcome = await deps.reader.read(images);
  } catch (error) {
    return fail(`falló la lectura con el modelo: ${message(error)}`);
  }
  if (!outcome.ok) return fail(`lectura no completada (${outcome.reason}): ${outcome.detail}`);

  try {
    const analysis = await analyzePrescription(outcome.reading, deps, { minConfidence: deps.minConfidence });
    return { id: group.id, files: group.files, ok: true, model: outcome.model, analysis };
  } catch (error) {
    return fail(`falló la búsqueda en el catálogo: ${message(error)}`);
  }
}

export async function runBatchCommand(deps: BatchCommandDeps): Promise<number> {
  const { write } = deps;

  let names: string[];
  try {
    names = await deps.listDir(deps.dir);
  } catch (error) {
    write(`Error: no se pudo leer la carpeta ${deps.dir}: ${error instanceof Error ? error.message : 'desconocido'}`);
    return EXIT_FAILED;
  }

  const groups = groupImageFiles(names);
  if (groups.length === 0) {
    write(`No hay imágenes JPG, PNG, WEBP o GIF en ${deps.dir}.`);
    return EXIT_FAILED;
  }

  write('DRY-RUN: análisis por lotes. No se escribe en la base ni se envía ningún mensaje.');
  write(`Cotizaciones: ${groups.length} (${groups.reduce((n, g) => n + g.files.length, 0)} imágenes)`);

  const results: BatchResult[] = [];
  // En serie: evita límites de velocidad de la API y deja el progreso legible.
  for (const [index, group] of groups.entries()) {
    const result = await analyzeGroup(group, deps);
    results.push(result);
    write(`  ${index + 1}/${groups.length} ${group.id}: ${result.ok ? result.analysis.decision : 'error'}`);
  }

  const outDir = join(deps.dir, 'resultados');
  const csvPath = join(outDir, `revision-${deps.stamp}.csv`);
  const reportPath = join(outDir, `reporte-${deps.stamp}.txt`);
  await deps.writeFile(csvPath, reviewCsv(results));
  await deps.writeFile(reportPath, reportText(results));

  const s = summarize(results);
  write('');
  write(`Decisiones: ${Object.entries(s.decisiones).map(([k, v]) => `${k} ${v}`).join(', ') || '-'}; errores ${s.errores}`);
  write(
    `Exámenes leídos: ${s.examenes} (identificados ${s.identificados}, por confirmar ${s.porConfirmar}, no identificados ${s.noIdentificados})`,
  );
  write(`Planilla de revisión: ${csvPath}`);
  write(`Reporte con borradores: ${reportPath}`);

  return s.errores === results.length ? EXIT_FAILED : EXIT_OK;
}
