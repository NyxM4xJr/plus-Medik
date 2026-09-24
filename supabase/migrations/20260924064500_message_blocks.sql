-- Bloques de mensajes entrantes y registro de adjuntos.
--
-- Un bloque agrupa los mensajes seguidos de un cliente (texto, imágenes,
-- documentos) para que una respuesta futura los consolide juntos.
-- Una receta de varias fotos queda como un bloque con sus páginas en orden
-- (block_sequence).
--
-- Los tiempos de agrupación llegan como parámetros desde el runtime
-- (INBOUND_BLOCK_GAP_SECONDS, INBOUND_BLOCK_MAX_SECONDS).
-- Ver docs/BITACORA.md antes de cambiarlos.

create table public.agent_message_blocks (
  id uuid primary key default gen_random_uuid(),

  agent_conversation_id uuid not null
    references public.agent_conversations(id)
    on delete cascade,

  status text not null default 'open'
    check (status in ('open', 'closed')),

  -- gap: llegó un mensaje después de la ventana de silencio.
  -- max_duration: el bloque superó su duración máxima.
  -- human_outbound: respondió una persona desde WhatsApp Business.
  close_reason text
    check (close_reason is null or close_reason in ('gap', 'max_duration', 'human_outbound')),

  -- Tiempos de WhatsApp (message_timestamp), no de llegada del webhook.
  opened_at timestamptz not null,
  last_message_at timestamptz not null,
  closed_at timestamptz,

  message_count integer not null default 0 check (message_count >= 0),
  text_count integer not null default 0 check (text_count >= 0),
  image_count integer not null default 0 check (image_count >= 0),
  document_count integer not null default 0 check (document_count >= 0),
  other_count integer not null default 0 check (other_count >= 0),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),

  constraint agent_message_blocks_close_coherence check (
    (status = 'open' and close_reason is null and closed_at is null)
    or
    (status = 'closed' and close_reason is not null and closed_at is not null)
  ),

  constraint agent_message_blocks_time_order check (last_message_at >= opened_at)
);

-- A lo sumo un bloque abierto por conversación.
create unique index uq_agent_message_blocks_one_open
on public.agent_message_blocks (agent_conversation_id)
where status = 'open';

create index ix_agent_message_blocks_conversation_time
on public.agent_message_blocks (agent_conversation_id, opened_at desc);


alter table public.agent_messages
  add column agent_message_block_id uuid
    references public.agent_message_blocks(id)
    on delete set null,
  add column block_sequence integer;

alter table public.agent_messages
  add constraint agent_messages_block_coherence check (
    (agent_message_block_id is null and block_sequence is null)
    or
    (agent_message_block_id is not null and block_sequence >= 1 and direction = 'inbound')
  );

create unique index uq_agent_messages_block_sequence
on public.agent_messages (agent_message_block_id, block_sequence)
where agent_message_block_id is not null;


-- Registro de imágenes/documentos. Solo datos técnicos del archivo:
-- nada se descarga ni se interpreta en esta fase.
create table public.agent_message_attachments (
  id uuid primary key default gen_random_uuid(),

  agent_message_id uuid not null unique
    references public.agent_messages(id)
    on delete cascade,

  kind text not null
    check (kind in ('image', 'document', 'audio', 'video', 'sticker')),

  provider_media_id text,
  mime_type text,
  filename text,
  sha256 text,
  file_size_bytes bigint check (file_size_bytes is null or file_size_bytes >= 0),

  download_status text not null default 'not_requested'
    check (download_status in ('not_requested', 'pending', 'downloaded', 'failed')),

  interpretation_status text not null default 'not_requested'
    check (interpretation_status in ('not_requested', 'pending', 'interpreted', 'failed')),

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);


