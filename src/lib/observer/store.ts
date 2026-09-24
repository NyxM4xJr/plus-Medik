import type { SupabaseClient } from '@supabase/supabase-js';
import type { PayloadDiagnostics } from '@/lib/attribution/debug';
import type { ReferralAttribution } from '@/lib/attribution/referral';
import type { KapsoProvenance, ObservedMessage } from '@/lib/kapso/provenance';

export interface BlockWindow {
  gapSeconds: number;
  maxSeconds: number;
}

export interface BlockAssignment {
  blockId: string;
  sequence: number;
  openedNewBlock: boolean;
  closedBlockId: string | null;
}

export interface PersistOptions {
  pauseMinutes: number;
  blockWindow: BlockWindow;
}

export interface PersistResult {
  persisted: boolean;
  duplicate?: boolean;
  conversationId?: string;
  messageId?: string;
  block?: BlockAssignment | null;
}

/**
 * Reclama el evento para procesarlo. Un evento 'failed', o atascado en
 * 'processing' más de staleSeconds, se vuelve a reclamar en el reintento.
 */
export async function claimWebhookEvent(
  supabase: SupabaseClient,
  input: {
    idempotencyKey: string;
    eventName: string;
    payloadVersion: string | null;
    staleSeconds: number;
  },
): Promise<'claimed' | 'duplicate'> {
  const { data, error } = await supabase.rpc('claim_webhook_event', {
    p_idempotency_key: input.idempotencyKey,
    p_event_name: input.eventName,
    p_payload_version: input.payloadVersion,
    p_stale_seconds: input.staleSeconds,
  });

  if (error) throw new Error(`claim_webhook_event: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error('claim_webhook_event: no_data');

  return row.claimed === true ? 'claimed' : 'duplicate';
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

async function findMessageId(
  supabase: SupabaseClient,
  providerMessageId: string,
): Promise<string> {
  const { data, error } = await supabase
    .from('agent_messages')
    .select('id')
    .eq('provider_message_id', providerMessageId)
    .single();

  if (error || !data) throw new Error(`agent_messages.select: ${error?.message ?? 'no_data'}`);
  return data.id as string;
}

async function insertMessage(
  supabase: SupabaseClient,
  conversationId: string,
  message: ObservedMessage,
): Promise<{ status: 'inserted' | 'duplicate'; messageId: string }> {
  const { data, error } = await supabase
    .from('agent_messages')
    .insert({
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
    })
    .select('id')
    .single();

  if (!error && data) return { status: 'inserted', messageId: data.id as string };
  if (error?.code === '23505' && message.providerMessageId) {
    return {
      status: 'duplicate',
      messageId: await findMessageId(supabase, message.providerMessageId),
    };
  }
  throw new Error(`agent_messages.insert: ${error?.message ?? 'no_data'}`);
}

/** Registra el archivo adjunto sin descargarlo. Idempotente por mensaje. */
async function registerAttachment(
  supabase: SupabaseClient,
  messageId: string,
  message: ObservedMessage,
): Promise<void> {
  if (!message.attachment) return;

  const { error } = await supabase.from('agent_message_attachments').upsert(
    {
      agent_message_id: messageId,
      kind: message.attachment.kind,
      provider_media_id: message.attachment.providerMediaId,
      mime_type: message.attachment.mimeType,
      filename: message.attachment.filename,
      sha256: message.attachment.sha256,
      file_size_bytes: message.attachment.fileSizeBytes,
    },
    { onConflict: 'agent_message_id', ignoreDuplicates: true },
  );

  if (error) throw new Error(`agent_message_attachments.upsert: ${error.message}`);
}

/** Asigna el mensaje entrante a su bloque. El RPC es idempotente. */
async function attachToBlock(
  supabase: SupabaseClient,
  messageId: string,
  window: BlockWindow,
): Promise<BlockAssignment> {
  const { data, error } = await supabase.rpc('attach_inbound_message_to_block', {
    p_message_id: messageId,
    p_gap_seconds: window.gapSeconds,
    p_max_seconds: window.maxSeconds,
  });

  if (error) throw new Error(`attach_inbound_message_to_block: ${error.message}`);

  const row = Array.isArray(data) ? data[0] : null;
  if (!row) throw new Error('attach_inbound_message_to_block: no_data');

  return {
    blockId: row.block_id,
    sequence: row.block_sequence,
    openedNewBlock: row.opened_new_block === true,
    closedBlockId: row.closed_block_id ?? null,
  };
}

async function closeOpenBlockOnHumanOutbound(
  supabase: SupabaseClient,
  conversationId: string,
  message: ObservedMessage,
): Promise<void> {
  const { error } = await supabase.rpc('close_open_block_on_human_outbound', {
    p_conversation_id: conversationId,
    p_message_timestamp: message.messageTimestamp,
  });

  if (error) throw new Error(`close_open_block_on_human_outbound: ${error.message}`);
}

async function hasTakeoverEvent(
  supabase: SupabaseClient,
  conversationId: string,
  providerMessageId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('agent_control_events')
    .select('id')
    .eq('agent_conversation_id', conversationId)
    .eq('action', 'pause')
    .eq('provider_message_id', providerMessageId)
    .limit(1);

  if (error) throw new Error(`agent_control_events.select: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
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

/**
 * Persiste un mensaje observado y sus efectos.
 *
 * Ante un mensaje repetido se vuelven a ejecutar los pasos idempotentes
 * (bloque, adjunto, cierre de bloque, takeover pendiente): si un intento
 * anterior falló a mitad de camino, el reintento lo completa.
 */
export async function persistObservedProvenance(
  supabase: SupabaseClient,
  provenance: KapsoProvenance,
  options: PersistOptions,
): Promise<PersistResult> {
  if (
    provenance.kind === 'unknown' ||
    provenance.kind === 'lifecycle'
  ) {
    return { persisted: false };
  }

  const { message } = provenance;
  const conversationId = await upsertConversation(supabase, message);
  const { status, messageId } = await insertMessage(supabase, conversationId, message);
  const duplicate = status === 'duplicate';
  let block: BlockAssignment | null = null;

  if (provenance.kind === 'customer_inbound') {
    block = await attachToBlock(supabase, messageId, options.blockWindow);
    await registerAttachment(supabase, messageId, message);
  }

  if (provenance.kind === 'human_outbound') {
    const takeoverPending =
      !duplicate ||
      (message.providerMessageId !== null &&
        !(await hasTakeoverEvent(supabase, conversationId, message.providerMessageId)));

    if (takeoverPending) {
      await applyObservedHumanTakeover(supabase, conversationId, message, options.pauseMinutes);
    }
    await closeOpenBlockOnHumanOutbound(supabase, conversationId, message);
  }

  return { persisted: true, duplicate, conversationId, messageId, block };
}

/**
 * Guarda la atribución de un mensaje entrante.
 * El índice único por provider_message_id evita duplicados ante reintentos.
 */
export async function insertConversationAttribution(
  supabase: SupabaseClient,
  input: {
    conversationId: string;
    providerMessageId: string | null;
    observedAt: string;
    attribution: ReferralAttribution;
  },
): Promise<'inserted' | 'duplicate'> {
  const { error } = await supabase.from('conversation_attributions').insert({
    agent_conversation_id: input.conversationId,
    provider_message_id: input.providerMessageId,
    source_type: input.attribution.sourceType,
    source_platform: input.attribution.sourcePlatform,
    source_id: input.attribution.sourceId,
    source_url: input.attribution.sourceUrl,
    ctwa_clid: input.attribution.ctwaClid,
    raw_referral: input.attribution.rawReferral,
    observed_at: input.observedAt,
  });

  if (!error) return 'inserted';
  if (error.code === '23505') return 'duplicate';
  throw new Error(`conversation_attributions.insert: ${error.message}`);
}

/**
 * Diagnóstico temporal: guarda solo la forma del payload y los valores
 * técnicos de atribución. Nunca contenido del mensaje.
 */
export async function insertAttributionDebug(
  supabase: SupabaseClient,
  input: {
    conversationId: string | null;
    providerMessageId: string | null;
    eventName: string;
    observedAt: string | null;
    diagnostics: PayloadDiagnostics;
  },
): Promise<'inserted' | 'duplicate'> {
  const { error } = await supabase.from('webhook_attribution_debug').insert({
    agent_conversation_id: input.conversationId,
    provider_message_id: input.providerMessageId,
    event_name: input.eventName,
    payload_shape: input.diagnostics.payloadShape,
    attribution_candidates: input.diagnostics.attributionCandidates,
    observed_at: input.observedAt,
  });

  if (!error) return 'inserted';
  if (error.code === '23505') return 'duplicate';
  throw new Error(`webhook_attribution_debug.insert: ${error.message}`);
}
