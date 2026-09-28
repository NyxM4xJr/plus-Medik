import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@/test/pglite';
import { planCatalogImport, type CatalogImportPlan } from './import';
import { LAB_TEST_COLUMNS, mapLabTestRow } from './supabase-reader';
import { CATALOG_COLUMNS, validateCatalogCsv, type CatalogValidationReport } from './validate';
import { DEFAULT_TARIFFS, withTariffs } from '@/test/catalog-fixtures';

/**
 * apply_lab_catalog_import sobre PGlite, con catálogos inventados.
 * El plan esperado se calcula con los módulos TypeScript, igual que lo hará
 * catalog:apply. Nada de esto se conecta a Supabase.
 */

const HEADER = CATALOG_COLUMNS.join(',');
const SOURCE = { csv_sha256: 'a'.repeat(64), operator: 'test', filename: 'catalogo.csv' };

let db: PGlite;

type Json = Record<string, unknown>;

interface ApplyArgs {
  rows: unknown;
  confirm: unknown;
  counts: unknown;
  source: unknown;
  max: number | null;
  allowMass: boolean | null;
}

interface Prepared extends ApplyArgs {
  report: CatalogValidationReport;
  plan: CatalogImportPlan;
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows.map(withTariffs)].join('\n');
}

/** Filas ok del reporte en el formato de p_rows (precio como texto). */
function payload(report: CatalogValidationReport): Json[] {
  return report.rows
    .filter((row) => row.status === 'ok')
    .map((row) => ({
      code: row.code,
      name: row.name,
      category: row.category,
      sample_type: row.sampleType,
      price_bs: (row.priceBs as number).toFixed(2),
      price_convenio_bs: (row.priceConvenioBs as number).toFixed(2),
      price_medicos_bs: (row.priceMedicosBs as number).toFixed(2),
      price_emergencia_bs: (row.priceEmergenciaBs as number).toFixed(2),
      active: row.active,
      notes: row.notes,
      status: row.status,
    }));
}

async function existingTests() {
  const { rows } = await db.query<Json>(
    `select ${LAB_TEST_COLUMNS} from lab_tests order by id`,
  );
  return rows.map((row) => mapLabTestRow(row as never));
}

/** Valida el CSV, planifica contra el estado actual y arma los argumentos. */
async function prepare(text: string): Promise<Prepared> {
  const report = validateCatalogCsv(text);
  const plan = planCatalogImport(report, await existingTests());
  return {
    report,
    plan,
    rows: payload(report),
    confirm: plan.deactivate.map((d) => d.code),
    counts: {
      create: plan.summary.create,
      update: plan.summary.update,
      unchanged: plan.summary.unchanged,
      deactivate: plan.summary.deactivate,
    },
    source: SOURCE,
    max: 10,
    allowMass: false,
  };
}

async function apply(args: ApplyArgs): Promise<Json> {
  const { rows } = await db.query<{ result: Json }>(
    'select apply_lab_catalog_import($1::jsonb, $2::text[], $3::jsonb, $4::jsonb, $5::integer, $6::boolean) as result',
    [
      args.rows === null ? null : JSON.stringify(args.rows),
      args.confirm,
      args.counts === null ? null : JSON.stringify(args.counts),
      args.source === null ? null : JSON.stringify(args.source),
      args.max,
      args.allowMass,
    ],
  );
  return rows[0].result;
}

async function seed(
  tests: Array<{ code: string | null; name: string; price?: number; active?: boolean; sample?: string | null }>,
) {
  for (const t of tests) {
    await db.query(
      'insert into lab_tests (code, name, sample_type, price_bs, price_convenio_bs, price_medicos_bs, ' +
        'price_emergencia_bs, active) values ($1, $2, $3, $4, $5, $6, $7, $8)',
      [
        t.code,
        t.name,
        t.sample === undefined ? 'Sangre' : t.sample,
        t.price ?? 45,
        DEFAULT_TARIFFS.priceConvenioBs,
        DEFAULT_TARIFFS.priceMedicosBs,
        DEFAULT_TARIFFS.priceEmergenciaBs,
        t.active ?? true,
      ],
    );
  }
}

