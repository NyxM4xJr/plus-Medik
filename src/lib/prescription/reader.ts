import { prescriptionReadingSchema, type PrescriptionReading } from '@/lib/prescription/reading';

/**
 * Contrato común de los lectores de recetas (Claude, OpenAI). Cada lector
 * solo transcribe; lo que viene después no depende del proveedor.
 */

export const IMAGE_MEDIA_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;
export type ImageMediaType = (typeof IMAGE_MEDIA_TYPES)[number];

export interface PrescriptionImage {
  data: Uint8Array;
  mediaType: ImageMediaType;
}

export type ReadFailure = 'no_images' | 'refusal' | 'max_tokens' | 'invalid_output';

export type ReadOutcome =
  | { ok: true; reading: PrescriptionReading; model: string }
  | { ok: false; reason: ReadFailure; detail: string };

export interface PrescriptionReader {
  read(images: readonly PrescriptionImage[]): Promise<ReadOutcome>;
}

export const READ_INSTRUCTION = 'Transcribe los exámenes solicitados en esta orden.';

/** Texto JSON del modelo → lectura validada. Los errores nombran campos, nunca valores. */
export function parseReadingText(text: string, model: string): ReadOutcome {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'invalid_output', detail: 'la respuesta no es JSON' };
  }

  const parsed = prescriptionReadingSchema.safeParse(json);
  if (!parsed.success) {
    const paths = [...new Set(parsed.error.issues.map((issue) => issue.path.join('.') || '(raíz)'))];
    return { ok: false, reason: 'invalid_output', detail: `campos inválidos: ${paths.join(', ')}` };
  }

  return { ok: true, reading: parsed.data, model };
}
