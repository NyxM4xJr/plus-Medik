import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@/test/pglite';
import {
  DEFAULT_MAX_DEACTIVATIONS,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_REFUSED,
  runCatalogApplyCommand,
  sha256Hex,
  type ApplyOptions,
  type CatalogApplyRpc,
} from './apply-command';
import type { LabTestReader } from './import';
import { LAB_TEST_COLUMNS, mapLabTestRow } from './supabase-reader';
import { CATALOG_COLUMNS } from './validate';
import { DEFAULT_TARIFFS, withTariffs } from '@/test/catalog-fixtures';

/**
 * catalog:apply de punta a punta contra apply_lab_catalog_import en PGlite,
 * con catálogos inventados. Comprueba que lo que arma el comando es lo que la
 * función acepta. Nada de esto se conecta a Supabase.
 */

const HEADER = CATALOG_COLUMNS.join(',');
const TARGET = 'pglite';
const INSERT_LAB_TEST =
  'insert into lab_tests (code, name, sample_type, price_bs, price_convenio_bs, price_medicos_bs, ' +
  'price_emergencia_bs, active) values ($1, $2, $3, $4, $5, $6, $7, $8)';

let db: PGlite;

type Json = Record<string, unknown>;

function csv(...rows: string[]): string {
  return [HEADER, ...rows.map(withTariffs)].join('\n');
}

const reader: LabTestReader = {
  async list() {
    const { rows } = await db.query<Json>(
      `select ${LAB_TEST_COLUMNS} from lab_tests order by id`,
    );
    return rows.map((row) => mapLabTestRow(row as never));
  },
};

/** El RPC como lo expone supabase-js, pero sobre PGlite. `before` simula a otro escribiendo justo antes. */
function pgliteRpc(before?: () => Promise<void>) {
  let calls = 0;
  const rpc: CatalogApplyRpc = async (args) => {
    calls += 1;
    await before?.();
    try {
      const { rows } = await db.query<{ result: unknown }>(
        'select apply_lab_catalog_import($1::jsonb, $2::text[], $3::jsonb, $4::jsonb, $5::integer, $6::boolean) as result',
        [
          JSON.stringify(args.p_rows),
          args.p_confirm_deactivate_codes,
          JSON.stringify(args.p_expected_counts),
          JSON.stringify(args.p_source),
          args.p_max_deactivations,
          args.p_allow_mass_deactivation,
        ],
      );
      return { data: rows[0].result, error: null };
    } catch (error) {
      const e = error as { message: string; code?: string };
      return { data: null, error: { message: e.message, code: e.code ?? 'P0001' } };
    }
  };
  return { rpc, calls: () => calls };
}

async function run(text: string, options: Partial<ApplyOptions>, rpc = pgliteRpc()) {
  const output: string[] = [];
  const code = await runCatalogApplyCommand({
    options: {
      csvPath: 'catalogo.csv',
      apply: false,
      operator: null,
      confirmDeactivations: null,
      allowMassDeactivation: false,
      ...options,
    },
    maxDeactivations: DEFAULT_MAX_DEACTIVATIONS,
    readFile: async () => new TextEncoder().encode(text),
    reader,
    rpc: rpc.rpc,
    confirm: async () => `aplicar ${TARGET}`,
    target: TARGET,
    write: (line) => output.push(line),
  });
  return { code, text: output.join('\n'), calls: rpc.calls() };
}

async function seed(tests: Array<{ code: string | null; name: string; price?: number; active?: boolean }>) {
  for (const t of tests) {
    await db.query(INSERT_LAB_TEST, [
      t.code,
      t.name,
      'Sangre',
      t.price ?? 45,
      DEFAULT_TARIFFS.priceConvenioBs,
      DEFAULT_TARIFFS.priceMedicosBs,
      DEFAULT_TARIFFS.priceEmergenciaBs,
      t.active ?? true,
    ]);
  }
}

async function snapshot() {
  const tests = await db.query('select * from lab_tests order by id');
  const imports = await db.query('select * from lab_catalog_imports order by id');
  const changes = await db.query('select * from lab_catalog_import_changes order by id');
  return { tests: tests.rows, imports: imports.rows, changes: changes.rows };
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
  await seed([
    { code: 'HEM01', name: 'Hemograma' },
    { code: 'OLD01', name: 'Examen retirado' },
    { code: null, name: 'Cargado a mano' },
  ]);
});

const CATALOG = csv('HEM01,Hemograma,,Sangre,50,true,', 'CRE01,Creatinina,Química,Sangre,30.5,true,Ayuno');

