import type { SupabaseClient } from '@supabase/supabase-js';
import type { CatalogOption, LabTestDetails } from '@/lib/prescription/analyze';

/**
 * Detalles de lab_tests para cotizar. Solo lectura y solo exámenes activos.
 * El error nombra el id y la columna, nunca valores.
 */

export const LAB_TEST_DETAIL_COLUMNS = 'id,code,name,sample_type,price_bs,notes';

interface DetailRow {
  id: unknown;
  code: unknown;
  name: unknown;
  sample_type: unknown;
  price_bs: unknown;
  notes: unknown;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function mapDetailRow(row: DetailRow): LabTestDetails {
  if (typeof row.id !== 'string' || row.id === '') throw new Error('lab_test_details_row_invalid: id');
  const fail = (column: string) => new Error(`lab_test_details_row_invalid: ${column} (id ${row.id})`);
  if (typeof row.name !== 'string') throw fail('name');

  const price = typeof row.price_bs === 'string' ? Number(row.price_bs) : row.price_bs;
  if (typeof price !== 'number' || !Number.isFinite(price)) throw fail('price_bs');

  return {
    id: row.id,
    code: text(row.code),
    name: row.name,
    sampleType: text(row.sample_type),
    priceBs: price,
    notes: text(row.notes),
  };
}

export function createSupabaseLabTestDetails(supabase: SupabaseClient) {
  return async (ids: string[]): Promise<LabTestDetails[]> => {
    if (ids.length === 0) return [];
    const { data, error } = await supabase
      .from('lab_tests')
      .select(LAB_TEST_DETAIL_COLUMNS)
      .in('id', [...new Set(ids)])
      .eq('active', true);
    if (error) throw new Error(`lab_tests.select: ${error.message}`);
    if (!Array.isArray(data)) throw new Error('lab_tests.select: no_data');
    return (data as DetailRow[]).map(mapDetailRow);
  };
}

/** Filas por página: PostgREST corta en 1000. */
const CATALOG_PAGE_SIZE = 1000;

/**
 * Todos los exámenes activos (id, código, nombre, Precio Paciente), para
 * identificar por contenido. Se lee una vez por análisis. Solo lectura.
 */
export function createSupabaseCatalogOptions(supabase: SupabaseClient, pageSize = CATALOG_PAGE_SIZE) {
  let cached: Promise<CatalogOption[]> | null = null;

  async function load(): Promise<CatalogOption[]> {
    const options: CatalogOption[] = [];
    for (let from = 0; ; from += pageSize) {
      const { data, error } = await supabase
        .from('lab_tests')
        .select('id,code,name,price_bs')
        .eq('active', true)
        .order('id', { ascending: true })
        .range(from, from + pageSize - 1);
      if (error) throw new Error(`lab_tests.select: ${error.message}`);
      if (!Array.isArray(data)) throw new Error('lab_tests.select: no_data');
      for (const row of data as DetailRow[]) {
        const test = mapDetailRow({ ...row, sample_type: null, notes: null });
        options.push({ labTestId: test.id, code: test.code, name: test.name, priceBs: test.priceBs });
      }
      if (data.length < pageSize) return options;
    }
  }

  return () => {
    cached ??= load();
    return cached;
  };
}
