import { describe, expect, it } from 'vitest';
import { candidate, fakeDeps } from '@/test/prescription-fixtures';
import { EXIT_FAILED, EXIT_OK, REVIEW_HEADER } from './batch-command';
import { parseReanalyzeArgs, runReanalyzeCommand } from './reanalyze-command';

const catalogDeps = fakeDeps({ glucosa: [candidate('glu')] });
const OLD_FINGERPRINT = 'a'.repeat(64);
const CURRENT_FINGERPRINT = 'b'.repeat(64);

function csvRow(values: Partial<Record<(typeof REVIEW_HEADER)[number], string>>): string {
  return REVIEW_HEADER.map((column) => values[column] ?? '').join(';');
}

function reviewedCsv(rows: string[]): string {
  return `﻿${REVIEW_HEADER.join(';')}\r\n${rows.join('\r\n')}\r\n`;
}

function examRow(overrides: Partial<Record<(typeof REVIEW_HEADER)[number], string>> = {}): string {
  return csvRow({
    cotizacion: 'base-1',
    imagenes: 'base-1.jpeg',
    decision: 'confirm',
    calidad_imagen_pct: '90',
    examen_leido: 'Glucosa',
    interpretacion: '',
    marca: 'tick',
    imagen: '1',
    confianza_lectura_pct: '95',
    estado: 'identificado',
    base_identificacion: 'contained',
    codigo_catalogo: '380',
    examen_catalogo: 'GLUCOSA',
    opciones: '',
    correcto_si_no: '',
    examen_correcto: '',
    notas: '',
    ...overrides,
  });
}

function jsonSnapshot(overrides: Record<string, unknown> = {}) {
  return JSON.stringify({
    schemaVersion: 2,
    generatedAt: '2026-09-30T18:00:00.000Z',
    provider: 'openai',
    catalogFingerprint: OLD_FINGERPRINT,
    readings: [
      {
        id: 'base-1',
        files: ['base-1.jpeg'],
        ok: true,
        model: 'test-model',
        reading: {
          is_lab_order: true,
          image_quality: 0.9,
          issues: [],
          exams: [{ text: 'Glucosa', interpretation: null, mark: 'tick', confidence: 0.95, image: 1 }],
        },
      },
    ],
    ...overrides,
  });
}

async function run(sourcePath: string, sourceText: string, options: { reviewPath?: string; reviewText?: string } = {}) {
  const output: string[] = [];
  const written = new Map<string, string>();
  const code = await runReanalyzeCommand({
    ...catalogDeps,
    sourcePath,
    sourceText,
    ...options,
    minConfidence: 0.6,
    stamp: '20260930180000',
    catalogFingerprint: async () => CURRENT_FINGERPRINT,
    validCatalogCodes: async () =>
      new Set((await catalogDeps.catalog()).flatMap((option) => (option.code ? [option.code] : []))),
    writeFile: async (path, text) => {
      written.set(path.replace(/\\/g, '/'), text);
    },
    write: (line) => output.push(line),
  });
  return { code, output: output.join('\n'), written };
}

describe('parseReanalyzeArgs', () => {
  it('acepta JSON, CSV y JSON con planilla revisada', () => {
    expect(parseReanalyzeArgs(['lecturas.json'])).toEqual({ sourcePath: 'lecturas.json' });
    expect(parseReanalyzeArgs(['revision.csv'])).toEqual({ sourcePath: 'revision.csv' });
    expect(parseReanalyzeArgs(['lecturas.json', '--review', 'revision.csv'])).toEqual({
      sourcePath: 'lecturas.json',
      reviewPath: 'revision.csv',
    });
    expect(parseReanalyzeArgs([])).toHaveProperty('error');
    expect(parseReanalyzeArgs(['revision.xlsx'])).toHaveProperty('error');
    expect(parseReanalyzeArgs(['lecturas.json', '--other', 'revision.csv'])).toHaveProperty('error');
    expect(parseReanalyzeArgs(['lecturas.json', '--review', '--unknown'])).toHaveProperty('error');
    expect(parseReanalyzeArgs(['lecturas.json', '--review', '--unknown.csv'])).toHaveProperty('error');
  });
});

