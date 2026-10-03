import { dirname, extname, join } from 'node:path';
import { z } from 'zod';
import { parseCsv } from '@/lib/catalog/csv';
import { analyzePrescription, type PrescriptionDeps } from '@/lib/prescription/analyze';
import {
  EXIT_FAILED,
  EXIT_OK,
  reportText,
  reviewCsv,
  summarize,
  type BatchReadingRecord,
  type BatchReadingsFile,
  type BatchResult,
  type ReviewAnnotation,
  type ReviewOnlyExam,
} from '@/lib/prescription/batch-command';
import { MARK_TYPES, prescriptionReadingSchema, type ReadExam } from '@/lib/prescription/reading';

export const REANALYZE_USAGE =
  'Uso: npm run prescription:reanalyze -- <lecturas.json|revision.csv> [--review <revision.csv>]';

export interface ReanalyzeArgs {
  sourcePath: string;
  reviewPath?: string;
}

export function parseReanalyzeArgs(args: readonly string[]): ReanalyzeArgs | { error: string } {
  if (args.length !== 1 && args.length !== 3) return { error: REANALYZE_USAGE };
  const [sourcePath, option, reviewPath] = args;
  if (sourcePath.startsWith('-')) return { error: `Opción no admitida: ${sourcePath}. ${REANALYZE_USAGE}` };
  const sourceExtension = extname(sourcePath).toLowerCase();
  if (args.length === 1 && !['.json', '.csv'].includes(sourceExtension)) {
    return { error: `Formato no admitido: se espera JSON o CSV. ${REANALYZE_USAGE}` };
  }
  if (args.length === 3) {
    if (option !== '--review') return { error: `Opción no admitida: ${option}. ${REANALYZE_USAGE}` };
    if (
      sourceExtension !== '.json' ||
      reviewPath.startsWith('-') ||
      extname(reviewPath).toLowerCase() !== '.csv'
    ) {
      return { error: `El modo combinado requiere lecturas.json --review revision.csv. ${REANALYZE_USAGE}` };
    }
    return { sourcePath, reviewPath };
  }
  return { sourcePath };
}

const legacyReadingsSchema = z.object({
  version: z.literal(1),
  generatedAt: z.string().datetime(),
  readings: z.array(
    z.discriminatedUnion('ok', [
      z.object({
        id: z.string().min(1),
        files: z.array(z.string()).min(1),
        ok: z.literal(true),
        model: z.string().min(1),
        reading: prescriptionReadingSchema,
      }),
      z.object({
        id: z.string().min(1),
        files: z.array(z.string()).min(1),
        ok: z.literal(false),
        error: z.string().min(1),
      }),
    ]),
  ),
});

const currentReadingsSchema = z.object({
  schemaVersion: z.literal(2),
  generatedAt: z.string().datetime(),
  provider: z.enum(['openai', 'anthropic']).optional(),
  catalogFingerprint: z.string().regex(/^[0-9a-f]{64}$/).optional(),
  readings: legacyReadingsSchema.shape.readings,
});

const savedReadingsSchema = z.union([currentReadingsSchema, legacyReadingsSchema]);

interface ImportedQuote {
  id: string;
  files: string[];
  decision: string;
  imageQuality: number | null;
  exams: ReadExam[];
  reviewAnnotations: ReviewAnnotation[];
  reviewOnlyExams: ReviewOnlyExam[];
  error: string | null;
}

export interface ReanalysisAccuracy {
  correct: number;
  incorrect: number;
  pending: number;
  pendingCodeChanged: number;
  invalidCorrectCodes: Array<{ quoteId: string; text: string; code: string }>;
}

