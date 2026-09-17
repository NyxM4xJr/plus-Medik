import type { SupabaseClient } from '@supabase/supabase-js';
import type { KapsoProvenance, ObservedMessage } from '@/lib/kapso/provenance';

export async function claimWebhookEvent(
  supabase: SupabaseClient,
  input: {
    idempotencyKey: string;
    eventName: string;
    payloadVersion: string | null;
  },
): Promise<'claimed' | 'duplicate'> {
  const { error } = await supabase.from('webhook_events').insert({
    idempotency_key: input.idempotencyKey,
    event_name: input.eventName,
    payload_version: input.payloadVersion,
    status: 'processing',
  });

  if (!error) return 'claimed';
  if (error.code === '23505') return 'duplicate';
  throw new Error(`webhook_events.insert: ${error.message}`);
}

export async function markWebhookEvent(
  supabase: SupabaseClient,
  idempotencyKey: string,
  status: 'processed' | 'failed',
  errorCode?: string,
): Promise<void> {
  const { error } = await supabase
    .from('webhook_events')
    .update({
      status,
      error_code: errorCode ?? null,
      processed_at: new Date().toISOString(),
    })
    .eq('idempotency_key', idempotencyKey);

  if (error) throw new Error(`webhook_events.update: ${error.message}`);
}

async function upsertConversation(
  supabase: SupabaseClient,
  message: ObservedMessage,
): Promise<string> {
  if (!message.customerPhone) throw new Error('missing_customer_phone');

  const { data, error } = await supabase
    .from('agent_conversations')
    .upsert(
      {
        customer_phone: message.customerPhone,
        last_provider_conversation_id: message.providerConversationId,
        provider_phone_number_id: message.providerPhoneNumberId,
        last_message_at: message.messageTimestamp,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'customer_phone' },
    )
    .select('id')
    .single();

  if (error || !data) throw new Error(`agent_conversations.upsert: ${error?.message ?? 'no_data'}`);
  return data.id as string;
}

async function insertMessage(
  supabase: SupabaseClient,
  conversationId: string,
  message: ObservedMessage,
): Promise<'inserted' | 'duplicate'> {
  const { error } = await supabase.from('agent_messages').insert({
    agent_conversation_id: conversationId,
    provider_message_id: message.providerMessageId,
    provider_conversation_id: message.providerConversationId,
    direction: message.direction,
    role: message.role,
    actor: message.actor,
    origin: message.origin,
    status: message.status,
    content: message.content,
    content_type: message.contentType,
    metadata: message.metadata,
    message_timestamp: message.messageTimestamp,
  });

  if (!error) return 'inserted';
  if (error.code === '23505') return 'duplicate';
  throw new Error(`agent_messages.insert: ${error.message}`);
}

async function applyObservedHumanTakeover(
  supabase: SupabaseClient,
  conversationId: string,
  message: ObservedMessage,
  pauseMinutes: number,
): Promise<void> {
  if (!message.providerMessageId) return;

  const pauseExpiresAt = new Date(
    Date.parse(message.messageTimestamp) + pauseMinutes * 60_000,
  ).toISOString();

  const { error } = await supabase.rpc('apply_observed_human_takeover', {
    p_conversation_id: conversationId,
    p_provider_message_id: message.providerMessageId,
    p_message_timestamp: message.messageTimestamp,
    p_pause_expires_at: pauseExpiresAt,
  });

  if (error) throw new Error(`apply_observed_human_takeover: ${error.message}`);
}

export async function persistObservedProvenance(
  supabase: SupabaseClient,
  provenance: KapsoProvenance,
  pauseMinutes: number,
): Promise<{ persisted: boolean; duplicate?: boolean }> {
  if (
    provenance.kind === 'unknown' ||
    provenance.kind === 'lifecycle'
  ) {
    return { persisted: false };
  }

  const conversationId = await upsertConversation(supabase, provenance.message);
  const inserted = await insertMessage(supabase, conversationId, provenance.message);

  if (inserted === 'duplicate') return { persisted: true, duplicate: true };

  if (provenance.kind === 'human_outbound') {
    await applyObservedHumanTakeover(supabase, conversationId, provenance.message, pauseMinutes);
  }

  return { persisted: true, duplicate: false };
}
