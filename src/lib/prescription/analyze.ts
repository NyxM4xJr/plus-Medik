import { normalizeLabText } from '@/lib/catalog/normalize';
import {
  classifyCandidates,
  type CatalogCandidate,
  type CatalogSearchResult,
} from '@/lib/catalog/search';
import { parseNotes, patientQuestions, type PatientQuestion } from '@/lib/prescription/preparation';
import type { MarkType, PrescriptionReading } from '@/lib/prescription/reading';

/**
 * Del texto leído en la receta a una decisión: cotizar o pedir confirmación.
 * Nunca elige entre variantes ni cotiza por debajo del umbral de confianza.
 * Ver docs/BITACORA.md, «Recetas: análisis y confirmación».
 */

/** Umbral provisional de confianza de lectura/identificación. No es FUZZY_CONFIDENT_SCORE. */
export const DEFAULT_MIN_CONFIDENCE = 0.6;

/** Opciones que se ofrecen como máximo cuando un examen es ambiguo. */
export const MAX_OPTIONS = 5;

/** Candidatos que se piden a search_lab_catalog por consulta en recetas. */
export const PRESCRIPTION_SEARCH_LIMIT = 10;

/**
 * Confianza de una identificación por contenido: un único examen del catálogo
 * contiene todas las palabras escritas. Supera el umbral; la lectura decide.
 */
export const CONTAINED_MATCH_CONFIDENCE = 0.9;

/**
 * Palabras que no distinguen un examen de otro. «a», «e» y «o» NO van aquí:
 * distinguen «Vitamina A», «Hepatitis E».
 */
const STOPWORDS = new Set(['de', 'del', 'la', 'las', 'el', 'los', 'en', 'y', 'por', 'para', 'con']);

/**
 * Palabras de método o técnica. Si varios exámenes contienen lo escrito, el
 * que solo agrega estas palabras es el examen directo («TESTOSTERONA TOTAL
 * (ECLIA)» frente a «PERFIL ANDROPAUSIA (…)»). Dos directos = se pregunta.
 */
const METHOD_WORDS = new Set([
  'eclia',
  'clia',
  'elisa',
  'fia',
  'fluorescencia',
  'quimioluminiscencia',
  'automatizado',
  'automatizada',
  'convencional',
]);

/**
 * Lo único que puede sobrar en lo escrito cuando el nombre del catálogo está
 * dentro del texto («Calcitonina sérica» → CALCITONINA). Las muestras (orina,
 * heces) no: distinguen variantes.
 */
const SAFE_QUALIFIERS = new Set(['serica', 'serico']);

/**
 * Palabras de más (sin contar método ni números) que puede tener un examen
 * para aceptarlo por contenido. Un panel que menciona lo escrito entre
 * decenas de patógenos no es ese examen: se pregunta.
 */
export const MAX_EXTRA_WORDS = 4;

/** Datos de lab_tests que necesita la cotización. */
export interface LabTestDetails {
  id: string;
  code: string | null;
  name: string;
  sampleType: string | null;
  /** Tarifa Paciente. */
  priceBs: number;
  notes: string | null;
}

/** Examen activo del catálogo, para identificar por contenido y ofrecer opciones. */
export interface CatalogOption {
  labTestId: string;
  code: string | null;
  name: string;
  /** Tarifa Paciente. */
  priceBs: number;
}

export interface PrescriptionDeps {
  search: (query: string) => Promise<CatalogSearchResult>;
  /** Solo exámenes activos; los ids que no existan simplemente no vuelven. */
  details: (ids: string[]) => Promise<LabTestDetails[]>;
  /** Todos los exámenes activos. Se lee una vez por análisis. */
  catalog: () => Promise<CatalogOption[]>;
}

/**
 * exact: nombre o alias exacto. contained: un único examen contiene todas las
 * palabras escritas (o su nombre completo está dentro de lo escrito). fuzzy:
 * parecido difuso claro. none: sin identificación única.
 */
export type IdentificationBasis = 'exact' | 'contained' | 'fuzzy' | 'none';

export interface Identification {
  status: 'matched' | 'ambiguous' | 'unmatched';
  basis: IdentificationBasis;
  match: CatalogOption | null;
  confidence: number;
  /** Con ambiguous: variantes a elegir. Vacío si solo hubo parecidos lejanos. */
  options: CatalogOption[];
}

export type ItemStatus = 'identified' | 'needs_confirmation' | 'not_identified';

