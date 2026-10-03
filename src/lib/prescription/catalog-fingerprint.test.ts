import { describe, expect, it } from 'vitest';
import { hashCatalogFingerprint } from './catalog-fingerprint';

const TEST = {
  id: 'test-1',
  code: '100',
  name: 'HEMOGRAMA',
  category: 'Hematología',
  sample_type: 'Sangre',
  price_bs: 50,
  active: true,
  notes: 'Ayuno',
};

describe('hashCatalogFingerprint', () => {
  it('es estable ante cambios de orden y alias inactivos', () => {
    const first = hashCatalogFingerprint([TEST], [{ lab_test_id: 'test-1', alias: 'HC' }]);
    const reordered = hashCatalogFingerprint(
      [{ ...TEST, id: 'inactive', active: false }, TEST],
      [
        { lab_test_id: 'inactive', alias: 'ignorar' },
        { lab_test_id: 'test-1', alias: 'HC' },
      ],
    );
    expect(first).toBe(reordered);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ['name', { ...TEST, name: 'HEMOGRAMA COMPLETO' }],
    ['sample_type', { ...TEST, sample_type: 'Plasma' }],
    ['price_bs', { ...TEST, price_bs: 55 }],
    ['notes', { ...TEST, notes: 'Sin ayuno' }],
  ])('cambia si cambia %s', (_field, updated) => {
    expect(hashCatalogFingerprint([TEST], [])).not.toBe(hashCatalogFingerprint([updated], []));
  });

  it('cambia cuando cambia un alias activo', () => {
    expect(hashCatalogFingerprint([TEST], [{ lab_test_id: 'test-1', alias: 'HC' }])).not.toBe(
      hashCatalogFingerprint([TEST], [{ lab_test_id: 'test-1', alias: 'hemograma' }]),
    );
  });
});
