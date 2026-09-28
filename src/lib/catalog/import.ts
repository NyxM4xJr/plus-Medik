import type { CatalogValidationReport, ValidatedCatalogRow } from '@/lib/catalog/validate';

/**
 * Importador del catálogo. Compara el reporte del validador contra lab_tests
 * y produce un plan. Por defecto solo planifica (dry-run); aplicar exige
 * mode: 'apply' y un reporte sin errores ni revisiones pendientes.
 *
 * Reglas: se empareja solo por code, nunca por nombre; nunca se borra; lo que
 * desaparece del archivo se desactiva. Ver docs/BITACORA.md, «Catálogo: importador».
 */

/** Fila de lab_tests tal como la necesita el importador. */
export interface ExistingLabTest {
  id: string;
  code: string | null;
  name: string;
  category: string | null;
  sampleType: string | null;
  /** Tarifa Paciente. */
  priceBs: number;
  /** null en exámenes cargados antes de las cuatro tarifas. */
  priceConvenioBs: number | null;
  priceMedicosBs: number | null;
  priceEmergenciaBs: number | null;
  active: boolean;
  notes: string | null;
}

export interface LabTestValues {
  code: string;
  name: string;
  category: string | null;
  sampleType: string | null;
  priceBs: number;
  priceConvenioBs: number;
  priceMedicosBs: number;
  priceEmergenciaBs: number;
  active: boolean;
  notes: string | null;
}

export type LabTestPatch = Partial<Omit<LabTestValues, 'code'>>;

/** Lectura de lab_tests. Suficiente para planificar (dry-run). */
export interface LabTestReader {
  list(): Promise<ExistingLabTest[]>;
}

/** Lectura y escritura de lab_tests. El importador no conoce Supabase. */
export interface LabTestRepository extends LabTestReader {
  insert(rows: LabTestValues[]): Promise<void>;
  update(id: string, patch: LabTestPatch): Promise<void>;
}

type ComparableField = keyof LabTestPatch;

const PRICE_FIELDS: ReadonlySet<ComparableField> = new Set([
  'priceBs',
  'priceConvenioBs',
  'priceMedicosBs',
  'priceEmergenciaBs',
]);

const COMPARABLE_FIELDS: ComparableField[] = [
  'name',
  'category',
  'sampleType',
  'priceBs',
  'priceConvenioBs',
  'priceMedicosBs',
  'priceEmergenciaBs',
  'active',
  'notes',
];

export interface FieldChange {
  field: ComparableField;
  from: unknown;
  to: unknown;
}

export type BlockedReason =
  | 'row_blocked'
  | 'row_needs_review'
  | 'code_case_mismatch'
  | 'ambiguous_existing_code';

export interface PlannedBlocked {
  line: number;
  code: string | null;
  proposedCode: string | null;
  name: string;
  reason: BlockedReason;
  detail: string;
}

/**
 * Inconsistencia en lab_tests: varias filas con el mismo código sin distinguir
 * mayúsculas. Bloquea el plan entero aunque el código no aparezca en el CSV.
 */
export interface ExistingCodeConflict {
  kind: 'duplicate_existing_code';
  code: string;
  rows: Array<{ id: string; code: string; name: string }>;
}

export interface CatalogImportPlan {
  /** true solo si el reporte está limpio, no hay filas bloqueadas ni conflictos. */
  canApply: boolean;
  /** Por qué no se puede aplicar, si aplica. */
  notApplicableReasons: string[];
  create: Array<{ line: number; values: LabTestValues }>;
  update: Array<{ line: number; id: string; code: string; changes: FieldChange[]; patch: LabTestPatch }>;
  unchanged: Array<{ line: number; id: string; code: string }>;
  deactivate: Array<{ id: string; code: string; name: string }>;
  blocked: PlannedBlocked[];
  /** lab_tests sin código: no se pueden emparejar y nunca se tocan. */
  unmanaged: Array<{ id: string; name: string }>;
  /** Inconsistencias de lab_tests que impiden aplicar hasta resolverlas a mano. */
  conflicts: ExistingCodeConflict[];
  summary: Record<
    'create' | 'update' | 'unchanged' | 'deactivate' | 'blocked' | 'unmanaged' | 'conflicts',
    number
  >;
}

