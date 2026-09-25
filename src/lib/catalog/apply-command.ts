import { createHash } from 'node:crypto';
import { z } from 'zod';
import { planCatalogImport, type CatalogImportPlan, type LabTestReader } from '@/lib/catalog/import';
import { formatCatalogPlanDetails } from '@/lib/catalog/plan-command';
import { validateCatalogCsv, type CatalogValidationReport } from '@/lib/catalog/validate';

/**
 * Comando de carga del catálogo. Sin --apply es dry-run: muestra el plan y
 * comprueba las opciones, pero nunca llama al RPC. Con --apply, después de
 * mostrar el plan pide confirmación escrita, vuelve a planificar y llama una
 * sola vez a apply_lab_catalog_import, que repite todas las validaciones
 * dentro de una transacción. Solo se ejecuta en una máquina local.
 * Ver docs/BITACORA.md, «Catálogo: carga», y docs/diseno/carga-catalogo.md.
 */

export const EXIT_OK = 0;
export const EXIT_FAILED = 1;
export const EXIT_REFUSED = 2;
export const EXIT_CANCELLED = 3;

/** Aprobado con el diseño: más de 10 desactivaciones exige --allow-mass-deactivation. */
export const DEFAULT_MAX_DEACTIVATIONS = 10;

export const APPLY_USAGE =
  'Uso: npm run catalog:apply -- <archivo.csv> [--apply --operator=NOMBRE] ' +
  '[--confirm-deactivations=COD1,COD2] [--allow-mass-deactivation]';

const MAX_OPERATOR_LENGTH = 100;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

export interface ApplyOptions {
  csvPath: string;
  /** false = dry-run (predeterminado). */
  apply: boolean;
  operator: string | null;
  /** null = la opción no se pasó. [] = se pasó vacía («ninguna»). */
  confirmDeactivations: string[] | null;
  allowMassDeactivation: boolean;
}

function codeKey(code: string): string {
  return code.trim().toUpperCase();
}

/**
 * Opciones admitidas: --apply, --operator=, --confirm-deactivations=,
 * --allow-mass-deactivation y una sola ruta. Todo lo demás, repetido o mal
 * formado, es un error: una opción mal escrita no puede pasar desapercibida.
 */
export function parseApplyArgs(args: readonly string[]): ApplyOptions | { error: string } {
  const fail = (message: string) => ({ error: `${message} ${APPLY_USAGE}` });
  const seen = new Set<string>();
  const paths: string[] = [];
  const options: Omit<ApplyOptions, 'csvPath'> = {
    apply: false,
    operator: null,
    confirmDeactivations: null,
    allowMassDeactivation: false,
  };

  for (const arg of args) {
    if (!arg.startsWith('-')) {
      paths.push(arg);
      continue;
    }
    if (!arg.startsWith('--')) return fail(`Opción no admitida: ${arg}.`);

    const eq = arg.indexOf('=');
    const name = eq === -1 ? arg.slice(2) : arg.slice(2, eq);
    const value = eq === -1 ? null : arg.slice(eq + 1);

    if (seen.has(name)) return fail(`Opción repetida: --${name}.`);
    seen.add(name);

    switch (name) {
      case 'apply':
      case 'allow-mass-deactivation':
        if (value !== null) return fail(`--${name} no lleva valor.`);
        if (name === 'apply') options.apply = true;
        else options.allowMassDeactivation = true;
        break;

      case 'operator': {
        const operator = (value ?? '').trim();
        if (operator === '') return fail('--operator necesita un nombre: --operator=NOMBRE.');
        if (operator.length > MAX_OPERATOR_LENGTH || CONTROL_CHARS.test(operator)) {
          return fail(`--operator debe tener hasta ${MAX_OPERATOR_LENGTH} caracteres, sin caracteres de control.`);
        }
        options.operator = operator;
        break;
      }

      case 'confirm-deactivations': {
        if (value === null) {
          return fail('--confirm-deactivations lleva la lista: --confirm-deactivations=COD1,COD2 (vacía si no hay).');
        }
        const codes = value.trim() === '' ? [] : value.split(',').map((code) => code.trim());
        if (codes.some((code) => code === '')) {
          return fail('--confirm-deactivations tiene un código vacío (revisa las comas).');
        }
        const keys = codes.map(codeKey);
        const repeated = keys.filter((key, index) => keys.indexOf(key) !== index);
        if (repeated.length > 0) {
          return fail(`--confirm-deactivations repite códigos: ${[...new Set(repeated)].join(', ')}.`);
        }
        options.confirmDeactivations = codes;
        break;
      }

      default:
        return fail(`Opción no admitida: ${arg}.`);
    }
  }

  if (paths.length !== 1) return fail('Indica exactamente un archivo CSV.');
  return { csvPath: paths[0], ...options };
}

