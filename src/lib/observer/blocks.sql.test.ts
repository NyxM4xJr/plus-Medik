import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@/test/pglite';

const GAP = 60;
const MAX = 600;
const T0 = Date.parse('2026-09-24T12:00:00Z');

function at(seconds: number): string {
  return new Date(T0 + seconds * 1000).toISOString();
}

interface AttachRow {
  block_id: string;
  block_sequence: number;
  opened_new_block: boolean;
  closed_block_id: string | null;
}

interface BlockRow {
  id: string;
  status: string;
  close_reason: string | null;
  opened_at: Date;
  last_message_at: Date;
  message_count: number;
  text_count: number;
  image_count: number;
  document_count: number;
  other_count: number;
}

let db: PGlite;
let messageCounter = 0;

async function conversation(phone = '59170000001'): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_conversations (customer_phone) values ($1) returning id`,
    [phone],
  );
  return rows[0].id;
}

async function message(
  conversationId: string,
  contentType: string,
  seconds: number,
  direction: 'inbound' | 'outbound' = 'inbound',
): Promise<string> {
  messageCounter += 1;
  const role = direction === 'inbound' ? 'user' : 'assistant';
  const actor = direction === 'inbound' ? 'customer' : 'human';
  const { rows } = await db.query<{ id: string }>(
    `insert into agent_messages
       (agent_conversation_id, provider_message_id, direction, role, actor, content_type, message_timestamp)
     values ($1, $2, $3, $4, $5, $6, $7)
     returning id`,
    [conversationId, `wamid.${messageCounter}`, direction, role, actor, contentType, at(seconds)],
  );
  return rows[0].id;
}

async function attach(messageId: string, gap = GAP, max = MAX): Promise<AttachRow> {
  const { rows } = await db.query<AttachRow>(
    `select * from attach_inbound_message_to_block($1, $2, $3)`,
    [messageId, gap, max],
  );
  return rows[0];
}

async function inbound(conversationId: string, contentType: string, seconds: number) {
  return attach(await message(conversationId, contentType, seconds));
}

async function blocks(conversationId: string): Promise<BlockRow[]> {
  const { rows } = await db.query<BlockRow>(
    `select * from agent_message_blocks where agent_conversation_id = $1 order by opened_at`,
    [conversationId],
  );
  return rows;
}

async function closeOnHuman(conversationId: string, seconds: number): Promise<string | null> {
  const { rows } = await db.query<{ closed: string | null }>(
    `select close_open_block_on_human_outbound($1, $2) as closed`,
    [conversationId, at(seconds)],
  );
  return rows[0].closed;
}

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('truncate agent_conversations cascade');
});

describe('attach_inbound_message_to_block', () => {
  it('agrupa texto y una receta de tres imágenes en un solo bloque ordenado', async () => {
    const conv = await conversation();

    const results = [
      await inbound(conv, 'text', 0),
      await inbound(conv, 'image', 5),
      await inbound(conv, 'image', 6),
      await inbound(conv, 'image', 8),
    ];

    expect(new Set(results.map((r) => r.block_id)).size).toBe(1);
    expect(results.map((r) => r.block_sequence)).toEqual([1, 2, 3, 4]);
    expect(results.map((r) => r.opened_new_block)).toEqual([true, false, false, false]);

    const [block] = await blocks(conv);
    expect(block).toMatchObject({
      status: 'open',
      message_count: 4,
      text_count: 1,
      image_count: 3,
      document_count: 0,
      other_count: 0,
    });
    expect(block.opened_at.toISOString()).toBe(at(0));
    expect(block.last_message_at.toISOString()).toBe(at(8));
  });

  it('cuenta documentos y clasifica sticker/audio como other', async () => {
    const conv = await conversation();

    await inbound(conv, 'document', 0);
    await inbound(conv, 'sticker', 1);
    await inbound(conv, 'audio', 2);

    const [block] = await blocks(conv);
    expect(block).toMatchObject({ document_count: 1, other_count: 2, message_count: 3 });
  });

  it('la ventana de silencio se mide desde el último mensaje, no desde el primero', async () => {
    const conv = await conversation();

    const first = await inbound(conv, 'text', 0);
    const second = await inbound(conv, 'image', 50);
    const third = await inbound(conv, 'image', 100);

    expect(second.block_id).toBe(first.block_id);
    expect(third.block_id).toBe(first.block_id);
  });

  it('un mensaje justo en el límite de la ventana sigue en el bloque', async () => {
    const conv = await conversation();

    const first = await inbound(conv, 'text', 0);
    const edge = await inbound(conv, 'image', GAP);

    expect(edge.block_id).toBe(first.block_id);
  });

  it('abre un bloque nuevo y cierra el anterior con gap tras el silencio', async () => {
    const conv = await conversation();

    const first = await inbound(conv, 'text', 0);
    const later = await inbound(conv, 'text', GAP + 1);

    expect(later.block_id).not.toBe(first.block_id);
    expect(later.block_sequence).toBe(1);
    expect(later.opened_new_block).toBe(true);
    expect(later.closed_block_id).toBe(first.block_id);

    const [closed, open] = await blocks(conv);
    expect(closed).toMatchObject({ status: 'closed', close_reason: 'gap', message_count: 1 });
    expect(open).toMatchObject({ status: 'open', message_count: 1 });
  });

  it('cierra por max_duration aunque el cliente nunca haga silencio', async () => {
    const conv = await conversation();
    const shortMax = 120;
    const send = async (type: string, seconds: number) =>
      attach(await message(conv, type, seconds), GAP, shortMax);

    await send('text', 0);
    await send('image', 50);
    await send('image', 100);
    const overflow = await send('image', 150);

    const result = await blocks(conv);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ close_reason: 'max_duration', message_count: 3 });
    expect(overflow.block_sequence).toBe(1);
  });

  it('es idempotente: reintentar no duplica ni infla contadores', async () => {
    const conv = await conversation();
    const messageId = await message(conv, 'image', 0);

    const first = await attach(messageId);
    const retry = await attach(messageId);

    expect(retry).toEqual({ ...first, opened_new_block: false, closed_block_id: null });
    const [block] = await blocks(conv);
    expect(block.message_count).toBe(1);
    expect(block.image_count).toBe(1);
  });

  it('un mensaje atrasado se suma al bloque abierto y adelanta opened_at', async () => {
    const conv = await conversation();

    const first = await inbound(conv, 'image', 10);
    const late = await inbound(conv, 'text', 2);

    expect(late.block_id).toBe(first.block_id);
    expect(late.block_sequence).toBe(2);

    const [block] = await blocks(conv);
    expect(block.opened_at.toISOString()).toBe(at(2));
    expect(block.last_message_at.toISOString()).toBe(at(10));
  });

  it('mantiene bloques independientes por conversación', async () => {
    const a = await conversation('59170000001');
    const b = await conversation('59170000002');

    const inA = await inbound(a, 'image', 0);
    const inB = await inbound(b, 'image', 1);

    expect(inA.block_id).not.toBe(inB.block_id);
    expect(inB.block_sequence).toBe(1);
  });

  it('rechaza mensajes salientes', async () => {
    const conv = await conversation();
    const outbound = await message(conv, 'text', 0, 'outbound');

    await expect(attach(outbound)).rejects.toThrow('message_not_inbound');
  });

  it('rechaza ventanas inválidas', async () => {
    const conv = await conversation();
    const messageId = await message(conv, 'text', 0);

    await expect(attach(messageId, 0, MAX)).rejects.toThrow('invalid_gap_seconds');
    await expect(attach(messageId, GAP, GAP - 1)).rejects.toThrow('invalid_max_seconds');
  });

  it('no permite dos bloques abiertos en la misma conversación', async () => {
    const conv = await conversation();
    await inbound(conv, 'text', 0);

    await expect(
      db.query(
        `insert into agent_message_blocks (agent_conversation_id, opened_at, last_message_at)
         values ($1, now(), now())`,
        [conv],
      ),
    ).rejects.toThrow(/uq_agent_message_blocks_one_open/);
  });
});

describe('close_open_block_on_human_outbound', () => {
  it('cierra el bloque abierto y el siguiente mensaje abre otro', async () => {
    const conv = await conversation();
    const before = await inbound(conv, 'image', 0);

    expect(await closeOnHuman(conv, 5)).toBe(before.block_id);

    const after = await inbound(conv, 'text', 10);
    expect(after.block_id).not.toBe(before.block_id);
    expect(after.opened_new_block).toBe(true);
    expect(after.closed_block_id).toBeNull();

    const [closed] = await blocks(conv);
    expect(closed).toMatchObject({ status: 'closed', close_reason: 'human_outbound' });
  });

  it('una reentrega tardía del mensaje humano no cierra un bloque posterior', async () => {
    const conv = await conversation();
    await inbound(conv, 'text', 100);

    expect(await closeOnHuman(conv, 50)).toBeNull();

    const [block] = await blocks(conv);
    expect(block.status).toBe('open');
  });

  it('sin bloque abierto no hace nada', async () => {
    const conv = await conversation();
    expect(await closeOnHuman(conv, 0)).toBeNull();
  });
});

describe('agent_message_attachments', () => {
  it('registra el adjunto sin descargarlo ni interpretarlo', async () => {
    const conv = await conversation();
    const messageId = await message(conv, 'image', 0);

    const { rows } = await db.query<{ download_status: string; interpretation_status: string }>(
      `insert into agent_message_attachments (agent_message_id, kind, provider_media_id, mime_type)
       values ($1, 'image', 'media-1', 'image/jpeg')
       returning download_status, interpretation_status`,
      [messageId],
    );

    expect(rows[0]).toEqual({
      download_status: 'not_requested',
      interpretation_status: 'not_requested',
    });
  });

  it('un mensaje tiene a lo sumo un adjunto', async () => {
    const conv = await conversation();
    const messageId = await message(conv, 'image', 0);
    const insert = `insert into agent_message_attachments (agent_message_id, kind) values ($1, 'image')`;

    await db.query(insert, [messageId]);
    await expect(db.query(insert, [messageId])).rejects.toThrow(/duplicate key/);
  });
});
