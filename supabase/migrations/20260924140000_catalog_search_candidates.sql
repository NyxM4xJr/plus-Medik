-- Búsqueda del catálogo por candidatos, sin ocultar variantes.
--
-- Reemplaza search_lab_catalog (20260918043714). La versión anterior usaba
-- NOT EXISTS globales: una coincidencia exacta de nombre ocultaba todos los
-- alias exactos, y un alias genérico asociado a una sola variante ocultaba
-- las demás.
--
-- Modelo de alias genérico: el mismo alias se asocia a cada variante en
-- lab_test_aliases (una fila por variante). No hay tabla nueva.
--
-- Niveles:
--   1. Exactos: coincidencias exactas de nombre UNIDAS a las de alias.
--      Ninguna oculta a la otra.
--   2. Difusos (pg_trgm, similitud >= 0.35): solo si no hay ningún exacto.
--
-- Cada lab_test_id aparece una sola vez (se prefiere exact_name).
-- total_candidates cuenta los candidatos antes de aplicar el límite, para
-- que quien llama sepa si el límite cortó variantes.
-- Ver docs/BITACORA.md, «Catálogo: búsqueda».

drop function if exists public.search_lab_catalog(text, integer);

create function public.search_lab_catalog(
  p_query text,
  p_limit integer default 5
)
returns table (
  lab_test_id uuid,
  code text,
  name text,
  category text,
  sample_type text,
  price_bs numeric,
  match_type text,
  matched_text text,
  similarity_score real,
  total_candidates integer
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with query_data as (
    select public.normalize_lab_text(p_query) as normalized_query
  ),

  exact_hits as (
    select
      lt.id as lab_test_id,
      'exact_name'::text as match_type,
      lt.name as matched_text,
      1 as priority
    from public.lab_tests lt
    cross join query_data q
    where lt.active = true
      and q.normalized_query <> ''
      and lt.normalized_name = q.normalized_query

    union all

    select
      lt.id,
      'exact_alias'::text,
      a.alias,
      2
    from public.lab_test_aliases a
    join public.lab_tests lt
      on lt.id = a.lab_test_id
    cross join query_data q
    where lt.active = true
      and q.normalized_query <> ''
      and a.normalized_alias = q.normalized_query
  ),

  -- Un candidato por examen: si coincide por nombre y por alias, gana el nombre.
  exact_candidates as (
    select distinct on (h.lab_test_id)
      h.lab_test_id,
      h.match_type,
      h.matched_text,
      1.0::real as similarity_score
    from exact_hits h
    order by h.lab_test_id, h.priority, h.matched_text
  ),

  exact_count as (
    select count(*) as n from exact_candidates
  ),

  fuzzy_scored as (
    select
      lt.id as lab_test_id,
      lt.name,
      similarity(lt.normalized_name, q.normalized_query)::real as name_score,
      best_alias.alias as best_alias,
      coalesce(best_alias.alias_score, 0)::real as alias_score
    from public.lab_tests lt
    cross join query_data q
    cross join exact_count e
    left join lateral (
      select
        a.alias,
        similarity(a.normalized_alias, q.normalized_query)::real as alias_score
      from public.lab_test_aliases a
      where a.lab_test_id = lt.id
      order by alias_score desc, a.alias
      limit 1
    ) best_alias on true
    where lt.active = true
      and q.normalized_query <> ''
      -- Nivel 2: solo cuando el nivel 1 no encontró nada.
      and e.n = 0
  ),

  fuzzy_candidates as (
    select
      lab_test_id,
      case when alias_score > name_score then 'fuzzy_alias' else 'fuzzy_name' end::text as match_type,
      case when alias_score > name_score then best_alias else name end::text as matched_text,
      greatest(name_score, alias_score)::real as similarity_score
    from fuzzy_scored
    where greatest(name_score, alias_score) >= 0.35
  ),

  candidates as (
    select * from exact_candidates
    union all
    select * from fuzzy_candidates
  ),

  counted as (
    select c.*, (count(*) over ())::integer as total_candidates
    from candidates c
  )

  select
    c.lab_test_id,
    lt.code,
    lt.name,
    lt.category,
    lt.sample_type,
    lt.price_bs,
    c.match_type,
    c.matched_text,
    c.similarity_score,
    c.total_candidates
  from counted c
  join public.lab_tests lt
    on lt.id = c.lab_test_id
  order by
    c.similarity_score desc,
    lt.name asc,
    lt.id asc
  limit least(
    greatest(coalesce(p_limit, 5), 1),
    20
  );
$$;


revoke all
on function public.search_lab_catalog(text, integer)
from public;

revoke all
on function public.search_lab_catalog(text, integer)
from anon;

revoke all
on function public.search_lab_catalog(text, integer)
from authenticated;

grant execute
on function public.search_lab_catalog(text, integer)
to service_role;
