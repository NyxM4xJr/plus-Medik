import { describe, expect, it } from 'vitest';
import { candidate, exam, fakeDeps, reading } from '@/test/prescription-fixtures';
import {
  EXIT_FAILED,
  EXIT_OK,
  groupImageFiles,
  parseBatchArgs,
  REVIEW_HEADER,
  runBatchCommand,
} from './batch-command';
import type { PrescriptionImage, ReadOutcome } from './reader';

describe('groupImageFiles', () => {
  it('une las páginas de la misma cotización y ordena de forma natural', () => {
    expect(
      groupImageFiles(['prueba10.jpeg', 'prueba2-2.jpeg', 'prueba2-1.jpeg', 'prueba1.jpeg', 'notas.txt', 'prueba3.png']),
    ).toEqual([
      { id: 'prueba1', files: ['prueba1.jpeg'] },
      { id: 'prueba2', files: ['prueba2-1.jpeg', 'prueba2-2.jpeg'] },
      { id: 'prueba3', files: ['prueba3.png'] },
      { id: 'prueba10', files: ['prueba10.jpeg'] },
    ]);
  });

  it('ordena las páginas por número, no por texto', () => {
    expect(groupImageFiles(['r-10.jpg', 'r-2.jpg', 'r-1.jpg'])).toEqual([{ id: 'r', files: ['r-1.jpg', 'r-2.jpg', 'r-10.jpg'] }]);
  });
});

describe('parseBatchArgs', () => {
  it('acepta exactamente una carpeta', () => {
    expect(parseBatchArgs(['imgsPrueba'])).toEqual({ dir: 'imgsPrueba' });
    expect(parseBatchArgs([])).toHaveProperty('error');
    expect(parseBatchArgs(['a', 'b'])).toHaveProperty('error');
    expect(parseBatchArgs(['--send'])).toHaveProperty('error');
  });
});

