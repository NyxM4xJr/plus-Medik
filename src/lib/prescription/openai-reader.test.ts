import type OpenAI from 'openai';
import { describe, expect, it } from 'vitest';
import { buildOpenAIReadRequest, createOpenAIPrescriptionReader, OPENAI_PRESCRIPTION_MODEL } from './openai-reader';
import { PRESCRIPTION_READING_JSON_SCHEMA, PRESCRIPTION_SYSTEM_PROMPT } from './reading';

type Params = OpenAI.Responses.ResponseCreateParamsNonStreaming;

const IMAGE = { data: new Uint8Array([1, 2, 3]), mediaType: 'image/jpeg' as const };

const VALID = {
  is_lab_order: true,
  image_quality: 0.8,
  issues: [],
  exams: [{ text: 'Glucosa', interpretation: null, mark: 'circle', confidence: 0.9, image: 1 }],
};

function fakeCreate(response: Record<string, unknown>) {
  const calls: Params[] = [];
  const create = async (params: Params) => {
    calls.push(params);
    return {
      model: 'gpt-5-mini-2026-08-07',
      status: 'completed',
      incomplete_details: null,
      output: [],
      output_text: '',
      ...response,
    } as unknown as OpenAI.Responses.Response;
  };
  return { create, calls };
}

describe('buildOpenAIReadRequest', () => {
  it('usa GPT-5 mini, el mismo prompt y esquema estricto, imágenes en alta resolución y sin guardar la respuesta', () => {
    const params = buildOpenAIReadRequest([IMAGE]);

    expect(params).toMatchObject({
      model: 'gpt-5-mini',
      instructions: PRESCRIPTION_SYSTEM_PROMPT,
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'prescription_reading',
          schema: PRESCRIPTION_READING_JSON_SCHEMA,
          strict: true,
        },
      },
    });
    const [message] = params.input as Array<{ content: unknown[] }>;
    expect(message.content).toEqual([
      { type: 'input_text', text: 'Imagen 1:' },
      { type: 'input_image', detail: 'high', image_url: 'data:image/jpeg;base64,AQID' },
      { type: 'input_text', text: 'Transcribe los exámenes solicitados en esta orden.' },
    ]);
    expect(OPENAI_PRESCRIPTION_MODEL).toBe('gpt-5-mini');
  });

  it('pide separar exámenes independientes escritos en la misma línea', () => {
    expect(PRESCRIPTION_SYSTEM_PROMPT).toContain('"Procalcitonina + PCR cuantitativo" son dos exámenes');
  });
});

describe('createOpenAIPrescriptionReader', () => {
  it('devuelve la lectura validada y el modelo que respondió', async () => {
    const fake = fakeCreate({ output_text: JSON.stringify(VALID) });
    expect(await createOpenAIPrescriptionReader(fake.create).read([IMAGE])).toEqual({
      ok: true,
      reading: VALID,
      model: 'gpt-5-mini-2026-08-07',
    });
  });

  it('sin imágenes no llama al modelo', async () => {
    const fake = fakeCreate({});
    expect(await createOpenAIPrescriptionReader(fake.create).read([])).toMatchObject({ ok: false, reason: 'no_images' });
    expect(fake.calls).toHaveLength(0);
  });

  it('respuesta incompleta por límite de salida', async () => {
    const fake = fakeCreate({ status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } });
    expect(await createOpenAIPrescriptionReader(fake.create).read([IMAGE])).toMatchObject({ ok: false, reason: 'max_tokens' });
  });

  it('respuesta incompleta por filtro de contenido', async () => {
    const fake = fakeCreate({ status: 'incomplete', incomplete_details: { reason: 'content_filter' } });
    expect(await createOpenAIPrescriptionReader(fake.create).read([IMAGE])).toMatchObject({
      ok: false,
      reason: 'refusal',
      detail: 'respuesta incompleta (content_filter)',
    });
  });

  it('rechazo explícito del modelo', async () => {
    const fake = fakeCreate({
      output: [{ type: 'message', content: [{ type: 'refusal', refusal: 'No puedo ayudar con eso.' }] }],
    });
    expect(await createOpenAIPrescriptionReader(fake.create).read([IMAGE])).toMatchObject({ ok: false, reason: 'refusal' });
  });

  it('salida que no cumple el esquema', async () => {
    const fake = fakeCreate({ output_text: JSON.stringify({ ...VALID, image_quality: 2 }) });
    expect(await createOpenAIPrescriptionReader(fake.create).read([IMAGE])).toEqual({
      ok: false,
      reason: 'invalid_output',
      detail: 'campos inválidos: image_quality',
    });
  });
});