export type ImportMode = 'dry-run' | 'apply';

export interface CatalogImportResult {
  mode: ImportMode;
  applied: boolean;
  plan: CatalogImportPlan;
}

export class CatalogImportRefusedError extends Error {
  constructor(readonly plan: CatalogImportPlan) {
    super(`catalog_import_refused: ${plan.notApplicableReasons.join('; ')}`);
    this.name = 'CatalogImportRefusedError';
  }
}

function codeKey(code: string): string {
  return code.trim().toUpperCase();
}

function toCents(price: number): number {
  return Math.round(price * 100);
}

function sameValue(field: ComparableField, a: unknown, b: unknown): boolean {
  if (PRICE_FIELDS.has(field) && a !== null && b !== null) {
    return toCents(a as number) === toCents(b as number);
  }
  return a === b;
}

function valuesFromRow(row: ValidatedCatalogRow): LabTestValues {
  // Solo se llama con filas ok: code, las cuatro tarifas y active ya están validados.
  return {
    code: row.code as string,
    name: row.name,
    category: row.category,
    sampleType: row.sampleType,
    priceBs: row.priceBs as number,
    priceConvenioBs: row.priceConvenioBs as number,
    priceMedicosBs: row.priceMedicosBs as number,
    priceEmergenciaBs: row.priceEmergenciaBs as number,
    active: row.active as boolean,
    notes: row.notes,
  };
}

function blockedFromRow(row: ValidatedCatalogRow, reason: BlockedReason, detail: string): PlannedBlocked {
  return {
    line: row.line,
    code: row.code,
    proposedCode: row.proposedCode,
    name: row.name,
    reason,
    detail,
  };
}

function byCode<T extends { code: string }>(a: T, b: T): number {
  return a.code.localeCompare(b.code);
}

/**
 * Compara el catálogo validado contra lab_tests. Función pura: no modifica
 * ni el reporte ni la colección recibida.
 */
