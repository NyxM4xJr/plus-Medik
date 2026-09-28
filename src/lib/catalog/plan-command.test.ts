import { describe, expect, it } from 'vitest';
import type { ExistingLabTest, LabTestReader } from './import';
import {
  EXIT_APPLICABLE,
  EXIT_FAILED,
  EXIT_NOT_APPLICABLE,
  parsePlanArgs,
  runCatalogPlanCommand,
} from './plan-command';
import { CATALOG_COLUMNS } from './validate';
import { DEFAULT_TARIFFS, withTariffs } from '@/test/catalog-fixtures';

const HEADER = CATALOG_COLUMNS.join(',');

function csvOf(...rows: string[]): string {
  return [HEADER, ...rows.map(withTariffs)].join('\n');
}

function test(overrides: Partial<ExistingLabTest> & Pick<ExistingLabTest, 'id' | 'code' | 'name'>): ExistingLabTest {
  return { category: null, sampleType: 'Sangre', priceBs: 45, ...DEFAULT_TARIFFS, active: true, notes: null, ...overrides };
}

function reader(tests: ExistingLabTest[]): LabTestReader & { calls: number } {
  const r = {
    calls: 0,
    async list() {
      r.calls += 1;
      return tests.map((t) => ({ ...t }));
    },
  };
  return r;
}

async function run(csv: string | Error, labTests: LabTestReader) {
  const output: string[] = [];
  const code = await runCatalogPlanCommand({
    csvPath: 'catalogo.csv',
    readFile: async () => {
      if (csv instanceof Error) throw csv;
      return csv;
    },
    reader: labTests,
    target: 'proyecto-prueba',
    write: (line) => output.push(line),
  });
  return { code, output, text: output.join('\n') };
}

const EXISTING = [
  test({ id: 'db-hem', code: 'HEM01', name: 'Hemograma' }),
  test({ id: 'db-glu', code: 'GLU01', name: 'Glucosa', priceBs: 20 }),
  test({ id: 'db-old', code: 'OLD01', name: 'Examen retirado' }),
  test({ id: 'db-man', code: null, name: 'Cargado a mano' }),
];

describe('parsePlanArgs', () => {
  it('acepta exactamente una ruta', () => {
    expect(parsePlanArgs(['catalogo.csv'])).toEqual({ csvPath: 'catalogo.csv' });
  });

  it.each([[[]], [['a.csv', 'b.csv']], [['a.csv', '--apply']]])('rechaza %j', (args) => {
    expect(parsePlanArgs(args)).toHaveProperty('error');
  });

  it.each(['--apply', '--mode=apply', '-a'])('no existe ninguna bandera: rechaza %s', (flag) => {
    const result = parsePlanArgs([flag]);
    expect(result).toHaveProperty('error');
    expect('error' in result && result.error).toContain('dry-run');
  });
});

describe('runCatalogPlanCommand', () => {
  it('imprime el resumen de las siete clases y marca DRY-RUN', async () => {
    const csv = csvOf(
      'HEM01,Hemograma completo,,Sangre,50,true,',
      'GLU01,Glucosa,,Sangre,20,true,',
      'CRE01,Creatinina,,Sangre,30,true,',
      ',Urea,,Sangre,25,true,',
    );

    const { code, text } = await run(csv, reader(EXISTING));

    expect(code).toBe(EXIT_NOT_APPLICABLE);
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('No se escribió nada');
    expect(text).toContain('Base: proyecto-prueba');
    expect(text).toMatch(/create\s+1/);
    expect(text).toMatch(/update\s+1/);
    expect(text).toMatch(/unchanged\s+1/);
    expect(text).toMatch(/deactivate\s+1/);
    expect(text).toMatch(/blocked\s+1/);
    expect(text).toMatch(/unmanaged\s+1/);
    expect(text).toMatch(/conflicts\s+0/);
    expect(text).toContain('HEM01: name "Hemograma" → "Hemograma completo"; priceBs 45 → 50');
    expect(text).toContain('CRE01  Creatinina  Bs paciente 30.00 / convenio 30.00 / médicos 40.00 / emergencia 60.00');
    expect(text).toContain('OLD01  Examen retirado');
    expect(text).toMatch(/línea 5 sin código \(propuesta AUTO-[0-9A-F]{8}\) \[row_needs_review\]/);
    expect(text).toContain('el plan NO se puede aplicar');
  });

  it('devuelve 0 si el plan se podría aplicar, y aclara que nunca aplica', async () => {
    const { code, text } = await run(
      csvOf('HEM01,Hemograma,,Sangre,45,true,'),
      reader([test({ id: 'db-hem', code: 'HEM01', name: 'Hemograma' })]),
    );

    expect(code).toBe(EXIT_APPLICABLE);
    expect(text).toContain('este comando nunca aplica');
  });

  it('muestra conflictos de lab_tests', async () => {
    const { code, text } = await run(
      csvOf('GLU01,Glucosa,,Sangre,20,true,'),
      reader([
        test({ id: 'a', code: 'HEM01', name: 'Hemograma' }),
        test({ id: 'b', code: 'hem01', name: 'Hemograma viejo' }),
      ]),
    );

    expect(code).toBe(EXIT_NOT_APPLICABLE);
    expect(text).toMatch(/conflicts\s+1/);
    expect(text).toContain('HEM01: HEM01 (id a), hem01 (id b)');
  });

  it('muestra los problemas del archivo', async () => {
    const { code, text } = await run('code,name\nHEM01,Hemograma', reader(EXISTING));

    expect(code).toBe(EXIT_NOT_APPLICABLE);
    expect(text).toContain('Problemas del archivo');
    expect(text).toContain('price_bs');
  });

  it('falla con código 1 si no puede leer el archivo', async () => {
    const labTests = reader(EXISTING);
    const { code, text } = await run(new Error('ENOENT'), labTests);

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('no se pudo leer el archivo catalogo.csv: ENOENT');
    expect(labTests.calls).toBe(0);
  });

  it('falla con código 1 si Supabase devuelve error', async () => {
    const failing: LabTestReader = {
      async list() {
        throw new Error('lab_tests.select: permission denied');
      },
    };

    const { code, text } = await run(csvOf('HEM01,Hemograma,,Sangre,45,true,'), failing);

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('no se pudo leer lab_tests: lab_tests.select: permission denied');
  });

  it('solo usa el lector: lee lab_tests una vez y no tiene cómo escribir', async () => {
    const labTests = reader(EXISTING);
    await run(csvOf('HEM01,Hemograma,,Sangre,45,true,'), labTests);

    expect(labTests.calls).toBe(1);
    expect(Object.keys(labTests)).toEqual(['calls', 'list']);
  });
});