describe('runReanalyzeCommand', () => {
  it('usa JSON y CSV juntos y conserva la revisión sin lector ni modelo', async () => {
    const { code, output, written } = await run('imgs/resultados/lecturas.json', jsonSnapshot(), {
      reviewPath: 'imgs/resultados/revision.csv',
      reviewText: reviewedCsv([examRow({ correcto_si_no: 'sí', examen_correcto: '380' })]),
    });

    expect(code).toBe(EXIT_OK);
    expect(output).toContain('Huella del catálogo guardada');
    expect(output).toContain('ADVERTENCIA: el catálogo cambió');
    expect(output).toContain('Evaluación manual: correctos 1, cotizados equivocados 0, revisados 1, pendientes 0');
    expect([...written.keys()]).toEqual([
      'imgs/resultados/revision-reanalizada-20260930180000.csv',
      'imgs/resultados/reporte-reanalizado-20260930180000.txt',
    ]);
    expect(written.get('imgs/resultados/revision-reanalizada-20260930180000.csv')).toContain(';sí;380;');
  });

  it('una marca «sí» con cambio de código queda pendiente y no es un acierto', async () => {
    const { output } = await run('lecturas.json', jsonSnapshot(), {
      reviewPath: 'revision.csv',
      reviewText: reviewedCsv([examRow({ codigo_catalogo: '108', correcto_si_no: 'sí' })]),
    });

    expect(output).toContain('correctos 0, cotizados equivocados 0, revisados 0, pendientes 1, pendientes por cambio de código 1');
  });

  it('la planilla nueva no arrastra un «sí» si cambió el código y deja una nota para revisar', async () => {
    const { written } = await run('lecturas.json', jsonSnapshot(), {
      reviewPath: 'revision.csv',
      reviewText: reviewedCsv([examRow({ codigo_catalogo: '108', correcto_si_no: 'sí', notas: 'ok' })]),
    });
    const generated = written.get('revision-reanalizada-20260930180000.csv') as string;
    expect(generated).toContain(';380;GLUCOSA;;;;ok | revisar: cambió el código (antes 108, marcado «sí»)');
  });

  it('una marca sin código previo (antes no identificado) queda pendiente por cambio de código', async () => {
    const { output } = await run('lecturas.json', jsonSnapshot(), {
      reviewPath: 'revision.csv',
      reviewText: reviewedCsv([examRow({ codigo_catalogo: '', estado: 'not_in_catalog', correcto_si_no: 'sí' })]),
    });
    expect(output).toContain('revisados 0, pendientes 1, pendientes por cambio de código 1');
  });

  it('«no» con el mismo código cuenta como cotización equivocada', async () => {
    const { output } = await run('lecturas.json', jsonSnapshot(), {
      reviewPath: 'revision.csv',
      reviewText: reviewedCsv([examRow({ correcto_si_no: 'no' })]),
    });
    expect(output).toContain('correctos 0, cotizados equivocados 1, revisados 1, pendientes 0');
  });

  it('examen_correcto distinto al nuevo código cuenta como cotización equivocada', async () => {
    const { output } = await run('lecturas.json', jsonSnapshot(), {
      reviewPath: 'revision.csv',
      reviewText: reviewedCsv([examRow({ examen_correcto: '108' })]),
    });

    expect(output).toContain('correctos 0, cotizados equivocados 1, revisados 1, pendientes 0');
  });

  it('código manual inválido queda pendiente y se lista', async () => {
    const { output } = await run('lecturas.json', jsonSnapshot(), {
      reviewPath: 'revision.csv',
      reviewText: reviewedCsv([examRow({ examen_correcto: 'NO-EXISTE' })]),
    });

    expect(output).toContain('pendientes 1');
    expect(output).toContain('Códigos en examen_correcto que no existen');
    expect(output).toContain('base-1: Glucosa → NO-EXISTE');
  });

  it('fila agregada sin marca o imagen se conserva como examen omitido, no como lectura', async () => {
    const { code, output, written } = await run(
      'revision.csv',
      reviewedCsv([
        examRow(),
        examRow({
          examen_leido: 'TSH',
          marca: '',
          imagen: '',
          confianza_lectura_pct: '',
          examen_correcto: '170',
        }),
      ]),
    );

    expect(code).toBe(EXIT_OK);
    expect(output).toContain('Exámenes agregados por el revisor (omitidos por el lector): 1');
    const generated = written.get('revision-reanalizada-20260930180000.csv') as string;
    expect(generated).toContain('TSH;;;;;omitido_por_lector');
    expect(generated).toContain(';1;95;');
  });

  it('una lectura con marca pero sin imagen es una celda borrada: rechaza con la línea', async () => {
    const { code, output, written } = await run('revision.csv', reviewedCsv([examRow({ imagen: '' })]));
    expect(code).toBe(EXIT_FAILED);
    expect(output).toContain('Línea 2: falta imagen');
    expect(written.size).toBe(0);
  });

  it('conserva exámenes agregados a cotizaciones sin exámenes leídos o con error, en cualquier orden', async () => {
    const added = { examen_leido: 'TSH', marca: '', imagen: '', confianza_lectura_pct: '', estado: '', examen_correcto: '170' };
    const { code, output, written } = await run(
      'revision.csv',
      reviewedCsv([
        csvRow({ cotizacion: 'vacia', imagenes: 'vacia.jpeg', decision: 'no_exams', calidad_imagen_pct: '90', ...added }),
        csvRow({ cotizacion: 'vacia', imagenes: 'vacia.jpeg', decision: 'no_exams', calidad_imagen_pct: '90' }),
        csvRow({ cotizacion: 'bad', imagenes: 'bad.jpeg', decision: 'error', ...added }),
        csvRow({ cotizacion: 'bad', imagenes: 'bad.jpeg', decision: 'error', estado: 'falló la lectura con el modelo' }),
        examRow({ cotizacion: 'good', imagenes: 'good.jpeg' }),
      ]),
    );

    expect(code).toBe(EXIT_OK);
    expect(output).toContain('Exámenes agregados por el revisor (omitidos por el lector): 2');
    expect(output).toContain('vacia=1, bad=1');
    const generated = written.get('revision-reanalizada-20260930180000.csv') as string;
    expect(generated).toContain('vacia;vacia.jpeg;no_exams;90;TSH;;;;;omitido_por_lector');
    expect(generated).toContain('bad;bad.jpeg;error;;;;;;;falló la lectura con el modelo');
    expect(generated).toContain('bad;bad.jpeg;error;;TSH;;;;;omitido_por_lector');
  });

  it('un error de cotización en el CSV no bloquea las demás', async () => {
    const { code, output, written } = await run(
      'revision.csv',
      reviewedCsv([
        csvRow({
          cotizacion: 'bad',
          imagenes: 'bad.jpeg',
          decision: 'error',
          estado: 'falló la lectura',
        }),
        examRow({ cotizacion: 'good', imagenes: 'good.jpeg' }),
      ]),
    );

    expect(code).toBe(EXIT_OK);
    expect(output).toContain('Cotizaciones: 2');
    expect(output).toContain('errores 1');
    expect(written.get('revision-reanalizada-20260930180000.csv')).toContain('bad;bad.jpeg;error');
  });

  it('acepta archivo JSON legacy version 1 sin huella', async () => {
    const legacy = JSON.stringify({
      version: 1,
      generatedAt: '2026-09-30T18:00:00.000Z',
      readings: JSON.parse(jsonSnapshot()).readings,
    });
    const { code, output } = await run('lecturas-v1.json', legacy);
    expect(code).toBe(EXIT_OK);
    expect(output).toContain('ADVERTENCIA: la entrada no contiene huella');
  });

  it('rechaza schemaVersion desconocida claramente', async () => {
    const { code, output } = await run('lecturas.json', jsonSnapshot({ schemaVersion: 3 }));
    expect(code).toBe(EXIT_FAILED);
    expect(output).toContain('schemaVersion 2');
  });

  it('avisa y lista filas de revisión que no existen en el JSON', async () => {
    const { output } = await run('lecturas.json', jsonSnapshot(), {
      reviewPath: 'revision.csv',
      reviewText: reviewedCsv([examRow({ cotizacion: 'otra', imagenes: 'otra.jpeg' })]),
    });
    expect(output).toContain('anotaciones CSV no coinciden con el JSON');
    expect(output).toContain('otra: Glucosa');
  });

  it('rechaza JSON malformado y CSV estructuralmente inválido', async () => {
    const malformedJson = await run('lecturas.json', '{');
    expect(malformedJson.code).toBe(EXIT_FAILED);
    expect(malformedJson.output).toContain('JSON no es válido');
    expect(malformedJson.written.size).toBe(0);

    const malformedCsv = await run('revision.csv', 'cotizacion;imagenes\r\na;b\r\n');
    expect(malformedCsv.code).toBe(EXIT_FAILED);
    expect(malformedCsv.output).toContain('Faltan columnas');
    expect(malformedCsv.written.size).toBe(0);
  });

  it('solo CSV importado advierte que no tiene huella y preserva anotaciones', async () => {
    const { code, output, written } = await run(
      'imgs/resultados/revision-base.csv',
      reviewedCsv([examRow({ correcto_si_no: 'No', examen_correcto: '108', notas: 'revisión' })]),
    );

    expect(code).toBe(EXIT_OK);
    expect(output).toContain('ADVERTENCIA: la entrada no contiene huella');
    expect(output).toContain('cotizados equivocados 1');
    expect(written.has('imgs/resultados/lecturas-importadas-20260930180000.json')).toBe(true);
  });
});
