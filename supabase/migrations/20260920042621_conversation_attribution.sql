create table public.conversation_attributions (
  id uuid primary key default gen_random_uuid(),

  agent_conversation_id uuid not null
    references public.agent_conversations(id)
    on delete cascade,

  -- Mensaje que originó esta atribución
  provider_message_id text,

  -- Tipo real de entrada
  source_type text not null default 'unknown'
    check (
      source_type in (
        'ctwa_ad',
        'organic',
        'referral_other',
        'unknown'
      )
    ),

  -- Plataforma cuando logremos identificarla
  source_platform text
    check (
      source_platform is null
      or source_platform in (
        'facebook',
        'instagram',
        'whatsapp',
        'other',
        'unknown'
      )
    ),

  -- Datos provenientes del referral/publicidad
  source_id text,
  source_url text,
  ctwa_clid text,

  -- Payload técnico original de atribución.
  -- No guardar aquí datos clínicos ni del catálogo.
  raw_referral jsonb,

  observed_at timestamptz not null default now(),
  created_at timestamptz not null default now(),

  constraint conversation_attributions_raw_referral_object
    check (
      raw_referral is null
      or jsonb_typeof(raw_referral) = 'object'
    )
);


-- Un mismo mensaje no debe crear dos atribuciones
create unique index conversation_attributions_provider_message_unique
on public.conversation_attributions (provider_message_id)
where provider_message_id is not null;


-- Consultar historial de origen de una conversación
create index conversation_attributions_conversation_time_idx
on public.conversation_attributions (
  agent_conversation_id,
  observed_at desc
);


-- Buscar campañas/anuncios
create index conversation_attributions_source_id_idx
on public.conversation_attributions (source_id)
where source_id is not null;


-- Buscar Click-to-WhatsApp
create index conversation_attributions_ctwa_clid_idx
on public.conversation_attributions (ctwa_clid)
where ctwa_clid is not null;


alter table public.conversation_attributions
enable row level security;