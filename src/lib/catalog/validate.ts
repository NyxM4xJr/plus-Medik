import { createHash } from 'node:crypto';
import { parseCsv } from '@/lib/catalog/csv';
import { normalizeLabText } from '@/lib/catalog/normalize';

/**
 * Validador del catálogo en CSV. Solo lee texto y produce un reporte:
 * no toca la base de datos ni decide nada por su cuenta.
 * Formato y reglas: docs/BITACORA.md, sección «Catálogo: formato CSV».
 */

export const CATALOG_COLUMNS = [
  'code',
  'name',
  'category',
  'sample_type',
  'price_bs',
  'active',
  'notes',
  'price_convenio_bs',
  'price_medicos_bs',
  'price_emergencia_bs',
] as const;

export type CatalogColumn = (typeof CATALOG_COLUMNS)[number];

/**
 * Las cuatro tarifas de la lista de PlusMedik. price_bs es la tarifa Paciente
 * (la columna original); las otras tres son columnas del mismo examen, no filas
 * aparte. Todas son obligatorias y siguen las mismas reglas de formato.
 */
export const TARIFF_COLUMNS = ['price_bs', 'price_convenio_bs', 'price_medicos_bs', 'price_emergencia_bs'] as const;

export type TariffColumn = (typeof TARIFF_COLUMNS)[number];

const TARIFF_LABELS: Record<TariffColumn, string> = {
  price_bs: 'Paciente',
  price_convenio_bs: 'Convenio',
  price_medicos_bs: 'Médicos',
  price_emergencia_bs: 'Emergencia particular',
};

/** blocking: la fila no se puede importar. review: requiere aprobación humana. */
export type IssueSeverity = 'blocking' | 'review' | 'warning';

export type IssueKind =
  | 'empty_file'
  | 'unterminated_quote'
  | 'wrong_delimiter'
  | 'missing_column'
  | 'duplicate_column'
  | 'unknown_column'
  | 'no_data_rows'
  | 'empty_row'
  | 'column_count'
  | 'missing_code'
  | 'duplicate_code'
  | 'proposed_code_conflict'
  | 'missing_name'
  | 'name_collision'
  | 'missing_price'
  | 'zero_price'
  | 'negative_price'
  | 'invalid_price'
  | 'price_out_of_range'
  | 'invalid_active';

export interface CatalogIssue {
  severity: IssueSeverity;
  kind: IssueKind;
  message: string;
  line?: number;
  field?: CatalogColumn;
}

export type RowStatus = 'ok' | 'needs_review' | 'blocked';

export interface ValidatedCatalogRow {
  line: number;
  status: RowStatus;
  code: string | null;
  /** Solo cuando falta el código. Es una propuesta: nunca se inserta sola. */
  proposedCode: string | null;
  name: string;
  normalizedName: string;
  category: string | null;
  sampleType: string | null;
  /** Tarifa Paciente. */
  priceBs: number | null;
  priceConvenioBs: number | null;
  priceMedicosBs: number | null;
  priceEmergenciaBs: number | null;
  active: boolean | null;
  notes: string | null;
  issues: CatalogIssue[];
}

export interface CatalogValidationReport {
  /** true solo si no hay problemas de archivo y todas las filas están ok. */
  autoImportAllowed: boolean;
  fileIssues: CatalogIssue[];
  rows: ValidatedCatalogRow[];
  duplicateCodes: Array<{ code: string; lines: number[] }>;
  nameCollisions: Array<{ normalizedName: string; lines: number[] }>;
  summary: {
    rows: number;
    ok: number;
    needsReview: number;
    blocked: number;
    emptyRowsSkipped: number;
  };
}

/** numeric(10,2) en las columnas de tarifa de lab_tests. */
const MAX_PRICE_BS = 99_999_999.99;
const PRICE_FORMAT = /^\d+(\.\d{1,2})?$/;
const ACTIVE_VALUES: Record<string, boolean> = {
  true: true,
  false: false,
  si: true,
  sí: true,
  no: false,
  '1': true,
  '0': false,
};

export const PROPOSED_CODE_PREFIX = 'AUTO-';

/**
 * Código provisional, determinista y sin depender del orden de las filas:
 * hash del nombre y del tipo de muestra normalizados. No incluye precio ni
 * categoría para que editarlos no cambie la propuesta.
 */
export function proposeCatalogCode(name: string, sampleType: string | null): string {
  const key = `${normalizeLabText(name)}|${normalizeLabText(sampleType)}`;
  const hash = createHash('sha256').update(key, 'utf8').digest('hex');
  return `${PROPOSED_CODE_PREFIX}${hash.slice(0, 8).toUpperCase()}`;
}

