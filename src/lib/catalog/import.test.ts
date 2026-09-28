import { describe, expect, it } from 'vitest';
import { createMemoryLabTests } from '@/test/memory-lab-tests';
import {
  CatalogImportRefusedError,
  planCatalogImport,
  runCatalogImport,
  type ExistingLabTest,
} from './import';
import { CATALOG_COLUMNS, validateCatalogCsv } from './validate';
import { DEFAULT_TARIFFS, withTariffs } from '@/test/catalog-fixtures';

const HEADER = CATALOG_COLUMNS.join(',');

function report(...rows: string[]) {
  return validateCatalogCsv([HEADER, ...rows.map(withTariffs)].join('\n'));
}

function existing(overrides: Partial<ExistingLabTest> & Pick<ExistingLabTest, 'id' | 'code' | 'name'>): ExistingLabTest {
  return {
    category: null,
    sampleType: null,
    priceBs: 45,
    ...DEFAULT_TARIFFS,
    active: true,
    notes: null,
    ...overrides,
  };
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(deepFreeze);
    Object.freeze(value);
  }
  return value;
}

const HEMOGRAMA = existing({ id: 'db-hem', code: 'HEM01', name: 'Hemograma', sampleType: 'Sangre', priceBs: 45 });
const GLUCOSA = existing({ id: 'db-glu', code: 'GLU01', name: 'Glucosa', sampleType: 'Sangre', priceBs: 20 });

describe('planCatalogImport: clasificación', () => {
  it('create: código válido que no existe', () => {
    const plan = planCatalogImport(report('HEM01,Hemograma,Hematología,Sangre,45,true,'), []);

    expect(plan.create).toEqual([
      {
        line: 2,
        values: {
          code: 'HEM01',
          name: 'Hemograma',
          category: 'Hematología',
          sampleType: 'Sangre',
          priceBs: 45,
          ...DEFAULT_TARIFFS,
          active: true,
          notes: null,
        },
      },
    ]);
    expect(plan.canApply).toBe(true);
  });

  it('update: código existente con cambios, y el patch solo lleva lo que cambió', () => {
    const plan = planCatalogImport(report('HEM01,Hemograma completo,,Sangre,50,true,En ayunas'), [HEMOGRAMA]);

    expect(plan.update).toHaveLength(1);
    expect(plan.update[0]).toMatchObject({ id: 'db-hem', code: 'HEM01', line: 2 });
    expect(plan.update[0].changes).toEqual([
      { field: 'name', from: 'Hemograma', to: 'Hemograma completo' },
      { field: 'priceBs', from: 45, to: 50 },
      { field: 'notes', from: null, to: 'En ayunas' },
    ]);
    expect(plan.update[0].patch).toEqual({ name: 'Hemograma completo', priceBs: 50, notes: 'En ayunas' });
  });

  it('update: un cambio solo en una tarifa actualiza solo esa tarifa', () => {
    const plan = planCatalogImport(
      validateCatalogCsv([HEADER, 'HEM01,Hemograma,,Sangre,45,true,,30,40,65.5'].join('\n')),
      [HEMOGRAMA],
    );

    expect(plan.update[0].changes).toEqual([{ field: 'priceEmergenciaBs', from: 60, to: 65.5 }]);
    expect(plan.update[0].patch).toEqual({ priceEmergenciaBs: 65.5 });
  });

  it('update: un examen cargado antes de las tarifas (nulas) las recibe del archivo', () => {
    const legacy = { ...HEMOGRAMA, priceConvenioBs: null, priceMedicosBs: null, priceEmergenciaBs: null };
    const plan = planCatalogImport(report('HEM01,Hemograma,,Sangre,45,true,'), [legacy]);

    expect(plan.update[0].patch).toEqual(DEFAULT_TARIFFS);
    expect(plan.unchanged).toEqual([]);
  });

  it('unchanged: mismo contenido; 45 y 45.00 son el mismo precio', () => {
    const plan = planCatalogImport(report('HEM01,Hemograma,,Sangre,45.00,true,'), [HEMOGRAMA]);

    expect(plan.unchanged).toEqual([{ line: 2, id: 'db-hem', code: 'HEM01' }]);
    expect(plan.update).toEqual([]);
  });

  it('deactivate: un examen activo que ya no aparece en el archivo', () => {
    const plan = planCatalogImport(report('HEM01,Hemograma,,Sangre,45,true,'), [HEMOGRAMA, GLUCOSA]);

    expect(plan.deactivate).toEqual([{ id: 'db-glu', code: 'GLU01', name: 'Glucosa' }]);
  });

  it('un examen ausente que ya estaba inactivo no se vuelve a desactivar', () => {
    const plan = planCatalogImport(report('HEM01,Hemograma,,Sangre,45,true,'), [
      HEMOGRAMA,
      { ...GLUCOSA, active: false },
    ]);

    expect(plan.deactivate).toEqual([]);
  });

  it('reactiva un examen inactivo que vuelve al archivo como activo', () => {
    const plan = planCatalogImport(report('HEM01,Hemograma,,Sangre,45,true,'), [{ ...HEMOGRAMA, active: false }]);

    expect(plan.update[0].patch).toEqual({ active: true });
  });

  it('blocked: filas con errores y filas pendientes de revisión', () => {
    const plan = planCatalogImport(
      report('HEM01,Hemograma,,Sangre,0,true,', ',Glucosa,,Sangre,20,true,', 'CRE01,Creatinina,,Sangre,30,true,'),
      [],
    );

    expect(plan.blocked.map((b) => [b.line, b.reason])).toEqual([
      [2, 'row_blocked'],
      [3, 'row_needs_review'],
    ]);
    expect(plan.create.map((c) => c.values.code)).toEqual(['CRE01']);
    expect(plan.canApply).toBe(false);
  });
});

