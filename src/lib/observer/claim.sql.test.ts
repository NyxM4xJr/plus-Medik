import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDatabase } from '@/test/pglite';

const STALE = 120;

interface ClaimRow {
  claimed: boolean;
  attempts: number;
}

let db: PGlite;

async function claim(key = 'key-1', stale = STALE): Promise<ClaimRow> {
  const { rows } = await db.query<ClaimRow>(
    `select * from claim_webhook_event($1, 'whatsapp.message.received', 'v2', $2)`,
    [key, stale],
  );
  return rows[0];
}

async function setEvent(key: string, status: string, claimedSecondsAgo: number | null) {
  await db.query(
    `update webhook_events
     set status = $2,
         claimed_at = case when $3::integer is null then null
                           else now() - make_interval(secs => $3::integer) end,
         received_at = now() - interval '1 hour'
     where idempotency_key = $1`,
    [key, status, claimedSecondsAgo],
  );
}

beforeAll(async () => {
  db = await createTestDatabase();
}, 60_000);

afterAll(async () => {
  await db?.close();
});

beforeEach(async () => {
  await db.exec('truncate webhook_events');
});

describe('claim_webhook_event', () => {
  it('reclama un evento nuevo en su primer intento', async () => {
    expect(await claim()).toEqual({ claimed: true, attempts: 1 });

    const { rows } = await db.query<{ status: string; claimed_at: Date | null }>(
      `select status, claimed_at from webhook_events`,
    );
    expect(rows[0].status).toBe('processing');
    expect(rows[0].claimed_at).not.toBeNull();
  });

  it('un evento procesado es duplicado', async () => {
    await claim();
    await setEvent('key-1', 'processed', 3600);

    expect(await claim()).toEqual({ claimed: false, attempts: 1 });
  });

  it('un evento fallido se reclama y cuenta el intento', async () => {
    await claim();
    await setEvent('key-1', 'failed', 5);

    expect(await claim()).toEqual({ claimed: true, attempts: 2 });

    const { rows } = await db.query<{ status: string; error_code: string | null }>(
      `select status, error_code from webhook_events`,
    );
    expect(rows[0]).toEqual({ status: 'processing', error_code: null });
  });

  it('un evento en proceso reciente es duplicado: otro intento sigue vivo', async () => {
    await claim();
    await setEvent('key-1', 'processing', STALE - 10);

    expect(await claim()).toEqual({ claimed: false, attempts: 1 });
  });

  it('un evento atascado en processing se reclama pasado el umbral', async () => {
    await claim();
    await setEvent('key-1', 'processing', STALE + 10);

    expect(await claim()).toEqual({ claimed: true, attempts: 2 });
  });

  it('tras reclamarlo, un reintento inmediato vuelve a ser duplicado', async () => {
    await claim();
    await setEvent('key-1', 'processing', STALE + 10);

    await claim();
    expect(await claim()).toEqual({ claimed: false, attempts: 2 });
  });

  it('filas anteriores a la migración (claimed_at null) usan received_at', async () => {
    await claim();
    await setEvent('key-1', 'processing', null);

    expect(await claim()).toEqual({ claimed: true, attempts: 2 });
  });

  it('rechaza umbrales menores a 60 segundos', async () => {
    await expect(claim('key-1', 30)).rejects.toThrow('invalid_stale_seconds');
  });
});
