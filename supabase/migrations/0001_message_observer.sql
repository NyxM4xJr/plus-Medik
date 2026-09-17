begin;

create extension if not exists pgcrypto;

create table if not exists public.webhook_events (
  id uuid primary key default gen_random_uuid(),
  idempotency_key text not null unique,
  event_name text not null,
  payload_version text,
  status text not null default 'processing' check (status in ('processing', 'processed', 'failed')),
  error_code text,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);

create table if not exists public.agent_conversations (
  id uuid primary key default gen_random_uuid(),
  customer_phone text not null unique,
  last_provider_conversation_id text,
  provider_phone_number_id text,
  state text not null default 'active' check (state in ('active', 'paused')),
  paused_at timestamptz,
  pause_expires_at timestamptz,
  pause_reason text,
  pause_source text,
  last_message_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint agent_conversations_phone_format check (customer_phone ~ '^[0-9]{8,15}$'),
  constraint agent_conversations_pause_coherence check (
    (state = 'active' and paused_at is null and pause_expires_at is null and pause_reason is null and pause_source is null)
    or
    (state = 'paused' and paused_at is not null and pause_reason is not null and pause_source is not null)
  )
);

create table if not exists public.agent_messages (
  id uuid primary key default gen_random_uuid(),
  agent_conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  provider_message_id text,
  provider_conversation_id text,
  direction text not null check (direction in ('inbound', 'outbound')),
  role text not null check (role in ('user', 'assistant')),
  actor text not null check (actor in ('customer', 'human', 'automation')),
  origin text,
  status text,
  content text,
  content_type text not null default 'unknown',
  metadata jsonb,
  message_timestamp timestamptz not null,
  created_at timestamptz not null default now(),
  constraint agent_messages_actor_coherence check (
    (direction = 'inbound' and role = 'user' and actor = 'customer')
    or
    (direction = 'outbound' and role = 'assistant' and actor in ('human', 'automation'))
  ),
  constraint agent_messages_metadata_object check (metadata is null or jsonb_typeof(metadata) = 'object')
);

create unique index if not exists uq_agent_messages_provider_message_id
  on public.agent_messages(provider_message_id)
  where provider_message_id is not null;

create index if not exists ix_agent_messages_conversation_time
  on public.agent_messages(agent_conversation_id, message_timestamp desc);

create table if not exists public.agent_control_events (
  id uuid primary key default gen_random_uuid(),
  agent_conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  action text not null check (action in ('pause', 'resume')),
  source text not null,
  reason text not null,
  provider_message_id text,
  expires_at timestamptz,
  metadata jsonb,
  created_at timestamptz not null default now()
);

create unique index if not exists uq_control_event_message_action
  on public.agent_control_events(agent_conversation_id, action, provider_message_id)
  where provider_message_id is not null;

create or replace function public.apply_observed_human_takeover(
  p_conversation_id uuid,
  p_provider_message_id text,
  p_message_timestamp timestamptz,
  p_pause_expires_at timestamptz
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.agent_conversations
  set
    state = 'paused',
    paused_at = case when state = 'active' then p_message_timestamp else paused_at end,
    pause_expires_at = case
      when state = 'paused' and pause_expires_at is null then null
      when pause_expires_at is null then p_pause_expires_at
      else greatest(pause_expires_at, p_pause_expires_at)
    end,
    pause_reason = case when state = 'active' then 'human.business_app' else pause_reason end,
    pause_source = case when state = 'active' then 'business_app' else pause_source end,
    updated_at = now()
  where id = p_conversation_id;

  insert into public.agent_control_events (
    agent_conversation_id,
    action,
    source,
    reason,
    provider_message_id,
    expires_at,
    metadata
  ) values (
    p_conversation_id,
    'pause',
    'business_app',
    'human.business_app',
    p_provider_message_id,
    p_pause_expires_at,
    jsonb_build_object('trigger', 'whatsapp.message.sent')
  )
  on conflict do nothing;
end;
$$;

revoke all on function public.apply_observed_human_takeover(uuid, text, timestamptz, timestamptz) from public;
revoke all on function public.apply_observed_human_takeover(uuid, text, timestamptz, timestamptz) from anon;
revoke all on function public.apply_observed_human_takeover(uuid, text, timestamptz, timestamptz) from authenticated;
grant execute on function public.apply_observed_human_takeover(uuid, text, timestamptz, timestamptz) to service_role;

alter table public.webhook_events enable row level security;
alter table public.agent_conversations enable row level security;
alter table public.agent_messages enable row level security;
alter table public.agent_control_events enable row level security;

commit;