/** Estado completo para comprobar que un rechazo no escribió nada. */
async function snapshot() {
  const tests = await db.query('select * from lab_tests order by id');
  const aliases = await db.query('select * from lab_test_aliases order by id');
  const imports = await db.query('select * from lab_catalog_imports order by id');
  const changes = await db.query('select * from lab_catalog_import_changes order by id');
  return { tests: tests.rows, aliases: aliases.rows, imports: imports.rows, changes: changes.rows };
}

async function expectRejected(args: ApplyArgs, error: RegExp) {
  const before = await snapshot();
  await expect(apply(args)).rejects.toThrow(error);
  expect(await snapshot()).toEqual(before);
}

async function byCode(code: string) {
  const { rows } = await db.query<Json>('select * from lab_tests where code = $1', [code]);
  return rows[0];
}

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('truncate lab_catalog_import_changes, lab_catalog_imports, lab_test_aliases, lab_tests cascade');
});

const BASE = [
  { code: 'HEM01', name: 'Hemograma', price: 45 },
  { code: 'GLU01', name: 'Glucosa', price: 20 },
  { code: 'OLD01', name: 'Examen retirado', price: 10 },
  { code: null, name: 'Cargado a mano', price: 5 },
];

const MIXED = csv(
  'HEM01,Hemograma completo,,Sangre,50,true,',
  'GLU01,Glucosa,,Sangre,20,true,',
  'CRE01,Creatinina,,Sangre,30,true,',
);

describe('paridad con planCatalogImport', () => {
  it.each([
    ['catálogo vacío: todo se crea', [], csv('A1,Uno,,Sangre,10,true,', 'A2,Dos,,Sangre,20,true,')],
    ['mezcla de create, update, unchanged, deactivate y unmanaged', BASE, MIXED],
    ['reactivación', [{ code: 'HEM01', name: 'Hemograma', active: false }], csv('HEM01,Hemograma,,Sangre,45,true,')],
    ['precio 45 = 45.00', [{ code: 'HEM01', name: 'Hemograma', price: 45 }], csv('HEM01,Hemograma,,Sangre,45.00,true,')],
  ])('%s', async (_label, tests, text) => {
    await seed(tests);
    const prepared = await prepare(text);
    expect(prepared.plan.canApply).toBe(true);

    const result = await apply(prepared);

    expect({
      create: result.created,
      update: result.updated,
      unchanged: result.unchanged,
      deactivate: result.deactivated,
      unmanaged: result.unmanaged,
    }).toEqual({
      create: prepared.plan.summary.create,
      update: prepared.plan.summary.update,
      unchanged: prepared.plan.summary.unchanged,
      deactivate: prepared.plan.summary.deactivate,
      unmanaged: prepared.plan.summary.unmanaged,
    });
  });
});

describe('camino feliz', () => {
  it('crea, actualiza, deja sin cambios y desactiva; nunca borra', async () => {
    await seed(BASE);
    const before = (await snapshot()).tests.length;

    const result = await apply(await prepare(MIXED));

    expect(result).toMatchObject({
      created: 1,
      updated: 1,
      unchanged: 1,
      deactivated: 1,
      reactivated: 0,
      unmanaged: 1,
      deactivated_codes: ['OLD01'],
    });
    expect((await snapshot()).tests).toHaveLength(before + 1);
    expect(await byCode('HEM01')).toMatchObject({ name: 'Hemograma completo', active: true });
    expect(Number((await byCode('HEM01')).price_bs)).toBe(50);
    expect(await byCode('OLD01')).toMatchObject({ active: false });
    expect(await byCode('CRE01')).toMatchObject({ name: 'Creatinina', active: true });

    const { rows } = await db.query<Json>("select * from lab_tests where code is null");
    expect(rows).toEqual([expect.objectContaining({ name: 'Cargado a mano', active: true })]);
  });

  it('informa las reactivaciones aparte', async () => {
    await seed([{ code: 'HEM01', name: 'Hemograma', active: false }]);
    const result = await apply(await prepare(csv('HEM01,Hemograma,,Sangre,45,true,')));

    expect(result).toMatchObject({ updated: 1, reactivated: 1 });
  });

  it('las variantes de Helicobacter quedan como filas separadas', async () => {
    await apply(
      await prepare(
        csv(
          'HP-AG,Helicobacter pylori antígeno en heces,,Heces,120,true,',
          'HP-IGG,Helicobacter pylori IgG,,Sangre,90,true,',
          'HP-IGM,Helicobacter pylori IgM,,Sangre,90,true,',
          'HP-ALI,Helicobacter pylori test del aliento,,Aliento,250,true,',
        ),
      ),
    );

    const { rows } = await db.query<{ code: string }>("select code from lab_tests where code like 'HP-%' order by code");
    expect(rows.map((r) => r.code)).toEqual(['HP-AG', 'HP-ALI', 'HP-IGG', 'HP-IGM']);
  });

  it('empareja solo por código: mismo nombre con otro código crea y desactiva', async () => {
    await seed([{ code: 'HEM01', name: 'Hemograma' }]);

    const result = await apply(await prepare(csv('HEM02,Hemograma,,Sangre,45,true,')));

    expect(result).toMatchObject({ created: 1, updated: 0, deactivated: 1, deactivated_codes: ['HEM01'] });
  });

  it('no toca lab_test_aliases', async () => {
    await seed(BASE);
    const hem = await byCode('HEM01');
    const old = await byCode('OLD01');
    await db.query('insert into lab_test_aliases (lab_test_id, alias) values ($1, $2), ($3, $4)', [
      hem.id,
      'hemograma',
      old.id,
      'retirado',
    ]);
    const before = (await snapshot()).aliases;

    await apply(await prepare(MIXED));

    expect((await snapshot()).aliases).toEqual(before);
  });
});

