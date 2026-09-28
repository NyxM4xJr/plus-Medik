import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  buildRpcRows,
  DEFAULT_MAX_DEACTIVATIONS,
  EXIT_CANCELLED,
  EXIT_FAILED,
  EXIT_OK,
  EXIT_REFUSED,
  fileNameOf,
  localExecutionError,
  parseApplyArgs,
  parseMaxDeactivations,
  runCatalogApplyCommand,
  sha256Hex,
  type ApplyOptions,
  type CatalogApplyRpc,
  type CatalogApplyRpcArgs,
} from './apply-command';
import type { ExistingLabTest, LabTestReader } from './import';
import { CATALOG_COLUMNS, validateCatalogCsv } from './validate';
import { DEFAULT_TARIFFS, withTariffs } from '@/test/catalog-fixtures';

const HEADER = CATALOG_COLUMNS.join(',');
const TARGET = 'proyecto-prueba';
const PHRASE = `aplicar ${TARGET}`;

function lab(overrides: Partial<ExistingLabTest> & Pick<ExistingLabTest, 'id' | 'code' | 'name'>): ExistingLabTest {
  return { category: null, sampleType: 'Sangre', priceBs: 45, ...DEFAULT_TARIFFS, active: true, notes: null, ...overrides };
}

function csv(...rows: string[]): string {
  return [HEADER, ...rows.map(withTariffs)].join('\n');
}

/** Lector que devuelve un estado distinto en cada llamada (el último se repite). */
function reader(...states: ExistingLabTest[][]): LabTestReader & { calls: number } {
  const r = {
    calls: 0,
    async list() {
      const state = states[Math.min(r.calls, states.length - 1)];
      r.calls += 1;
      return state.map((t) => ({ ...t }));
    },
  };
  return r;
}

const OK_RESULT = {
  import_id: '00000000-0000-0000-0000-000000000001',
  created: 1,
  updated: 1,
  unchanged: 0,
  deactivated: 1,
  reactivated: 0,
  unmanaged: 0,
  deactivated_codes: ['OLD01'],
};

function rpcMock(response: Awaited<ReturnType<CatalogApplyRpc>> | Error = { data: OK_RESULT, error: null }) {
  const calls: CatalogApplyRpcArgs[] = [];
  const rpc: CatalogApplyRpc = async (args) => {
    calls.push(structuredClone(args));
    if (response instanceof Error) throw response;
    return response;
  };
  return { rpc, calls };
}

function options(overrides: Partial<ApplyOptions> = {}): ApplyOptions {
  return {
    csvPath: 'catalogo.csv',
    apply: false,
    operator: null,
    confirmDeactivations: null,
    allowMassDeactivation: false,
    ...overrides,
  };
}

const APPLY = { apply: true, operator: 'Ana' } as const;

async function run(
  input: {
    csv?: string | Uint8Array | Error;
    options?: Partial<ApplyOptions>;
    labTests?: LabTestReader;
    rpc?: ReturnType<typeof rpcMock>;
    answer?: string;
    max?: number;
  } = {},
) {
  const output: string[] = [];
  const questions: string[] = [];
  const rpc = input.rpc ?? rpcMock();
  const labTests = input.labTests ?? reader(EXISTING);
  const content = input.csv ?? CSV_BASE;

  const code = await runCatalogApplyCommand({
    options: options(input.options),
    maxDeactivations: input.max ?? DEFAULT_MAX_DEACTIVATIONS,
    readFile: async () => {
      if (content instanceof Error) throw content;
      return typeof content === 'string' ? new TextEncoder().encode(content) : content;
    },
    reader: labTests,
    rpc: rpc.rpc,
    confirm: async (question) => {
      questions.push(question);
      return input.answer ?? PHRASE;
    },
    target: TARGET,
    write: (line) => output.push(line),
  });

  return { code, output, text: output.join('\n'), questions, calls: rpc.calls };
}