export function summarizeReanalysisAccuracy(results: readonly BatchResult[], validCodes: ReadonlySet<string>): ReanalysisAccuracy {
  let correct = 0;
  let incorrect = 0;
  let pending = 0;
  let pendingCodeChanged = 0;
  const invalidCorrectCodes: ReanalysisAccuracy['invalidCorrectCodes'] = [];

  for (const result of results) {
    if (!result.ok) continue;
    const annotations = new Map<string, ReviewAnnotation[]>();
    for (const annotation of result.reviewAnnotations ?? []) {
      const key = JSON.stringify([annotation.text, annotation.interpretation, annotation.mark, annotation.image]);
      annotations.set(key, [...(annotations.get(key) ?? []), annotation]);
    }
    for (const exam of result.analysis.exams) {
      if (exam.status !== 'identified') continue;
      const key = JSON.stringify([exam.text, exam.interpretation, exam.mark, exam.image]);
      const annotation = annotations.get(key)?.shift();
      const newCode = exam.labTestCode;
      if (!annotation) {
        pending += 1;
        continue;
      }

      const expectedCode = annotation.correctExam?.trim() ?? '';
      if (expectedCode !== '') {
        if (!validCodes.has(expectedCode)) {
          pending += 1;
          invalidCorrectCodes.push({ quoteId: result.id, text: exam.text, code: expectedCode });
        } else if (newCode === expectedCode) {
          correct += 1;
        } else {
          incorrect += 1;
        }
        continue;
      }

      // Sin código de verdad, el «sí/no» solo vale para el mismo código que vio el revisor
      // (incluye el caso en que antes no había código y ahora sí).
      const previousCode = annotation.catalogCode?.trim() || null;
      if (previousCode !== newCode) {
        pending += 1;
        if (annotation.correct) pendingCodeChanged += 1;
        continue;
      }
      const decision = annotation.correct ? normalizeYesNo(annotation.correct) : null;
      if (decision === 'no') incorrect += 1;
      else if (decision === 'yes') correct += 1;
      else pending += 1;
    }
  }

  return { correct, incorrect, pending, pendingCodeChanged, invalidCorrectCodes };
}

function normalizeYesNo(value: string): 'yes' | 'no' | null {
  const normalized = value
    .trim()
    .toLocaleLowerCase('es')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
  if (['si', 's', 'yes', 'y', 'true', '1', 'correcto', 'correcta'].includes(normalized)) return 'yes';
  if (['no', 'n', 'false', '0', 'incorrecto', 'incorrecta', 'equivocado', 'equivocada'].includes(normalized)) return 'no';
  return null;
}

function fieldIndex(headers: readonly string[], required: readonly string[]): { indexes: Map<string, number> } | { error: string } {
  const indexes = new Map<string, number>();
  for (const [index, header] of headers.entries()) {
    const key = header.trim().toLowerCase();
    if (indexes.has(key)) return { error: `Encabezado CSV duplicado: ${key}.` };
    indexes.set(key, index);
  }
  const missing = required.filter((column) => !indexes.has(column));
  if (missing.length > 0) return { error: `Faltan columnas en la planilla: ${missing.join(', ')}.` };
  return { indexes };
}

function csvValue(fields: readonly string[], indexes: Map<string, number>, key: string): string {
  return fields[indexes.get(key) as number]?.trim() ?? '';
}

function percentage(value: string, line: number, field: string): number | { error: string } {
  const parsed = Number(value);
  if (value === '' || !Number.isFinite(parsed) || parsed < 0 || parsed > 100) {
    return { error: `Línea ${line}: porcentaje inválido en ${field}.` };
  }
  return parsed / 100;
}

interface CsvImport {
  readings: BatchReadingRecord[];
  annotations: Map<string, ReviewAnnotation[]>;
  reviewOnlyExams: Map<string, ReviewOnlyExam[]>;
}