describe('cuatro tarifas', () => {
  /** Fila con tarifas propias: paciente, convenio, médicos, emergencia. */
  function tariffCsv(code: string, name: string, [paciente, convenio, medicos, emergencia]: number[]) {
    return [HEADER, `${code},${name},,Sangre,${paciente},true,,${convenio},${medicos},${emergencia}`].join('\n');
  }

  async function tariffsOf(code: string) {
    const test = await byCode(code);
    return [test.price_bs, test.price_convenio_bs, test.price_medicos_bs, test.price_emergencia_bs].map(Number);
  }

  it('crea el examen una sola vez, con las cuatro tarifas en la misma fila, y las audita', async () => {
    await apply(await prepare(tariffCsv('HEM01', 'Hemograma', [45, 36, 45, 53])));

    expect((await snapshot()).tests).toHaveLength(1);
    expect(await tariffsOf('HEM01')).toEqual([45, 36, 45, 53]);
    const { rows } = await db.query<Json>('select after from lab_catalog_import_changes');
    expect(rows[0].after).toMatchObject({
      price_bs: 45,
      price_convenio_bs: 36,
      price_medicos_bs: 45,
      price_emergencia_bs: 53,
    });
  });

  it('un cambio solo en una tarifa es update, con before y after', async () => {
    await apply(await prepare(tariffCsv('HEM01', 'Hemograma', [45, 36, 45, 53])));

    const prepared = await prepare(tariffCsv('HEM01', 'Hemograma', [45, 36, 45, 60]));
    expect(prepared.plan.update[0].changes).toEqual([{ field: 'priceEmergenciaBs', from: 53, to: 60 }]);
    expect(await apply(prepared)).toMatchObject({ created: 0, updated: 1, unchanged: 0 });

    expect(await tariffsOf('HEM01')).toEqual([45, 36, 45, 60]);
    const { rows } = await db.query<Json>("select before, after from lab_catalog_import_changes where action = 'update'");
    expect(rows[0].before).toMatchObject({ price_emergencia_bs: 53 });
    expect(rows[0].after).toMatchObject({ price_emergencia_bs: 60 });
  });

  it('un examen cargado antes de las tarifas (nulas) se completa con update', async () => {
    await db.query("insert into lab_tests (code, name, sample_type, price_bs) values ('HEM01', 'Hemograma', 'Sangre', 45)");

    const prepared = await prepare(tariffCsv('HEM01', 'Hemograma', [45, 36, 45, 53]));
    expect(prepared.plan.summary).toMatchObject({ create: 0, update: 1, unchanged: 0 });
    await apply(prepared);

    expect(await tariffsOf('HEM01')).toEqual([45, 36, 45, 53]);
  });

  it('la tabla rechaza tarifas en 0 o negativas', async () => {
    for (const column of ['price_convenio_bs', 'price_medicos_bs', 'price_emergencia_bs']) {
      await expect(
        db.query(`insert into lab_tests (code, name, price_bs, ${column}) values ('X1', 'Uno', 10, 0)`),
      ).rejects.toThrow(/check constraint/);
    }
  });
});

