import type { PGlite } from '@electric-sql/pglite';
import type { SupabaseClient } from '@supabase/supabase-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@/test/pglite';
import { searchLabCatalog } from './search';

/**
 * Catálogo inventado. Nada de esto es la lista real de PlusMedik.
 */
const TESTS: Array<{ code: string; name: string; price: number; active?: boolean; aliases?: string[] }> = [
  { code: 'HP-AG', name: 'Helicobacter pylori antígeno en heces', price: 120, aliases: ['helicobacter', 'H. pylori'] },
  {
    code: 'HP-IGG',
    name: 'Helicobacter pylori IgG',
    price: 90,
    aliases: ['helicobacter', 'H. pylori', 'helicobacter igg'],
  },
  { code: 'HP-IGM', name: 'Helicobacter pylori IgM', price: 90, aliases: ['helicobacter', 'H. pylori'] },
  { code: 'HP-ALI', name: 'Helicobacter pylori test del aliento', price: 250, aliases: ['helicobacter', 'H. pylori'] },
  { code: 'HEM01', name: 'Hemograma completo', price: 45, aliases: ['hemograma', 'Hemograma Completo'] },
  { code: 'AU01', name: 'Ácido Úrico', price: 35 },
  { code: 'GLU-S', name: 'Glucosa', price: 20 },
  { code: 'GLU-O', name: 'GLUCOSA', price: 25 },
  { code: 'PL01', name: 'Perfil lipídico', price: 80 },
  { code: 'COL01', name: 'Colesterol total', price: 30, aliases: ['perfil lipidico'] },
  { code: 'OLD01', name: 'Examen retirado', price: 10, active: false, aliases: ['retirado'] },
  ...Array.from({ length: 25 }, (_, i) => ({
    code: `PAN${String(i).padStart(2, '0')}`,
    name: `Panel de prueba ${String(i).padStart(2, '0')}`,
    price: 10,
    aliases: ['panel masivo'],
  })),
];

interface Row {
  lab_test_id: string;
  code: string;
  name: string;
  match_type: string;
  matched_text: string;
  similarity_score: number;
  total_candidates: number;
}

let db: PGlite;
const idByCode = new Map<string, string>();

async function search(query: string | null, limit?: number): Promise<Row[]> {
  const { rows } = await db.query<Row>(
    limit === undefined
      ? 'select * from search_lab_catalog($1)'
      : 'select * from search_lab_catalog($1, $2)',
    limit === undefined ? [query] : [query, limit],
  );
  return rows;
}

const codes = (rows: Row[]) => rows.map((row) => row.code).sort();

/** Cliente que envía el RPC a PGlite: prueba el módulo TypeScript contra el SQL real. */
function pgliteClient(): SupabaseClient {
  return {
    rpc: async (fn: string, args: { p_query: string; p_limit: number }) => {
      if (fn !== 'search_lab_catalog') throw new Error(`rpc inesperado: ${fn}`);
      const { rows } = await db.query('select * from search_lab_catalog($1, $2)', [args.p_query, args.p_limit]);
      return { data: rows, error: null };
    },
  } as unknown as SupabaseClient;
}