/** Lector falso: la lectura depende de cuántas imágenes recibe. */
function readerFor(outcomes: Record<number, ReadOutcome | Error>) {
  const calls: number[] = [];
  return {
    calls,
    async read(images: readonly PrescriptionImage[]) {
      calls.push(images.length);
      const outcome = outcomes[images.length];
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
}

async function run(files: string[], outcomes: Record<number, ReadOutcome | Error>) {
  const output: string[] = [];
  const written = new Map<string, string>();
  const reader = readerFor(outcomes);
  const code = await runBatchCommand({
    ...fakeDeps({ glucosa: [candidate('glu')], tsh: [candidate('tsh')] }),
    dir: 'imgs',
    minConfidence: 0.6,
    provider: 'openai',
    catalogFingerprint: async () => 'a'.repeat(64),
    stamp: '202609290300',
    listDir: async () => files,
    readFile: async () => new Uint8Array([1]),
    writeFile: async (path, text) => {
      written.set(path.replace(/\\/g, '/'), text);
    },
    reader,
    write: (line) => output.push(line),
  });
  return { code, text: output.join('\n'), written, reader };
}

const ONE: ReadOutcome = { ok: true, model: 'gpt-5-mini', reading: reading([exam('Glucosa')]) };
const LOW_IMAGE: ReadOutcome = {
  ok: true,
  model: 'gpt-5-mini',
  reading: reading([exam('Glucosa')], { image_quality: 0.4 }),
};
const TWO: ReadOutcome = {
  ok: true,
  model: 'gpt-5-mini',
  reading: reading([exam('TSH', { image: 1 }), exam('Ferritina', { image: 2, interpretation: 'Ferritina sérica' })]),
};

describe('runBatchCommand', () => {
  it('analiza cada cotización con todas sus imágenes y escribe planilla y reporte', async () => {
    const { code, text, written, reader } = await run(['a.jpeg', 'b-1.jpeg', 'b-2.jpeg'], { 1: ONE, 2: TWO });

    expect(code).toBe(EXIT_OK);
    expect(reader.calls).toEqual([1, 2]);
    expect(text).toContain('Cotizaciones: 2 (3 imágenes)');
    expect(text).toContain('Decisiones: quote 1, confirm 1; errores 0');
    expect(text).toContain('Exámenes leídos: 3 (identificados 2, por confirmar 0, no identificados 1)');
    expect([...written.keys()]).toEqual([
      'imgs/resultados/lecturas-202609290300.json',
      'imgs/resultados/revision-202609290300.csv',
      'imgs/resultados/reporte-202609290300.txt',
    ]);
  });

  it('guarda la lectura cruda validada y el modelo en JSON', async () => {
    const { written } = await run(['a.jpeg'], { 1: ONE });
    const snapshot = JSON.parse(written.get('imgs/resultados/lecturas-202609290300.json') as string);

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      provider: 'openai',
      catalogFingerprint: 'a'.repeat(64),
      readings: [{ id: 'a', files: ['a.jpeg'], ok: true, model: 'gpt-5-mini', reading: ONE.reading }],
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/"data"|base64,/i);
  });

  it('guarda todas las páginas relativas del grupo sin copiar bytes de las imágenes', async () => {
    const { written } = await run(['prueba7-1.jpeg', 'prueba7-2.jpeg'], { 2: TWO });
    const snapshot = JSON.parse(written.get('imgs/resultados/lecturas-202609290300.json') as string);
    expect(snapshot.readings[0]).toMatchObject({
      id: 'prueba7',
      files: ['prueba7-1.jpeg', 'prueba7-2.jpeg'],
      reading: TWO.reading,
    });
    expect(JSON.stringify(snapshot)).not.toMatch(/data:|base64,/i);
  });

  it('incluye el código candidato en la planilla aunque la imagen impida cotizar', async () => {
    const { written } = await run(['a.jpeg'], { 1: LOW_IMAGE });
    const rows = (written.get('imgs/resultados/revision-202609290300.csv') as string).split('\r\n');
    expect(rows[1]).toContain(';identificado;exact;380;GLUCOSA;');
  });

  it('la planilla trae BOM, «;» y columnas vacías para el revisor', async () => {
    const { written } = await run(['a.jpeg', 'b-1.jpeg', 'b-2.jpeg'], { 1: ONE, 2: TWO });
    const lines = (written.get('imgs/resultados/revision-202609290300.csv') as string).split('\r\n');

    expect(lines[0]).toBe('﻿' + REVIEW_HEADER.join(';'));
    expect(lines[1]).toBe('a;a.jpeg;quote;90;Glucosa;;tick;1;95;identificado;exact;380;GLUCOSA;;;;');
    expect(lines[3]).toBe('b;b-1.jpeg + b-2.jpeg;confirm;90;Ferritina;Ferritina sérica;tick;2;95;not_in_catalog;none;;;;;;');
  });

  it('el reporte trae el análisis y el borrador marcado como no enviado', async () => {
    const { written } = await run(['a.jpeg'], { 1: ONE });
    const report = written.get('imgs/resultados/reporte-202609290300.txt') as string;

    expect(report).toContain('=== a (a.jpeg) ===');
    expect(report).toContain('Borrador (NO enviado):');
    expect(report).toContain('*Total: Bs 20*');
  });

  it('un error en una cotización no detiene las demás', async () => {
    const { code, text, written } = await run(['a.jpeg', 'b-1.jpeg', 'b-2.jpeg'], { 1: ONE, 2: new Error('401 Incorrect API key') });

    expect(code).toBe(EXIT_OK);
    expect(text).toContain('2/2 b: error');
    expect(written.get('imgs/resultados/revision-202609290300.csv')).toContain('b;b-1.jpeg + b-2.jpeg;error');
    const snapshot = JSON.parse(written.get('imgs/resultados/lecturas-202609290300.json') as string);
    expect(snapshot.readings[1]).toMatchObject({ id: 'b', ok: false });
  });

  it('si fallan todas, termina con error', async () => {
    const { code } = await run(['a.jpeg'], { 1: new Error('401') });
    expect(code).toBe(EXIT_FAILED);
  });

  it('carpeta sin imágenes', async () => {
    const { code, text } = await run(['notas.txt'], {});
    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('No hay imágenes');
  });
});