describe('idempotencia', () => {
  it('la misma carga dos veces: la segunda no cambia nada ni audita cambios', async () => {
    await seed(BASE);
    await apply(await prepare(MIXED));
    const afterFirst = await snapshot();

    const second = await apply(await prepare(MIXED));

    expect(second).toMatchObject({ created: 0, updated: 0, unchanged: 3, deactivated: 0 });
    const afterSecond = await snapshot();
    expect(afterSecond.tests).toEqual(afterFirst.tests);
    expect(afterSecond.changes).toEqual(afterFirst.changes);
    // La segunda carga queda registrada como carga sin cambios.
    expect(afterSecond.imports).toHaveLength(2);
  });
});

describe('rechazos de filas: nada se escribe', () => {
  const row = (overrides: Json = {}): Json => ({
    code: 'HEM01',
    name: 'Hemograma',
    category: null,
    sample_type: 'Sangre',
    price_bs: '45.00',
    price_convenio_bs: '30.00',
    price_medicos_bs: '40.00',
    price_emergencia_bs: '60.00',
    active: true,
    notes: null,
    status: 'ok',
    ...overrides,
  });

  async function argsFor(rows: unknown, counts: Json = { create: 1, update: 0, unchanged: 0, deactivate: 0 }) {
    return { rows, confirm: [], counts, source: SOURCE, max: 10, allowMass: false };
  }

  beforeEach(async () => {
    await seed([{ code: 'GLU01', name: 'Glucosa' }]);
  });

  it.each([
    ['status needs_review', [row({ status: 'needs_review' })], /^row_not_ok: filas 1/],
    ['status blocked', [row(), row({ code: 'X2', name: 'Dos', status: 'blocked' })], /^row_not_ok: filas 2/],
    ['sin status', [{ ...row(), status: undefined }], /^row_not_ok/],
    ['código vacío', [row({ code: '   ' })], /^missing_code/],
    ['código nulo', [row({ code: null })], /^missing_code/],
    ['nombre vacío', [row({ name: ' -- ' })], /^missing_name/],
    ['precio 0', [row({ price_bs: '0.00' })], /^invalid_price/],
    ['precio negativo', [row({ price_bs: '-5.00' })], /^invalid_price/],
    ['precio como número JSON', [row({ price_bs: 45 })], /^invalid_price/],
    ['precio con coma', [row({ price_bs: '45,50' })], /^invalid_price/],
    ['precio con 3 decimales', [row({ price_bs: '45.505' })], /^invalid_price/],
    ['precio fuera de rango', [row({ price_bs: '100000000.00' })], /^invalid_price/],
    ['tarifa Convenio faltante', [{ ...row(), price_convenio_bs: undefined }], /^invalid_price: filas 1/],
    ['tarifa Médicos en 0', [row({ price_medicos_bs: '0.00' })], /^invalid_price: filas 1/],
    ['tarifa Emergencia con 3 decimales', [row({ price_emergencia_bs: '53.123' })], /^invalid_price: filas 1/],
    ['tarifa como número JSON', [row({ price_convenio_bs: 36 })], /^invalid_price: filas 1/],
    ['active como texto', [row({ active: 'true' })], /^invalid_active/],
    ['fila que no es objeto', [row(), 'HEM02'], /^invalid_input: filas que no son objeto: 2/],
    ['proposedCode enviado', [row({ proposedCode: 'AUTO-12345678' })], /^invalid_input: claves no admitidas: proposedCode/],
    ['category numérica', [row({ category: 5 })], /^invalid_input: campos de texto/],
    ['código duplicado sin distinguir mayúsculas', [row(), row({ code: 'hem01', name: 'Otro' })], /^duplicate_codes: HEM01/],
    ['colisión de nombre', [row(), row({ code: 'HEM02', name: 'HEMOGRAMA' })], /^name_collisions: hemograma/],
  ])('%s', async (_label, rows, error) => {
    await expectRejected(await argsFor(rows), error);
  });

  it('código que difiere solo en mayúsculas del existente', async () => {
    await expectRejected(await argsFor([row({ code: 'glu01', name: 'Glucosa' })]), /^code_case_mismatch: glu01/);
  });

  it('conflictos existentes en lab_tests (sin el índice upper)', async () => {
    await db.exec('drop index lab_tests_code_upper_unique');
    try {
      await seed([{ code: 'glu01', name: 'Glucosa vieja' }]);
      await expectRejected(await argsFor([row()]), /^existing_code_conflicts: GLU01/);
    } finally {
      await db.exec('truncate lab_tests cascade');
      await db.exec('create unique index lab_tests_code_upper_unique on public.lab_tests (upper(code)) where code is not null');
    }
  });
});

