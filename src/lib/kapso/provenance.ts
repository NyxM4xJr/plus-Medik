import { normalizePhone } from '@/lib/phone';

export const KAPSO_EVENT_RECEIVED = 'whatsapp.message.received';
export const KAPSO_EVENT_SENT = 'whatsapp.message.sent';
export const KAPSO_ORIGIN_BUSINESS_APP = 'business_app';
export const KAPSO_ORIGIN_CLOUD_API = 'cloud_api';

const LIFECYCLE_EVENTS = new Set([
  'whatsapp.message.delivered',
  'whatsapp.message.read',
  'whatsapp.message.failed',
]);

export type MessageActor = 'customer' | 'human' | 'automation';
export type MessageDirection = 'inbound' | 'outbound';
export type MessageRole = 'user' | 'assistant';

export interface ObservedMessage {
  providerMessageId: string | null;
  providerConversationId: string | null;
  providerPhoneNumberId: string | null;
  customerPhone: string;
  messageTimestamp: string;
  direction: MessageDirection;
  role: MessageRole;
  actor: MessageActor;
  origin: string | null;
  status: string | null;
  content: string | null;
  contentType: string;
  metadata: Record<string, unknown> | null;
}

export type KapsoProvenance =
  | { kind: 'customer_inbound'; message: ObservedMessage }
  | { kind: 'human_outbound'; message: ObservedMessage }
  | { kind: 'system_outbound'; message: ObservedMessage }
  | { kind: 'lifecycle'; providerMessageId: string | null }
  | { kind: 'unknown' };

type Rec = Record<string, unknown>;

function rec(value: unknown): Rec | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Rec)
    : undefined;
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null;
}

function timestamp(value: unknown): string {
  const raw = typeof value === 'number' || typeof value === 'string' ? value : null;
  if (raw === null) return new Date().toISOString();

  if (typeof raw === 'number') {
    const ms = raw < 10_000_000_000 ? raw * 1000 : raw;
    const d = new Date(ms);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  if (typeof raw === 'string') {
    const numeric = Number(raw);
    if (Number.isFinite(numeric) && raw.trim() !== '') {
      const ms = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
      const d = new Date(ms);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }

  return new Date().toISOString();
}

function contentOf(message: Rec, type: string): string | null {
  if (type === 'text') return str(rec(message.text)?.body);
  if (['image', 'audio', 'video', 'document'].includes(type)) {
    return str(rec(message[type])?.caption);
  }
  if (type === 'interactive') return str(rec(rec(message.interactive)?.body)?.text);
  return null;
}

function mediaMetadata(message: Rec, type: string): Record<string, unknown> | null {
  if (!['image', 'audio', 'video', 'document'].includes(type)) return null;
  const media = rec(message[type]);
  if (!media) return { has_media: true };

  const metadata: Record<string, unknown> = { has_media: true };
  const id = str(media.id);
  const mime = str(media.mime_type);
  const filename = str(media.filename);
  if (id) metadata.media_id = id;
  if (mime) metadata.mime_type = mime;
  if (filename) metadata.filename = filename;
  return metadata;
}

function buildMessage(
  root: Rec,
  message: Rec,
  actor: MessageActor,
  direction: MessageDirection,
  role: MessageRole,
): ObservedMessage {
  const kapso = rec(message.kapso);
  const conversation = rec(root.conversation);
  const type = str(message.type) ?? 'unknown';
  const inbound = direction === 'inbound';
  const phoneSource =
    str(conversation?.phone_number) ?? (inbound ? str(message.from) : str(message.to)) ?? '';

  return {
    providerMessageId: str(message.id),
    providerConversationId: str(conversation?.id),
    providerPhoneNumberId: str(root.phone_number_id) ?? str(conversation?.phone_number_id),
    customerPhone: normalizePhone(phoneSource),
    messageTimestamp: timestamp(message.timestamp ?? root.timestamp ?? message.created_at),
    direction,
    role,
    actor,
    origin: str(kapso?.origin),
    status: str(kapso?.status),
    content: contentOf(message, type),
    contentType: type,
    metadata: mediaMetadata(message, type),
  };
}

export function parseKapsoProvenance(eventName: string | null, payload: unknown): KapsoProvenance {
  const root = rec(payload);
  if (!root) return { kind: 'unknown' };

  const message = rec(root.message);

  if (eventName && LIFECYCLE_EVENTS.has(eventName)) {
    return { kind: 'lifecycle', providerMessageId: str(message?.id) ?? str(root.message_id) };
  }

  if (!message) return { kind: 'unknown' };

  if (eventName === KAPSO_EVENT_RECEIVED) {
    return {
      kind: 'customer_inbound',
      message: buildMessage(root, message, 'customer', 'inbound', 'user'),
    };
  }

  if (eventName === KAPSO_EVENT_SENT) {
    const kapso = rec(message.kapso);
    const direction = str(kapso?.direction);
    const origin = str(kapso?.origin);

    if (direction === 'outbound' && origin === KAPSO_ORIGIN_BUSINESS_APP) {
      return {
        kind: 'human_outbound',
        message: buildMessage(root, message, 'human', 'outbound', 'assistant'),
      };
    }

    if (direction === 'outbound' && origin === KAPSO_ORIGIN_CLOUD_API) {
      return {
        kind: 'system_outbound',
        message: buildMessage(root, message, 'automation', 'outbound', 'assistant'),
      };
    }
  }

  return { kind: 'unknown' };
}
