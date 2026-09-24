import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@/test/pglite';
import { normalizeLabText } from './normalize';

const SAMPLES = [
  'Hemograma Completo',
  'Ácido Úrico',
  'ÁCIDO ÚRICO',
  'acido  urico.',
  'Helicobacter pylori IgG',
  'H. pylori (Ag. en heces)',
  'PCR-ultrasensible',
  'Niño / Ñandú',
  'Pingüino ÜÑ',
  'Vitamina B12 (cianocobalamina)',
  'T3/T4 libre',
  'Café à la crème ç',
  '  ---  ',
  '',
  'Glucosa\tpost-prandial\n2h',
];

let db: PGlite;

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('normalizeLabText', () => {
  it.each(SAMPLES)('coincide con public.normalize_lab_text para %j', async (sample) => {
    const { rows } = await db.query<{ normalized: string }>(
      'select public.normalize_lab_text($1) as normalized',
      [sample],
    );

    expect(normalizeLabText(sample)).toBe(rows[0].normalized);
  });

  it('trata null como cadena vacía, igual que coalesce en SQL', async () => {
    const { rows } = await db.query<{ normalized: string }>('select public.normalize_lab_text(null) as normalized');
    expect(normalizeLabText(null)).toBe(rows[0].normalized);
  });
});