function parseCsvReadings(text: string): CsvImport | { error: string } {
  const parsed = parseCsv(text, ';');
  if (parsed.error) return { error: `CSV inválido en línea ${parsed.error.line}: ${parsed.error.message}` };
  if (parsed.records.length < 2) return { error: 'La planilla no tiene filas de datos.' };

  const headers = fieldIndex(parsed.records[0].fields, [
    'cotizacion',
    'imagenes',
    'decision',
    'calidad_imagen_pct',
    'examen_leido',
    'interpretacion',
    'marca',
    'imagen',
    'confianza_lectura_pct',
    'codigo_catalogo',
    'correcto_si_no',
    'examen_correcto',
    'notas',
  ]);
  if ('error' in headers) return headers;

  const quotes = new Map<string, ImportedQuote>();
  for (const record of parsed.records.slice(1)) {
    if (record.fields.every((field) => field.trim() === '')) continue;
    if (record.fields.length !== parsed.records[0].fields.length) {
      return { error: `Línea ${record.line}: número de columnas distinto al encabezado.` };
    }
    const id = csvValue(record.fields, headers.indexes, 'cotizacion');
    const files = csvValue(record.fields, headers.indexes, 'imagenes')
      .split(/\s+\+\s+/)
      .map((file) => file.trim())
      .filter(Boolean);
    const decision = csvValue(record.fields, headers.indexes, 'decision');
    if (!id || files.length === 0 || !decision) {
      return { error: `Línea ${record.line}: cotización, imágenes o decisión vacías.` };
    }

    if (decision === 'error') {
      let quote = quotes.get(id);
      if (quote && !quote.error) return { error: `Línea ${record.line}: la cotización ${id} mezcla filas de error y lecturas.` };
      if (!quote) {
        quote = { id, files, decision, imageQuality: null, exams: [], reviewAnnotations: [], reviewOnlyExams: [], error: 'falló la lectura' };
        quotes.set(id, quote);
      }
      const omittedText = csvValue(record.fields, headers.indexes, 'examen_leido');
      if (!omittedText) {
        quote.error = csvValue(record.fields, headers.indexes, 'estado') || quote.error;
        continue;
      }
      // Examen que el revisor agregó a una cotización sin lectura: nunca es una lectura.
      const correct = csvValue(record.fields, headers.indexes, 'correcto_si_no') || null;
      if (correct && normalizeYesNo(correct) === null) {
        return { error: `Línea ${record.line}: correcto_si_no debe indicar sí o no.` };
      }
      quote.reviewOnlyExams.push({
        text: omittedText,
        interpretation: csvValue(record.fields, headers.indexes, 'interpretacion') || null,
        correct,
        correctExam: csvValue(record.fields, headers.indexes, 'examen_correcto') || null,
        notes: csvValue(record.fields, headers.indexes, 'notas') || null,
      });
      continue;
    }

    const qualityText = csvValue(record.fields, headers.indexes, 'calidad_imagen_pct');
    const quality = qualityText === '' ? null : percentage(qualityText, record.line, 'calidad_imagen_pct');
    if (quality !== null && typeof quality !== 'number') return quality;
    const examText = csvValue(record.fields, headers.indexes, 'examen_leido');

    let quote = quotes.get(id);
    if (!quote) {
      quote = {
        id,
        files,
        decision,
        imageQuality: typeof quality === 'number' ? quality : null,
        exams: [],
        reviewAnnotations: [],
        reviewOnlyExams: [],
        error: null,
      };
      quotes.set(id, quote);
    } else if (
      quote.error !== null ||
      quote.decision !== decision ||
      quote.files.join('\0') !== files.join('\0')
    ) {
      return { error: `Línea ${record.line}: datos de cabecera inconsistentes para la cotización ${id}.` };
    }
    if (typeof quality === 'number') {
      if (quote.imageQuality !== null && quote.imageQuality !== quality) {
        return { error: `Línea ${record.line}: datos de cabecera inconsistentes para la cotización ${id}.` };
      }
      quote.imageQuality = quality;
    }

    if (!examText) {
      if (quote.imageQuality === null) return { error: `Línea ${record.line}: falta calidad_imagen_pct.` };
      continue;
    }
    const mark = csvValue(record.fields, headers.indexes, 'marca');
    const imageRaw = csvValue(record.fields, headers.indexes, 'imagen');
    const correct = csvValue(record.fields, headers.indexes, 'correcto_si_no') || null;
    if (correct && normalizeYesNo(correct) === null) {
      return { error: `Línea ${record.line}: correcto_si_no debe indicar sí o no.` };
    }
    const annotationBase = {
      text: examText,
      interpretation: csvValue(record.fields, headers.indexes, 'interpretacion') || null,
      correct,
      correctExam: csvValue(record.fields, headers.indexes, 'examen_correcto') || null,
      notes: csvValue(record.fields, headers.indexes, 'notas') || null,
    };
    if (!mark && !imageRaw) {
      quote.reviewOnlyExams.push(annotationBase);
      continue;
    }
    if (!mark || !imageRaw) {
      // Una lectura original siempre trae ambas; una sola vacía es una celda borrada, no un agregado.
      return { error: `Línea ${record.line}: falta ${mark ? 'imagen' : 'marca'} en una lectura (un examen agregado deja ambas vacías).` };
    }
    if (quote.imageQuality === null) return { error: `Línea ${record.line}: falta calidad_imagen_pct.` };
    if (!MARK_TYPES.includes(mark as (typeof MARK_TYPES)[number])) {
      return { error: `Línea ${record.line}: marca inválida.` };
    }
    const imageValue = Number(imageRaw);
    if (!Number.isInteger(imageValue) || imageValue < 1) {
      return { error: `Línea ${record.line}: número de imagen inválido.` };
    }
    const confidence = percentage(
      csvValue(record.fields, headers.indexes, 'confianza_lectura_pct'),
      record.line,
      'confianza_lectura_pct',
    );
    if (typeof confidence !== 'number') return confidence;

    const exam: ReadExam = {
      text: examText,
      interpretation: csvValue(record.fields, headers.indexes, 'interpretacion') || null,
      mark: mark as ReadExam['mark'],
      image: imageValue,
      confidence,
    };
    quote.exams.push(exam);

    quote.reviewAnnotations.push({
      text: exam.text,
      interpretation: exam.interpretation,
      mark: exam.mark,
      image: exam.image,
      correct,
      correctExam: annotationBase.correctExam,
      catalogCode: csvValue(record.fields, headers.indexes, 'codigo_catalogo') || null,
      notes: annotationBase.notes,
    });
  }

  if (quotes.size === 0) return { error: 'La planilla no contiene cotizaciones.' };
  const missingQuality = [...quotes.values()].find((quote) => !quote.error && quote.imageQuality === null);
  if (missingQuality) {
    return { error: `La cotización ${missingQuality.id} solo tiene exámenes agregados y no incluye una lectura original.` };
  }
  const annotations = new Map<string, ReviewAnnotation[]>();
  const reviewOnlyExams = new Map<string, ReviewOnlyExam[]>();
  const readings = [...quotes.values()].map((quote): BatchReadingRecord => {
    annotations.set(quote.id, quote.reviewAnnotations);
    reviewOnlyExams.set(quote.id, quote.reviewOnlyExams);
    if (quote.error) return { id: quote.id, files: quote.files, ok: false, error: quote.error };
    return {
      id: quote.id,
      files: quote.files,
      ok: true,
      model: 'lectura importada de planilla',
      reading: {
        is_lab_order: quote.decision !== 'not_lab_order',
        image_quality: quote.imageQuality as number,
        issues: [],
        exams: quote.exams,
      },
    };
  });
  return {
    readings,
    annotations,
    reviewOnlyExams,
  };
}