beforeAll(async () => {
  db = await createTestDatabase();

  for (const test of TESTS) {
    const { rows } = await db.query<{ id: string }>(
      'insert into lab_tests (code, name, price_bs, active) values ($1, $2, $3, $4) returning id',
      [test.code, test.name, test.price, test.active ?? true],
    );
    idByCode.set(test.code, rows[0].id);
    for (const alias of test.aliases ?? []) {
      await db.query('insert into lab_test_aliases (lab_test_id, alias) values ($1, $2)', [rows[0].id, alias]);
    }
  }
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('search_lab_catalog (SQL)', () => {
  it('alias genérico: "helicobacter" devuelve todas las variantes', async () => {
    const rows = await search('helicobacter', 10);

    expect(codes(rows)).toEqual(['HP-AG', 'HP-ALI', 'HP-IGG', 'HP-IGM']);
    expect(rows.every((row) => row.match_type === 'exact_alias' && row.similarity_score === 1)).toBe(true);
    expect(rows.every((row) => row.total_candidates === 4)).toBe(true);
  });

  it('mayúsculas y tildes no cambian el resultado', async () => {
    expect(codes(await search('HELICOBÁCTER', 10))).toEqual(['HP-AG', 'HP-ALI', 'HP-IGG', 'HP-IGM']);
    expect(codes(await search('h pylori', 10))).toEqual(['HP-AG', 'HP-ALI', 'HP-IGG', 'HP-IGM']);
  });

  it('alias específico: "helicobacter igg" devuelve solo IgG', async () => {
    const rows = await search('helicobacter igg');

    expect(codes(rows)).toEqual(['HP-IGG']);
    expect(rows[0]).toMatchObject({ match_type: 'exact_alias', matched_text: 'helicobacter igg', total_candidates: 1 });
  });

  it('nombre exacto de una variante devuelve solo esa variante', async () => {
    const rows = await search('helicobacter pylori IGG');
    expect(rows.map((row) => [row.code, row.match_type])).toEqual([['HP-IGG', 'exact_name']]);
  });

  it('"hemograma" apunta a un único examen', async () => {
    const rows = await search('hemograma');
    expect(rows.map((row) => [row.code, row.match_type])).toEqual([['HEM01', 'exact_alias']]);
  });

  it('cada examen aparece una sola vez aunque coincida por nombre y por alias', async () => {
    const rows = await search('hemograma completo');
    expect(rows.map((row) => [row.code, row.match_type])).toEqual([['HEM01', 'exact_name']]);
  });

  it('tildes en el nombre: "ACIDO URICO" encuentra "Ácido Úrico"', async () => {
    const rows = await search('ACIDO URICO');
    expect(rows.map((row) => [row.code, row.matched_text])).toEqual([['AU01', 'Ácido Úrico']]);
  });

  it('nombres normalizados iguales devuelven ambos, sin fusionarlos', async () => {
    const rows = await search('glucosa');

    expect(codes(rows)).toEqual(['GLU-O', 'GLU-S']);
    expect(new Set(rows.map((row) => row.lab_test_id)).size).toBe(2);
    expect(rows.every((row) => row.match_type === 'exact_name')).toBe(true);
  });

  it('un nombre exacto no oculta los alias exactos de otros exámenes', async () => {
    const rows = await search('perfil lipidico');

    expect(rows.map((row) => [row.code, row.match_type]).sort()).toEqual([
      ['COL01', 'exact_alias'],
      ['PL01', 'exact_name'],
    ]);
  });

  it('una consulta sin coincidencias no devuelve nada', async () => {
    expect(await search('radiografía de tórax')).toEqual([]);
    expect(await search('')).toEqual([]);
    expect(await search('   ')).toEqual([]);
    expect(await search(null)).toEqual([]);
  });

  it('los exámenes inactivos no aparecen', async () => {
    expect(await search('retirado')).toEqual([]);
    expect(await search('examen retirado')).toEqual([]);
  });

  it('la búsqueda difusa solo aparece cuando no hay exactos', async () => {
    const fuzzy = await search('hemogrma completo');
    expect(fuzzy[0]).toMatchObject({ code: 'HEM01', match_type: expect.stringMatching(/^fuzzy_/) });
    expect(fuzzy[0].similarity_score).toBeGreaterThanOrEqual(0.35);
    expect(fuzzy[0].similarity_score).toBeLessThan(1);

    const exact = await search('helicobacter');
    expect(exact.some((row) => row.match_type.startsWith('fuzzy_'))).toBe(false);
  });

  it('respeta p_limit e informa el total antes del límite', async () => {
    const rows = await search('helicobacter', 2);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.total_candidates === 4)).toBe(true);
    expect(await search('helicobacter')).toHaveLength(4);
  });

  it('p_limit se acota entre 1 y 20', async () => {
    expect(await search('helicobacter', 0)).toHaveLength(1);
    const many = await search('panel masivo', 100);
    expect(many).toHaveLength(20);
    expect(many[0].total_candidates).toBe(25);
  });

  it('el orden es estable entre ejecuciones', async () => {
    const first = await search('panel masivo', 20);
    const second = await search('panel masivo', 20);
    expect(second.map((row) => row.code)).toEqual(first.map((row) => row.code));
  });

  it('no mezcla datos entre consultas, ni en paralelo', async () => {
    const [hp, hem, glu, none] = await Promise.all([
      search('helicobacter', 10),
      search('hemograma'),
      search('glucosa'),
      search('radiografia'),
    ]);

    expect(codes(hp)).toEqual(['HP-AG', 'HP-ALI', 'HP-IGG', 'HP-IGM']);
    expect(codes(hem)).toEqual(['HEM01']);
    expect(codes(glu)).toEqual(['GLU-O', 'GLU-S']);
    expect(none).toEqual([]);
  });

  it('mantiene los permisos: solo service_role puede ejecutarla', async () => {
    const { rows } = await db.query<Record<string, boolean>>(`
      select
        has_function_privilege('service_role', 'public.search_lab_catalog(text, integer)', 'execute') as service_role,
        has_function_privilege('anon', 'public.search_lab_catalog(text, integer)', 'execute') as anon,
        has_function_privilege('authenticated', 'public.search_lab_catalog(text, integer)', 'execute') as authenticated
    `);

    expect(rows[0]).toEqual({ service_role: true, anon: false, authenticated: false });
  });

  it('queda una sola versión de la función', async () => {
    const { rows } = await db.query<{ n: number }>(
      "select count(*)::integer as n from pg_proc where proname = 'search_lab_catalog'",
    );
    expect(rows[0].n).toBe(1);
  });
});

