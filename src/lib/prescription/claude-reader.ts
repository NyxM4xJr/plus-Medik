import type Anthropic from '@anthropic-ai/sdk';
import { PRESCRIPTION_READING_JSON_SCHEMA, PRESCRIPTION_SYSTEM_PROMPT } from '@/lib/prescription/reading';
import {
  parseReadingText,
  READ_INSTRUCTION,
  type PrescriptionImage,
  type PrescriptionReader,
} from '@/lib/prescription/reader';

/**
 * Lee imágenes de órdenes de laboratorio con Claude (visión + salida
 * estructurada). Solo transcribe: no identifica contra el catálogo ni decide.
 * La llamada se inyecta para que los tests no dependan de la API.
 */

export const PRESCRIPTION_MODEL = 'claude-opus-5';

type CreateParams = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;
type CreateMessage = (params: CreateParams) => Promise<Anthropic.Beta.Messages.BetaMessage>;

/** La llamada real: API beta por el parámetro fallbacks. */
export function anthropicCreate(client: Anthropic): CreateMessage {
  return (params) => client.beta.messages.create(params);
}

export function buildReadRequest(images: readonly PrescriptionImage[], model = PRESCRIPTION_MODEL): CreateParams {
  const content: Anthropic.Beta.Messages.BetaContentBlockParam[] = images.flatMap((image, index) => [
    { type: 'text' as const, text: `Imagen ${index + 1}:` },
    {
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: image.mediaType,
        data: Buffer.from(image.data).toString('base64'),
      },
    },
  ]);
  content.push({ type: 'text', text: READ_INSTRUCTION });

  return {
    model,
    max_tokens: 16000,
    // Si un clasificador de seguridad rechaza, la API reintenta con el modelo
    // de respaldo recomendado dentro de la misma llamada.
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    thinking: { type: 'adaptive' },
    system: PRESCRIPTION_SYSTEM_PROMPT,
    output_config: { format: { type: 'json_schema', schema: PRESCRIPTION_READING_JSON_SCHEMA } },
    messages: [{ role: 'user', content }],
  };
}

export function createClaudePrescriptionReader(create: CreateMessage, model = PRESCRIPTION_MODEL): PrescriptionReader {
  return {
    async read(images) {
      if (images.length === 0) return { ok: false, reason: 'no_images', detail: 'no se recibieron imágenes' };

      const response = await create(buildReadRequest(images, model));

      if (response.stop_reason === 'refusal') {
        const category = response.stop_details?.category ?? 'sin categoría';
        return { ok: false, reason: 'refusal', detail: `el modelo declinó la lectura (${category})` };
      }
      if (response.stop_reason === 'max_tokens') {
        return { ok: false, reason: 'max_tokens', detail: 'la respuesta se cortó por max_tokens' };
      }

      const text = response.content
        .flatMap((block) => (block.type === 'text' ? [block.text] : []))
        .join('');
      return parseReadingText(text, response.model);
    },
  };
}