export type ItemReason =
  | 'ok'
  | 'low_reading_confidence'
  | 'low_identification_confidence'
  | 'multiple_options'
  | 'not_in_catalog';

export interface AnalyzedExam {
  text: string;
  interpretation: string | null;
  mark: MarkType;
  image: number;
  readingConfidence: number;
  identificationConfidence: number;
  /** min(lectura, identificación). */
  confidence: number;
  status: ItemStatus;
  reason: ItemReason;
  /** Cómo se identificó: ver IdentificationBasis. */
  basis: IdentificationBasis;
  /** Con identified, y con needs_confirmation cuando hay un único candidato a confirmar. */
  labTestId: string | null;
  /** Nombre en el catálogo del examen de labTestId. */
  labTestName: string | null;
  /** Con needs_confirmation por varias opciones: las variantes a elegir. */
  options: CatalogOption[];
}

export interface QuoteLine {
  labTestId: string;
  code: string | null;
  name: string;
  priceBs: number;
  sampleType: string | null;
  preparation: string | null;
  deliveryTime: string | null;
}

export type Decision =
  /** Todo identificado con confianza suficiente: se cotiza. */
  | 'quote'
  /** Hay exámenes dudosos, ambiguos o no encontrados: se pregunta antes de cotizar. */
  | 'confirm'
  /** Sin exámenes legibles y la imagen es de baja calidad: pedir otra foto. */
  | 'retake'
  /** La imagen no es una orden de laboratorio. */
  | 'not_lab_order'
  /** Es una orden, pero no se leyó ningún examen solicitado. */
  | 'no_exams';

export interface PrescriptionAnalysis {
  decision: Decision;
  minConfidence: number;
  imageQuality: number;
  lowImageQuality: boolean;
  issues: string[];
  exams: AnalyzedExam[];
  /** Solo con decision quote. */
  quote: { lines: QuoteLine[]; totalBs: number } | null;
  /** Solo con decision confirm cuando hay líneas seguras para un subtotal parcial. */
  partialQuote: { lines: QuoteLine[]; totalBs: number } | null;
  /** Preguntas de preparación para los exámenes cotizados, incluso si el subtotal es parcial. */
  questions: PatientQuestion[];
}

function isExact(candidate: CatalogCandidate): boolean {
  return candidate.matchType === 'exact_name' || candidate.matchType === 'exact_alias';
}

function tokens(text: string): Set<string> {
  return new Set(normalizeLabText(text).split(' ').filter((word) => word !== '' && !STOPWORDS.has(word)));
}

function containsAll(container: Set<string>, words: Set<string>): boolean {
  return words.size > 0 && [...words].every((word) => container.has(word));
}

/**
 * Busca por el texto leído y, si el modelo propuso uno, por el nombre
 * completo. Une los candidatos por examen (gana el exacto y luego el mayor
 * puntaje). Orden de decisión:
 *   1. Exacto (nombre o alias): único → matched; varios → ambiguous.
 *   2. Por contenido, sobre TODO el catálogo activo (no solo los candidatos de
 *      la búsqueda, que el límite puede cortar): exámenes cuyo nombre contiene
 *      todas las palabras de lo escrito o de la interpretación. Uno →
 *      matched. Varios → si uno solo agrega palabras de método, ese; si no,
 *      ambiguous entre ellos. Si ninguno, el nombre completo dentro del texto
 *      del médico (nunca de la interpretación), sobrando solo calificadores
 *      inofensivos. Nunca elige entre dos.
 *   3. Difuso, como en la búsqueda textual. Si el límite cortó candidatos,
 *      nada difuso es único.
 */
