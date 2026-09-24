export const MEDIA_TYPES = ['image', 'document', 'audio', 'video', 'sticker'] as const;

export type AttachmentKind = (typeof MEDIA_TYPES)[number];

export interface ObservedAttachment {
  kind: AttachmentKind;
  providerMediaId: string | null;
  mimeType: string | null;
  filename: string | null;
  sha256: string | null;
  fileSizeBytes: number | null;
}

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function size(value: unknown): number | null {
  const numeric = typeof value === 'string' && value.trim() !== '' ? Number(value) : value;
  return typeof numeric === 'number' && Number.isSafeInteger(numeric) && numeric >= 0
    ? numeric
    : null;
}

export function isMediaType(type: string): type is AttachmentKind {
  return (MEDIA_TYPES as readonly string[]).includes(type);
}

/**
 * Datos técnicos del archivo adjunto a un mensaje.
 *
 * Lee el formato de Meta (`message.<tipo>`) y, como respaldo, `message.kapso.media_data`.
 * La forma real que envía Kapso para archivos aún no está confirmada (ver docs/BITACORA.md).
 * Nunca guarda URLs de descarga ni el pie de foto: el pie ya queda en agent_messages.content.
 */
export function extractAttachment(message: Rec, type: string): ObservedAttachment | null {
  if (!isMediaType(type)) return null;

  const media = rec(message[type]);
  const kapsoMedia = rec(rec(message.kapso)?.media_data);

  return {
    kind: type,
    providerMediaId: str(media?.id),
    mimeType: str(media?.mime_type) ?? str(kapsoMedia?.content_type),
    filename: str(media?.filename) ?? str(kapsoMedia?.filename),
    sha256: str(media?.sha256),
    fileSizeBytes: size(media?.file_size) ?? size(kapsoMedia?.byte_size),
  };
}
