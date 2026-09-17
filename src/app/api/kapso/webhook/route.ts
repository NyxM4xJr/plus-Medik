import { NextResponse } from 'next/server';
import { getServerEnv } from '@/lib/env';
import { parseKapsoProvenance } from '@/lib/kapso/provenance';
import { claimWebhookEvent, markWebhookEvent, persistObservedProvenance } from '@/lib/observer/store';
import { verifyKapsoSignature } from '@/lib/security/webhook-signature';
import { getSupabaseAdmin } from '@/lib/supabase/admin';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 30;

export async function POST(request: Request): Promise<Response> {
  const rawBody = await request.text();
  const signature = request.headers.get('x-webhook-signature');
  const eventName = request.headers.get('x-webhook-event');
  const payloadVersion = request.headers.get('x-webhook-payload-version');
  const idempotencyKey = request.headers.get('x-idempotency-key');

  const env = getServerEnv();

  if (!verifyKapsoSignature(rawBody, signature, env.KAPSO_WEBHOOK_SECRET)) {
    return NextResponse.json({ ok: false, error: 'invalid_signature' }, { status: 401 });
  }

  if (!eventName || !idempotencyKey) {
    return NextResponse.json({ ok: false, error: 'missing_webhook_headers' }, { status: 400 });
  }

  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid_json' }, { status: 400 });
  }

  const supabase = getSupabaseAdmin();

  try {
    const claim = await claimWebhookEvent(supabase, {
      idempotencyKey,
      eventName,
      payloadVersion,
    });

    if (claim === 'duplicate') {
      return NextResponse.json({ ok: true, duplicate: true }, { status: 200 });
    }

    const provenance = parseKapsoProvenance(eventName, payload);
    const result = await persistObservedProvenance(
      supabase,
      provenance,
      env.HUMAN_TAKEOVER_PAUSE_MINUTES,
    );

    await markWebhookEvent(supabase, idempotencyKey, 'processed');

    return NextResponse.json(
      {
        ok: true,
        kind: provenance.kind,
        persisted: result.persisted,
        duplicate_message: result.duplicate ?? false,
      },
      { status: 200 },
    );
  } catch (error) {
    try {
      await markWebhookEvent(supabase, idempotencyKey, 'failed', 'processing_error');
    } catch {
      // El error original es el relevante. El webhook devolverá 500 para permitir reintento.
    }

    console.error('kapso_webhook_failed', {
      event: eventName,
      reason: error instanceof Error ? error.message : 'unknown',
    });

    return NextResponse.json({ ok: false, error: 'processing_error' }, { status: 500 });
  }
}
