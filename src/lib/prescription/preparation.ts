/**
 * Preparación y preguntas al paciente a partir de lab_tests.notes.
 * Las notas del catálogo tienen la forma
 *   «Preparacion: <texto del laboratorio> | Tiempo de entrega: <texto>».
 * Las preguntas salen de reglas fijas sobre ese texto: nunca las inventa un
 * modelo, y cada una nombra los exámenes que la motivan.
 */

export interface ParsedNotes {
  preparation: string | null;
  deliveryTime: string | null;
}

const PREPARATION = /(?:^|\|)\s*Preparaci[oó]n:\s*(.*?)\s*(?=\||$)/i;
const DELIVERY = /(?:^|\|)\s*Tiempo de entrega:\s*(.*?)\s*(?=\||$)/i;

export function parseNotes(notes: string | null): ParsedNotes {
  if (!notes) return { preparation: null, deliveryTime: null };
  const preparation = PREPARATION.exec(notes)?.[1]?.trim() || null;
  const deliveryTime = DELIVERY.exec(notes)?.[1]?.trim() || null;
  return { preparation, deliveryTime };
}

function plain(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

export type QuestionId = 'fasting' | 'medication' | 'menstrual_cycle' | 'abstinence' | 'antibiotics';

export interface PatientQuestion {
  id: QuestionId;
  question: string;
  /** Nombres de los exámenes que la motivan, en el orden recibido. */
  exams: string[];
}

interface Rule {
  id: QuestionId;
  applies: (preparation: string) => boolean;
  question: (preparations: string[]) => string;
}

const NO_FASTING = /no (?:se )?requiere (?:de )?ayuno|sin ayuno/;
// Solo horas atadas a «ayuno»: «ayuno de 8 a 12 horas» o «8 a 12 horas de ayuno».
// Las horas de otras indicaciones (ejercicio, abstinencia) no cuentan.
const FASTING_HOURS = [
  /ayuno(?: previo| estricto)? de (\d{1,2})(?: a (\d{1,2}))? horas/g,
  /(\d{1,2})(?: a (\d{1,2}))? horas de ayuno/g,
];

/** Rango de horas de ayuno más exigente mencionado: «8 a 12» o «8». */
function strictestFasting(preparations: string[]): string | null {
  let best: { min: number; max: number } | null = null;
  for (const preparation of preparations) {
    for (const match of FASTING_HOURS.flatMap((pattern) => [...preparation.matchAll(pattern)])) {
      const min = Number(match[1]);
      const max = Number(match[2] ?? match[1]);
      if (!best || max > best.max || (max === best.max && min > best.min)) best = { min, max };
    }
  }
  if (!best) return null;
  return best.min === best.max ? `${best.min}` : `${best.min} a ${best.max}`;
}

const RULES: Rule[] = [
  {
    id: 'fasting',
    applies: (p) => p.includes('ayuno') && !NO_FASTING.test(p),
    question: (preparations) => {
      const hours = strictestFasting(preparations);
      return hours
        ? `¿Puede venir con ${hours} horas de ayuno?`
        : '¿Puede venir en ayunas?';
    },
  },
  {
    id: 'medication',
    // «Tratamiento con antibióticos» ya lo cubre su propia regla, y el de óvulos
    // o cremas no es medicación que preguntar: solo cuenta otro «tratamiento».
    applies: (p) =>
      /medicacion|medicamento|anticoagul|biotina|suplemento|tiroides|dosis|inyeccion/.test(p) ||
      /tratamiento(?!\s+(?:con\s+|de\s+)?(?:los\s+)?(?:antibiotic|ovulo|crema))/.test(p),
    question: () => '¿Está tomando algún medicamento, suplemento (por ejemplo biotina) o tratamiento?',
  },
  {
    id: 'menstrual_cycle',
    applies: (p) => /menstru|ciclo|fase/.test(p),
    question: () => 'Si es mujer: ¿en qué día o fase de su ciclo menstrual se encuentra?',
  },
  {
    id: 'abstinence',
    applies: (p) => p.includes('abstinencia'),
    question: () => '¿Podrá cumplir la abstinencia sexual indicada antes de la toma?',
  },
  {
    id: 'antibiotics',
    applies: (p) => p.includes('antibiotico'),
    question: () => '¿Tomó antibióticos en los últimos días?',
  },
];

/** Preguntas relevantes para un conjunto de exámenes, sin repetir. */
export function patientQuestions(
  exams: ReadonlyArray<{ name: string; preparation: string | null }>,
): PatientQuestion[] {
  const questions: PatientQuestion[] = [];
  for (const rule of RULES) {
    const matching = exams.filter((exam) => exam.preparation && rule.applies(plain(exam.preparation)));
    if (matching.length === 0) continue;
    questions.push({
      id: rule.id,
      question: rule.question(matching.map((exam) => plain(exam.preparation as string))),
      exams: matching.map((exam) => exam.name),
    });
  }
  return questions;
}
