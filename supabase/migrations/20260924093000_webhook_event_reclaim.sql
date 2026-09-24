-- Reclamo de eventos de webhook fallidos o atascados.
--
-- Un evento queda atascado en 'processing' si la función muere a mitad de
-- camino (timeout, caída). Sin reclamo, los reintentos de Kapso se trataban
-- como duplicados y el mensaje se perdía.
--
-- El umbral llega como parámetro desde el runtime
-- (WEBHOOK_PROCESSING_STALE_SECONDS). Ver docs/BITACORA.md antes de cambiarlo.

-- Momento del último reclamo. Las filas anteriores quedan en null y se usa
-- received_at en su lugar.
alter table public.webhook_events
  add column claimed_at timestamptz,
  add column attempts integer not null default 1 check (attempts >= 1);

alter table public.webhook_events
  alter column claimed_at set default now();


-- Reclama un evento en una sola sentencia atómica.
-- claimed = true: este intento debe procesarlo.
-- claimed = false: ya fue procesado o lo está procesando otro intento vivo.
create or replace function public.claim_webhook_event(
  p_idempotency_key text,
  p_event_name text,
  p_payload_version text,
  p_stale_seconds integer
)
returns table (
  claimed boolean,
  attempts integer
)
language plpgsql
security invoker
set search_path = public
as $$
begin
  if p_stale_seconds is null or p_stale_seconds < 60 then
    raise exception 'invalid_stale_seconds';
  end if;

  return query
  insert into public.webhook_events as e (
    idempotency_key,
    event_name,
    payload_version,
    status,
    claimed_at
  )
  values (
    p_idempotency_key,
    p_event_name,
    p_payload_version,
    'processing',
    now()
  )
  on conflict (idempotency_key) do update
  set
    status = 'processing',
    error_code = null,
    processed_at = null,
    claimed_at = now(),
    attempts = e.attempts + 1
  where e.status = 'failed'
     or (
       e.status = 'processing'
       and coalesce(e.claimed_at, e.received_at) < now() - make_interval(secs => p_stale_seconds)
     )
  returning true, e.attempts;

  if not found then
    return query
    select false, e.attempts
    from public.webhook_events e
    where e.idempotency_key = p_idempotency_key;
  end if;
end;
$$;

revoke all on function public.claim_webhook_event(text, text, text, integer) from public;
revoke all on function public.claim_webhook_event(text, text, text, integer) from anon;
revoke all on function public.claim_webhook_event(text, text, text, integer) from authenticated;
grant execute on function public.claim_webhook_event(text, text, text, integer) to service_role;