describe('searchLabCatalog contra el SQL real (PGlite)', () => {
  it('"helicobacter" → ambiguous con todas las variantes', async () => {
    const result = await searchLabCatalog(pgliteClient(), 'helicobacter', { limit: 10 });

    expect(result).toMatchObject({ status: 'ambiguous', reason: 'multiple_exact', match: null, totalCandidates: 4 });
    expect(result.candidates.map((c) => c.code).sort()).toEqual(['HP-AG', 'HP-ALI', 'HP-IGG', 'HP-IGM']);
  });

  it('"helicobacter" con límite corto → ambiguous y truncated', async () => {
    const result = await searchLabCatalog(pgliteClient(), 'helicobacter', { limit: 2 });

    expect(result).toMatchObject({ status: 'ambiguous', reason: 'truncated', truncated: true, totalCandidates: 4 });
    expect(result.candidates).toHaveLength(2);
  });

  it('"helicobacter igg" → matched con solo IgG', async () => {
    const result = await searchLabCatalog(pgliteClient(), 'helicobacter igg');

    expect(result).toMatchObject({ status: 'matched', reason: 'single_exact' });
    expect(result.match).toMatchObject({
      labTestId: idByCode.get('HP-IGG'),
      code: 'HP-IGG',
      matchType: 'exact_alias',
      similarityScore: 1,
      priceBs: 90,
    });
    expect(result.candidates).toHaveLength(1);
  });

  it('"hemograma" → matched', async () => {
    const result = await searchLabCatalog(pgliteClient(), 'hemograma');
    expect(result).toMatchObject({ status: 'matched', match: { code: 'HEM01', labTestId: idByCode.get('HEM01') } });
  });

  it('nombres normalizados iguales → ambiguous con ambos candidatos', async () => {
    const result = await searchLabCatalog(pgliteClient(), 'Glucosa');

    expect(result.status).toBe('ambiguous');
    expect(result.candidates.map((c) => c.labTestId).sort()).toEqual(
      [idByCode.get('GLU-O'), idByCode.get('GLU-S')].sort(),
    );
  });

  it('consulta sin relación → unmatched', async () => {
    const result = await searchLabCatalog(pgliteClient(), 'radiografía de tórax');
    expect(result).toMatchObject({ status: 'unmatched', reason: 'no_candidates', candidates: [], match: null });
  });

  it('todo lab_test_id devuelto existe en lab_tests', async () => {
    const known = new Set(idByCode.values());
    for (const query of ['helicobacter', 'hemograma', 'glucosa', 'hemogrma completo', 'perfil lipidico']) {
      const result = await searchLabCatalog(pgliteClient(), query, { limit: 20 });
      for (const candidate of result.candidates) expect(known.has(candidate.labTestId)).toBe(true);
    }
  });
});