function optional(value: string | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

function parsePrice(
  raw: string,
  line: number,
  field: TariffColumn,
): { price: number | null; issue: CatalogIssue | null } {
  const value = raw.trim();
  const label = `Precio ${TARIFF_LABELS[field]}`;
  const issue = (kind: IssueKind, message: string): CatalogIssue => ({
    severity: 'blocking',
    kind,
    message,
    line,
    field,
  });

  if (value === '') return { price: null, issue: issue('missing_price', `Falta el ${label.toLowerCase()}.`) };
  if (value.startsWith('-')) {
    return { price: null, issue: issue('negative_price', `${label} negativo: «${value}».`) };
  }
  if (!PRICE_FORMAT.test(value)) {
    const hint = value.includes(',')
      ? ' Usa punto como separador decimal (45.50), sin separador de miles.'
      : ' Formato esperado: número con hasta 2 decimales (45 o 45.50), sin «Bs».';
    return { price: null, issue: issue('invalid_price', `${label} inválido: «${value}».${hint}`) };
  }

  const price = Number(value);
  if (price === 0) return { price: null, issue: issue('zero_price', `${label} no puede ser 0.`) };
  if (price > MAX_PRICE_BS) {
    return { price: null, issue: issue('price_out_of_range', `${label} fuera de rango: «${value}».`) };
  }

  return { price, issue: null };
}

function parseActive(raw: string, line: number): { active: boolean | null; issue: CatalogIssue | null } {
  const value = raw.trim().toLowerCase();
  if (value === '') return { active: true, issue: null };
  if (value in ACTIVE_VALUES) return { active: ACTIVE_VALUES[value], issue: null };

  return {
    active: null,
    issue: {
      severity: 'blocking',
      kind: 'invalid_active',
      message: `Valor de active inválido: «${raw.trim()}». Usa true/false, si/no o 1/0 (vacío = true).`,
      line,
      field: 'active',
    },
  };
}

function rowStatus(issues: CatalogIssue[]): RowStatus {
  if (issues.some((issue) => issue.severity === 'blocking')) return 'blocked';
  if (issues.some((issue) => issue.severity === 'review')) return 'needs_review';
  return 'ok';
}

function groupLines<T>(rows: T[], key: (row: T) => string | null, line: (row: T) => number) {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const value = key(row);
    if (value === null || value === '') continue;
    groups.set(value, [...(groups.get(value) ?? []), line(row)]);
  }
  return [...groups].filter(([, lines]) => lines.length > 1);
}

function emptyReport(fileIssues: CatalogIssue[]): CatalogValidationReport {
  return {
    autoImportAllowed: false,
    fileIssues,
    rows: [],
    duplicateCodes: [],
    nameCollisions: [],
    summary: { rows: 0, ok: 0, needsReview: 0, blocked: 0, emptyRowsSkipped: 0 },
  };
}