describe('parámetros nulos e inválidos: nada se escribe', () => {
  let valid: ApplyArgs;

  beforeEach(async () => {
    await seed(BASE);
    valid = await prepare(MIXED);
  });

  it.each<[string, Partial<ApplyArgs>, RegExp]>([
    ['p_rows null', { rows: null }, /^invalid_input: p_rows no puede ser null/],
    ['p_rows no es arreglo', { rows: { code: 'X' } }, /^invalid_input: p_rows debe ser un arreglo/],
    ['p_rows vacío', { rows: [] }, /^invalid_input: p_rows está vacío/],
    ['confirmación null', { confirm: null }, /^invalid_confirmation: .*no puede ser null/],
    ['confirmación con elemento null', { confirm: ['OLD01', null] }, /^invalid_confirmation: .*nulos o vacíos/],
    ['confirmación con elemento vacío', { confirm: ['OLD01', '  '] }, /^invalid_confirmation: .*nulos o vacíos/],
    ['confirmación con repetidos', { confirm: ['OLD01', ' old01 '] }, /^invalid_confirmation: .*repetidos/],
    ['conteos null', { counts: null }, /^invalid_expected_counts: .*no puede ser null/],
    ['conteos no objeto', { counts: [1, 2] }, /^invalid_expected_counts: debe ser un objeto/],
    ['conteos sin una clave', { counts: { create: 1, update: 1, unchanged: 1 } }, /^invalid_expected_counts: claves/],
    [
      'conteos con clave extra',
      { counts: { create: 1, update: 1, unchanged: 1, deactivate: 1, blocked: 0 } },
      /^invalid_expected_counts: claves/,
    ],
    ['conteo negativo', { counts: { create: -1, update: 1, unchanged: 1, deactivate: 1 } }, /^invalid_expected_counts: los conteos/],
    ['conteo decimal', { counts: { create: 1.5, update: 1, unchanged: 1, deactivate: 1 } }, /^invalid_expected_counts: los conteos/],
    ['conteo como texto', { counts: { create: '1', update: 1, unchanged: 1, deactivate: 1 } }, /^invalid_expected_counts: los conteos/],
    ['source null', { source: null }, /^invalid_source: p_source no puede ser null/],
    ['source no objeto', { source: 'catalogo.csv' }, /^invalid_source: debe ser un objeto/],
    ['source sin csv_sha256', { source: { operator: 'x' } }, /^invalid_source: csv_sha256/],
    ['source con sha inválido', { source: { operator: 'x', csv_sha256: 'abc' } }, /^invalid_source: csv_sha256/],
    ['source sin operator', { source: { csv_sha256: 'b'.repeat(64) } }, /^invalid_source: operator/],
    ['source con operator vacío', { source: { csv_sha256: 'b'.repeat(64), operator: ' ' } }, /^invalid_source: operator/],
    ['source de más de 4 KB', { source: { ...SOURCE, extra: 'x'.repeat(5000) } }, /^invalid_source: supera 4 KB/],
    ['límite null', { max: null }, /^invalid_max_deactivations: no puede ser null/],
    ['límite negativo', { max: -1 }, /^invalid_max_deactivations: no puede ser negativo/],
    ['bandera masiva null', { allowMass: null }, /^invalid_mass_deactivation_flag/],
  ])('%s', async (_label, override, error) => {
    await expectRejected({ ...valid, ...override }, error);
  });

  it('los cuatro parámetros críticos no tienen default: omitirlos es un error de llamada', async () => {
    await expect(
      db.query("select apply_lab_catalog_import('[]'::jsonb, '{}'::text[], '{}'::jsonb)"),
    ).rejects.toThrow(/does not exist/);
  });
});

