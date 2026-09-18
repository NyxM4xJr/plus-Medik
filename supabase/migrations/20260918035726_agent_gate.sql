create or replace function public.resolve_agent_gate(
  p_conversation_id uuid,
  p_now timestamptz default now()
)
returns table (
  allowed boolean,
  conversation_state text,
  resumed boolean,
  current_pause_expires_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state text;
  v_pause_expires_at timestamptz;
begin
  select
    state,
    pause_expires_at
  into
    v_state,
    v_pause_expires_at
  from public.agent_conversations
  where id = p_conversation_id
  for update;

  if not found then
    raise exception 'conversation_not_found';
  end if;

  if v_state = 'active' then
    return query
    select
      true,
      'active'::text,
      false,
      null::timestamptz;

    return;
  end if;

  if v_pause_expires_at is null then
    return query
    select
      false,
      'paused'::text,
      false,
      null::timestamptz;

    return;
  end if;

  if v_pause_expires_at > p_now then
    return query
    select
      false,
      'paused'::text,
      false,
      v_pause_expires_at;

    return;
  end if;

  update public.agent_conversations
  set
    state = 'active',
    paused_at = null,
    pause_expires_at = null,
    pause_reason = null,
    pause_source = null,
    updated_at = now()
  where id = p_conversation_id;

  insert into public.agent_control_events (
    agent_conversation_id,
    action,
    source,
    reason,
    expires_at,
    metadata
  )
  values (
    p_conversation_id,
    'resume',
    'timeout',
    'human_takeover_expired',
    v_pause_expires_at,
    jsonb_build_object(
      'trigger',
      'agent_gate'
    )
  );

  return query
  select
    true,
    'active'::text,
    true,
    null::timestamptz;
end;
$$;

revoke all
on function public.resolve_agent_gate(uuid, timestamptz)
from public;

revoke all
on function public.resolve_agent_gate(uuid, timestamptz)
from anon;

revoke all
on function public.resolve_agent_gate(uuid, timestamptz)
from authenticated;

grant execute
on function public.resolve_agent_gate(uuid, timestamptz)
to service_role;