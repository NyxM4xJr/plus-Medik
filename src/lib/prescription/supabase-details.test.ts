import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { createSupabaseLabTestDetails, LAB_TEST_DETAIL_COLUMNS, mapDetailRow } from './supabase-details';

const ROW = {
  id: 'a',
  code: '380',
  name: 'GLUCOSA',
  sample_type: 'Suero',
  price_bs: '20.00',
  notes: 'Preparacion: Se requiere ayuno de 8 a 12 horas.',
};

describe('mapDetailRow', () => {
  it('mapea la fila y acepta price_bs numeric como texto', () => {
    expect(mapDetailRow(ROW)).toEqual({
      id: 'a',
      code: '380',
      name: 'GLUCOSA',
      sampleType: 'Suero',
      priceBs: 20,
      notes: 'Preparacion: Se requiere ayuno de 8 a 12 horas.',
    });
  });

  it.each([
    ['id', { id: null }, 'lab_test_details_row_invalid: id'],
    ['name', { name: 5 }, 'lab_test_details_row_invalid: name (id a)'],
    ['price_bs', { price_bs: 'abc' }, 'lab_test_details_row_invalid: price_bs (id a)'],
  ])('falla con %s inválido, sin mostrar valores', (_label, overrides, message) => {
    expect(() => mapDetailRow({ ...ROW, ...overrides })).toThrow(message);
  });
});

describe('createSupabaseLabTestDetails', () => {
  function fakeClient(data: unknown[]) {
    const calls: Array<[string, ...unknown[]]> = [];
    const builder = {
      select(columns: string) {
        calls.push(['select', columns]);
        return builder;
      },
      in(column: string, values: unknown[]) {
        calls.push(['in', column, values]);
        return builder;
      },
      async eq(column: string, value: unknown) {
        calls.push(['eq', column, value]);
        return { data, error: null };
      },
    };
    const client = {
      from(table: string) {
        calls.push(['from', table]);
        return builder;
      },
    } as unknown as SupabaseClient;
    return { client, calls };
  }

  it('lee solo exámenes activos, sin ids repetidos', async () => {
    const db = fakeClient([ROW]);
    const details = await createSupabaseLabTestDetails(db.client)(['a', 'a', 'b']);

    expect(details.map((d) => d.id)).toEqual(['a']);
    expect(db.calls).toEqual([
      ['from', 'lab_tests'],
      ['select', LAB_TEST_DETAIL_COLUMNS],
      ['in', 'id', ['a', 'b']],
      ['eq', 'active', true],
    ]);
  });

  it('sin ids no consulta', async () => {
    const db = fakeClient([]);
    expect(await createSupabaseLabTestDetails(db.client)([])).toEqual([]);
    expect(db.calls).toEqual([]);
  });
});

describe('modo observer', () => {
  it('ninguna ruta de la app lee recetas con el modelo ni usa el comando de análisis', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(join(process.cwd(), 'src', 'app'));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      expect(readFileSync(file, 'utf8')).not.toMatch(/prescription|@anthropic-ai\/sdk|from 'openai'/);
    }
  });
});