export function planCatalogImport(
  report: CatalogValidationReport,
  existing: readonly ExistingLabTest[],
): CatalogImportPlan {
  const notApplicableReasons: string[] = [];
  const fileBroken = report.fileIssues.some((issue) => issue.severity !== 'warning');

  if (fileBroken) notApplicableReasons.push('el archivo tiene errores de formato');
  if (report.rows.length === 0) notApplicableReasons.push('el archivo no tiene filas de datos');

  const create: CatalogImportPlan['create'] = [];
  const update: CatalogImportPlan['update'] = [];
  const unchanged: CatalogImportPlan['unchanged'] = [];
  const deactivate: CatalogImportPlan['deactivate'] = [];
  const blocked: PlannedBlocked[] = [];
  const unmanaged: CatalogImportPlan['unmanaged'] = [];

  const existingByCode = new Map<string, ExistingLabTest[]>();
  for (const test of existing) {
    if (test.code === null || test.code.trim() === '') {
      unmanaged.push({ id: test.id, name: test.name });
      continue;
    }
    const key = codeKey(test.code);
    existingByCode.set(key, [...(existingByCode.get(key) ?? []), test]);
  }

  // Se detecta siempre, aunque el archivo esté roto o no use ese código.
  const conflicts: ExistingCodeConflict[] = [...existingByCode]
    .filter(([, tests]) => tests.length > 1)
    .map(([key, tests]) => ({
      kind: 'duplicate_existing_code' as const,
      code: key,
      rows: tests
        .map((test) => ({ id: test.id, code: test.code as string, name: test.name }))
        .sort((a, b) => a.id.localeCompare(b.id)),
    }))
    .sort((a, b) => a.code.localeCompare(b.code));
  const conflictKeys = new Set(conflicts.map((conflict) => conflict.code));

  if (conflicts.length > 0) {
    notApplicableReasons.push(
      `lab_tests tiene códigos repetidos sin distinguir mayúsculas: ${conflicts.map((c) => c.code).join(', ')}`,
    );
  }

  // Un archivo roto no produce acciones: evita desactivar el catálogo entero.
  if (!fileBroken) {
    for (const row of report.rows) {
      if (row.status === 'blocked') {
        blocked.push(blockedFromRow(row, 'row_blocked', row.issues.map((issue) => issue.message).join(' ')));
        continue;
      }
      if (row.status === 'needs_review') {
        blocked.push(blockedFromRow(row, 'row_needs_review', row.issues.map((issue) => issue.message).join(' ')));
        continue;
      }

      const values = valuesFromRow(row);
      const matches = existingByCode.get(codeKey(values.code)) ?? [];

      if (matches.length > 1) {
        blocked.push(
          blockedFromRow(
            row,
            'ambiguous_existing_code',
            `En lab_tests hay ${matches.length} filas con el código ${values.code} (sin distinguir mayúsculas).`,
          ),
        );
        continue;
      }

      const [current] = matches;
      if (!current) {
        create.push({ line: row.line, values });
        continue;
      }

      if (current.code !== values.code) {
        blocked.push(
          blockedFromRow(
            row,
            'code_case_mismatch',
            `El código del archivo «${values.code}» difiere en mayúsculas del existente «${current.code}».`,
          ),
        );
        continue;
      }

      const changes: FieldChange[] = COMPARABLE_FIELDS.filter(
        (field) => !sameValue(field, current[field], values[field]),
      ).map((field) => ({ field, from: current[field], to: values[field] }));

      if (changes.length === 0) {
        unchanged.push({ line: row.line, id: current.id, code: values.code });
      } else {
        const patch = Object.fromEntries(changes.map((change) => [change.field, change.to])) as LabTestPatch;
        update.push({ line: row.line, id: current.id, code: values.code, changes, patch });
      }
    }

    // Solo se desactiva lo que no aparece en NINGUNA fila del archivo,
    // aunque su fila esté bloqueada.
    const codesInFile = new Set(report.rows.flatMap((row) => (row.code ? [codeKey(row.code)] : [])));
    for (const [key, tests] of existingByCode) {
      // Un código en conflicto queda intacto hasta resolverlo a mano.
      if (codesInFile.has(key) || conflictKeys.has(key)) continue;
      for (const test of tests) {
        if (test.active) deactivate.push({ id: test.id, code: test.code as string, name: test.name });
      }
    }
  }

  if (blocked.length > 0) {
    notApplicableReasons.push(`${blocked.length} fila(s) bloqueadas o pendientes de revisión`);
  }

  create.sort((a, b) => a.values.code.localeCompare(b.values.code));
  update.sort(byCode);
  unchanged.sort(byCode);
  deactivate.sort(byCode);
  blocked.sort((a, b) => a.line - b.line);
  unmanaged.sort((a, b) => a.id.localeCompare(b.id));

  return {
    canApply: notApplicableReasons.length === 0 && report.autoImportAllowed,
    notApplicableReasons:
      notApplicableReasons.length === 0 && !report.autoImportAllowed
        ? ['el validador no permite la carga automática']
        : notApplicableReasons,
    create,
    update,
    unchanged,
    deactivate,
    blocked,
    unmanaged,
    conflicts,
    summary: {
      create: create.length,
      update: update.length,
      unchanged: unchanged.length,
      deactivate: deactivate.length,
      blocked: blocked.length,
      unmanaged: unmanaged.length,
      conflicts: conflicts.length,
    },
  };
}

/**
 * Planifica contra el estado actual de lab_tests y, solo con mode: 'apply',
 * ejecuta el plan. El plan se recalcula justo antes de aplicar para no usar
 * datos viejos. No es transaccional: si falla a mitad, repetir la importación
 * converge porque las filas ya aplicadas salen como unchanged.
 */
export async function runCatalogImport(
  report: CatalogValidationReport,
  repository: LabTestRepository,
  options: { mode?: ImportMode } = {},
): Promise<CatalogImportResult> {
  const mode = options.mode ?? 'dry-run';
  const plan = planCatalogImport(report, await repository.list());

  if (mode === 'dry-run') return { mode, applied: false, plan };

  if (!plan.canApply) throw new CatalogImportRefusedError(plan);

  if (plan.create.length > 0) {
    await repository.insert(plan.create.map((item) => item.values));
  }
  for (const item of plan.update) {
    await repository.update(item.id, item.patch);
  }
  for (const item of plan.deactivate) {
    await repository.update(item.id, { active: false });
  }

  return { mode, applied: true, plan };
}