describe('planCatalogImport: reglas', () => {
  it('una fila con proposedCode queda bloqueada y la propuesta nunca se usa como código', () => {
    const validation = report(',Glucosa,,Sangre,20,true,');
    const proposed = validation.rows[0].proposedCode;
    const plan = planCatalogImport(validation, []);

    expect(proposed).toMatch(/^AUTO-/);
    expect(plan.blocked).toEqual([
      expect.objectContaining({ line: 2, code: null, proposedCode: proposed, reason: 'row_needs_review' }),
    ]);
    expect(plan.create).toEqual([]);
    expect(JSON.stringify(plan.create)).not.toContain(proposed);
  });

  it('precio vacío, cero o inválido nunca se importa', () => {
    const plan = planCatalogImport(
      report('A1,Uno,,,,true,', 'A2,Dos,,,0,true,', 'A3,Tres,,,abc,true,', 'A4,Cuatro,,,-5,true,'),
      [],
    );

    expect(plan.create).toEqual([]);
    expect(plan.blocked.map((b) => b.code)).toEqual(['A1', 'A2', 'A3', 'A4']);
  });

  it('nunca empareja por nombre: mismo nombre con otro código crea uno y desactiva el otro', () => {
    const plan = planCatalogImport(report('HEM02,Hemograma,,Sangre,45,true,'), [HEMOGRAMA]);

    expect(plan.create.map((c) => c.values.code)).toEqual(['HEM02']);
    expect(plan.deactivate.map((d) => d.code)).toEqual(['HEM01']);
    expect(plan.update).toEqual([]);
  });

  it('variantes con nombres parecidos quedan como filas separadas', () => {
    const plan = planCatalogImport(
      report(
        'HP-AG,Helicobacter pylori antígeno en heces,,Heces,120,true,',
        'HP-IGG,Helicobacter pylori IgG,,Sangre,90,true,',
        'HP-IGM,Helicobacter pylori IgM,,Sangre,90,true,',
      ),
      [existing({ id: 'db-hp', code: 'HP-IGG', name: 'Helicobacter pylori IgG', sampleType: 'Sangre', priceBs: 90 })],
    );

    expect(plan.create.map((c) => c.values.code)).toEqual(['HP-AG', 'HP-IGM']);
    expect(plan.unchanged.map((u) => u.code)).toEqual(['HP-IGG']);
    expect(plan.canApply).toBe(true);
  });

  it('nombres que normalizan igual bloquean ambas filas: nada se fusiona ni se crea', () => {
    const plan = planCatalogImport(report('GLU-S,Glucosa,,Sangre,20,true,', 'GLU-O,GLUCOSA,,Orina,25,true,'), []);

    expect(plan.create).toEqual([]);
    expect(plan.blocked.map((b) => [b.code, b.reason])).toEqual([
      ['GLU-S', 'row_needs_review'],
      ['GLU-O', 'row_needs_review'],
    ]);
  });

  it('no desactiva un examen cuyo código aparece en una fila bloqueada', () => {
    const plan = planCatalogImport(report('GLU01,Glucosa,,Sangre,0,true,', 'HEM01,Hemograma,,Sangre,45,true,'), [
      HEMOGRAMA,
      GLUCOSA,
    ]);

    expect(plan.deactivate).toEqual([]);
    expect(plan.blocked.map((b) => b.code)).toEqual(['GLU01']);
  });

  it('un archivo con errores de formato no produce ninguna acción ni desactivaciones', () => {
    const broken = validateCatalogCsv('code,name\nHEM01,Hemograma');
    const plan = planCatalogImport(broken, [HEMOGRAMA, GLUCOSA]);

    expect(plan.summary).toEqual({
      create: 0,
      update: 0,
      unchanged: 0,
      deactivate: 0,
      blocked: 0,
      unmanaged: 0,
      conflicts: 0,
    });
    expect(plan.canApply).toBe(false);
    expect(plan.notApplicableReasons).toContain('el archivo tiene errores de formato');
  });

  it('bloquea un código que difiere solo en mayúsculas del existente', () => {
    const plan = planCatalogImport(report('hem01,Hemograma,,Sangre,45,true,'), [HEMOGRAMA]);

    expect(plan.blocked[0]).toMatchObject({ reason: 'code_case_mismatch', code: 'hem01' });
    expect(plan.deactivate).toEqual([]);
  });

  it('bloquea si en lab_tests hay dos códigos que solo difieren en mayúsculas', () => {
    const plan = planCatalogImport(report('HEM01,Hemograma,,Sangre,45,true,'), [
      HEMOGRAMA,
      existing({ id: 'db-hem-lower', code: 'hem01', name: 'Hemograma viejo' }),
    ]);

    expect(plan.blocked[0]).toMatchObject({ reason: 'ambiguous_existing_code' });
    expect(plan.update).toEqual([]);
  });

  describe('códigos repetidos en lab_tests sin distinguir mayúsculas', () => {
    const HEM_LOWER = existing({ id: 'db-hem-lower', code: 'hem01', name: 'Hemograma viejo' });

    it('bloquean el plan aunque el código no aparezca en el CSV, y no se desactivan', () => {
      const plan = planCatalogImport(report('GLU01,Glucosa,,Sangre,20,true,'), [HEMOGRAMA, HEM_LOWER, GLUCOSA]);

      expect(plan.conflicts).toEqual([
        {
          kind: 'duplicate_existing_code',
          code: 'HEM01',
          rows: [
            { id: 'db-hem', code: 'HEM01', name: 'Hemograma' },
            { id: 'db-hem-lower', code: 'hem01', name: 'Hemograma viejo' },
          ],
        },
      ]);
      expect(plan.deactivate).toEqual([]);
      expect(plan.unchanged.map((u) => u.code)).toEqual(['GLU01']);
      expect(plan.canApply).toBe(false);
      expect(plan.notApplicableReasons.join(' ')).toContain('HEM01');
      expect(plan.summary.conflicts).toBe(1);
    });

    it('otros exámenes ausentes sí se siguen proponiendo para desactivar en el plan', () => {
      const plan = planCatalogImport(report('HEM02,Hemograma nuevo,,Sangre,45,true,'), [
        HEMOGRAMA,
        HEM_LOWER,
        GLUCOSA,
      ]);

      expect(plan.deactivate.map((d) => d.code)).toEqual(['GLU01']);
      expect(plan.canApply).toBe(false);
    });

    it('se informan aunque el archivo esté roto', () => {
      const plan = planCatalogImport(validateCatalogCsv('code,name\nX,Y'), [HEMOGRAMA, HEM_LOWER]);

      expect(plan.conflicts).toHaveLength(1);
      expect(plan.deactivate).toEqual([]);
    });

    it('apply se rechaza y ambas filas quedan intactas', async () => {
      const db = createMemoryLabTests([HEMOGRAMA, HEM_LOWER, GLUCOSA]);
      const before = db.snapshot();

      await expect(
        runCatalogImport(report('GLU01,Glucosa,,Sangre,25,true,'), db.repository, { mode: 'apply' }),
      ).rejects.toBeInstanceOf(CatalogImportRefusedError);
      expect(db.operations).toEqual([]);
      expect(db.snapshot()).toEqual(before);
    });
  });

  it('lab_tests sin código quedan como unmanaged y nunca se desactivan', () => {
    const plan = planCatalogImport(report('HEM01,Hemograma,,Sangre,45,true,'), [
      HEMOGRAMA,
      existing({ id: 'db-manual', code: null, name: 'Examen cargado a mano' }),
    ]);

    expect(plan.unmanaged).toEqual([{ id: 'db-manual', name: 'Examen cargado a mano' }]);
    expect(plan.deactivate).toEqual([]);
  });

  it('no modifica el reporte ni la colección recibida', () => {
    const validation = deepFreeze(report('HEM01,Hemograma,,Sangre,50,true,', ',Glucosa,,,20,true,'));
    const current = deepFreeze([HEMOGRAMA, GLUCOSA].map((row) => ({ ...row })));

    expect(() => planCatalogImport(validation, current)).not.toThrow();
  });
});

