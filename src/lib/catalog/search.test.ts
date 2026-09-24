import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import {
  CLOSE_SCORE_DELTA,
  FUZZY_CONFIDENT_SCORE,
  classifyCandidates,
  mapSearchRow,
  searchLabCatalog,
  type CatalogCandidate,
  type MatchType,
} from './search';

function candidate(id: string, matchType: MatchType, score: number): CatalogCandidate {
  return {
    labTestId: id,
    code: `C-${id}`,
    name: `Examen ${id}`,
    category: null,
    sampleType: null,
    priceBs: 45,
    matchType,
    matchedText: `texto ${id}`,
    similarityScore: score,
  };
}

function row(id: string, overrides: Record<string, unknown> = {}) {
  return {
    lab_test_id: id,
    code: `C-${id}`,
    name: `Examen ${id}`,
    category: null,
    sample_type: 'Sangre',
    price_bs: '45.00',
    match_type: 'exact_alias',
    matched_text: 'alias',
    similarity_score: 1,
    total_candidates: 1,
    ...overrides,
  };
}

function fakeRpc(response: { data?: unknown; error?: { message: string } | null }) {
  const calls: Array<{ fn: string; args: unknown }> = [];
  const client = {
    rpc: async (fn: string, args: unknown) => {
      calls.push({ fn, args });
      return { data: response.data ?? null, error: response.error ?? null };
    },
  } as unknown as SupabaseClient;
  return { client, calls };
}

describe('classifyCandidates', () => {
  it('matched: un único candidato exacto', () => {
    const only = candidate('a', 'exact_name', 1);
    const result = classifyCandidates('hemograma', [only]);

    expect(result).toMatchObject({ status: 'matched', reason: 'single_exact', match: only, truncated: false });
  });

  it('ambiguous: varios candidatos exactos, sin elegir ninguno', () => {
    const candidates = [candidate('a', 'exact_alias', 1), candidate('b', 'exact_alias', 1)];
    const result = classifyCandidates('helicobacter', candidates);

    expect(result).toMatchObject({ status: 'ambiguous', reason: 'multiple_exact', match: null });
  });

  it('unmatched: sin candidatos', () => {
    expect(classifyCandidates('radiografía', [])).toMatchObject({
      status: 'unmatched',
      reason: 'no_candidates',
      match: null,
      candidates: [],
    });
  });

  it('ambiguous si el límite dejó candidatos afuera, aunque llegue uno solo', () => {
    const result = classifyCandidates('helicobacter', [candidate('a', 'exact_alias', 1)], 4);
    expect(result).toMatchObject({ status: 'ambiguous', reason: 'truncated', truncated: true, totalCandidates: 4 });
  });

  it('preserva candidatos, puntajes y match_type tal como llegan', () => {
    const candidates = [
      candidate('a', 'fuzzy_name', 0.52),
      candidate('b', 'fuzzy_alias', 0.48),
      candidate('c', 'fuzzy_name', 0.36),
    ];
    const result = classifyCandidates('hemogrma', candidates);

    expect(result.candidates).toBe(candidates);
    expect(result.candidates.map((c) => [c.labTestId, c.matchType, c.similarityScore])).toEqual([
      ['a', 'fuzzy_name', 0.52],
      ['b', 'fuzzy_alias', 0.48],
      ['c', 'fuzzy_name', 0.36],
    ]);
  });

  describe('candidatos difusos', () => {
    it('matched si el mejor es confiable y se separa del segundo', () => {
      const best = candidate('a', 'fuzzy_name', FUZZY_CONFIDENT_SCORE + 0.2);
      const result = classifyCandidates('q', [best, candidate('b', 'fuzzy_name', best.similarityScore - CLOSE_SCORE_DELTA - 0.05)]);

      expect(result).toMatchObject({ status: 'matched', reason: 'fuzzy_clear', match: best });
    });

    it('matched con un único candidato difuso confiable', () => {
      const result = classifyCandidates('q', [candidate('a', 'fuzzy_alias', 0.75)]);
      expect(result).toMatchObject({ status: 'matched', reason: 'fuzzy_clear' });
    });

    it('ambiguous si el mejor tiene puntaje bajo, aunque sea el único', () => {
      const result = classifyCandidates('q', [candidate('a', 'fuzzy_name', FUZZY_CONFIDENT_SCORE - 0.01)]);
      expect(result).toMatchObject({ status: 'ambiguous', reason: 'fuzzy_low_score', match: null });
    });

    it('ambiguous si los dos mejores puntajes están cerca', () => {
      const result = classifyCandidates('q', [
        candidate('a', 'fuzzy_name', 0.8),
        candidate('b', 'fuzzy_name', 0.8 - CLOSE_SCORE_DELTA + 0.01),
      ]);
      expect(result).toMatchObject({ status: 'ambiguous', reason: 'fuzzy_close_scores' });
    });

    it('ordena por puntaje antes de decidir, sin depender del orden recibido', () => {
      const best = candidate('b', 'fuzzy_name', 0.9);
      const result = classifyCandidates('q', [candidate('a', 'fuzzy_name', 0.5), best]);
      expect(result.match).toBe(best);
    });
  });

  it('nunca inventa candidatos: match siempre es uno de los recibidos', () => {
    const sets: CatalogCandidate[][] = [
      [candidate('a', 'exact_name', 1)],
      [candidate('a', 'fuzzy_name', 0.9), candidate('b', 'fuzzy_name', 0.4)],
      [candidate('a', 'fuzzy_alias', 0.7)],
    ];
    for (const candidates of sets) {
      const { match } = classifyCandidates('q', candidates);
      expect(match === null || candidates.includes(match)).toBe(true);
    }
  });
});

