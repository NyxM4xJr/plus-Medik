import { classifyCandidates, type CatalogCandidate, type MatchType } from '@/lib/catalog/search';
import type { LabTestDetails, PrescriptionDeps } from '@/lib/prescription/analyze';
import type { PrescriptionReading, ReadExam } from '@/lib/prescription/reading';

/** Catálogo inventado para los tests de recetas. Nunca datos reales de pacientes. */
export const TESTS: Record<string, LabTestDetails> = {
  hem: { id: 'hem', code: '108', name: 'HEMOGRAMA COMPLETO', sampleType: 'Sangre total EDTA', priceBs: 50, notes: 'Preparacion: No requiere condiciones especiales. | Tiempo de entrega: 1 dia' },
  glu: { id: 'glu', code: '380', name: 'GLUCOSA', sampleType: 'Suero', priceBs: 20, notes: 'Preparacion: Se requiere ayuno de 8 a 12 horas. | Tiempo de entrega: 2 horas' },
  tsh: { id: 'tsh', code: '170', name: 'TSH', sampleType: 'Suero 500 ul', priceBs: 117.65, notes: 'Preparacion: Se requiere ayuno de 8 a 12 horas. Informar si está tomando alguna medicación para la tiroides. | Tiempo de entrega: 1 dia' },
  hpHeces: { id: 'hpHeces', code: '453', name: 'HELICOBACTER PYLORI (HECES)', sampleType: 'Heces fecales', priceBs: 100, notes: null },
  hpIgg: { id: 'hpIgg', code: '204', name: 'HELICOBACTER PYLORI IgG', sampleType: 'Suero', priceBs: 90, notes: null },
};

export function candidate(id: string, matchType: MatchType = 'exact_name', similarityScore = 1): CatalogCandidate {
  const test = TESTS[id];
  return {
    labTestId: test.id,
    code: test.code,
    name: test.name,
    category: null,
    sampleType: test.sampleType,
    priceBs: test.priceBs,
    matchType,
    matchedText: test.name.toLowerCase(),
    similarityScore,
  };
}

/** Búsqueda falsa: consulta en minúsculas → candidatos. Lo no listado no tiene candidatos. */
export function fakeDeps(
  index: Record<string, CatalogCandidate[]>,
  catalog: Record<string, LabTestDetails> = TESTS,
): PrescriptionDeps & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    async search(query) {
      queries.push(query);
      return classifyCandidates(query, index[query.trim().toLowerCase()] ?? []);
    },
    async details(ids) {
      return ids.flatMap((id) => (catalog[id] ? [catalog[id]] : []));
    },
    async catalog() {
      return Object.values(catalog).map((test) => ({
        labTestId: test.id,
        code: test.code,
        name: test.name,
        priceBs: test.priceBs,
      }));
    },
  };
}

export function exam(text: string, overrides: Partial<ReadExam> = {}): ReadExam {
  return { text, interpretation: null, mark: 'tick', confidence: 0.95, image: 1, ...overrides };
}

export function reading(exams: ReadExam[], overrides: Partial<PrescriptionReading> = {}): PrescriptionReading {
  return { is_lab_order: true, image_quality: 0.9, issues: [], exams, ...overrides };
}
