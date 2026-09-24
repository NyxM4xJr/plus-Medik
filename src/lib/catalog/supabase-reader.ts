import type { SupabaseClient } from '@supabase/supabase-js';
import type { ExistingLabTest, LabTestReader } from '@/lib/catalog/import';

/**
 * Lector de lab_tests en Supabase. Solo lectura: no existe ningún método de
 * escritura. Debe recibir un cliente creado con service_role en servidor.
 */

export const LAB_TEST_COLUMNS = 'id,code,name,category,sample_type,price_bs,active,notes';

/** Filas por página. PostgREST corta en 1000 por defecto. */
export const LAB_TEST_PAGE_SIZE = 1000;

interface LabTestRow {
  id: unknown;
  code: unknown;
  name: unknown;
  category: unknown;
  sample_type: unknown;
  price_bs: unknown;
  active: unknown;
  notes: unknown;
}

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * snake_case de Supabase → ExistingLabTest. price_bs es numeric: puede llegar
 * como número o como texto. Una fila con forma inesperada es un error, no se
 * adivina. El error solo nombra el id y la columna, nunca valores.
 */
export function mapLabTestRow(row: LabTestRow): ExistingLabTest {
  const id = row.id;
  if (typeof id !== 'string' || id === '') throw new Error('lab_tests_row_invalid: id');

  const fail = (column: string) => new Error(`lab_tests_row_invalid: ${column} (id ${id})`);

  if (typeof row.name !== 'string') throw fail('name');
  if (typeof row.active !== 'boolean') throw fail('active');

  const price = typeof row.price_bs === 'string' ? Number(row.price_bs) : row.price_bs;
  if (typeof price !== 'number' || !Number.isFinite(price)) throw fail('price_bs');

  return {
    id,
    code: nullableText(row.code),
    name: row.name,
    category: nullableText(row.category),
    sampleType: nullableText(row.sample_type),
    priceBs: price,
    active: row.active,
    notes: nullableText(row.notes),
  };
}

export function createSupabaseLabTestReader(
  supabase: SupabaseClient,
  pageSize = LAB_TEST_PAGE_SIZE,
): LabTestReader {
  return {
    async list() {
      const tests: ExistingLabTest[] = [];

      for (let from = 0; ; from += pageSize) {
        const { data, error } = await supabase
          .from('lab_tests')
          .select(LAB_TEST_COLUMNS)
          .order('id', { ascending: true })
          .range(from, from + pageSize - 1);

        if (error) throw new Error(`lab_tests.select: ${error.message}`);
        if (!Array.isArray(data)) throw new Error('lab_tests.select: no_data');

        tests.push(...(data as LabTestRow[]).map(mapLabTestRow));
        if (data.length < pageSize) return tests;
      }
    },
  };
}