export async function identify(
  search: PrescriptionDeps['search'],
  catalog: readonly CatalogOption[],
  text: string,
  interpretation: string | null,
): Promise<Identification> {
  const queries = [text, interpretation].filter(
    (query, index, all): query is string =>
      query !== null && query.trim() !== '' && all.findIndex((q) => q?.trim().toLowerCase() === query.trim().toLowerCase()) === index,
  );
  const results = await Promise.all(queries.map((query) => search(query)));

  const merged = new Map<string, CatalogCandidate>();
  for (const candidate of results.flatMap((result) => result.candidates)) {
    const current = merged.get(candidate.labTestId);
    const better =
      !current ||
      (isExact(candidate) && !isExact(current)) ||
      (isExact(candidate) === isExact(current) && candidate.similarityScore > current.similarityScore);
    if (better) merged.set(candidate.labTestId, candidate);
  }
  const candidates = [...merged.values()].sort((a, b) => b.similarityScore - a.similarityScore);
  const truncated = results.some((result) => result.truncated);

  const matched = (match: CatalogOption, basis: IdentificationBasis, confidence: number): Identification => ({
    status: 'matched',
    basis,
    match,
    confidence,
    options: [],
  });
  const ambiguous = (options: CatalogOption[], basis: IdentificationBasis): Identification => ({
    status: 'ambiguous',
    basis,
    match: null,
    confidence: 0,
    options: options.slice(0, MAX_OPTIONS),
  });

  // 1. Exactos.
  const exact = candidates.filter(isExact);
  if (exact.length === 1 && !truncated) return matched(exact[0], 'exact', 1);
  if (exact.length > 0) return ambiguous(exact, 'exact');

  // 2. Por contenido, sobre todo el catálogo.
  const written = queries.map(tokens);
  const entries = catalog
    .map((option) => ({ option, words: tokens(option.name) }))
    .sort((a, b) => a.words.size - b.words.size || a.option.name.localeCompare(b.option.name));
  const containing = entries.filter(({ words }) => written.some((query) => containsAll(words, query)));
  if (containing.length > 0) {
    // Palabras que el examen agrega a lo escrito, sin método ni números.
    const extra = (words: Set<string>) =>
      Math.min(
        ...written.map(
          (query) => [...words].filter((word) => !query.has(word) && !METHOD_WORDS.has(word) && !/^\d+$/.test(word)).length,
        ),
      );
    const direct = containing.filter(({ words }) => extra(words) === 0);
    if (direct.length === 1) return matched(direct[0].option, 'contained', CONTAINED_MATCH_CONFIDENCE);
    if (direct.length > 1) return ambiguous(direct.map(({ option }) => option), 'contained');
    const close = containing.filter(({ words }) => extra(words) <= MAX_EXTRA_WORDS);
    if (close.length === 1) return matched(close[0].option, 'contained', CONTAINED_MATCH_CONFIDENCE);
    return ambiguous((close.length > 0 ? close : containing).map(({ option }) => option), 'contained');
  }
  const textWords = tokens(text);
  const inside = entries.filter(
    ({ words }) =>
      containsAll(textWords, words) && [...textWords].every((word) => words.has(word) || SAFE_QUALIFIERS.has(word)),
  );
  if (inside.length === 1) return matched(inside[0].option, 'contained', CONTAINED_MATCH_CONFIDENCE);
  if (inside.length > 1) return ambiguous(inside.map(({ option }) => option), 'contained');

  // 3. Difuso.
  if (candidates.length === 0) return { status: 'unmatched', basis: 'none', match: null, confidence: 0, options: [] };
  const fuzzy = classifyCandidates(queries.join(' / '), candidates, candidates.length + (truncated ? 1 : 0));
  if (fuzzy.status === 'matched' && fuzzy.match) return matched(fuzzy.match, 'fuzzy', fuzzy.match.similarityScore);
  // Solo parecidos lejanos: no se ofrecen como opciones.
  return ambiguous(fuzzy.reason === 'fuzzy_low_score' ? [] : candidates, 'none');
}

function analyzeExam(
  exam: PrescriptionReading['exams'][number],
  result: Identification,
  minConfidence: number,
): AnalyzedExam {
  const identification = result.confidence;
  const base = {
    text: exam.text,
    interpretation: exam.interpretation,
    mark: exam.mark,
    image: exam.image,
    readingConfidence: exam.confidence,
    identificationConfidence: identification,
    confidence: Math.min(exam.confidence, identification),
    basis: result.basis,
  };

  if (result.status === 'matched' && result.match) {
    const labTestId = result.match.labTestId;
    const labTestName = result.match.name;
    if (exam.confidence < minConfidence) {
      return { ...base, status: 'needs_confirmation', reason: 'low_reading_confidence', labTestId, labTestName, options: [] };
    }
    if (identification < minConfidence) {
      return { ...base, status: 'needs_confirmation', reason: 'low_identification_confidence', labTestId, labTestName, options: [] };
    }
    return { ...base, status: 'identified', reason: 'ok', labTestId, labTestName, options: [] };
  }

  // Un candidato difuso bajo el umbral no es «no existe»: pedir confirmación sin elegirlo.
  if (result.status === 'ambiguous' && result.options.length === 0) {
    return {
      ...base,
      status: 'needs_confirmation',
      reason: 'low_identification_confidence',
      labTestId: null,
      labTestName: null,
      options: [],
    };
  }

  // Varias variantes plausibles: se pregunta cuál, nunca se elige una.
  if (result.status === 'ambiguous') {
    return {
      ...base,
      status: 'needs_confirmation',
      reason: 'multiple_options',
      labTestId: null,
      labTestName: null,
      options: result.options,
    };
  }

  // Sin candidatos o solo parecidos lejanos: lo revisa una persona.
  return {
    ...base,
    status: 'not_identified',
    reason: 'not_in_catalog',
    labTestId: null,
    labTestName: null,
    options: [],
  };
}

