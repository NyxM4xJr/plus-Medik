import { describe, expect, it } from 'vitest';
import { candidate, exam, fakeDeps, reading } from '@/test/prescription-fixtures';
import {
  EXIT_FAILED,
  EXIT_OK,
  mediaTypeOf,
  parseAnalyzeArgs,
  parseMinConfidence,
  parseProvider,
  runAnalyzeCommand,
} from './analyze-command';
import type { PrescriptionReader, ReadOutcome } from './reader';

describe('parseAnalyzeArgs', () => {
  it('acepta una o varias imágenes', () => {
    expect(parseAnalyzeArgs(['a.jpg', 'b.PNG'])).toEqual({ paths: ['a.jpg', 'b.PNG'] });
  });

  it.each([[[]], [['--send', 'a.jpg']], [['a.pdf']]])('rechaza %j', (args) => {
    expect(parseAnalyzeArgs(args)).toHaveProperty('error');
  });

  it('detecta el tipo por la extensión', () => {
    expect(mediaTypeOf('foto.JPEG')).toBe('image/jpeg');
    expect(mediaTypeOf('foto.webp')).toBe('image/webp');
    expect(mediaTypeOf('foto.heic')).toBeNull();
  });
});

describe('parseMinConfidence', () => {
  it('sin definir es 0.6', () => {
    expect(parseMinConfidence(undefined)).toEqual({ value: 0.6 });
  });

  it.each(['', 'abc', '0', '-0.2', '1.5'])('rechaza «%s»', (raw) => {
    expect(parseMinConfidence(raw)).toHaveProperty('error');
  });

  it('acepta valores en (0, 1]', () => {
    expect(parseMinConfidence('0.75')).toEqual({ value: 0.75 });
    expect(parseMinConfidence('1')).toEqual({ value: 1 });
  });
});

describe('parseProvider', () => {
  it('sin definir usa OpenAI', () => {
    expect(parseProvider(undefined)).toEqual({ value: 'openai' });
  });

  it('acepta openai y anthropic sin distinguir mayúsculas', () => {
    expect(parseProvider(' Anthropic ')).toEqual({ value: 'anthropic' });
  });

  it.each(['', 'gemini'])('rechaza «%s»', (raw) => {
    expect(parseProvider(raw)).toHaveProperty('error');
  });
});

function reader(outcome: ReadOutcome | Error): PrescriptionReader & { calls: number } {
  const r = {
    calls: 0,
    async read() {
      r.calls += 1;
      if (outcome instanceof Error) throw outcome;
      return outcome;
    },
  };
  return r;
}

async function run(outcome: ReadOutcome | Error, readFile = async () => new Uint8Array([1])) {
  const output: string[] = [];
  const code = await runAnalyzeCommand({
    ...fakeDeps({ glucosa: [candidate('glu')] }),
    paths: ['receta.jpg'],
    minConfidence: 0.6,
    readFile,
    reader: reader(outcome),
    write: (line) => output.push(line),
  });
  return { code, text: output.join('\n') };
}

describe('runAnalyzeCommand', () => {
  it('muestra el análisis y el borrador, marcado como no enviado', async () => {
    const { code, text } = await run({ ok: true, reading: reading([exam('Glucosa')]), model: 'claude-opus-5' });

    expect(code).toBe(EXIT_OK);
    expect(text).toContain('DRY-RUN');
    expect(text).toContain('Decisión: quote');
    expect(text).toContain('[identified] «Glucosa» marca tick, imagen 1 | lectura 95%, identificación 100% (exact) → GLUCOSA');
    expect(text).toContain('Borrador de respuesta (NO enviado):');
    expect(text).toContain('*Total: Bs 20*');
  });

  it('si la lectura falla, termina con error y avisa que pasaría a una persona', async () => {
    const { code, text } = await run({ ok: false, reason: 'refusal', detail: 'el modelo declinó la lectura (null)' });

    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('pasaría a una persona');
    expect(text).not.toContain('Borrador');
  });

  it('si la API falla, termina con error', async () => {
    const { code, text } = await run(new Error('overloaded'));
    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('falló la lectura con el modelo: overloaded');
  });

  it('si no puede leer la imagen, no llama al modelo', async () => {
    const { code, text } = await run({ ok: true, reading: reading([]), model: 'x' }, async () => {
      throw new Error('ENOENT');
    });
    expect(code).toBe(EXIT_FAILED);
    expect(text).toContain('no se pudo leer receta.jpg: ENOENT');
  });
});
