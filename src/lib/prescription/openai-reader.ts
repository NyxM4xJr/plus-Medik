import type OpenAI from 'openai';
import { PRESCRIPTION_READING_JSON_SCHEMA, PRESCRIPTION_SYSTEM_PROMPT } from '@/lib/prescription/reading';
import {
  parseReadingText,
  READ_INSTRUCTION,
  type PrescriptionImage,
  type PrescriptionReader,
} from '@/lib/prescription/reader';

/**
 * Lee imágenes de órdenes de laboratorio con OpenAI (API Responses, visión +
 * salida estructurada estricta). Mismo prompt y esquema que el lector de
 * Claude. La llamada se inyecta para que los tests no dependan de la API.
 */

export const OPENAI_PRESCRIPTION_MODEL = 'gpt-5-mini';

type CreateParams = OpenAI.Responses.ResponseCreateParamsNonStreaming;
type CreateResponse = (params: CreateParams) => Promise<OpenAI.Responses.Response>;

export function openaiCreate(client: OpenAI): CreateResponse {
  return (params) => client.responses.create(params);
}

export function buildOpenAIReadRequest(
  images: readonly PrescriptionImage[],
  model = OPENAI_PRESCRIPTION_MODEL,
): CreateParams {
  const content: OpenAI.Responses.ResponseInputContent[] = images.flatMap((image, index) => [
    { type: 'input_text' as const, text: `Imagen ${index + 1}:` },
    {
      type: 'input_image' as const,
      // high: la letra de las recetas necesita la resolución completa.
      detail: 'high' as const,
      image_url: `data:${image.mediaType};base64,${Buffer.from(image.data).toString('base64')}`,
    },
  ]);
  content.push({ type: 'input_text', text: READ_INSTRUCTION });

  return {
    model,
    instructions: PRESCRIPTION_SYSTEM_PROMPT,
    input: [{ role: 'user', content }],
    text: {
      format: {
        type: 'json_schema',
        name: 'prescription_reading',
        schema: PRESCRIPTION_READING_JSON_SCHEMA,
        strict: true,
      },
    },
    max_output_tokens: 16000,
    // Las recetas tienen datos de salud: que OpenAI no guarde la respuesta.
    store: false,
  };
}

export function createOpenAIPrescriptionReader(
  create: CreateResponse,
  model = OPENAI_PRESCRIPTION_MODEL,
): PrescriptionReader {
  return {
    async read(images) {
      if (images.length === 0) return { ok: false, reason: 'no_images', detail: 'no se recibieron imágenes' };

      const response = await create(buildOpenAIReadRequest(images, model));

      if (response.status === 'incomplete') {
        const reason = response.incomplete_details?.reason ?? 'desconocido';
        return reason === 'max_output_tokens'
          ? { ok: false, reason: 'max_tokens', detail: 'la respuesta se cortó por max_output_tokens' }
          : { ok: false, reason: 'refusal', detail: `respuesta incompleta (${reason})` };
      }

      const refused = response.output.some(
        (item) => item.type === 'message' && item.content.some((part) => part.type === 'refusal'),
      );
      if (refused) return { ok: false, reason: 'refusal', detail: 'el modelo declinó la lectura' };

      return parseReadingText(response.output_text, response.model);
    },
  };
}