export interface ReanalyzeCommandDeps extends PrescriptionDeps {
  sourcePath: string;
  sourceText: string;
  reviewPath?: string;
  reviewText?: string;
  minConfidence: number;
  stamp: string;
  catalogFingerprint: () => Promise<string>;
  validCatalogCodes: () => Promise<ReadonlySet<string>>;
  writeFile: (path: string, text: string) => Promise<void>;
  write: (line: string) => void;
}

function matchAnnotations(readings: readonly ReadExam[], annotations: readonly ReviewAnnotation[]): ReviewAnnotation[] {
  const counts = new Map<string, number>();
  for (const exam of readings) {
    const key = JSON.stringify([exam.text, exam.interpretation, exam.mark, exam.image]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const matched: ReviewAnnotation[] = [];
  for (const annotation of annotations) {
    const key = JSON.stringify([annotation.text, annotation.interpretation, annotation.mark, annotation.image]);
    const count = counts.get(key) ?? 0;
    if (count === 0) continue;
    counts.set(key, count - 1);
    matched.push(annotation);
  }
  return matched;
}

export async function runReanalyzeCommand(deps: ReanalyzeCommandDeps): Promise<number> {
  const isCsv = extname(deps.sourcePath).toLowerCase() === '.csv';
  let snapshot: BatchReadingsFile;
  let reviews: CsvImport | null = null;
  let savedFingerprint: string | undefined;

  if (isCsv) {
    const imported = parseCsvReadings(deps.sourceText);
    if ('error' in imported) {
      deps.write(`Error: ${imported.error}`);
      return EXIT_FAILED;
    }
    reviews = imported;
    snapshot = {
      schemaVersion: 2,
      generatedAt: new Date().toISOString(),
      readings: imported.readings,
    };
  } else {
    let json: unknown;
    try {
      json = JSON.parse(deps.sourceText);
    } catch {
      deps.write('Error: el archivo JSON no es válido.');
      return EXIT_FAILED;
    }
    const parsed = savedReadingsSchema.safeParse(json);
    if (!parsed.success) {
      deps.write('Error: el JSON no coincide con schemaVersion 2 ni con el formato legacy version 1.');
      return EXIT_FAILED;
    }
    if ('schemaVersion' in parsed.data) {
      snapshot = parsed.data;
      savedFingerprint = parsed.data.catalogFingerprint;
    } else {
      snapshot = {
        schemaVersion: 2,
        generatedAt: parsed.data.generatedAt,
        readings: parsed.data.readings,
      };
    }
    if (deps.reviewText) {
      const imported = parseCsvReadings(deps.reviewText);
      if ('error' in imported) {
        deps.write(`Error: ${imported.error}`);
        return EXIT_FAILED;
      }
      reviews = imported;
    }
  }

  if (snapshot.readings.length === 0) {
    deps.write('Error: el archivo no contiene lecturas para reanalizar.');
    return EXIT_FAILED;
  }

  let currentFingerprint: string;
  try {
    currentFingerprint = await deps.catalogFingerprint();
  } catch (error) {
    deps.write(`Error: no se pudo calcular la huella del catálogo: ${error instanceof Error ? error.message : 'desconocido'}`);
    return EXIT_FAILED;
  }
  if (savedFingerprint) {
    deps.write(`Huella del catálogo guardada: ${savedFingerprint}`);
    deps.write(`Huella del catálogo actual: ${currentFingerprint}`);
    if (savedFingerprint !== currentFingerprint) {
      deps.write('ADVERTENCIA: el catálogo cambió desde la lectura guardada; esta medición no es comparable directamente.');
    }
  } else {
    deps.write('ADVERTENCIA: la entrada no contiene huella del catálogo; no se puede confirmar la comparabilidad histórica.');
    deps.write(`Huella del catálogo actual: ${currentFingerprint}`);
  }

  let validCodes: ReadonlySet<string>;
  try {
    validCodes = await deps.validCatalogCodes();
  } catch (error) {
    deps.write(`Error: no se pudieron validar los códigos del catálogo: ${error instanceof Error ? error.message : 'desconocido'}`);
    return EXIT_FAILED;
  }
  const annotationsByQuote = reviews?.annotations ?? new Map<string, ReviewAnnotation[]>();
  const reviewOnlyByQuote = reviews?.reviewOnlyExams ?? new Map<string, ReviewOnlyExam[]>();
  const unmatchedReviews: Array<{ quoteId: string; text: string }> = [];
  if (reviews && !isCsv) {
    for (const [quoteId, annotations] of reviews.annotations) {
      const record = snapshot.readings.find((item) => item.id === quoteId);
      const counts = new Map<string, number>();
      if (record?.ok) {
        for (const exam of record.reading.exams) {
          const key = JSON.stringify([exam.text, exam.interpretation, exam.mark, exam.image]);
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
      }
      for (const annotation of annotations) {
        const key = JSON.stringify([annotation.text, annotation.interpretation, annotation.mark, annotation.image]);
        const count = counts.get(key) ?? 0;
        if (count > 0) counts.set(key, count - 1);
        else unmatchedReviews.push({ quoteId, text: annotation.text });
      }
    }
    for (const quoteId of reviewOnlyByQuote.keys()) {
      if (!snapshot.readings.some((record) => record.id === quoteId)) {
        unmatchedReviews.push(...(reviewOnlyByQuote.get(quoteId) ?? []).map((exam) => ({ quoteId, text: exam.text })));
      }
    }
  }

  deps.write('DRY-RUN: reanálisis local de lecturas guardadas. No se llama al modelo ni se escribe en Supabase.');
  deps.write(`Cotizaciones: ${snapshot.readings.length}`);
  if (unmatchedReviews.length > 0) {
    deps.write(`ADVERTENCIA: ${unmatchedReviews.length} anotaciones CSV no coinciden con el JSON:`);
    for (const unmatched of unmatchedReviews) deps.write(`  ${unmatched.quoteId}: ${unmatched.text}`);
  }

  const results: BatchResult[] = [];
  for (const [index, record] of snapshot.readings.entries()) {
    if (!record.ok) {
      results.push({
        id: record.id,
        files: record.files,
        ok: false,
        error: record.error,
        ...((reviewOnlyByQuote.get(record.id)?.length ?? 0) > 0
          ? { reviewOnlyExams: reviewOnlyByQuote.get(record.id) }
          : {}),
      });
      deps.write(`  ${index + 1}/${snapshot.readings.length} ${record.id}: error de lectura guardado`);
      continue;
    }

    try {
      const analysis = await analyzePrescription(record.reading, deps, { minConfidence: deps.minConfidence });
      const availableAnnotations = annotationsByQuote.get(record.id) ?? [];
      const attachedAnnotations = isCsv
        ? availableAnnotations
        : matchAnnotations(record.reading.exams, availableAnnotations);
      const result: BatchResult = {
        id: record.id,
        files: record.files,
        ok: true,
        model: record.model,
        analysis,
        ...(attachedAnnotations.length > 0 ? { reviewAnnotations: attachedAnnotations } : {}),
        ...((reviewOnlyByQuote.get(record.id)?.length ?? 0) > 0
          ? { reviewOnlyExams: reviewOnlyByQuote.get(record.id) }
          : {}),
      };
      results.push(result);
      deps.write(`  ${index + 1}/${snapshot.readings.length} ${record.id}: ${analysis.decision}`);
    } catch (error) {
      results.push({
        id: record.id,
        files: record.files,
        ok: false,
        error: `falló la búsqueda en el catálogo: ${error instanceof Error ? error.message : 'desconocido'}`,
      });
      deps.write(`  ${index + 1}/${snapshot.readings.length} ${record.id}: error`);
    }
  }

  const outputDir = dirname(deps.sourcePath);
  const csvPath = join(outputDir, `revision-reanalizada-${deps.stamp}.csv`);
  const reportPath = join(outputDir, `reporte-reanalizado-${deps.stamp}.txt`);
  await deps.writeFile(csvPath, reviewCsv(results));
  await deps.writeFile(reportPath, reportText(results));
  if (isCsv) {
    await deps.writeFile(join(outputDir, `lecturas-importadas-${deps.stamp}.json`), `${JSON.stringify(snapshot, null, 2)}\n`);
  }

  const summary = summarize(results);
  const accuracy = summarizeReanalysisAccuracy(results, validCodes);
  deps.write(
    `Decisiones: ${Object.entries(summary.decisiones).map(([key, count]) => `${key} ${count}`).join(', ') || '-'}; errores ${summary.errores}`,
  );
  deps.write(`Coincidencias sin ambigüedad de identify(): ${summary.identificationMatches}`);
  deps.write(
    `Exámenes leídos: ${summary.examenes} (identificados ${summary.identificados}, por confirmar ${summary.porConfirmar}, no identificados ${summary.noIdentificados})`,
  );
  deps.write(
    `Evaluación manual: correctos ${accuracy.correct}, cotizados equivocados ${accuracy.incorrect}, revisados ${accuracy.correct + accuracy.incorrect}, pendientes ${accuracy.pending}, pendientes por cambio de código ${accuracy.pendingCodeChanged}`,
  );
  deps.write(`Exámenes agregados por el revisor (omitidos por el lector): ${[...reviewOnlyByQuote.values()].reduce((n, exams) => n + exams.length, 0)}`);
  const omissionsPerQuote = [...reviewOnlyByQuote.entries()].filter(([, exams]) => exams.length > 0);
  if (omissionsPerQuote.length > 0) {
    deps.write(`Omitidos por cotización: ${omissionsPerQuote.map(([id, exams]) => `${id}=${exams.length}`).join(', ')}`);
  }
  if (accuracy.invalidCorrectCodes.length > 0) {
    deps.write('Códigos en examen_correcto que no existen en el catálogo:');
    for (const item of accuracy.invalidCorrectCodes) deps.write(`  ${item.quoteId}: ${item.text} → ${item.code}`);
  }
  if (isCsv) deps.write(`Lecturas importadas: ${join(outputDir, `lecturas-importadas-${deps.stamp}.json`)}`);
  deps.write(`Planilla de revisión: ${csvPath}`);
  deps.write(`Reporte: ${reportPath}`);

  return summary.errores === results.length ? EXIT_FAILED : EXIT_OK;
}