/** CATALOG_MAX_DEACTIVATIONS: sin definir = 10; definida debe ser un entero >= 0. */
export function parseMaxDeactivations(raw: string | undefined): { value: number } | { error: string } {
  if (raw === undefined) return { value: DEFAULT_MAX_DEACTIVATIONS };
  if (!/^[0-9]{1,9}$/.test(raw.trim())) {
    return {
      error: `CATALOG_MAX_DEACTIVATIONS inválido: «${raw}». Debe ser un entero >= 0 (sin definir = ${DEFAULT_MAX_DEACTIVATIONS}).`,
    };
  }
  return { value: Number(raw.trim()) };
}

/**
 * La carga nunca corre en Vercel ni en CI. Se comprueba con el entorno del
 * proceso, antes de leer .env.local.
 */
export function localExecutionError(env: Readonly<Record<string, string | undefined>>): string | null {
  const found = ['VERCEL', 'VERCEL_ENV', 'NEXT_RUNTIME', 'CI'].filter((name) => (env[name] ?? '') !== '');
  return found.length === 0
    ? null
    : `catalog:apply solo se ejecuta en una máquina local controlada (detectado: ${found.join(', ')}).`;
}

export function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Nombre del archivo sin la ruta local, para la auditoría. */
export function fileNameOf(path: string): string {
  return path.split(/[\\/]/).pop() ?? path;
}

/** Fila de p_rows. Campos explícitos: nada más viaja (ni proposedCode, ni line, ni issues). */
export interface CatalogRpcRow {
  code: string;
  name: string;
  category: string | null;
  sample_type: string | null;
  /** Texto decimal con dos decimales: la función lo convierte a numeric(10,2). */
  price_bs: string;
  active: boolean;
  notes: string | null;
  status: 'ok';
}

/** Solo filas ok del validador, en el formato de p_rows. */
export function buildRpcRows(report: CatalogValidationReport): CatalogRpcRow[] {
  return report.rows
    .filter((row) => row.status === 'ok')
    .map((row) => {
      if (row.code === null || row.priceBs === null || row.active === null) {
        throw new Error(`fila ${row.line} ok sin code, price_bs o active`);
      }
      return {
        code: row.code,
        name: row.name,
        category: row.category,
        sample_type: row.sampleType,
        price_bs: row.priceBs.toFixed(2),
        active: row.active,
        notes: row.notes,
        status: 'ok',
      };
    });
}

export interface ExpectedCounts {
  create: number;
  update: number;
  unchanged: number;
  deactivate: number;
}

export function expectedCountsOf(plan: CatalogImportPlan): ExpectedCounts {
  const { create, update, unchanged, deactivate } = plan.summary;
  return { create, update, unchanged, deactivate };
}

/**
 * Motivos por los que estas opciones no permiten aplicar el plan. Vacío =
 * se puede aplicar. Se evalúa igual en dry-run, para avisar antes.
 */
export function evaluateApplyGate(
  plan: CatalogImportPlan,
  options: ApplyOptions,
  maxDeactivations: number,
): string[] {
  const reasons: string[] = [];
  const planned = plan.deactivate.map((d) => d.code);

  if (!plan.canApply) reasons.push(`el plan no se puede aplicar: ${plan.notApplicableReasons.join('; ')}`);

  if (options.confirmDeactivations === null) {
    if (planned.length > 0) {
      reasons.push(
        `falta --confirm-deactivations con los ${planned.length} código(s) que se desactivan: ` +
          `--confirm-deactivations=${planned.join(',')}`,
      );
    }
  } else {
    const confirmed = new Set(options.confirmDeactivations.map(codeKey));
    const plannedKeys = new Set(planned.map(codeKey));
    const missing = planned.filter((code) => !confirmed.has(codeKey(code)));
    const extra = options.confirmDeactivations.filter((code) => !plannedKeys.has(codeKey(code)));
    if (missing.length > 0 || extra.length > 0) {
      reasons.push(
        '--confirm-deactivations no coincide con el plan' +
          (missing.length > 0 ? `; faltan: ${missing.join(', ')}` : '') +
          (extra.length > 0 ? `; no se desactivan: ${extra.join(', ')}` : ''),
      );
    }
  }

  if (planned.length > maxDeactivations && !options.allowMassDeactivation) {
    reasons.push(
      `el plan desactiva ${planned.length} exámenes y el límite es ${maxDeactivations} ` +
        '(CATALOG_MAX_DEACTIVATIONS): hace falta --allow-mass-deactivation',
    );
  }
  if (options.allowMassDeactivation && planned.length <= maxDeactivations) {
    reasons.push(
      `--allow-mass-deactivation no corresponde: el plan desactiva ${planned.length} ` +
        `y el límite es ${maxDeactivations}`,
    );
  }

  if (options.apply && options.operator === null) {
    reasons.push('falta --operator=NOMBRE (queda en la auditoría de la carga)');
  }

  return reasons;
}