describe('mapSearchRow', () => {
  it('mapea la fila y acepta price_bs numeric como texto', () => {
    expect(mapSearchRow(row('a', { similarity_score: 0.42, match_type: 'fuzzy_name', total_candidates: 3 }))).toEqual({
      candidate: {
        labTestId: 'a',
        code: 'C-a',
        name: 'Examen a',
        category: null,
        sampleType: 'Sangre',
        priceBs: 45,
        matchType: 'fuzzy_name',
        matchedText: 'alias',
        similarityScore: 0.42,
      },
      totalCandidates: 3,
    });
  });

  it.each([
    ['lab_test_id', { lab_test_id: null }],
    ['name', { name: 3 }],
    ['match_type', { match_type: 'parecido' }],
    ['matched_text', { matched_text: null }],
    ['price_bs', { price_bs: 'abc' }],
    ['similarity_score', { similarity_score: null }],
    ['total_candidates', { total_candidates: 1.5 }],
  ])('falla con una fila inválida: %s', (column, overrides) => {
    expect(() => mapSearchRow(row('a', overrides))).toThrow(`search_lab_catalog_row_invalid: ${column}`);
  });
});

describe('searchLabCatalog', () => {
  it('llama al RPC con la consulta y el límite', async () => {
    const rpc = fakeRpc({ data: [row('a')] });

    const result = await searchLabCatalog(rpc.client, 'hemograma', { limit: 8 });

    expect(rpc.calls).toEqual([{ fn: 'search_lab_catalog', args: { p_query: 'hemograma', p_limit: 8 } }]);
    expect(result).toMatchObject({ status: 'matched', match: { labTestId: 'a' } });
  });

  it('usa el total del RPC para detectar truncamiento', async () => {
    const rpc = fakeRpc({ data: [row('a', { total_candidates: 4 }), row('b', { total_candidates: 4 })] });

    const result = await searchLabCatalog(rpc.client, 'helicobacter', { limit: 2 });

    expect(result).toMatchObject({ status: 'ambiguous', reason: 'truncated', totalCandidates: 4 });
  });

  it('una consulta vacía es unmatched y no llama al RPC', async () => {
    const rpc = fakeRpc({ data: [] });

    await expect(searchLabCatalog(rpc.client, '   ')).resolves.toMatchObject({
      status: 'unmatched',
      reason: 'empty_query',
    });
    expect(rpc.calls).toEqual([]);
  });

  it('falla claramente si el RPC devuelve error', async () => {
    const rpc = fakeRpc({ error: { message: 'permission denied' } });
    await expect(searchLabCatalog(rpc.client, 'hemograma')).rejects.toThrow('search_lab_catalog: permission denied');
  });

  it('falla si el RPC no devuelve datos', async () => {
    const rpc = fakeRpc({ data: null });
    await expect(searchLabCatalog(rpc.client, 'hemograma')).rejects.toThrow('search_lab_catalog: no_data');
  });
});