/** Un mismo examen leído dos veces (por ejemplo en dos fotos) cuenta una vez. */
function dedupe(exams: AnalyzedExam[]): AnalyzedExam[] {
  const seen = new Map<string, number>();
  const out: AnalyzedExam[] = [];
  for (const exam of exams) {
    const index = exam.labTestId && exam.status === 'identified' ? seen.get(exam.labTestId) : undefined;
    if (index === undefined) {
      if (exam.labTestId && exam.status === 'identified') seen.set(exam.labTestId, out.length);
      out.push(exam);
    }
  }
  return out;
}

export async function analyzePrescription(
  reading: PrescriptionReading,
  deps: PrescriptionDeps,
  options: { minConfidence?: number } = {},
): Promise<PrescriptionAnalysis> {
  const minConfidence = options.minConfidence ?? DEFAULT_MIN_CONFIDENCE;
  const lowImageQuality = reading.image_quality < minConfidence;
  const empty = {
    minConfidence,
    imageQuality: reading.image_quality,
    lowImageQuality,
    issues: reading.issues,
    partialQuote: null,
  };

  if (!reading.is_lab_order) {
    return { ...empty, decision: 'not_lab_order', exams: [], quote: null, questions: [] };
  }
  if (reading.exams.length === 0) {
    return { ...empty, decision: lowImageQuality ? 'retake' : 'no_exams', exams: [], quote: null, questions: [] };
  }

  const catalog = await deps.catalog();
  const results = await Promise.all(
    reading.exams.map((exam) => identify(deps.search, catalog, exam.text, exam.interpretation)),
  );
  let exams = dedupe(reading.exams.map((exam, index) => analyzeExam(exam, results[index], minConfidence)));
  const identifiedIds = exams
    .filter((exam) => exam.status === 'identified' && exam.labTestId !== null)
    .map((exam) => exam.labTestId as string);
  const details = new Map(
    (!lowImageQuality && identifiedIds.length > 0 ? await deps.details(identifiedIds) : []).map((test) => [test.id, test]),
  );

  // Un examen que desapareció o se desactivó entre la búsqueda y la cotización no se cotiza.
  const missing = exams.filter(
    (exam) => exam.status === 'identified' && exam.labTestId !== null && !details.has(exam.labTestId),
  );
  if (missing.length > 0) {
    const missingIds = new Set(missing.map((exam) => exam.labTestId));
    exams = exams.map((exam) =>
      exam.labTestId !== null && missingIds.has(exam.labTestId)
        ? { ...exam, status: 'not_identified' as const, reason: 'not_in_catalog' as const, labTestId: null, labTestName: null }
        : exam,
    );
  }

  const lines: QuoteLine[] = exams
    .filter((exam) => exam.status === 'identified' && exam.labTestId !== null)
    .map((exam) => {
    const test = details.get(exam.labTestId as string) as LabTestDetails;
    const { preparation, deliveryTime } = parseNotes(test.notes);
    return {
      labTestId: test.id,
      code: test.code,
      name: test.name,
      priceBs: test.priceBs,
      sampleType: test.sampleType,
      preparation,
      deliveryTime,
    };
  });
  const totalCents = lines.reduce((sum, line) => sum + Math.round(line.priceBs * 100), 0);
  const totalBs = totalCents / 100;
  const allIdentified = exams.every((exam) => exam.status === 'identified');

  if (!allIdentified || lowImageQuality) {
    const partialQuote = !lowImageQuality && lines.length > 0 ? { lines, totalBs } : null;
    return {
      ...empty,
      decision: 'confirm',
      exams,
      quote: null,
      partialQuote,
      questions: partialQuote ? patientQuestions(lines) : [],
    };
  }

  return {
    ...empty,
    decision: 'quote',
    exams,
    quote: { lines, totalBs },
    partialQuote: null,
    questions: patientQuestions(lines),
  };
}