describe('confirmación de desactivaciones', () => {
  beforeEach(async () => {
    await seed([
      { code: 'HEM01', name: 'Hemograma' },
      { code: 'OLD01', name: 'Retirado uno' },
      { code: 'OLD02', name: 'Retirado dos' },
    ]);
  });

  const TEXT = csv('HEM01,Hemograma,,Sangre,45,true,');

  it('sin confirmar, rechaza', async () => {
    await expectRejected({ ...(await prepare(TEXT)), confirm: [] }, /^deactivation_confirmation_mismatch/);
  });

  it('con la lista exacta, aplica', async () => {
    const result = await apply(await prepare(TEXT));
    expect(result.deactivated_codes).toEqual(['OLD01', 'OLD02']);
  });

  it('acepta otro orden, espacios y minúsculas', async () => {
    const result = await apply({ ...(await prepare(TEXT)), confirm: [' old02', 'Old01 '] });
    expect(result.deactivated).toBe(2);
  });

  it('con un código de menos, rechaza', async () => {
    await expectRejected({ ...(await prepare(TEXT)), confirm: ['OLD01'] }, /^deactivation_confirmation_mismatch/);
  });

  it('con un código de más, rechaza', async () => {
    await expectRejected(
      { ...(await prepare(TEXT)), confirm: ['OLD01', 'OLD02', 'HEM01'] },
      /^deactivation_confirmation_mismatch/,
    );
  });

  it('confirmar desactivaciones cuando el plan no desactiva nada, rechaza', async () => {
    const prepared = await prepare(csv('HEM01,Hemograma,,Sangre,45,true,', 'OLD01,Retirado uno,,Sangre,45,true,', 'OLD02,Retirado dos,,Sangre,45,true,'));
    await expectRejected({ ...prepared, confirm: ['OLD01'] }, /^deactivation_confirmation_mismatch/);
  });
});

describe('protección de desactivaciones masivas', () => {
  const ELEVEN = Array.from({ length: 11 }, (_, i) => ({ code: `OLD${String(i).padStart(2, '0')}`, name: `Retirado ${i}` }));

  beforeEach(async () => {
    await seed([{ code: 'HEM01', name: 'Hemograma' }, ...ELEVEN]);
  });

  const TEXT = csv('HEM01,Hemograma,,Sangre,45,true,');

  it('11 desactivaciones con límite 10 y bandera false: rechaza', async () => {
    await expectRejected(await prepare(TEXT), /^mass_deactivation_requires_override: 11 desactivaciones, límite 10/);
  });

  it('con la bandera en null: rechaza', async () => {
    await expectRejected({ ...(await prepare(TEXT)), allowMass: null }, /^invalid_mass_deactivation_flag/);
  });

  it('con la bandera en true: aplica y lo registra en la auditoría', async () => {
    const result = await apply({ ...(await prepare(TEXT)), allowMass: true });

    expect(result.deactivated).toBe(11);
    const { rows } = await db.query<Json>('select mass_deactivation_override, max_deactivations from lab_catalog_imports');
    expect(rows).toEqual([{ mass_deactivation_override: true, max_deactivations: 10 }]);
  });

  it('el límite es configurable', async () => {
    const result = await apply({ ...(await prepare(TEXT)), max: 11 });
    expect(result.deactivated).toBe(11);
  });

  it('segunda capa: sin la validación de parámetros, «is not true» sigue bloqueando null', async () => {
    const { rows } = await db.query<{ def: string }>(
      "select pg_get_functiondef('public.apply_lab_catalog_import(jsonb, text[], jsonb, jsonb, integer, boolean)'::regprocedure) as def",
    );
    const withoutFirstLayer = rows[0].def
      .replace(/-- \[check:mass_flag\][\s\S]*?-- \[\/check:mass_flag\]/, '')
      .replace('public.apply_lab_catalog_import(', 'public.apply_lab_catalog_import_sin_capa1(');
    expect(withoutFirstLayer).not.toContain('invalid_mass_deactivation_flag');

    await db.exec(withoutFirstLayer);
    try {
      const prepared = await prepare(TEXT);
      const before = await snapshot();
      await expect(
        db.query(
          'select apply_lab_catalog_import_sin_capa1($1::jsonb, $2::text[], $3::jsonb, $4::jsonb, $5::integer, $6::boolean)',
          [
            JSON.stringify(prepared.rows),
            prepared.confirm,
            JSON.stringify(prepared.counts),
            JSON.stringify(SOURCE),
            10,
            null,
          ],
        ),
      ).rejects.toThrow(/^mass_deactivation_requires_override/);
      expect(await snapshot()).toEqual(before);
    } finally {
      await db.exec('drop function public.apply_lab_catalog_import_sin_capa1(jsonb, text[], jsonb, jsonb, integer, boolean)');
    }
  });
});