describe('catalog:apply contra apply_lab_catalog_import (PGlite)', () => {
  it('dry-run no escribe nada', async () => {
    const before = await snapshot();
    const { code, calls } = await run(CATALOG, { confirmDeactivations: ['OLD01'] });

    expect(code).toBe(EXIT_OK);
    expect(calls).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('aplica el plan mostrado y deja la auditoría con hash, operador y archivo', async () => {
    const { code, text, calls } = await run(CATALOG, {
      apply: true,
      operator: 'Ana',
      csvPath: 'C:\\datos\\catalogo.csv',
      confirmDeactivations: ['old01'],
    });

    expect(code).toBe(EXIT_OK);
    expect(calls).toBe(1);
    expect(text).toMatch(/creados 1, actualizados 1 \(reactivados 0\), sin cambios 0, desactivados 1, sin código 1/);

    expect(await byCode('HEM01')).toMatchObject({ price_bs: '50.00', active: true });
    expect(await byCode('CRE01')).toMatchObject({
      name: 'Creatinina',
      category: 'Química',
      price_bs: '30.50',
      notes: 'Ayuno',
      active: true,
    });
    expect(await byCode('OLD01')).toMatchObject({ active: false });

    const { rows: imports } = await db.query<Json>('select source, summary, input_rows from lab_catalog_imports');
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      source: {
        csv_sha256: sha256Hex(new TextEncoder().encode(CATALOG)),
        operator: 'Ana',
        filename: 'catalogo.csv',
        tool: 'catalog:apply',
      },
      summary: { create: 1, update: 1, unchanged: 0, deactivate: 1, reactivated: 0, unmanaged: 1 },
      input_rows: 2,
    });

    const { rows: changes } = await db.query<Json>('select code, action from lab_catalog_import_changes order by code');
    expect(changes).toEqual([
      { code: 'CRE01', action: 'create' },
      { code: 'HEM01', action: 'update' },
      { code: 'OLD01', action: 'deactivate' },
    ]);
  });

  it('una segunda ejecución con el mismo archivo no llama a la base', async () => {
    const options = { apply: true, operator: 'Ana', confirmDeactivations: ['OLD01'] };
    expect((await run(CATALOG, options)).code).toBe(EXIT_OK);
    const after = await snapshot();

    const second = await run(CATALOG, { apply: true, operator: 'Ana' });
    expect(second.code).toBe(EXIT_OK);
    expect(second.text).toContain('Nada que aplicar');
    expect(second.calls).toBe(0);
    expect(await snapshot()).toEqual(after);
  });

  it('si lab_tests cambia justo antes del RPC, la función rechaza con plan_changed y no escribe', async () => {
    const rpc = pgliteRpc(async () => {
      await db.query("update lab_tests set price_bs = 50 where code = 'HEM01'");
    });
    const { code, text, calls } = await run(
      CATALOG,
      { apply: true, operator: 'Ana', confirmDeactivations: ['OLD01'] },
      rpc,
    );

    expect(code).toBe(EXIT_FAILED);
    expect(calls).toBe(1);
    expect(text).toContain('La base rechazó la carga');
    expect(text).toContain('plan_changed');
    const { rows } = await db.query('select * from lab_catalog_imports');
    expect(rows).toHaveLength(0);
    expect(await byCode('CRE01')).toBeUndefined();
    expect(await byCode('OLD01')).toMatchObject({ active: true });
  });

  it('si aparece una desactivación nueva justo antes del RPC, la función la rechaza', async () => {
    const rpc = pgliteRpc(async () => {
      await seed([{ code: 'NEW01', name: 'Agregado a mano' }]);
    });
    const { code, text } = await run(CATALOG, { apply: true, operator: 'Ana', confirmDeactivations: ['OLD01'] }, rpc);

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('deactivation_confirmation_mismatch');
    expect(await byCode('OLD01')).toMatchObject({ active: true });
    expect(await byCode('NEW01')).toMatchObject({ active: true });
  });

  it('una fila en revisión no llega a la función', async () => {
    const before = await snapshot();
    const { code, calls } = await run(csv('HEM01,Hemograma,,Sangre,50,true,', ',Urea,,Sangre,25,true,'), {
      apply: true,
      operator: 'Ana',
      confirmDeactivations: ['OLD01'],
    });

    expect(code).toBe(EXIT_REFUSED);
    expect(calls).toBe(0);
    expect(await snapshot()).toEqual(before);
  });
});