describe('runCatalogImport', () => {
  const CSV_OK = report('HEM01,Hemograma completo,,Sangre,50,true,', 'CRE01,Creatinina,,Sangre,30,true,');

  it('por defecto es dry-run y no escribe nada', async () => {
    const db = createMemoryLabTests([HEMOGRAMA, GLUCOSA]);
    const before = db.snapshot();

    const result = await runCatalogImport(CSV_OK, db.repository);

    expect(result.mode).toBe('dry-run');
    expect(result.applied).toBe(false);
    expect(result.plan.summary).toMatchObject({ create: 1, update: 1, deactivate: 1 });
    expect(db.operations).toEqual([]);
    expect(db.snapshot()).toEqual(before);
  });

  it('dry-run explícito tampoco escribe, aunque el plan tenga acciones', async () => {
    const db = createMemoryLabTests([HEMOGRAMA, GLUCOSA]);
    await runCatalogImport(CSV_OK, db.repository, { mode: 'dry-run' });
    expect(db.operations).toEqual([]);
  });

  it('apply se rechaza si hay filas bloqueadas o en revisión, sin escribir nada', async () => {
    const db = createMemoryLabTests([HEMOGRAMA]);
    const dirty = report('HEM01,Hemograma,,Sangre,50,true,', ',Glucosa,,Sangre,20,true,');

    await expect(runCatalogImport(dirty, db.repository, { mode: 'apply' })).rejects.toBeInstanceOf(
      CatalogImportRefusedError,
    );
    expect(db.operations).toEqual([]);
  });

  it('apply ejecuta create, update y desactivación, sin borrar', async () => {
    const db = createMemoryLabTests([HEMOGRAMA, GLUCOSA]);

    const result = await runCatalogImport(CSV_OK, db.repository, { mode: 'apply' });

    expect(result.applied).toBe(true);
    expect(db.operations.map((op) => op.op)).toEqual(['insert', 'update', 'update']);
    const after = db.snapshot();
    expect(after).toHaveLength(3);
    expect(after.find((r) => r.code === 'HEM01')).toMatchObject({ name: 'Hemograma completo', priceBs: 50 });
    expect(after.find((r) => r.code === 'GLU01')).toMatchObject({ active: false });
    expect(after.find((r) => r.code === 'CRE01')).toMatchObject({ active: true, priceBs: 30 });
  });

  it('es idempotente: la segunda importación no cambia nada', async () => {
    const db = createMemoryLabTests([HEMOGRAMA, GLUCOSA]);
    await runCatalogImport(CSV_OK, db.repository, { mode: 'apply' });
    const writes = db.operations.length;

    const second = await runCatalogImport(CSV_OK, db.repository, { mode: 'apply' });

    expect(second.plan.summary).toMatchObject({ create: 0, update: 0, deactivate: 0, unchanged: 2 });
    expect(db.operations).toHaveLength(writes);
  });
});