/**
 * Huella del plan completo. Si cambia entre lo que vio el operador y el
 * momento de aplicar, no se llama al RPC. Cubre también cambios que se
 * compensan en los conteos (el RPC solo compara conteos y desactivaciones).
 */
export function planFingerprint(plan: CatalogImportPlan): string {
  return JSON.stringify({
    canApply: plan.canApply,
    create: plan.create.map((c) => c.values),
    update: plan.update.map((u) => [u.id, u.code, u.changes]),
    unchanged: plan.unchanged.map((u) => [u.id, u.code]),
    deactivate: plan.deactivate.map((d) => [d.id, d.code]),
    blocked: plan.blocked.map((b) => [b.line, b.reason]),
    unmanaged: plan.unmanaged.map((u) => u.id),
    conflicts: plan.conflicts.map((c) => [c.code, c.rows.map((r) => r.id)]),
  });
}

export interface CatalogApplyRpcArgs {
  p_rows: CatalogRpcRow[];
  p_confirm_deactivate_codes: string[];
  p_expected_counts: ExpectedCounts;
  p_source: { csv_sha256: string; operator: string; filename: string; tool: 'catalog:apply' };
  p_max_deactivations: number;
  p_allow_mass_deactivation: boolean;
}

/**
 * Llamada a apply_lab_catalog_import con la forma de supabase-js. Un error con
 * code viene de Postgres (la transacción se revirtió); sin code, o si la
 * promesa falla, el resultado es desconocido.
 */
export type CatalogApplyRpc = (
  args: CatalogApplyRpcArgs,
) => Promise<{ data: unknown; error: { message: string; code?: string } | null }>;

const applyResultSchema = z.object({
  import_id: z.string(),
  created: z.number().int(),
  updated: z.number().int(),
  unchanged: z.number().int(),
  deactivated: z.number().int(),
  reactivated: z.number().int(),
  unmanaged: z.number().int(),
  deactivated_codes: z.array(z.string()),
});

export interface ApplyCommandDeps {
  options: ApplyOptions;
  maxDeactivations: number;
  readFile: (path: string) => Promise<Uint8Array>;
  reader: LabTestReader;
  rpc: CatalogApplyRpc;
  /** Hace una pregunta al operador y devuelve lo que escribió. */
  confirm: (question: string) => Promise<string>;
  /** Base contra la que se aplica (ref del proyecto). Forma parte de la frase de confirmación. */
  target: string;
  write: (line: string) => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'desconocido';
}

const UNKNOWN_OUTCOME_HINT =
  'No se reintentó. Antes de volver a ejecutar, revisa lab_catalog_imports (applied_at y ' +
  "source->>'csv_sha256') para saber si la carga se aplicó.";