/** HEM01 sube de precio, CRE01 es nuevo, OLD01 desaparece del archivo. */
const EXISTING = [
  lab({ id: 'db-hem', code: 'HEM01', name: 'Hemograma' }),
  lab({ id: 'db-old', code: 'OLD01', name: 'Examen retirado' }),
];
const CSV_BASE = csv('HEM01,Hemograma,,Sangre,50,true,', 'CRE01,Creatinina,Química,Sangre,30.5,true,Ayuno');

describe('parseApplyArgs', () => {
  it('por defecto es dry-run', () => {
    expect(parseApplyArgs(['catalogo.csv'])).toEqual({
      csvPath: 'catalogo.csv',
      apply: false,
      operator: null,
      confirmDeactivations: null,
      allowMassDeactivation: false,
    });
  });

  it('lee todas las opciones', () => {
    expect(
      parseApplyArgs([
        '--apply',
        'catalogo.csv',
        '--operator= Ana Pérez ',
        '--confirm-deactivations=HEM01, glu01',
        '--allow-mass-deactivation',
      ]),
    ).toEqual({
      csvPath: 'catalogo.csv',
      apply: true,
      operator: 'Ana Pérez',
      confirmDeactivations: ['HEM01', 'glu01'],
      allowMassDeactivation: true,
    });
  });

  it('--confirm-deactivations= vacío es una lista vacía explícita', () => {
    expect(parseApplyArgs(['a.csv', '--confirm-deactivations='])).toMatchObject({ confirmDeactivations: [] });
  });

  it.each([
    [[], 'exactamente un archivo'],
    [['a.csv', 'b.csv'], 'exactamente un archivo'],
    [['a.csv', '--mode=apply'], 'no admitida'],
    [['a.csv', '-a'], 'no admitida'],
    [['a.csv', '--apply=true'], 'no lleva valor'],
    [['a.csv', '--allow-mass-deactivation=1'], 'no lleva valor'],
    [['a.csv', '--apply', '--apply'], 'repetida'],
    [['a.csv', '--operator='], 'necesita un nombre'],
    [['a.csv', '--operator'], 'necesita un nombre'],
    [['a.csv', `--operator=${'x'.repeat(101)}`], 'hasta 100'],
    [['a.csv', '--operator=Ana\nBeto'], 'caracteres de control'],
    [['a.csv', '--confirm-deactivations'], 'lleva la lista'],
    [['a.csv', '--confirm-deactivations=HEM01,,GLU01'], 'código vacío'],
    [['a.csv', '--confirm-deactivations=HEM01,'], 'código vacío'],
    [['a.csv', '--confirm-deactivations=HEM01,hem01 '], 'repite códigos: HEM01'],
  ])('rechaza %j', (args, message) => {
    const result = parseApplyArgs(args);
    expect(result).toHaveProperty('error');
    expect('error' in result && result.error).toContain(message);
  });
});

describe('parseMaxDeactivations (CATALOG_MAX_DEACTIVATIONS)', () => {
  it('sin definir usa 10', () => {
    expect(parseMaxDeactivations(undefined)).toEqual({ value: 10 });
  });

  it.each([
    ['0', 0],
    ['25', 25],
    [' 7 ', 7],
  ])('acepta %j', (raw, value) => {
    expect(parseMaxDeactivations(raw)).toEqual({ value });
  });

  it.each(['', ' ', 'diez', '-1', '1.5', '1e3', '10abc', '1234567890'])('rechaza %j', (raw) => {
    expect(parseMaxDeactivations(raw)).toHaveProperty('error');
  });
});

describe('localExecutionError', () => {
  it('permite una máquina local', () => {
    expect(localExecutionError({ PATH: '/usr/bin', VERCEL: '' })).toBeNull();
  });

  it.each(['VERCEL', 'VERCEL_ENV', 'NEXT_RUNTIME', 'CI'])('rechaza si existe %s', (name) => {
    expect(localExecutionError({ [name]: '1' })).toContain(name);
  });

  it('ninguna ruta de la app importa el comando de carga', () => {
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const path = join(dir, entry);
        if (statSync(path).isDirectory()) walk(path);
        else files.push(path);
      }
    };
    walk(join(process.cwd(), 'src', 'app'));

    expect(files.length).toBeGreaterThan(0);
    for (const file of files) expect(readFileSync(file, 'utf8')).not.toMatch(/apply-command|catalog-apply/);
  });
});

