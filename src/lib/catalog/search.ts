import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * Búsqueda en el catálogo. Llama a search_lab_catalog y clasifica el
 * resultado sin elegir nunca entre variantes: si hay duda, es ambiguous y
 * se devuelven todos los candidatos. Ver docs/BITACORA.md, «Catálogo: búsqueda».
 */

export const MATCH_TYPES = ['exact_name', 'exact_alias', 'fuzzy_name', 'fuzzy_alias'] as const;
export type MatchType = (typeof MATCH_TYPES)[number];

/** Umbral de similitud del RPC (pg_trgm). Debajo no hay candidato. */
export const FUZZY_MIN_SCORE = 0.35;
/** Un candidato difuso solo es matched si alcanza este puntaje... */
export const FUZZY_CONFIDENT_SCORE = 0.6;
/** ...y supera al segundo por al menos esta diferencia. */
export const CLOSE_SCORE_DELTA = 0.1;

export const DEFAULT_SEARCH_LIMIT = 5;

export interface CatalogCandidate {
  labTestId: string;
  code: string | null;
  name: string;
  category: string | null;
  sampleType: string | null;
  priceBs: number;
  matchType: MatchType;
  matchedText: string;
  similarityScore: number;
}

export type SearchStatus = 'matched' | 'ambiguous' | 'unmatched';

export type SearchReason =
  | 'empty_query'
  | 'no_candidates'
  | 'single_exact'
  | 'multiple_exact'
  | 'truncated'
  | 'fuzzy_clear'
  | 'fuzzy_low_score'
  | 'fuzzy_close_scores';

export interface CatalogSearchResult {
  query: string;
  status: SearchStatus;
  reason: SearchReason;
  /** Solo con status matched: el único candidato elegido. */
  match: CatalogCandidate | null;
  /** Siempre todos los candidatos devueltos, en el orden del RPC. */
  candidates: CatalogCandidate[];
  /** Candidatos que existían antes del límite. */
  totalCandidates: number;
  /** true si el límite dejó candidatos afuera. */
  truncated: boolean;
}

function isExact(candidate: CatalogCandidate): boolean {
  return candidate.matchType === 'exact_name' || candidate.matchType === 'exact_alias';
}

/**
 * Clasificación pura. Nunca crea candidatos: match siempre es uno de los
 * recibidos.
 *   - Sin candidatos: unmatched.
 *   - Límite cortó candidatos: ambiguous (truncated).
 *   - Exactos: 1 → matched; más de 1 → ambiguous.
 *   - Solo difusos: matched si el mejor tiene puntaje >= FUZZY_CONFIDENT_SCORE
 *     y supera al segundo por >= CLOSE_SCORE_DELTA; si no, ambiguous.
 */
export function classifyCandidates(
  query: string,
  candidates: CatalogCandidate[],
  totalCandidates = candidates.length,
): CatalogSearchResult {
  const truncated = totalCandidates > candidates.length;
  const result = (status: SearchStatus, reason: SearchReason, match: CatalogCandidate | null = null) => ({
    query,
    status,
    reason,
    match,
    candidates,
    totalCandidates,
    truncated,
  });

  if (candidates.length === 0) return result('unmatched', 'no_candidates');
  if (truncated) return result('ambiguous', 'truncated');

  const exact = candidates.filter(isExact);
  if (exact.length === 1 && candidates.length === 1) return result('matched', 'single_exact', exact[0]);
  if (exact.length > 0) return result('ambiguous', 'multiple_exact');

  const [best, second] = [...candidates].sort((a, b) => b.similarityScore - a.similarityScore);
  if (best.similarityScore < FUZZY_CONFIDENT_SCORE) return result('ambiguous', 'fuzzy_low_score');
  if (second && best.similarityScore - second.similarityScore < CLOSE_SCORE_DELTA) {
    return result('ambiguous', 'fuzzy_close_scores');
  }
  return result('matched', 'fuzzy_clear', best);
}

interface SearchRow {
  lab_test_id: unknown;
  code: unknown;
  name: unknown;
  category: unknown;
  sample_type: unknown;
  price_bs: unknown;
  match_type: unknown;
  matched_text: unknown;
  similarity_score: unknown;
  total_candidates: unknown;
}

function num(value: unknown): number | null {
  const parsed = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isFinite(parsed) ? parsed : null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/** Fila del RPC → candidato. Una fila con forma inesperada es un error. */
export function mapSearchRow(row: SearchRow): { candidate: CatalogCandidate; totalCandidates: number } {
  const fail = (column: string) => new Error(`search_lab_catalog_row_invalid: ${column}`);

  if (typeof row.lab_test_id !== 'string' || row.lab_test_id === '') throw fail('lab_test_id');
  if (typeof row.name !== 'string') throw fail('name');
  if (!(MATCH_TYPES as readonly unknown[]).includes(row.match_type)) throw fail('match_type');
  if (typeof row.matched_text !== 'string') throw fail('matched_text');

  const price = num(row.price_bs);
  const score = num(row.similarity_score);
  const total = num(row.total_candidates);
  if (price === null) throw fail('price_bs');
  if (score === null) throw fail('similarity_score');
  if (total === null || !Number.isInteger(total)) throw fail('total_candidates');

  return {
    candidate: {
      labTestId: row.lab_test_id,
      code: text(row.code),
      name: row.name,
      category: text(row.category),
      sampleType: text(row.sample_type),
      priceBs: price,
      matchType: row.match_type as MatchType,
      matchedText: row.matched_text,
      similarityScore: score,
    },
    totalCandidates: total,
  };
}

export async function searchLabCatalog(
  supabase: SupabaseClient,
  query: string,
  options: { limit?: number } = {},
): Promise<CatalogSearchResult> {
  if (query.trim() === '') {
    return {
      query,
      status: 'unmatched',
      reason: 'empty_query',
      match: null,
      candidates: [],
      totalCandidates: 0,
      truncated: false,
    };
  }

  const { data, error } = await supabase.rpc('search_lab_catalog', {
    p_query: query,
    p_limit: options.limit ?? DEFAULT_SEARCH_LIMIT,
  });

  if (error) throw new Error(`search_lab_catalog: ${error.message}`);
  if (!Array.isArray(data)) throw new Error('search_lab_catalog: no_data');

  const rows = (data as SearchRow[]).map(mapSearchRow);
  const candidates = rows.map((row) => row.candidate);
  // Todas las filas traen el mismo total (count over ()).
  const totalCandidates = rows.length > 0 ? rows[0].totalCandidates : 0;

  return classifyCandidates(query, candidates, Math.max(totalCandidates, candidates.length));
}