describe('cambios entre el plan y la carga', () => {
  beforeEach(async () => {
    await seed(BASE);
  });

  it('examen agregado a mano con código que no está en el CSV → confirmación no coincide', async () => {
    const prepared = await prepare(MIXED);
    await seed([{ code: 'NEW99', name: 'Agregado a mano' }]);

    await expectRejected(prepared, /^deactivation_confirmation_mismatch/);
  });

  it('examen desactivado a mano que el plan iba a desactivar → confirmación no coincide', async () => {
    const prepared = await prepare(MIXED);
    await db.query("update lab_tests set active = false where code = 'OLD01'");

    await expectRejected(prepared, /^deactivation_confirmation_mismatch/);
  });

  it('examen editado a mano que estaba unchanged → plan_changed', async () => {
    const prepared = await prepare(MIXED);
    await db.query("update lab_tests set price_bs = 99 where code = 'GLU01'");

    await expectRejected(prepared, /^plan_changed/);
  });

  it('código creado a mano que el CSV iba a crear → plan_changed', async () => {
    const prepared = await prepare(MIXED);
    await seed([{ code: 'CRE01', name: 'Creatinina', price: 30 }]);

    await expectRejected(prepared, /^plan_changed/);
  });

  it('fila borrada a mano → plan_changed', async () => {
    const prepared = await prepare(MIXED);
    await db.query("delete from lab_tests where code = 'GLU01'");

    await expectRejected(prepared, /^plan_changed/);
  });

  it('crear hem01 junto a HEM01 es imposible por el índice upper(code)', async () => {
    await expect(seed([{ code: 'hem01', name: 'Duplicado' }])).rejects.toThrow(/lab_tests_code_upper_unique/);
  });

  it('LÍMITE CONOCIDO: dos cambios que se compensan no se detectan y el CSV sobrescribe', async () => {
    // Plan: HEM01 update, GLU01 unchanged.
    const prepared = await prepare(MIXED);
    // Compensación: HEM01 editado a mano para coincidir con el CSV (update → unchanged)
    // y GLU01 editado a mano (unchanged → update). Los conteos no cambian.
    await db.query("update lab_tests set name = 'Hemograma completo', price_bs = 50 where code = 'HEM01'");
    await db.query("update lab_tests set price_bs = 99 where code = 'GLU01'");

    const result = await apply(prepared);

    expect(result).toMatchObject({ updated: 1, unchanged: 1 });
    expect(Number((await byCode('GLU01')).price_bs)).toBe(20);
    const { rows } = await db.query<Json>("select before from lab_catalog_import_changes where code = 'GLU01'");
    expect(Number((rows[0].before as Json).price_bs)).toBe(99);
  });

  it('no deja advisory locks tomados después de aplicar', async () => {
    await apply(await prepare(MIXED));
    const { rows } = await db.query<{ n: number }>("select count(*)::integer as n from pg_locks where locktype = 'advisory'");
    expect(rows[0].n).toBe(0);
  });
});

describe('rollback real', () => {
  it('un error después de validar revierte inserciones, actualizaciones y auditoría', async () => {
    await seed(BASE);
    // Trigger de prueba: falla al desactivar OLD01, que es la última escritura.
    await db.exec(`
      create function test_fail_on_old01() returns trigger language plpgsql as $$
      begin
        if new.code = 'OLD01' and new.active = false then
          raise exception 'fallo_forzado';
        end if;
        return new;
      end;
      $$;
      create trigger test_fail_on_old01 before update on lab_tests
      for each row execute function test_fail_on_old01();
    `);
    try {
      const prepared = await prepare(MIXED);
      expect(prepared.plan.summary).toMatchObject({ create: 1, update: 1, deactivate: 1 });

      await expectRejected(prepared, /fallo_forzado/);
    } finally {
      await db.exec('drop trigger test_fail_on_old01 on lab_tests; drop function test_fail_on_old01();');
    }
  });
});