describe('sha256Hex y p_source', () => {
  it('coincide con el vector conocido de SHA-256', () => {
    expect(sha256Hex(new TextEncoder().encode('abc'))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('fileNameOf quita la ruta local', () => {
    expect(fileNameOf('C:\\Users\\ana\\catalogo.csv')).toBe('catalogo.csv');
    expect(fileNameOf('datos/2026/catalogo.csv')).toBe('catalogo.csv');
    expect(fileNameOf('catalogo.csv')).toBe('catalogo.csv');
  });

  it('envía el hash de los bytes exactos del archivo, operator y filename', async () => {
    // BOM y CRLF: el hash es del archivo tal cual, no del texto normalizado.
    const bytes = new TextEncoder().encode(`\uFEFF${CSV_BASE.replace(/\n/g, '\r\n')}`);
    const { code, calls } = await run({
      csv: bytes,
      options: { ...APPLY, csvPath: 'C:\\datos\\catalogo.csv', confirmDeactivations: ['OLD01'] },
    });

    expect(code).toBe(EXIT_OK);
    expect(calls).toHaveLength(1);
    expect(calls[0].p_source).toEqual({
      csv_sha256: sha256Hex(bytes),
      operator: 'Ana',
      filename: 'catalogo.csv',
      tool: 'catalog:apply',
    });
    expect(calls[0].p_source.csv_sha256).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('buildRpcRows', () => {
  it('solo envía filas ok, con las claves exactas de p_rows y sin proposedCode', () => {
    const report = validateCatalogCsv(
      csv('HEM01,Hemograma,,Sangre,45.5,si,', ',Urea,,Sangre,25,true,', 'GLU01,Glucosa,,Sangre,abc,true,'),
    );
    const rows = buildRpcRows(report);

    expect(report.rows.map((r) => r.status)).toEqual(['ok', 'needs_review', 'blocked']);
    expect(rows).toEqual([
      {
        code: 'HEM01',
        name: 'Hemograma',
        category: null,
        sample_type: 'Sangre',
        price_bs: '45.50',
        price_convenio_bs: '30.00',
        price_medicos_bs: '40.00',
        price_emergencia_bs: '60.00',
        active: true,
        notes: null,
        status: 'ok',
      },
    ]);
    expect(JSON.stringify(rows)).not.toMatch(/proposed|AUTO-|line|issues/i);
  });
});

describe('runCatalogApplyCommand: dry-run', () => {
  it('es el modo predeterminado: muestra el plan y no llama al RPC ni pide confirmación', async () => {
    const labTests = reader(EXISTING);
    const { code, text, calls, questions } = await run({ labTests, options: { confirmDeactivations: ['OLD01'] } });

    expect(code).toBe(EXIT_OK);
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('No se escribió nada');
    expect(text).toContain(`Base: ${TARGET}`);
    expect(text).toMatch(/SHA-256: [0-9a-f]{64}/);
    expect(text).toMatch(/create\s+1/);
    expect(text).toMatch(/deactivate\s+1/);
    expect(text).toContain('se podría aplicar');
    expect(text).toContain('--apply --operator=NOMBRE');
    expect(calls).toHaveLength(0);
    expect(questions).toHaveLength(0);
    expect(labTests.calls).toBe(1);
  });

  it('avisa en dry-run qué confirmación falta, con la lista exacta', async () => {
    const { code, text, calls } = await run();

    expect(code).toBe(EXIT_REFUSED);
    expect(text).toContain('falta --confirm-deactivations');
    expect(text).toContain('--confirm-deactivations=OLD01');
    expect(calls).toHaveLength(0);
  });

  it('no exige --operator en dry-run', async () => {
    const { code } = await run({ options: { confirmDeactivations: ['OLD01'] } });
    expect(code).toBe(EXIT_OK);
  });
});

describe('runCatalogApplyCommand: rechazos antes del RPC', () => {
  async function expectRefused(input: Parameters<typeof run>[0], message: string | RegExp) {
    const result = await run(input);
    expect(result.code).toBe(EXIT_REFUSED);
    expect(result.text).toMatch(message);
    expect(result.calls).toHaveLength(0);
    expect(result.questions).toHaveLength(0);
  }

  it('confirmación faltante', async () => {
    await expectRefused({ options: { ...APPLY } }, /falta --confirm-deactivations con los 1 código\(s\)/);
  });

  it('confirmación vacía cuando el plan desactiva', async () => {
    await expectRefused({ options: { ...APPLY, confirmDeactivations: [] } }, /no coincide con el plan; faltan: OLD01/);
  });

  it('código de desactivación incorrecto', async () => {
    await expectRefused(
      { options: { ...APPLY, confirmDeactivations: ['OLD02'] } },
      /faltan: OLD01; no se desactivan: OLD02/,
    );
  });

  it('código de más en la confirmación', async () => {
    await expectRefused(
      { options: { ...APPLY, confirmDeactivations: ['OLD01', 'HEM01'] } },
      /no se desactivan: HEM01/,
    );
  });

  it('confirmación con códigos cuando el plan no desactiva nada', async () => {
    await expectRefused(
      {
        labTests: reader([lab({ id: 'db-hem', code: 'HEM01', name: 'Hemograma' })]),
        options: { ...APPLY, confirmDeactivations: ['OLD01'] },
      },
      /no se desactivan: OLD01/,
    );
  });

  it('falta --operator con --apply', async () => {
    await expectRefused({ options: { apply: true, confirmDeactivations: ['OLD01'] } }, /falta --operator/);
  });

  it('fila bloqueada', async () => {
    await expectRefused(
      { csv: csv('HEM01,Hemograma,,Sangre,50,true,', 'OLD01,Retirado,,Sangre,abc,true,'), options: { ...APPLY } },
      /el plan no se puede aplicar/,
    );
  });

  it('fila en revisión (sin código, con propuesta)', async () => {
    await expectRefused(
      {
        csv: csv('HEM01,Hemograma,,Sangre,50,true,', 'OLD01,Retirado,,Sangre,45,true,', ',Urea,,Sangre,25,true,'),
        options: { ...APPLY },
      },
      /pendientes de revisión/,
    );
  });

  it('conflicto de códigos en lab_tests', async () => {
    await expectRefused(
      {
        labTests: reader([...EXISTING, lab({ id: 'db-dup', code: 'hem01', name: 'Hemograma viejo' })]),
        options: { ...APPLY, confirmDeactivations: ['OLD01'] },
      },
      /códigos repetidos/,
    );
  });

  it('archivo con errores de formato', async () => {
    await expectRefused({ csv: 'code;name\nHEM01;Hemograma', options: { ...APPLY } }, /errores de formato/);
  });
});

describe('runCatalogApplyCommand: desactivaciones masivas', () => {
  const many = Array.from({ length: 11 }, (_, i) =>
    lab({ id: `db-${i}`, code: `OLD${String(i).padStart(2, '0')}`, name: `Retirado ${i}` }),
  );
  const manyCodes = many.map((t) => t.code as string);
  const onlyHem = csv('HEM01,Hemograma,,Sangre,45,true,');

  it('más de 10 exige --allow-mass-deactivation', async () => {
    const { code, text, calls } = await run({
      csv: onlyHem,
      labTests: reader(many),
      options: { ...APPLY, confirmDeactivations: manyCodes },
    });

    expect(code).toBe(EXIT_REFUSED);
    expect(text).toContain('desactiva 11 exámenes y el límite es 10');
    expect(calls).toHaveLength(0);
  });

  it('con --allow-mass-deactivation se envía la bandera y el límite', async () => {
    const { code, text, calls } = await run({
      csv: onlyHem,
      labTests: reader(many),
      options: { ...APPLY, confirmDeactivations: manyCodes, allowMassDeactivation: true },
    });

    expect(code).toBe(EXIT_OK);
    expect(text).toContain('desactivación masiva autorizada');
    expect(calls).toHaveLength(1);
    expect(calls[0].p_allow_mass_deactivation).toBe(true);
    expect(calls[0].p_max_deactivations).toBe(10);
    expect(calls[0].p_confirm_deactivate_codes).toEqual(manyCodes);
  });

  it('--allow-mass-deactivation sin necesidad se rechaza', async () => {
    const { code, text, calls } = await run({
      options: { ...APPLY, confirmDeactivations: ['OLD01'], allowMassDeactivation: true },
    });

    expect(code).toBe(EXIT_REFUSED);
    expect(text).toContain('--allow-mass-deactivation no corresponde');
    expect(calls).toHaveLength(0);
  });

  it('respeta CATALOG_MAX_DEACTIVATIONS: con 0, una sola desactivación ya es masiva', async () => {
    const refused = await run({ max: 0, options: { ...APPLY, confirmDeactivations: ['OLD01'] } });
    expect(refused.code).toBe(EXIT_REFUSED);
    expect(refused.text).toContain('el límite es 0');

    const allowed = await run({
      max: 0,
      options: { ...APPLY, confirmDeactivations: ['OLD01'], allowMassDeactivation: true },
    });
    expect(allowed.code).toBe(EXIT_OK);
    expect(allowed.calls[0].p_max_deactivations).toBe(0);
  });
});

describe('runCatalogApplyCommand: confirmación y plan cambiado', () => {
  const opts = { ...APPLY, confirmDeactivations: ['old01'] };

  it('camino feliz: una sola llamada con los argumentos del plan mostrado', async () => {
    const labTests = reader(EXISTING);
    const { code, text, calls, questions } = await run({ labTests, options: opts });

    expect(code).toBe(EXIT_OK);
    expect(questions).toEqual([`Escribe «${PHRASE}» para aplicar (cualquier otra cosa cancela): `]);
    expect(labTests.calls).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      p_rows: [
        { code: 'HEM01', name: 'Hemograma', price_bs: '50.00', status: 'ok' },
        {
          code: 'CRE01',
          name: 'Creatinina',
          category: 'Química',
          sample_type: 'Sangre',
          price_bs: '30.50',
          active: true,
          notes: 'Ayuno',
          status: 'ok',
        },
      ],
      p_confirm_deactivate_codes: ['old01'],
      p_expected_counts: { create: 1, update: 1, unchanged: 0, deactivate: 1 },
      p_max_deactivations: 10,
      p_allow_mass_deactivation: false,
    });
    expect(Object.keys(calls[0]).sort()).toEqual([
      'p_allow_mass_deactivation',
      'p_confirm_deactivate_codes',
      'p_expected_counts',
      'p_max_deactivations',
      'p_rows',
      'p_source',
    ]);
    expect(text).toContain('crear 1, actualizar 1, sin cambios 0, desactivar 1');
    expect(text).toContain('desactivaciones confirmadas: OLD01');
    expect(text).toContain('Carga aplicada. import_id 00000000-0000-0000-0000-000000000001');
    expect(text).toContain('desactivados: OLD01');
    // El resumen se muestra antes de preguntar.
    expect(text.indexOf('crear 1')).toBeLessThan(text.indexOf('Carga aplicada'));
  });

  it.each(['', 'si', 'aplicar', `APLICAR ${TARGET}`, `aplicar otra-base`])(
    'cancela si la respuesta es %j',
    async (answer) => {
      const { code, text, calls } = await run({ options: opts, answer });

      expect(code).toBe(EXIT_CANCELLED);
      expect(text).toContain('Cancelado');
      expect(calls).toHaveLength(0);
    },
  );

  it('no llama al RPC si lab_tests cambió después de mostrar el plan', async () => {
    const added = lab({ id: 'db-new', code: 'NEW01', name: 'Agregado a mano' });
    const { code, text, calls } = await run({ options: opts, labTests: reader(EXISTING, [...EXISTING, added]) });

    expect(code).toBe(EXIT_REFUSED);
    expect(text).toContain('El plan cambió');
    expect(calls).toHaveLength(0);
  });

  it('detecta cambios que dejan los conteos iguales', async () => {
    // HEM01 sigue en update, pero desde otro precio: los conteos no cambian.
    const edited = [lab({ id: 'db-hem', code: 'HEM01', name: 'Hemograma', priceBs: 47 }), EXISTING[1]];
    const { code, calls } = await run({ options: opts, labTests: reader(EXISTING, edited) });

    expect(code).toBe(EXIT_REFUSED);
    expect(calls).toHaveLength(0);
  });

  it('no llama al RPC si no hay nada que aplicar', async () => {
    const { code, text, calls, questions } = await run({
      csv: csv('HEM01,Hemograma,,Sangre,45,true,'),
      labTests: reader([lab({ id: 'db-hem', code: 'HEM01', name: 'Hemograma' })]),
      options: { ...APPLY },
    });

    expect(code).toBe(EXIT_OK);
    expect(text).toContain('Nada que aplicar');
    expect(calls).toHaveLength(0);
    expect(questions).toHaveLength(0);
  });
});

describe('runCatalogApplyCommand: errores', () => {
  const opts = { ...APPLY, confirmDeactivations: ['OLD01'] };

  it('error de Postgres: informa el rechazo y no reintenta', async () => {
    const rpc = rpcMock({ data: null, error: { code: 'P0001', message: 'plan_changed: plan actual …' } });
    const { code, text, calls } = await run({ options: opts, rpc });

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('La base rechazó la carga (P0001): plan_changed');
    expect(text).toContain('se revirtió');
    expect(calls).toHaveLength(1);
  });

  it('error sin código: resultado desconocido, no reintenta', async () => {
    const rpc = rpcMock({ data: null, error: { code: '', message: 'TypeError: fetch failed' } });
    const { code, text, calls } = await run({ options: opts, rpc });

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('resultado es desconocido');
    expect(text).toContain('lab_catalog_imports');
    expect(calls).toHaveLength(1);
  });

  it('excepción en la llamada: resultado desconocido, no reintenta', async () => {
    const rpc = rpcMock(new Error('socket hang up'));
    const { code, text, calls } = await run({ options: opts, rpc });

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('resultado es desconocido: socket hang up');
    expect(text).toContain('No se reintentó');
    expect(calls).toHaveLength(1);
  });

  it('respuesta con formato inesperado', async () => {
    const rpc = rpcMock({ data: { ok: true }, error: null });
    const { code, text, calls } = await run({ options: opts, rpc });

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('formato inesperado');
    expect(calls).toHaveLength(1);
  });

  it('archivo ilegible', async () => {
    const { code, text, calls } = await run({ csv: new Error('ENOENT'), options: opts });

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('no se pudo leer el archivo');
    expect(calls).toHaveLength(0);
  });

  it('archivo que no es UTF-8 (por ejemplo, exportado en Windows-1252)', async () => {
    const latin1 = Uint8Array.from([...new TextEncoder().encode(`${HEADER}\nHEM01,Hemograma,Qu`), 0xed, 0x6d]);
    const { code, text, calls } = await run({ csv: latin1, options: opts });

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('no es UTF-8 válido');
    expect(calls).toHaveLength(0);
  });

  it('lab_tests ilegible', async () => {
    const failing: LabTestReader = {
      async list() {
        throw new Error('lab_tests.select: timeout');
      },
    };
    const { code, text, calls } = await run({ options: opts, labTests: failing });

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('no se pudo leer lab_tests');
    expect(calls).toHaveLength(0);
  });
});
