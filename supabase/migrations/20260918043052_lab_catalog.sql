create extension if not exists pg_trgm with schema extensions;

-- Normaliza nombres para búsquedas:
-- "Hemograma Completo" -> "hemograma completo"
-- "Ácido Úrico" -> "acido urico"
create or replace function public.normalize_lab_text(p_text text)
returns text
language sql
immutable
parallel safe
as $$
  select trim(
    regexp_replace(
      lower(
        translate(
          coalesce(p_text, ''),
          'áéíóúüñÁÉÍÓÚÜÑ',
          'aeiouunAEIOUUN'
        )
      ),
      '[^a-z0-9]+',
      ' ',
      'g'
    )
  );
$$;

create table public.lab_tests (
  id uuid primary key default gen_random_uuid(),

  code text,
  name text not null,

  normalized_name text
    generated always as (public.normalize_lab_text(name)) stored,

  category text,
  sample_type text,

  price_bs numeric(10,2) not null
    check (price_bs >= 0),

  active boolean not null default true,

  notes text,
  metadata jsonb not null default '{}'::jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index lab_tests_code_unique
on public.lab_tests (code)
where code is not null;

create index lab_tests_normalized_name_idx
on public.lab_tests (normalized_name);

create index lab_tests_normalized_name_trgm_idx
on public.lab_tests
using gin (normalized_name extensions.gin_trgm_ops);


-- Alias y formas alternativas.
-- Ejemplo:
-- Canonico: Hemograma completo
-- Alias: hemograma, hemograma completo, hc
create table public.lab_test_aliases (
  id uuid primary key default gen_random_uuid(),

  lab_test_id uuid not null
    references public.lab_tests(id)
    on delete cascade,

  alias text not null,

  normalized_alias text
    generated always as (public.normalize_lab_text(alias)) stored,

  created_at timestamptz not null default now(),

  unique (lab_test_id, normalized_alias)
);

create index lab_test_aliases_normalized_idx
on public.lab_test_aliases (normalized_alias);

create index lab_test_aliases_normalized_trgm_idx
on public.lab_test_aliases
using gin (normalized_alias extensions.gin_trgm_ops);


-- Mantener updated_at automáticamente
create or replace function public.update_lab_test_timestamp()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger lab_tests_updated_at
before update on public.lab_tests
for each row
execute function public.update_lab_test_timestamp();


-- Solo backend/service_role accederá directamente por ahora
alter table public.lab_tests enable row level security;
alter table public.lab_test_aliases enable row level security;