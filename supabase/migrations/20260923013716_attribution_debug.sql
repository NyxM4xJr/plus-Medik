create table public.webhook_attribution_debug (
  id uuid primary key default gen_random_uuid(),

  agent_conversation_id uuid
    references public.agent_conversations(id)
    on delete cascade,

  provider_message_id text,

  event_name text not null,

  -- Solo estructura técnica del webhook:
  -- rutas/claves + tipos, nunca valores del mensaje.
  payload_shape jsonb not null default '{}'::jsonb,

  -- Solo valores técnicos relacionados con atribución/publicidad.
  attribution_candidates jsonb not null default '{}'::jsonb,

  observed_at timestamptz,
  created_at timestamptz not null default now(),

  -- Diagnóstico temporal: después podremos eliminar estos registros.
  expires_at timestamptz not null default (now() + interval '7 days'),

  constraint webhook_attribution_debug_shape_object
    check (jsonb_typeof(payload_shape) = 'object'),

  constraint webhook_attribution_debug_candidates_object
    check (jsonb_typeof(attribution_candidates) = 'object')
);


-- Evita duplicados del mismo mensaje por reintentos del webhook.
create unique index webhook_attribution_debug_provider_message_unique
on public.webhook_attribution_debug (provider_message_id)
where provider_message_id is not null;


create index webhook_attribution_debug_created_at_idx
on public.webhook_attribution_debug (created_at desc);


create index webhook_attribution_debug_expires_at_idx
on public.webhook_attribution_debug (expires_at);


alter table public.webhook_attribution_debug
enable row level security;