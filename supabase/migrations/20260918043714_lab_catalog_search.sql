create or replace function public.search_lab_catalog(
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
  similarity_score real
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  with query_data as (
    select public.normalize_lab_text(p_query) as normalized_query
  ),

  exact_name as (
    select
      lt.id as lab_test_id,
      lt.code,
      lt.name,
      lt.category,
      lt.sample_type,
      lt.price_bs,
      'exact_name'::text as match_type,
      lt.name as matched_text,
      1.0::real as similarity_score
    from public.lab_tests lt
    cross join query_data q
    where lt.active = true
      and q.normalized_query <> ''
      and lt.normalized_name = q.normalized_query
  ),

  exact_alias as (
    select
      lt.id as lab_test_id,
      lt.code,
      lt.name,
      lt.category,
      lt.sample_type,
      lt.price_bs,
      'exact_alias'::text as match_type,
      a.alias as matched_text,
      1.0::real as similarity_score
    from public.lab_test_aliases a
    join public.lab_tests lt
      on lt.id = a.lab_test_id
    cross join query_data q
    where lt.active = true
      and q.normalized_query <> ''
      and a.normalized_alias = q.normalized_query
      and not exists (
        select 1 from exact_name
      )
  ),

  fuzzy_candidates as (
    select
      lt.id as lab_test_id,
      lt.code,
      lt.name,
      lt.category,
      lt.sample_type,
      lt.price_bs,

      similarity(
        lt.normalized_name,
        q.normalized_query
      )::real as name_score,

      best_alias.alias as best_alias,
      coalesce(best_alias.alias_score, 0)::real as alias_score

    from public.lab_tests lt
    cross join query_data q

    left join lateral (
      select
        a.alias,
        similarity(
          a.normalized_alias,
          q.normalized_query
        )::real as alias_score
      from public.lab_test_aliases a
      where a.lab_test_id = lt.id
      order by
        similarity(
          a.normalized_alias,
          q.normalized_query
        ) desc
      limit 1
    ) best_alias on true

    where lt.active = true
      and q.normalized_query <> ''
      and not exists (
        select 1 from exact_name
      )
      and not exists (
        select 1 from exact_alias
      )
  ),

  fuzzy as (
    select
      lab_test_id,
      code,
      name,
      category,
      sample_type,
      price_bs,

      case
        when alias_score > name_score
          then 'fuzzy_alias'
        else 'fuzzy_name'
      end::text as match_type,

      case
        when alias_score > name_score
          then best_alias
        else name
      end::text as matched_text,

      greatest(
        name_score,
        alias_score
      )::real as similarity_score

    from fuzzy_candidates

    where greatest(
      name_score,
      alias_score
    ) >= 0.35
  ),

  results as (
    select * from exact_name
    union all
    select * from exact_alias
    union all
    select * from fuzzy
  )

  select *
  from results
  order by
    similarity_score desc,
    name asc
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