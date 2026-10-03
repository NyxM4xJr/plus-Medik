import { createHash } from 'node:crypto';
import type { SupabaseClient } from '@supabase/supabase-js';

export interface CatalogFingerprintTest {
  id: string;
  code: string | null;
  name: string;
  category: string | null;
  sample_type: string | null;
  price_bs: number | null;
  active: boolean;
  notes: string | null;
}

export interface CatalogFingerprintAlias {
  lab_test_id: string;
  alias: string;
}

const PAGE_SIZE = 1000;
const compareText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

function nullableText(value: unknown, field: string): string | null {
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`catalog_fingerprint_invalid: ${field}`);
  return value;
}

function numericPrice(value: unknown): number {
  const parsed = typeof value === 'string' ? Number(value) : value;
  if (typeof parsed !== 'number' || !Number.isFinite(parsed)) {
    throw new Error('catalog_fingerprint_invalid: price_bs');
  }
  return parsed;
}

async function loadRows<T>(loadPage: (from: number, to: number) => Promise<T[]>): Promise<T[]> {
  const rows: T[] = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await loadPage(from, from + PAGE_SIZE - 1);
    rows.push(...page);
    if (page.length < PAGE_SIZE) return rows;
  }
}

export function hashCatalogFingerprint(
  tests: readonly CatalogFingerprintTest[],
  aliases: readonly CatalogFingerprintAlias[],
): string {
  const activeTests = tests
    .map((test) => ({
      id: test.id,
      code: test.code,
      name: test.name,
      category: test.category,
      sample_type: test.sample_type,
      price_bs: test.price_bs,
      active: test.active,
      notes: test.notes,
    }))
    .filter((test) => test.active)
    .sort((a, b) => compareText(a.id, b.id));
  const activeIds = new Set(activeTests.map((test) => test.id));
  const activeAliases = aliases
    .filter((alias) => activeIds.has(alias.lab_test_id))
    .map((alias) => ({ lab_test_id: alias.lab_test_id, alias: alias.alias }))
    .sort((a, b) => compareText(a.lab_test_id, b.lab_test_id) || compareText(a.alias, b.alias));
  const serialized = JSON.stringify({ tests: activeTests, aliases: activeAliases });
  return createHash('sha256').update(serialized, 'utf8').digest('hex');
}

export function createSupabaseCatalogFingerprint(supabase: SupabaseClient): () => Promise<string> {
  return async () => {
    const tests = await loadRows(async (from, to) => {
      const { data, error } = await supabase
        .from('lab_tests')
        .select('id,code,name,category,sample_type,price_bs,active,notes')
        .eq('active', true)
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw new Error(`catalog_fingerprint.lab_tests: ${error.message}`);
      if (!Array.isArray(data)) throw new Error('catalog_fingerprint.lab_tests: no_data');
      return data.map((row) => {
        const value = row as Record<string, unknown>;
        if (typeof value.id !== 'string' || typeof value.name !== 'string' || value.active !== true) {
          throw new Error('catalog_fingerprint_invalid: lab_tests');
        }
        return {
          id: value.id,
          code: nullableText(value.code, 'code'),
          name: value.name,
          category: nullableText(value.category, 'category'),
          sample_type: nullableText(value.sample_type, 'sample_type'),
          price_bs: numericPrice(value.price_bs),
          active: value.active,
          notes: nullableText(value.notes, 'notes'),
        };
      });
    });
    const aliases = await loadRows(async (from, to) => {
      const { data, error } = await supabase
        .from('lab_test_aliases')
        .select('lab_test_id,alias')
        .order('lab_test_id', { ascending: true })
        .order('alias', { ascending: true })
        .range(from, to);
      if (error) throw new Error(`catalog_fingerprint.lab_test_aliases: ${error.message}`);
      if (!Array.isArray(data)) throw new Error('catalog_fingerprint.lab_test_aliases: no_data');
      return data.map((row) => {
        const value = row as Record<string, unknown>;
        if (typeof value.lab_test_id !== 'string' || typeof value.alias !== 'string') {
          throw new Error('catalog_fingerprint_invalid: lab_test_aliases');
        }
        return { lab_test_id: value.lab_test_id, alias: value.alias };
      });
    });
    return hashCatalogFingerprint(tests, aliases);
  };
}

export function createSupabaseCatalogCodes(supabase: SupabaseClient): () => Promise<ReadonlySet<string>> {
  return async () => {
    const codes = await loadRows(async (from, to) => {
      const { data, error } = await supabase
        .from('lab_tests')
        .select('code')
        .not('code', 'is', null)
        .order('code', { ascending: true })
        .range(from, to);
      if (error) throw new Error(`catalog_codes.select: ${error.message}`);
      if (!Array.isArray(data)) throw new Error('catalog_codes.select: no_data');
      return data.map((row) => {
        const value = (row as Record<string, unknown>).code;
        if (typeof value !== 'string') throw new Error('catalog_codes_invalid: code');
        return value;
      });
    });
    return new Set(codes);
  };
}