export function validateCatalogCsv(csv: string): CatalogValidationReport {
  const fileIssues: CatalogIssue[] = [];
  const parsed = parseCsv(csv);

  if (parsed.error) {
    return emptyReport([
      {
        severity: 'blocking',
        kind: 'unterminated_quote',
        message: `${parsed.error.message} El registro empieza en la línea ${parsed.error.line}.`,
        line: parsed.error.line,
      },
    ]);
  }

  const [headerRecord, ...dataRecords] = parsed.records;
  if (!headerRecord || headerRecord.fields.every((field) => field.trim() === '')) {
    return emptyReport([{ severity: 'blocking', kind: 'empty_file', message: 'El archivo está vacío.' }]);
  }

  const header = headerRecord.fields.map((field) => field.trim().toLowerCase());

  if (header.length === 1 && header[0].includes(';')) {
    return emptyReport([
      {
        severity: 'blocking',
        kind: 'wrong_delimiter',
        message: 'El archivo parece separado por «;». Expórtalo como CSV separado por comas.',
        line: 1,
      },
    ]);
  }

  const seen = new Set<string>();
  for (const column of header) {
    if (seen.has(column)) {
      fileIssues.push({
        severity: 'blocking',
        kind: 'duplicate_column',
        message: `Columna repetida: «${column}».`,
        line: 1,
      });
    }
    seen.add(column);
    if (!(CATALOG_COLUMNS as readonly string[]).includes(column)) {
      fileIssues.push({
        severity: 'warning',
        kind: 'unknown_column',
        message: `Columna desconocida, se ignora: «${column}».`,
        line: 1,
      });
    }
  }

  for (const column of CATALOG_COLUMNS) {
    if (!seen.has(column)) {
      fileIssues.push({
        severity: 'blocking',
        kind: 'missing_column',
        message: `Falta la columna obligatoria «${column}».`,
        line: 1,
      });
    }
  }

  if (fileIssues.some((issue) => issue.severity === 'blocking')) return emptyReport(fileIssues);

  const index = Object.fromEntries(CATALOG_COLUMNS.map((column) => [column, header.indexOf(column)])) as Record<
    CatalogColumn,
    number
  >;

  const rows: ValidatedCatalogRow[] = [];
  let emptyRowsSkipped = 0;

  for (const record of dataRecords) {
    if (record.fields.every((field) => field.trim() === '')) {
      emptyRowsSkipped += 1;
      fileIssues.push({
        severity: 'warning',
        kind: 'empty_row',
        message: 'Fila vacía, se ignora.',
        line: record.line,
      });
      continue;
    }

    const issues: CatalogIssue[] = [];
    const cell = (column: CatalogColumn) => record.fields[index[column]] ?? '';

    if (record.fields.length !== header.length) {
      issues.push({
        severity: 'blocking',
        kind: 'column_count',
        message: `La fila tiene ${record.fields.length} columnas y el encabezado ${header.length}. Revisa comas sin comillas.`,
        line: record.line,
      });
    }

    const name = cell('name').trim();
    const normalizedName = normalizeLabText(name);
    if (normalizedName === '') {
      issues.push({
        severity: 'blocking',
        kind: 'missing_name',
        message: 'Falta el nombre del examen.',
        line: record.line,
        field: 'name',
      });
    }

    const sampleType = optional(cell('sample_type'));
    const code = optional(cell('code'));
    let proposedCode: string | null = null;
    if (code === null) {
      proposedCode = normalizedName === '' ? null : proposeCatalogCode(name, sampleType);
      issues.push({
        severity: 'review',
        kind: 'missing_code',
        message: proposedCode
          ? `Falta el código. Propuesta provisional: ${proposedCode} (requiere aprobación).`
          : 'Falta el código.',
        line: record.line,
        field: 'code',
      });
    }

    const prices = {} as Record<TariffColumn, number | null>;
    for (const field of TARIFF_COLUMNS) {
      const { price, issue: priceIssue } = parsePrice(cell(field), record.line, field);
      if (priceIssue) issues.push(priceIssue);
      prices[field] = price;
    }

    const { active, issue: activeIssue } = parseActive(cell('active'), record.line);
    if (activeIssue) issues.push(activeIssue);

    rows.push({
      line: record.line,
      status: 'ok',
      code,
      proposedCode,
      name,
      normalizedName,
      category: optional(cell('category')),
      sampleType,
      priceBs: prices.price_bs,
      priceConvenioBs: prices.price_convenio_bs,
      priceMedicosBs: prices.price_medicos_bs,
      priceEmergenciaBs: prices.price_emergencia_bs,
      active,
      notes: optional(cell('notes')),
      issues,
    });
  }

  if (rows.length === 0) {
    fileIssues.push({ severity: 'blocking', kind: 'no_data_rows', message: 'El archivo no tiene filas de datos.' });
  }

  const byLine = new Map(rows.map((row) => [row.line, row]));

  // Códigos repetidos: se comparan sin distinguir mayúsculas. Bloquean todas las filas.
  const duplicateCodes = groupLines(rows, (row) => row.code?.toUpperCase() ?? null, (row) => row.line).map(
    ([code, lines]) => {
      for (const line of lines) {
        byLine.get(line)?.issues.push({
          severity: 'blocking',
          kind: 'duplicate_code',
          message: `Código repetido «${code}» en las líneas ${lines.join(', ')}.`,
          line,
          field: 'code',
        });
      }
      return { code, lines };
    },
  );

  // Nombres que normalizan igual: nunca se fusionan; todas las filas quedan en revisión.
  const nameCollisions = groupLines(rows, (row) => row.normalizedName, (row) => row.line).map(
    ([normalizedName, lines]) => {
      for (const line of lines) {
        byLine.get(line)?.issues.push({
          severity: 'review',
          kind: 'name_collision',
          message: `El nombre normaliza igual que en las líneas ${lines.filter((l) => l !== line).join(', ')} («${normalizedName}»). No se fusionan: confirma si son exámenes distintos.`,
          line,
          field: 'name',
        });
      }
      return { normalizedName, lines };
    },
  );

  // Una propuesta que choca con un código real del archivo no sirve.
  const explicitCodes = new Set(rows.flatMap((row) => (row.code ? [row.code.toUpperCase()] : [])));
  for (const row of rows) {
    if (row.proposedCode && explicitCodes.has(row.proposedCode.toUpperCase())) {
      row.issues.push({
        severity: 'review',
        kind: 'proposed_code_conflict',
        message: `La propuesta ${row.proposedCode} ya existe como código en el archivo.`,
        line: row.line,
        field: 'code',
      });
    }
  }

  for (const row of rows) row.status = rowStatus(row.issues);

  const summary = {
    rows: rows.length,
    ok: rows.filter((row) => row.status === 'ok').length,
    needsReview: rows.filter((row) => row.status === 'needs_review').length,
    blocked: rows.filter((row) => row.status === 'blocked').length,
    emptyRowsSkipped,
  };

  return {
    autoImportAllowed:
      !fileIssues.some((issue) => issue.severity !== 'warning') &&
      rows.length > 0 &&
      summary.ok === rows.length,
    fileIssues,
    rows,
    duplicateCodes,
    nameCollisions,
    summary,
  };
}
