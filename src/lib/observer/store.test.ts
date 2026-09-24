import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';
import { parseKapsoProvenance, type KapsoProvenance } from '@/lib/kapso/provenance';
import { claimWebhookEvent, persistObservedProvenance, type PersistOptions } from './store';

interface Call {
  table?: string;
  rpc?: string;
  op: 'select' | 'insert' | 'update' | 'upsert' | 'rpc';
  payload?: unknown;
  options?: unknown;
  filters: Record<string, unknown>;
}

interface Reply {
  data?: unknown;
  error?: { code?: string; message: string } | null;
}

type Responder = (call: Call) => Reply | undefined;

interface Builder extends PromiseLike<Reply> {
  insert(payload: unknown): Builder;
  update(payload: unknown): Builder;
  upsert(payload: unknown, options?: unknown): Builder;
  select(columns?: string): Builder;
  eq(column: string, value: unknown): Builder;
  limit(count: number): Builder;
  single(): Builder;
}

/** Cliente falso: registra cada llamada y responde según el test. */
function fakeSupabase(responder: Responder) {
  const calls: Call[] = [];

  function resolve(call: Call): Required<Reply> {
    calls.push(call);
    const reply = responder(call) ?? {};
    return { data: reply.data ?? null, error: reply.error ?? null };
  }

  function from(table: string): Builder {
    const call: Call = { table, op: 'select', filters: {} };
    const builder: Builder = {
      insert(payload) {
        call.op = 'insert';
        call.payload = payload;
        return builder;
      },
      update(payload) {
        call.op = 'update';
        call.payload = payload;
        return builder;
      },
      upsert(payload, options) {
        call.op = 'upsert';
        call.payload = payload;
        call.options = options;
        return builder;
      },
      select() {
        return builder;
      },
      eq(column, value) {
        call.filters[column] = value;
        return builder;
      },
      limit() {
        return builder;
      },
      single() {
        return builder;
      },
      then(onFulfilled, onRejected) {
        return Promise.resolve(resolve(call)).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  const client = {
    from,
    rpc: async (name: string, args: unknown) =>
      resolve({ rpc: name, op: 'rpc', payload: args, filters: {} }),
  } as unknown as SupabaseClient;

  const rpcNames = () => calls.filter((c) => c.rpc).map((c) => c.rpc);
  const tableCalls = (table: string, op?: Call['op']) =>
    calls.filter((c) => c.table === table && (!op || c.op === op));

  return { client, calls, rpcNames, tableCalls };
}

const OPTIONS: PersistOptions = {
  pauseMinutes: 30,
  blockWindow: { gapSeconds: 60, maxSeconds: 600 },
};

const base = {
  phone_number_id: 'pn-1',
  conversation: { id: 'conv-1', phone_number: '+591 700-00001' },
};

function customer(message: Record<string, unknown>): KapsoProvenance {
  return parseKapsoProvenance('whatsapp.message.received', {
    ...base,
    message: { timestamp: '1780000000', from: '59170000001', ...message },
  });
}

function human(id = 'wamid.human'): KapsoProvenance {
  return parseKapsoProvenance('whatsapp.message.sent', {
    ...base,
    message: {
      id,
      type: 'text',
      timestamp: '1780000100',
      to: '59170000001',
      text: { body: 'Le ayudo' },
      kapso: { direction: 'outbound', origin: 'business_app' },
    },
  });
}

const BLOCK_ROW = {
  block_id: 'block-1',
  block_sequence: 2,
  opened_new_block: false,
  closed_block_id: null,
};

/** Base de datos «feliz»: todo se inserta; se puede forzar duplicado del mensaje. */
function happyPath(overrides: { duplicateMessage?: boolean; pauseEventExists?: boolean } = {}) {
  return (call: Call): Reply | undefined => {
    if (call.table === 'agent_conversations') return { data: { id: 'conv-uuid' } };
    if (call.table === 'agent_messages' && call.op === 'insert') {
      return overrides.duplicateMessage
        ? { error: { code: '23505', message: 'duplicate key' } }
        : { data: { id: 'msg-uuid' } };
    }
    if (call.table === 'agent_messages' && call.op === 'select') return { data: { id: 'msg-existing' } };
    if (call.table === 'agent_control_events') {
      return { data: overrides.pauseEventExists ? [{ id: 'evt-1' }] : [] };
    }
    if (call.rpc === 'attach_inbound_message_to_block') return { data: [BLOCK_ROW] };
    return undefined;
  };
}

describe('claimWebhookEvent', () => {
  const input = {
    idempotencyKey: 'key-1',
    eventName: 'whatsapp.message.received',
    payloadVersion: 'v2',
    staleSeconds: 120,
  };

  it('reclama con un solo RPC y le pasa el umbral de atascado', async () => {
    const db = fakeSupabase(() => ({ data: [{ claimed: true, attempts: 1 }] }));

    await expect(claimWebhookEvent(db.client, input)).resolves.toBe('claimed');
    expect(db.calls).toEqual([
      {
        rpc: 'claim_webhook_event',
        op: 'rpc',
        filters: {},
        payload: {
          p_idempotency_key: 'key-1',
          p_event_name: 'whatsapp.message.received',
          p_payload_version: 'v2',
          p_stale_seconds: 120,
        },
      },
    ]);
  });

  it('claimed=false es duplicado', async () => {
    const db = fakeSupabase(() => ({ data: [{ claimed: false, attempts: 3 }] }));
    await expect(claimWebhookEvent(db.client, input)).resolves.toBe('duplicate');
  });

  it('propaga errores del RPC para que Kapso reintente', async () => {
    const db = fakeSupabase(() => ({ error: { message: 'boom' } }));
    await expect(claimWebhookEvent(db.client, input)).rejects.toThrow('claim_webhook_event: boom');
  });

  it('una respuesta vacía es un error, no un duplicado silencioso', async () => {
    const db = fakeSupabase(() => ({ data: [] }));
    await expect(claimWebhookEvent(db.client, input)).rejects.toThrow('claim_webhook_event: no_data');
  });
});

describe('persistObservedProvenance', () => {
  it('asigna un texto a su bloque sin registrar adjunto', async () => {
    const db = fakeSupabase(happyPath());

    const result = await persistObservedProvenance(
      db.client,
      customer({ id: 'wamid.t', type: 'text', text: { body: 'Hola' } }),
      OPTIONS,
    );

    expect(result).toEqual({
      persisted: true,
      duplicate: false,
      conversationId: 'conv-uuid',
      messageId: 'msg-uuid',
      block: { blockId: 'block-1', sequence: 2, openedNewBlock: false, closedBlockId: null },
    });
    expect(db.calls.find((c) => c.rpc === 'attach_inbound_message_to_block')?.payload).toEqual({
      p_message_id: 'msg-uuid',
      p_gap_seconds: 60,
      p_max_seconds: 600,
    });
    expect(db.tableCalls('agent_message_attachments')).toHaveLength(0);
  });

  it('registra la imagen como adjunto pendiente, sin URL ni interpretación', async () => {
    const db = fakeSupabase(happyPath());

    await persistObservedProvenance(
      db.client,
      customer({
        id: 'wamid.img',
        type: 'image',
        image: { id: 'media-1', mime_type: 'image/jpeg', sha256: 'abc', caption: 'Receta' },
      }),
      OPTIONS,
    );

    const [upsert] = db.tableCalls('agent_message_attachments', 'upsert');
    expect(upsert.payload).toEqual({
      agent_message_id: 'msg-uuid',
      kind: 'image',
      provider_media_id: 'media-1',
      mime_type: 'image/jpeg',
      filename: null,
      sha256: 'abc',
      file_size_bytes: null,
    });
    expect(upsert.options).toEqual({ onConflict: 'agent_message_id', ignoreDuplicates: true });
  });

  it('registra un documento', async () => {
    const db = fakeSupabase(happyPath());

    await persistObservedProvenance(
      db.client,
      customer({
        id: 'wamid.doc',
        type: 'document',
        document: { id: 'media-2', mime_type: 'application/pdf', filename: 'orden.pdf' },
      }),
      OPTIONS,
    );

    const [upsert] = db.tableCalls('agent_message_attachments', 'upsert');
    expect(upsert.payload).toMatchObject({ kind: 'document', filename: 'orden.pdf' });
  });

  it('un mensaje repetido completa bloque y adjunto usando el id existente', async () => {
    const db = fakeSupabase(happyPath({ duplicateMessage: true }));

    const result = await persistObservedProvenance(
      db.client,
      customer({ id: 'wamid.img', type: 'image', image: { id: 'media-1' } }),
      OPTIONS,
    );

    expect(result.duplicate).toBe(true);
    expect(result.messageId).toBe('msg-existing');
    expect(db.tableCalls('agent_messages', 'select')[0].filters).toEqual({
      provider_message_id: 'wamid.img',
    });
    expect(db.calls.find((c) => c.rpc === 'attach_inbound_message_to_block')?.payload).toMatchObject({
      p_message_id: 'msg-existing',
    });
    expect(db.tableCalls('agent_message_attachments', 'upsert')).toHaveLength(1);
  });

  it('un mensaje humano aplica takeover y cierra el bloque abierto', async () => {
    const db = fakeSupabase(happyPath());

    const result = await persistObservedProvenance(db.client, human(), OPTIONS);

    expect(result.block).toBeNull();
    expect(db.rpcNames()).toEqual([
      'apply_observed_human_takeover',
      'close_open_block_on_human_outbound',
    ]);

    const takeover = db.calls.find((c) => c.rpc === 'apply_observed_human_takeover');
    expect(takeover?.payload).toMatchObject({
      p_provider_message_id: 'wamid.human',
      p_pause_expires_at: new Date(1_780_000_100_000 + 30 * 60_000).toISOString(),
    });
  });

  it('un mensaje humano repetido no reaplica un takeover ya registrado', async () => {
    const db = fakeSupabase(happyPath({ duplicateMessage: true, pauseEventExists: true }));

    await persistObservedProvenance(db.client, human(), OPTIONS);

    expect(db.rpcNames()).toEqual(['close_open_block_on_human_outbound']);
  });

  it('un mensaje humano repetido completa el takeover que había fallado', async () => {
    const db = fakeSupabase(happyPath({ duplicateMessage: true, pauseEventExists: false }));

    await persistObservedProvenance(db.client, human(), OPTIONS);

    expect(db.rpcNames()).toEqual([
      'apply_observed_human_takeover',
      'close_open_block_on_human_outbound',
    ]);
  });

  it('un saliente automático no toca takeover ni bloques', async () => {
    const db = fakeSupabase(happyPath());
    const provenance = parseKapsoProvenance('whatsapp.message.sent', {
      ...base,
      message: {
        id: 'wamid.api',
        type: 'text',
        timestamp: '1780000100',
        to: '59170000001',
        text: { body: 'Automático' },
        kapso: { direction: 'outbound', origin: 'cloud_api' },
      },
    });

    await persistObservedProvenance(db.client, provenance, OPTIONS);

    expect(db.rpcNames()).toEqual([]);
    expect(db.tableCalls('agent_message_attachments')).toHaveLength(0);
  });

  it('lifecycle y unknown no escriben nada', async () => {
    const db = fakeSupabase(happyPath());

    await persistObservedProvenance(db.client, { kind: 'lifecycle', providerMessageId: 'x' }, OPTIONS);
    await persistObservedProvenance(db.client, { kind: 'unknown' }, OPTIONS);

    expect(db.calls).toHaveLength(0);
  });

  it('si falla la asignación al bloque, el error se propaga para que Kapso reintente', async () => {
    const db = fakeSupabase((call) =>
      call.rpc === 'attach_inbound_message_to_block'
        ? { error: { message: 'lock timeout' } }
        : happyPath()(call),
    );

    await expect(
      persistObservedProvenance(
        db.client,
        customer({ id: 'wamid.t', type: 'text', text: { body: 'Hola' } }),
        OPTIONS,
      ),
    ).rejects.toThrow('attach_inbound_message_to_block: lock timeout');
  });
});
