import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { buildReadRequest, createClaudePrescriptionReader, PRESCRIPTION_MODEL } from './claude-reader';
import { PRESCRIPTION_READING_JSON_SCHEMA } from './reading';

type Params = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

const IMAGE = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' as const };

const VALID = {
  is_lab_order: true,
  image_quality: 0.8,
  issues: [],
  exams: [{ text: 'Glucosa', interpretation: null, mark: 'tick', confidence: 0.9, image: 1 }],
};

/** Llamada falsa: registra los parámetros y devuelve la respuesta indicada. */
function fakeCreate(response: Partial<Anthropic.Beta.Messages.BetaMessage>) {
  const calls: Params[] = [];
  const create = async (params: Params) => {
    calls.push(params);
    return { model: PRESCRIPTION_MODEL, stop_reason: 'end_turn', stop_details: null, content: [], ...response } as unknown as Anthropic.Beta.Messages.BetaMessage;
  };
  return { create, calls };
}

const textBlock = (text: string) => [{ type: 'text', text, citations: null }] as Anthropic.Beta.Messages.BetaContentBlock[];

describe('buildReadRequest', () => {
  it('usa Claude Opus 5 con pensamiento adaptativo, respaldo por defecto y salida con esquema', () => {
    const params = buildReadRequest([IMAGE, { ...IMAGE, mediaType: 'image/png' }]);

    expect(params).toMatchObject({
      model: 'claude-opus-5',
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      thinking: { type: 'adaptive' },
      output_config: { format: { type: 'json_schema', schema: PRESCRIPTION_READING_JSON_SCHEMA } },
    });
    const content = params.messages[0].content as Anthropic.Beta.Messages.BetaContentBlockParam[];
    expect(content.map((block) => block.type)).toEqual(['text', 'image', 'text', 'image', 'text']);
    expect(content[0]).toEqual({ type: 'text', text: 'Imagen 1:' });
    expect(content[1]).toEqual({
      type: 'image',
      source: { type: 'base64', media_type: 'image/jpeg', data: 'AQID' },
    });
  });

  it('el esquema no admite propiedades extra en ningún nivel', () => {
    expect(PRESCRIPTION_READING_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(PRESCRIPTION_READING_JSON_SCHEMA.properties.exams.items.additionalProperties).toBe(false);
    expect([...PRESCRIPTION_READING_JSON_SCHEMA.required].sort()).toEqual(
      Object.keys(PRESCRIPTION_READING_JSON_SCHEMA.properties).sort(),
    );
  });
});

describe('createClaudePrescriptionReader', () => {
  it('devuelve la lectura validada y el modelo que respondió', async () => {
    const fake = fakeCreate({ content: textBlock(JSON.stringify(VALID)), model: 'claude-opus-4-8' });

    const outcome = await createClaudePrescriptionReader(fake.create).read([IMAGE]);

    expect(outcome).toEqual({ ok: true, reading: VALID, model: 'claude-opus-4-8' });
    expect(fake.calls).toHaveLength(1);
  });

  it('sin imágenes no llama al modelo', async () => {
    const fake = fakeCreate({});
    expect(await createClaudePrescriptionReader(fake.create).read([])).toMatchObject({ ok: false, reason: 'no_images' });
    expect(fake.calls).toHaveLength(0);
  });

  it('rechazo del modelo: no intenta leer el contenido', async () => {
    const fake = fakeCreate({
      stop_reason: 'refusal',
      stop_details: { type: 'refusal', category: null, explanation: null },
      content: textBlock('{}'),
    } as never);
    expect(await createClaudePrescriptionReader(fake.create).read([IMAGE])).toMatchObject({ ok: false, reason: 'refusal' });
  });

  it('respuesta cortada por max_tokens', async () => {
    const fake = fakeCreate({ stop_reason: 'max_tokens', content: textBlock('{"is_lab') });
    expect(await createClaudePrescriptionReader(fake.create).read([IMAGE])).toMatchObject({ ok: false, reason: 'max_tokens' });
  });

  it.each([
    ['no es JSON', 'hola', 'la respuesta no es JSON'],
    ['confianza fuera de rango', JSON.stringify({ ...VALID, image_quality: 1.4 }), 'campos inválidos: image_quality'],
    [
      'marca desconocida',
      JSON.stringify({ ...VALID, exams: [{ ...VALID.exams[0], mark: 'star' }] }),
      'campos inválidos: exams.0.mark',
    ],
  ])('salida inválida: %s', async (_label, text, detail) => {
    const fake = fakeCreate({ content: textBlock(text) });
    expect(await createClaudePrescriptionReader(fake.create).read([IMAGE])).toEqual({
      ok: false,
      reason: 'invalid_output',
      detail,
    });
  });

  it('una interpretación vacía se guarda como null', async () => {
    const fake = fakeCreate({
      content: textBlock(JSON.stringify({ ...VALID, exams: [{ ...VALID.exams[0], interpretation: '  ' }] })),
    });
    const outcome = await createClaudePrescriptionReader(fake.create).read([IMAGE]);
    expect(outcome.ok && outcome.reading.exams[0].interpretation).toBeNull();
  });
});