describe('auditoría', () => {
  it('una fila por carga y una por cambio, con before y after', async () => {
    await seed(BASE);
    const result = await apply(await prepare(MIXED));

    const { rows: imports } = await db.query<Json>('select * from lab_catalog_imports');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      id: result.import_id,
      source: SOURCE,
      input_rows: 3,
      summary: { create: 1, update: 1, unchanged: 1, deactivate: 1, reactivated: 0, unmanaged: 1 },
      max_deactivations: 10,
      mass_deactivation_override: false,
    });

    const { rows: changes } = await db.query<Json>(
      'select code, action, before, after from lab_catalog_import_changes order by code',
    );
    expect(changes.map((c) => [c.code, c.action])).toEqual([
      ['CRE01', 'create'],
      ['HEM01', 'update'],
      ['OLD01', 'deactivate'],
    ]);
    const [create, update, deactivate] = changes;
    expect(create.before).toBeNull();
    expect(create.after).toMatchObject({ code: 'CRE01', name: 'Creatinina', active: true });
    expect(update.before).toMatchObject({ name: 'Hemograma' });
    expect(update.after).toMatchObject({ name: 'Hemograma completo' });
    expect(deactivate.before).toMatchObject({ active: true });
    expect(deactivate.after).toMatchObject({ active: false });
  });

  it('un examen con historial de cargas no se puede borrar', async () => {
    await apply(await prepare(csv('HEM01,Hemograma,,Sangre,45,true,')));
    await expect(db.query("delete from lab_tests where code = 'HEM01'")).rejects.toThrow(/foreign key/);
  });
});

describe('índice y permisos', () => {
  it('varios exámenes sin código siguen permitidos', async () => {
    await expect(
      seed([
        { code: null, name: 'Sin código uno' },
        { code: null, name: 'Sin código dos' },
      ]),
    ).resolves.toBeUndefined();
  });

  it('solo service_role puede ejecutar la función', async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      select
        has_function_privilege('service_role', 'public.apply_lab_catalog_import(jsonb, text[], jsonb, jsonb, integer, boolean)', 'execute') as service_role,
        has_function_privilege('anon', 'public.apply_lab_catalog_import(jsonb, text[], jsonb, jsonb, integer, boolean)', 'execute') as anon,
        has_function_privilege('authenticated', 'public.apply_lab_catalog_import(jsonb, text[], jsonb, jsonb, integer, boolean)', 'execute') as authenticated
    `);
    expect(rows[0]).toEqual({ service_role: true, anon: false, authenticated: false });
  });

  it('las tablas de auditoría tienen RLS y anon/authenticated no tienen acceso', async () => {
    const { rows } = await db.query<Json>(`
      select c.relname, c.relrowsecurity,
        has_table_privilege('anon', c.oid, 'select') as anon_select,
        has_table_privilege('authenticated', c.oid, 'select') as authenticated_select
      from pg_class c
      where c.relname in ('lab_catalog_imports', 'lab_catalog_import_changes')
      order by c.relname
    `);
    expect(rows).toEqual([
      { relname: 'lab_catalog_import_changes', relrowsecurity: true, anon_select: false, authenticated_select: false },
      { relname: 'lab_catalog_imports', relrowsecurity: true, anon_select: false, authenticated_select: false },
    ]);
  });

  it('funciona ejecutada como service_role con los permisos que Supabase le da', async () => {
    await db.exec(`
      alter role service_role bypassrls;
      grant usage on schema public to service_role;
      grant all on all tables in schema public to service_role;
    `);
    await seed(BASE);
    const prepared = await prepare(MIXED);

    await db.exec('set role service_role');
    try {
      const result = await apply(prepared);
      expect(result).toMatchObject({ created: 1, updated: 1, deactivated: 1 });
    } finally {
      await db.exec('reset role');
    }
  });

  it('la función no contiene ningún delete', async () => {
    const { rows } = await db.query<{ def: string }>(
      "select pg_get_functiondef('public.apply_lab_catalog_import(jsonb, text[], jsonb, jsonb, integer, boolean)'::regprocedure) as def",
    );
    expect(rows[0].def).not.toMatch(/\bdelete\b/i);
  });
});