export async function runCatalogApplyCommand(deps: ApplyCommandDeps): Promise<number> {
  const { options, write } = deps;

  let bytes: Uint8Array;
  try {
    bytes = await deps.readFile(options.csvPath);
  } catch (error) {
    write(`Error: no se pudo leer el archivo ${options.csvPath}: ${errorMessage(error)}`);
    return EXIT_FAILED;
  }

  let csv: string;
  try {
    csv = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    write(`Error: ${options.csvPath} no es UTF-8 válido. Expórtalo como «CSV UTF-8».`);
    return EXIT_FAILED;
  }

  const csvSha256 = sha256Hex(bytes);
  const report = validateCatalogCsv(csv);

  let plan: CatalogImportPlan;
  try {
    plan = planCatalogImport(report, await deps.reader.list());
  } catch (error) {
    write(`Error: no se pudo leer lab_tests: ${errorMessage(error)}`);
    return EXIT_FAILED;
  }

  write(
    options.apply
      ? 'CARGA DEL CATÁLOGO (--apply). Todavía no se escribió nada.'
      : 'DRY-RUN: catalog:apply sin --apply. No se escribió nada.',
  );
  write(`Archivo: ${options.csvPath}`);
  write(`SHA-256: ${csvSha256}`);
  write(`Base: ${deps.target}`);
  write(`Límite de desactivaciones (CATALOG_MAX_DEACTIVATIONS): ${deps.maxDeactivations}`);
  for (const line of formatCatalogPlanDetails(report, plan)) write(line);
  write('');

  const reasons = evaluateApplyGate(plan, options, deps.maxDeactivations);
  const rows = buildRpcRows(report);
  if (plan.canApply && rows.length !== report.rows.length) {
    reasons.push('hay filas que no están ok');
  }

  if (reasons.length > 0) {
    write('No se puede aplicar:');
    for (const reason of reasons) write(`  - ${reason}`);
    return EXIT_REFUSED;
  }

  const counts = expectedCountsOf(plan);
  if (counts.create + counts.update + counts.deactivate === 0) {
    write('Nada que aplicar: el catálogo ya coincide con el archivo. No se llamó a la base.');
    return EXIT_OK;
  }

  if (!options.apply) {
    write('Resultado: con estas opciones la carga se podría aplicar.');
    write('Para aplicarla, repite el comando con las mismas opciones más --apply --operator=NOMBRE.');
    return EXIT_OK;
  }

  const operator = options.operator as string;
  const confirmPhrase = `aplicar ${deps.target}`;
  write(`Se va a aplicar en ${deps.target}, en una sola transacción:`);
  write(`  crear ${counts.create}, actualizar ${counts.update}, sin cambios ${counts.unchanged}, desactivar ${counts.deactivate}`);
  if (plan.deactivate.length > 0) {
    write(`  desactivaciones confirmadas: ${plan.deactivate.map((d) => d.code).join(', ')}`);
  }
  if (options.allowMassDeactivation) write('  desactivación masiva autorizada (--allow-mass-deactivation)');
  write(`  operador: ${operator}`);

  const answer = await deps.confirm(`Escribe «${confirmPhrase}» para aplicar (cualquier otra cosa cancela): `);
  if (answer.trim() !== confirmPhrase) {
    write('Cancelado. No se escribió nada.');
    return EXIT_CANCELLED;
  }

  // lab_tests pudo cambiar mientras el operador leía: se planifica de nuevo.
  let current: CatalogImportPlan;
  try {
    current = planCatalogImport(report, await deps.reader.list());
  } catch (error) {
    write(`Error: no se pudo volver a leer lab_tests: ${errorMessage(error)}. No se escribió nada.`);
    return EXIT_FAILED;
  }
  if (planFingerprint(current) !== planFingerprint(plan)) {
    write('El plan cambió desde que se mostró (lab_tests se modificó). No se escribió nada.');
    write('Vuelve a ejecutar el comando, revisa el plan nuevo y confirma otra vez.');
    return EXIT_REFUSED;
  }

  const args: CatalogApplyRpcArgs = {
    p_rows: rows,
    p_confirm_deactivate_codes: options.confirmDeactivations ?? [],
    p_expected_counts: counts,
    p_source: { csv_sha256: csvSha256, operator, filename: fileNameOf(options.csvPath), tool: 'catalog:apply' },
    p_max_deactivations: deps.maxDeactivations,
    p_allow_mass_deactivation: options.allowMassDeactivation,
  };

  // Una sola llamada, sin reintentos, pase lo que pase.
  let response: Awaited<ReturnType<CatalogApplyRpc>>;
  try {
    response = await deps.rpc(args);
  } catch (error) {
    write(`Error: la llamada falló y el resultado es desconocido: ${errorMessage(error)}`);
    write(UNKNOWN_OUTCOME_HINT);
    return EXIT_FAILED;
  }

  if (response.error) {
    if (response.error.code) {
      write(`La base rechazó la carga (${response.error.code}): ${response.error.message}`);
      write('La transacción se revirtió: no se escribió nada.');
    } else {
      write(`Error: la llamada falló y el resultado es desconocido: ${response.error.message}`);
      write(UNKNOWN_OUTCOME_HINT);
    }
    return EXIT_FAILED;
  }

  const result = applyResultSchema.safeParse(response.data);
  if (!result.success) {
    write('Aviso: la base respondió sin error, pero con un formato inesperado. La carga probablemente se aplicó.');
    write(UNKNOWN_OUTCOME_HINT);
    return EXIT_FAILED;
  }

  const r = result.data;
  write(`Carga aplicada. import_id ${r.import_id}`);
  write(
    `  creados ${r.created}, actualizados ${r.updated} (reactivados ${r.reactivated}), ` +
      `sin cambios ${r.unchanged}, desactivados ${r.deactivated}, sin código ${r.unmanaged}`,
  );
  if (r.deactivated_codes.length > 0) write(`  desactivados: ${r.deactivated_codes.join(', ')}`);
  return EXIT_OK;
}