-- Asigna un mensaje entrante a su bloque.
-- Idempotente: si el mensaje ya tiene bloque, devuelve el mismo.
-- Serializa por conversación para que imágenes que llegan en paralelo
-- caigan en el mismo bloque.
create or replace function public.attach_inbound_message_to_block(
  p_message_id uuid,
  p_gap_seconds integer,
  p_max_seconds integer
)
returns table (
  block_id uuid,
  block_sequence integer,
  opened_new_block boolean,
  closed_block_id uuid
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_conversation_id uuid;
  v_direction text;
  v_content_type text;
  v_message_at timestamptz;
  v_existing_block uuid;
  v_existing_sequence integer;
  v_block public.agent_message_blocks%rowtype;
  v_has_open boolean := false;
  v_closed_block_id uuid := null;
  v_close_reason text := null;
  v_kind text;
  v_sequence integer;
begin
  if p_gap_seconds is null or p_gap_seconds < 1 then
    raise exception 'invalid_gap_seconds';
  end if;

  if p_max_seconds is null or p_max_seconds < p_gap_seconds then
    raise exception 'invalid_max_seconds';
  end if;

  select m.agent_conversation_id
  into v_conversation_id
  from public.agent_messages m
  where m.id = p_message_id;

  if not found then
    raise exception 'message_not_found';
  end if;

  perform 1
  from public.agent_conversations c
  where c.id = v_conversation_id
  for update;

  -- Releer después del lock: otra ejecución pudo asignarlo.
  select
    m.direction,
    m.content_type,
    m.message_timestamp,
    m.agent_message_block_id,
    m.block_sequence
  into
    v_direction,
    v_content_type,
    v_message_at,
    v_existing_block,
    v_existing_sequence
  from public.agent_messages m
  where m.id = p_message_id;

  if v_direction <> 'inbound' then
    raise exception 'message_not_inbound';
  end if;

  if v_existing_block is not null then
    return query select v_existing_block, v_existing_sequence, false, null::uuid;
    return;
  end if;

  select *
  into v_block
  from public.agent_message_blocks b
  where b.agent_conversation_id = v_conversation_id
    and b.status = 'open';

  v_has_open := found;

  if v_has_open then
    -- Un mensaje atrasado (anterior al último) siempre se suma al bloque abierto.
    if v_message_at > v_block.last_message_at + make_interval(secs => p_gap_seconds) then
      v_close_reason := 'gap';
    elsif v_message_at > v_block.opened_at + make_interval(secs => p_max_seconds) then
      v_close_reason := 'max_duration';
    end if;

    if v_close_reason is not null then
      update public.agent_message_blocks b
      set
        status = 'closed',
        close_reason = v_close_reason,
        closed_at = now(),
        updated_at = now()
      where b.id = v_block.id;

      v_closed_block_id := v_block.id;
      v_has_open := false;
    end if;
  end if;

  if not v_has_open then
    insert into public.agent_message_blocks (
      agent_conversation_id,
      opened_at,
      last_message_at
    )
    values (
      v_conversation_id,
      v_message_at,
      v_message_at
    )
    returning * into v_block;
  end if;

  v_kind := case
    when v_content_type = 'text' then 'text'
    when v_content_type = 'image' then 'image'
    when v_content_type = 'document' then 'document'
    else 'other'
  end;

  update public.agent_message_blocks b
  set
    opened_at = least(b.opened_at, v_message_at),
    last_message_at = greatest(b.last_message_at, v_message_at),
    message_count = b.message_count + 1,
    text_count = b.text_count + (v_kind = 'text')::integer,
    image_count = b.image_count + (v_kind = 'image')::integer,
    document_count = b.document_count + (v_kind = 'document')::integer,
    other_count = b.other_count + (v_kind = 'other')::integer,
    updated_at = now()
  where b.id = v_block.id
  returning b.message_count into v_sequence;

  update public.agent_messages m
  set
    agent_message_block_id = v_block.id,
    block_sequence = v_sequence
  where m.id = p_message_id;

  return query select v_block.id, v_sequence, not v_has_open, v_closed_block_id;
end;
$$;


-- Cierra el bloque abierto cuando responde una persona.
-- Solo cierra bloques abiertos hasta el momento del mensaje humano, para que
-- una reentrega tardía del mismo webhook no cierre un bloque posterior.
create or replace function public.close_open_block_on_human_outbound(
  p_conversation_id uuid,
  p_message_timestamp timestamptz
)
returns uuid
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_closed_block_id uuid;
begin
  perform 1
  from public.agent_conversations c
  where c.id = p_conversation_id
  for update;

  update public.agent_message_blocks b
  set
    status = 'closed',
    close_reason = 'human_outbound',
    closed_at = now(),
    updated_at = now()
  where b.agent_conversation_id = p_conversation_id
    and b.status = 'open'
    and b.opened_at <= p_message_timestamp
  returning b.id into v_closed_block_id;

  return v_closed_block_id;
end;
$$;


revoke all on function public.attach_inbound_message_to_block(uuid, integer, integer) from public;
revoke all on function public.attach_inbound_message_to_block(uuid, integer, integer) from anon;
revoke all on function public.attach_inbound_message_to_block(uuid, integer, integer) from authenticated;
grant execute on function public.attach_inbound_message_to_block(uuid, integer, integer) to service_role;

revoke all on function public.close_open_block_on_human_outbound(uuid, timestamptz) from public;
revoke all on function public.close_open_block_on_human_outbound(uuid, timestamptz) from anon;
revoke all on function public.close_open_block_on_human_outbound(uuid, timestamptz) from authenticated;
grant execute on function public.close_open_block_on_human_outbound(uuid, timestamptz) to service_role;

alter table public.agent_message_blocks enable row level security;
alter table public.agent_message_attachments enable row level security;
