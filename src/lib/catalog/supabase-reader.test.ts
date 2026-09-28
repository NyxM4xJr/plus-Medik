import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { LAB_TEST_COLUMNS, createSupabaseLabTestReader, mapLabTestRow } from './supabase-reader';

type Row = Record<string, unknown>;

interface Query {
  table: string;
  columns?: string;
  order?: [string, unknown];
  range?: [number, number];
}

/**
 * Cliente falso de solo lectura: from().select().order().range().
 * No tiene insert/update/upsert/delete: cualquier intento de escritura falla.
 */
function fakeClient(rows: Row[], options: { error?: string; data?: unknown } = {}) {
  const queries: Query[] = [];
  const client = {
    from(table: string) {
      const query: Query = { table };
      queries.push(query);
      const builder = {
        select(columns: string) {
          query.columns = columns;
          return builder;
        },
        order(column: string, opts: unknown) {
          query.order = [column, opts];
          return builder;
        },
        async range(from: number, to: number) {
          query.range = [from, to];
          if (options.error) return { data: null, error: { message: options.error } };
          if ('data' in options) return { data: options.data, error: null };
          return { data: rows.slice(from, to + 1), error: null };
        },
      };
      return builder;
    },
  } as unknown as SupabaseClient;

  return { client, queries };
}

function dbRow(id: string, overrides: Row = {}): Row {
  return {
    id,
    code: `C-${id}`,
    name: `Examen ${id}`,
    category: 'Bioquímica',
    sample_type: 'Sangre',
    price_bs: 45,
    price_convenio_bs: 30,
    price_medicos_bs: 40,
    price_emergencia_bs: 60,
    active: true,
    notes: null,
    ...overrides,
  };
}

describe('mapLabTestRow', () => {
  it('mapea snake_case a ExistingLabTest', () => {
    expect(mapLabTestRow(dbRow('1', { sample_type: 'Orina', notes: 'En ayunas' }) as never)).toEqual({
      id: '1',
      code: 'C-1',
      name: 'Examen 1',
      category: 'Bioquímica',
      sampleType: 'Orina',
      priceBs: 45,
      priceConvenioBs: 30,
      priceMedicosBs: 40,
      priceEmergenciaBs: 60,
      active: true,
      notes: 'En ayunas',
    });
  });

  it('acepta price_bs numeric como texto', () => {
    expect(mapLabTestRow(dbRow('1', { price_bs: '120.50' }) as never).priceBs).toBe(120.5);
  });

  it('lee las otras tres tarifas como texto numeric y acepta null en exámenes anteriores', () => {
    expect(
      mapLabTestRow(
        dbRow('1', { price_convenio_bs: '36.00', price_medicos_bs: null, price_emergencia_bs: '52.94' }) as never,
      ),
    ).toMatchObject({ priceConvenioBs: 36, priceMedicosBs: null, priceEmergenciaBs: 52.94 });
  });

  it('convierte nulos a null y conserva code null (unmanaged)', () => {
    const mapped = mapLabTestRow(dbRow('1', { code: null, category: null, sample_type: null }) as never);
    expect(mapped).toMatchObject({ code: null, category: null, sampleType: null });
  });

  it.each([
    ['id', { id: null }, 'lab_tests_row_invalid: id'],
    ['name', { name: null }, 'lab_tests_row_invalid: name (id 1)'],
    ['active', { active: 'true' }, 'lab_tests_row_invalid: active (id 1)'],
    ['price_bs no numérico', { price_bs: 'abc' }, 'lab_tests_row_invalid: price_bs (id 1)'],
    ['price_bs nulo', { price_bs: null }, 'lab_tests_row_invalid: price_bs (id 1)'],
    ['tarifa no numérica', { price_medicos_bs: 'abc' }, 'lab_tests_row_invalid: price_medicos_bs (id 1)'],
    ['tarifa ausente del select', { price_convenio_bs: undefined }, 'lab_tests_row_invalid: price_convenio_bs (id 1)'],
  ])('falla con una fila de forma inesperada: %s', (_label, overrides, message) => {
    expect(() => mapLabTestRow(dbRow('1', overrides) as never)).toThrow(message);
  });

  it('el error no incluye valores de la fila', () => {
    expect(() => mapLabTestRow(dbRow('1', { name: 42, notes: 'dato sensible' }) as never)).toThrow(
      /^lab_tests_row_invalid: name \(id 1\)$/,
    );
  });
});

describe('createSupabaseLabTestReader', () => {
  it('lee solo las columnas necesarias de lab_tests, ordenadas por id', async () => {
    const db = fakeClient([dbRow('1'), dbRow('2')]);

    const tests = await createSupabaseLabTestReader(db.client).list();

    expect(tests.map((t) => t.id)).toEqual(['1', '2']);
    expect(db.queries).toEqual([
      {
        table: 'lab_tests',
        columns: LAB_TEST_COLUMNS,
        order: ['id', { ascending: true }],
        range: [0, 999],
      },
    ]);
    expect(LAB_TEST_COLUMNS).not.toContain('*');
  });

  it('pagina hasta traer todas las filas', async () => {
    const rows = Array.from({ length: 7 }, (_, i) => dbRow(String(i).padStart(2, '0')));
    const db = fakeClient(rows);

    const tests = await createSupabaseLabTestReader(db.client, 3).list();

    expect(tests).toHaveLength(7);
    expect(db.queries.map((q) => q.range)).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ]);
  });

  it('una página exacta hace una consulta extra y termina con la página vacía', async () => {
    const db = fakeClient([dbRow('1'), dbRow('2'), dbRow('3')]);

    const tests = await createSupabaseLabTestReader(db.client, 3).list();

    expect(tests).toHaveLength(3);
    expect(db.queries).toHaveLength(2);
  });

  it('un catálogo vacío devuelve una lista vacía', async () => {
    await expect(createSupabaseLabTestReader(fakeClient([]).client).list()).resolves.toEqual([]);
  });

  it('falla claramente si Supabase devuelve error', async () => {
    const db = fakeClient([], { error: 'permission denied for table lab_tests' });

    await expect(createSupabaseLabTestReader(db.client).list()).rejects.toThrow(
      'lab_tests.select: permission denied for table lab_tests',
    );
  });

  it('falla si Supabase no devuelve datos', async () => {
    const db = fakeClient([], { data: null });
    await expect(createSupabaseLabTestReader(db.client).list()).rejects.toThrow('lab_tests.select: no_data');
  });

  it('solo expone list: no tiene métodos de escritura', () => {
    const reader = createSupabaseLabTestReader(fakeClient([]).client);
    expect(Object.keys(reader)).toEqual(['list']);
  });
});
