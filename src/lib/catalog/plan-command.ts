import { planCatalogImport, type CatalogImportPlan, type LabTestReader } from '@/lib/catalog/import';
import { validateCatalogCsv, type CatalogValidationReport } from '@/lib/catalog/validate';

/**
 * Comando del plan de importación. Siempre dry-run: solo recibe un lector,
 * así que no tiene forma de escribir. Ver docs/BITACORA.md, «Catálogo: comando».
 */

export const EXIT_APPLICABLE = 0;
export const EXIT_FAILED = 1;
export const EXIT_NOT_APPLICABLE = 2;

export const PLAN_USAGE = 'Uso: npm run catalog:plan -- <archivo.csv>';

/** Acepta exactamente una ruta. Cualquier bandera (incluida --apply) se rechaza. */
export function parsePlanArgs(args: readonly string[]): { csvPath: string } | { error: string } {
  if (args.length !== 1) return { error: PLAN_USAGE };
  const [arg] = args;
  if (arg.startsWith('-')) return { error: `Opción no admitida: ${arg}. Este comando solo hace dry-run. ${PLAN_USAGE}` };
  return { csvPath: arg };
}

export interface PlanCommandDeps {
  csvPath: string;
  readFile: (path: string) => Promise<string>;
  reader: LabTestReader;
  /** Base contra la que se compara (ref del proyecto), para no confundir entornos. */
  target: string;
  write: (line: string) => void;
}

function section(title: string, lines: string[]): string[] {
  return lines.length === 0 ? [] : ['', `${title}:`, ...lines.map((line) => `  ${line}`)];
}

export function formatCatalogPlan(
  report: CatalogValidationReport,
  plan: CatalogImportPlan,
  meta: { csvPath: string; target: string },
): string[] {
  const s = plan.summary;
  const fileProblems = report.fileIssues.filter((issue) => issue.severity !== 'warning');

  return [
    'DRY-RUN: plan de importación del catálogo. No se escribió nada.',
    `Archivo: ${meta.csvPath}`,
    `Base: ${meta.target}`,
    `Filas del archivo: ${report.summary.rows} (ok ${report.summary.ok}, en revisión ${report.summary.needsReview}, bloqueadas ${report.summary.blocked}, vacías ignoradas ${report.summary.emptyRowsSkipped})`,
    '',
    'Resumen:',
    `  create      ${s.create}`,
    `  update      ${s.update}`,
    `  unchanged   ${s.unchanged}`,
    `  deactivate  ${s.deactivate}`,
    `  blocked     ${s.blocked}`,
    `  unmanaged   ${s.unmanaged}`,
    `  conflicts   ${s.conflicts}`,
    ...section(
      'Problemas del archivo',
      fileProblems.map((issue) => `${issue.line ? `línea ${issue.line}: ` : ''}${issue.message}`),
    ),
    ...section(
      'Conflictos en lab_tests (corregir a mano antes de importar)',
      plan.conflicts.map((c) => `${c.code}: ${c.rows.map((r) => `${r.code} (id ${r.id})`).join(', ')}`),
    ),
    ...section(
      'Bloqueadas',
      plan.blocked.map(
        (b) =>
          `línea ${b.line} ${b.code ?? `sin código${b.proposedCode ? ` (propuesta ${b.proposedCode})` : ''}`} [${b.reason}]: ${b.detail}`,
      ),
    ),
    ...section('Crear', plan.create.map((c) => `${c.values.code}  ${c.values.name}  Bs ${c.values.priceBs.toFixed(2)}`)),
    ...section(
      'Actualizar',
      plan.update.map(
        (u) =>
          `${u.code}: ${u.changes.map((c) => `${c.field} ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`).join('; ')}`,
      ),
    ),
    ...section('Desactivar', plan.deactivate.map((d) => `${d.code}  ${d.name}`)),
    ...section('Sin código en lab_tests (no se tocan)', plan.unmanaged.map((u) => `id ${u.id}  ${u.name}`)),
    '',
    plan.canApply
      ? 'Resultado: el plan se podría aplicar (este comando nunca aplica).'
      : `Resultado: el plan NO se puede aplicar: ${plan.notApplicableReasons.join('; ')}.`,
  ];
}

export async function runCatalogPlanCommand(deps: PlanCommandDeps): Promise<number> {
  let csv: string;
  try {
    csv = await deps.readFile(deps.csvPath);
  } catch (error) {
    deps.write(`Error: no se pudo leer el archivo ${deps.csvPath}: ${error instanceof Error ? error.message : 'desconocido'}`);
    return EXIT_FAILED;
  }

  const report = validateCatalogCsv(csv);

  let plan: CatalogImportPlan;
  try {
    plan = planCatalogImport(report, await deps.reader.list());
  } catch (error) {
    deps.write(`Error: no se pudo leer lab_tests: ${error instanceof Error ? error.message : 'desconocido'}`);
    return EXIT_FAILED;
  }

  for (const line of formatCatalogPlan(report, plan, { csvPath: deps.csvPath, target: deps.target })) {
    deps.write(line);
  }

  return plan.canApply ? EXIT_APPLICABLE : EXIT_NOT_APPLICABLE;
}
