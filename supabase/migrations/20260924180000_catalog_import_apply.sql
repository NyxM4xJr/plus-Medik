-- Carga transaccional del catálogo.
--
-- Diseño aprobado: docs/diseno/carga-catalogo.md (segunda versión).
-- apply_lab_catalog_import aplica un catálogo validado a lab_tests en una sola
-- transacción: valida todo antes de escribir, toma locks, recalcula el plan,
-- lo compara con lo que confirmó el operador, aplica y audita. Cualquier error
-- revierte todo, incluida la auditoría. Nunca borra ni toca lab_test_aliases.
--
-- Límite conocido: p_expected_counts no detecta dos cambios manuales que se
-- compensan exactamente entre el plan y la carga. En ese caso el CSV se
-- aplica y sobrescribe la edición manual, que queda en «before» de la
-- auditoría. Ver el diseño, «Cambios entre el plan y la carga».


-- Hace imposibles los códigos que solo difieren en mayúsculas (HEM01 / hem01).
create unique index lab_tests_code_upper_unique
on public.lab_tests (upper(code))
where code is not null;


-- Auditoría: registro de cargas, no un catálogo paralelo. Se conserva
-- indefinidamente en esta etapa.
create table public.lab_catalog_imports (
  id uuid primary key default gen_random_uuid(),
  applied_at timestamptz not null default now(),
  source jsonb not null,
  input_rows integer not null check (input_rows > 0),
  summary jsonb not null,
  max_deactivations integer not null check (max_deactivations >= 0),
  mass_deactivation_override boolean not null,

  constraint lab_catalog_imports_source_object check (jsonb_typeof(source) = 'object'),
  constraint lab_catalog_imports_summary_object check (jsonb_typeof(summary) = 'object')
);

create index lab_catalog_imports_applied_at_idx
on public.lab_catalog_imports (applied_at desc);

create table public.lab_catalog_import_changes (
  id uuid primary key default gen_random_uuid(),
  import_id uuid not null references public.lab_catalog_imports(id),
  -- Sin cascade: un examen con historial de cargas no se puede borrar.
  lab_test_id uuid not null references public.lab_tests(id),
  code text not null,
  action text not null check (action in ('create', 'update', 'deactivate')),
  before jsonb,
  after jsonb not null,

  constraint lab_catalog_import_changes_before check ((action = 'create') = (before is null))
);

create index lab_catalog_import_changes_import_idx
on public.lab_catalog_import_changes (import_id);

create index lab_catalog_import_changes_lab_test_idx
on public.lab_catalog_import_changes (lab_test_id);

alter table public.lab_catalog_imports enable row level security;
alter table public.lab_catalog_import_changes enable row level security;

revoke all on table public.lab_catalog_imports from anon, authenticated;
revoke all on table public.lab_catalog_import_changes from anon, authenticated;


create function public.apply_lab_catalog_import(
  p_rows jsonb,
  p_confirm_deactivate_codes text[],
  p_expected_counts jsonb,
  p_source jsonb,
  p_max_deactivations integer default 10,
  p_allow_mass_deactivation boolean default false
)
returns jsonb
language plpgsql
volatile
security invoker
set search_path = public
as $$
declare
  c_allowed_keys constant text[] := array[
    'code', 'name', 'category', 'sample_type', 'price_bs', 'active', 'notes', 'status'
  ];
  c_count_keys constant text[] := array['create', 'deactivate', 'unchanged', 'update'];
  v_bad text;
  v_create integer;
  v_update integer;
  v_unchanged integer;
  v_deactivate integer;
  v_reactivated integer;
  v_unmanaged integer;
  v_counts jsonb;
  v_expected jsonb;
  v_confirmed text[];
  v_to_deactivate text[];
  v_import_id uuid;
begin
  -- ─── 1. Parámetros ─────────────────────────────────────────────────────
  -- Cada null se comprueba en su propio if: «null or x» puede dar null y un
  -- if con null no entra en la rama.

  if p_rows is null then
    raise exception 'invalid_input: p_rows no puede ser null';
  end if;
  if jsonb_typeof(p_rows) <> 'array' then
    raise exception 'invalid_input: p_rows debe ser un arreglo';
  end if;
  if jsonb_array_length(p_rows) = 0 then
    raise exception 'invalid_input: p_rows está vacío';
  end if;

  if p_confirm_deactivate_codes is null then
    raise exception 'invalid_confirmation: p_confirm_deactivate_codes no puede ser null';
  end if;
  if array_ndims(p_confirm_deactivate_codes) > 1 then
    raise exception 'invalid_confirmation: debe ser una lista simple';
  end if;
  if exists (
    select 1 from unnest(p_confirm_deactivate_codes) as c(code)
    where c.code is null or btrim(c.code) = ''
  ) then
    raise exception 'invalid_confirmation: la lista tiene elementos nulos o vacíos';
  end if;
  if (select count(*) from unnest(p_confirm_deactivate_codes) as c(code))
     <> (select count(distinct upper(btrim(c.code))) from unnest(p_confirm_deactivate_codes) as c(code)) then
    raise exception 'invalid_confirmation: la lista tiene códigos repetidos';
  end if;

  if p_expected_counts is null then
    raise exception 'invalid_expected_counts: p_expected_counts no puede ser null';
  end if;
  if jsonb_typeof(p_expected_counts) <> 'object' then
    raise exception 'invalid_expected_counts: debe ser un objeto';
  end if;
  if (select array_agg(k order by k) from jsonb_object_keys(p_expected_counts) as k)
     is distinct from c_count_keys then
    raise exception 'invalid_expected_counts: claves esperadas create, update, unchanged, deactivate';
  end if;
  if exists (
    select 1 from jsonb_each(p_expected_counts) as e
    where jsonb_typeof(e.value) <> 'number' or (e.value #>> '{}') !~ '^[0-9]{1,9}$'
  ) then
    raise exception 'invalid_expected_counts: los conteos deben ser enteros >= 0';
  end if;

  if p_source is null then
    raise exception 'invalid_source: p_source no puede ser null';
  end if;
  if jsonb_typeof(p_source) <> 'object' then
    raise exception 'invalid_source: debe ser un objeto';
  end if;
  if octet_length(p_source::text) > 4096 then
    raise exception 'invalid_source: supera 4 KB';
  end if;
  if jsonb_typeof(p_source -> 'csv_sha256') is distinct from 'string'
     or (p_source ->> 'csv_sha256') !~ '^[0-9a-fA-F]{64}$' then
    raise exception 'invalid_source: csv_sha256 debe ser un sha256 en hexadecimal';
  end if;
  if jsonb_typeof(p_source -> 'operator') is distinct from 'string'
     or btrim(p_source ->> 'operator') = '' then
    raise exception 'invalid_source: operator es obligatorio';
  end if;

  if p_max_deactivations is null then
    raise exception 'invalid_max_deactivations: no puede ser null';
  end if;
  if p_max_deactivations < 0 then
    raise exception 'invalid_max_deactivations: no puede ser negativo';
  end if;

  -- [check:mass_flag]
  if p_allow_mass_deactivation is null then
    raise exception 'invalid_mass_deactivation_flag: p_allow_mass_deactivation no puede ser null';
  end if;
  -- [/check:mass_flag]

  -- ─── 2. Filas de entrada ───────────────────────────────────────────────
  -- Los errores nombran posiciones (1 = primera fila) o códigos, nunca precios
  -- ni notas. Máximo 20 ejemplos.

  drop table if exists pg_temp.lab_catalog_raw;
  create temp table lab_catalog_raw on commit drop as
  select t.n::integer as n, t.e as e
  from jsonb_array_elements(p_rows) with ordinality as t(e, n);

  select string_agg(s.n::text, ', ' order by s.n) into v_bad
  from (select r.n from pg_temp.lab_catalog_raw r where jsonb_typeof(r.e) <> 'object' order by r.n limit 20) s;
  if v_bad is not null then
    raise exception 'invalid_input: filas que no son objeto: %', v_bad;
  end if;

  select string_agg(distinct k, ', ') into v_bad
  from pg_temp.lab_catalog_raw r, jsonb_object_keys(r.e) as k
  where k <> all (c_allowed_keys);
  if v_bad is not null then
    raise exception 'invalid_input: claves no admitidas: %', v_bad;
  end if;

  select string_agg(s.n::text, ', ' order by s.n) into v_bad
  from (
    select r.n from pg_temp.lab_catalog_raw r
    where coalesce(jsonb_typeof(r.e -> 'code'), 'null') not in ('null', 'string')
       or coalesce(jsonb_typeof(r.e -> 'name'), 'null') not in ('null', 'string')
       or coalesce(jsonb_typeof(r.e -> 'category'), 'null') not in ('null', 'string')
       or coalesce(jsonb_typeof(r.e -> 'sample_type'), 'null') not in ('null', 'string')
       or coalesce(jsonb_typeof(r.e -> 'notes'), 'null') not in ('null', 'string')
    order by r.n limit 20
  ) s;
  if v_bad is not null then
    raise exception 'invalid_input: campos de texto con tipo inválido en las filas %', v_bad;
  end if;

  select string_agg(s.n::text, ', ' order by s.n) into v_bad
  from (
    select r.n from pg_temp.lab_catalog_raw r
    where (r.e -> 'status') is distinct from '"ok"'::jsonb
    order by r.n limit 20
  ) s;
  if v_bad is not null then
    raise exception 'row_not_ok: filas %', v_bad;
  end if;

  select string_agg(s.n::text, ', ' order by s.n) into v_bad
  from (
    select r.n from pg_temp.lab_catalog_raw r
    where coalesce(btrim(r.e ->> 'code'), '') = ''
    order by r.n limit 20
  ) s;
  if v_bad is not null then
    raise exception 'missing_code: filas %', v_bad;
  end if;

  select string_agg(s.n::text, ', ' order by s.n) into v_bad
  from (
    select r.n from pg_temp.lab_catalog_raw r
    where public.normalize_lab_text(r.e ->> 'name') = ''
    order by r.n limit 20
  ) s;
  if v_bad is not null then
    raise exception 'missing_name: filas %', v_bad;
  end if;

  select string_agg(s.n::text, ', ' order by s.n) into v_bad
  from (
    select r.n from pg_temp.lab_catalog_raw r
    where jsonb_typeof(r.e -> 'price_bs') is distinct from 'string'
       or (r.e ->> 'price_bs') !~ '^[0-9]{1,8}(\.[0-9]{1,2})?$'
    order by r.n limit 20
  ) s;
  if v_bad is null then
    select string_agg(s.n::text, ', ' order by s.n) into v_bad
    from (
      select r.n from pg_temp.lab_catalog_raw r
      where (r.e ->> 'price_bs')::numeric <= 0
      order by r.n limit 20
    ) s;
  end if;
  if v_bad is not null then
    raise exception 'invalid_price: filas %', v_bad;
  end if;

  select string_agg(s.n::text, ', ' order by s.n) into v_bad
  from (
    select r.n from pg_temp.lab_catalog_raw r
    where jsonb_typeof(r.e -> 'active') is distinct from 'boolean'
    order by r.n limit 20
  ) s;
  if v_bad is not null then
    raise exception 'invalid_active: filas %', v_bad;
  end if;

  -- Mismas reglas que el validador TypeScript: textos recortados, vacío = null.
  drop table if exists pg_temp.lab_catalog_input;
  create temp table lab_catalog_input on commit drop as
  select
    r.n,
    btrim(r.e ->> 'code') as code,
    upper(btrim(r.e ->> 'code')) as code_key,
    btrim(r.e ->> 'name') as name,
    public.normalize_lab_text(r.e ->> 'name') as normalized_name,
    nullif(btrim(r.e ->> 'category'), '') as category,
    nullif(btrim(r.e ->> 'sample_type'), '') as sample_type,
    (r.e ->> 'price_bs')::numeric(10, 2) as price_bs,
    (r.e ->> 'active')::boolean as active,
    nullif(btrim(r.e ->> 'notes'), '') as notes
  from pg_temp.lab_catalog_raw r;

  select string_agg(s.code_key, ', ' order by s.code_key) into v_bad
  from (
    select i.code_key from pg_temp.lab_catalog_input i
    group by i.code_key having count(*) > 1
    order by i.code_key limit 20
  ) s;
  if v_bad is not null then
    raise exception 'duplicate_codes: %', v_bad;
  end if;

  select string_agg(s.normalized_name, ', ' order by s.normalized_name) into v_bad
  from (
    select i.normalized_name from pg_temp.lab_catalog_input i
    group by i.normalized_name having count(*) > 1
    order by i.normalized_name limit 20
  ) s;
  if v_bad is not null then
    raise exception 'name_collisions: %', v_bad;
  end if;

  -- ─── 3. Locks ──────────────────────────────────────────────────────────
  -- Se liberan solos al terminar la transacción (commit o rollback).

  perform set_config('lock_timeout', '5s', true);

  if not pg_try_advisory_xact_lock(hashtext('lab_catalog_import')) then
    raise exception 'catalog_import_in_progress';
  end if;

  -- Bloquea escrituras de cualquier otro origen; las lecturas siguen.
  lock table public.lab_tests in share row exclusive mode;

  -- ─── 4. Estado actual (leído después de los locks) ─────────────────────
  -- Un código vacío o nulo en lab_tests es «sin código» (unmanaged): no se
  -- empareja ni se desactiva, igual que en planCatalogImport.

  select string_agg(s.k, ', ' order by s.k) into v_bad
  from (
    select upper(btrim(lt.code)) as k from public.lab_tests lt
    where coalesce(btrim(lt.code), '') <> ''
    group by upper(btrim(lt.code)) having count(*) > 1
    order by 1 limit 20
  ) s;
  if v_bad is not null then
    raise exception 'existing_code_conflicts: %', v_bad;
  end if;

  select string_agg(s.code, ', ' order by s.code) into v_bad
  from (
    select i.code from pg_temp.lab_catalog_input i
    join public.lab_tests lt
      on coalesce(btrim(lt.code), '') <> '' and upper(btrim(lt.code)) = i.code_key
    where lt.code <> i.code
    order by i.code limit 20
  ) s;
  if v_bad is not null then
    raise exception 'code_case_mismatch: %', v_bad;
  end if;

  -- ─── 5. Plan recalculado ───────────────────────────────────────────────

  drop table if exists pg_temp.lab_catalog_plan;
  create temp table lab_catalog_plan on commit drop as
  select
    'create'::text as action,
    null::uuid as lab_test_id,
    i.code,
    null::jsonb as before,
    false as reactivated
  from pg_temp.lab_catalog_input i
  where not exists (
    select 1 from public.lab_tests lt
    where coalesce(btrim(lt.code), '') <> '' and upper(btrim(lt.code)) = i.code_key
  )

  union all

  select
    case
      when (lt.name, lt.category, lt.sample_type, lt.price_bs, lt.active, lt.notes)
           is not distinct from
           (i.name, i.category, i.sample_type, i.price_bs, i.active, i.notes)
        then 'unchanged'
      else 'update'
    end,
    lt.id,
    lt.code,
    jsonb_build_object(
      'code', lt.code, 'name', lt.name, 'category', lt.category,
      'sample_type', lt.sample_type, 'price_bs', lt.price_bs,
      'active', lt.active, 'notes', lt.notes
    ),
    lt.active = false and i.active = true
  from pg_temp.lab_catalog_input i
  join public.lab_tests lt
    on coalesce(btrim(lt.code), '') <> '' and upper(btrim(lt.code)) = i.code_key

  union all

  select
    'deactivate',
    lt.id,
    lt.code,
    jsonb_build_object(
      'code', lt.code, 'name', lt.name, 'category', lt.category,
      'sample_type', lt.sample_type, 'price_bs', lt.price_bs,
      'active', lt.active, 'notes', lt.notes
    ),
    false
  from public.lab_tests lt
  where lt.active = true
    and coalesce(btrim(lt.code), '') <> ''
    and not exists (
      select 1 from pg_temp.lab_catalog_input i where i.code_key = upper(btrim(lt.code))
    );

  select
    count(*) filter (where p.action = 'create'),
    count(*) filter (where p.action = 'update'),
    count(*) filter (where p.action = 'unchanged'),
    count(*) filter (where p.action = 'deactivate'),
    count(*) filter (where p.reactivated)
  into v_create, v_update, v_unchanged, v_deactivate, v_reactivated
  from pg_temp.lab_catalog_plan p;

  select count(*) into v_unmanaged
  from public.lab_tests lt
  where coalesce(btrim(lt.code), '') = '';

  -- ─── 6. Confirmación del operador ──────────────────────────────────────

  -- Conjuntos normalizados con upper(trim(code)), la misma clave del índice.
  select coalesce(array_agg(upper(btrim(p.code)) order by upper(btrim(p.code))), '{}')
  into v_to_deactivate
  from pg_temp.lab_catalog_plan p
  where p.action = 'deactivate';

  select coalesce(array_agg(upper(btrim(c.code)) order by upper(btrim(c.code))), '{}')
  into v_confirmed
  from unnest(p_confirm_deactivate_codes) as c(code);

  -- is distinct from: con <>, un null haría pasar la comparación.
  if v_confirmed is distinct from v_to_deactivate then
    raise exception 'deactivation_confirmation_mismatch: el plan actual desactiva %, se confirmaron %',
      cardinality(v_to_deactivate), cardinality(v_confirmed);
  end if;

  v_counts := jsonb_build_object(
    'create', v_create,
    'update', v_update,
    'unchanged', v_unchanged,
    'deactivate', v_deactivate
  );
  v_expected := jsonb_build_object(
    'create', (p_expected_counts ->> 'create')::integer,
    'update', (p_expected_counts ->> 'update')::integer,
    'unchanged', (p_expected_counts ->> 'unchanged')::integer,
    'deactivate', (p_expected_counts ->> 'deactivate')::integer
  );
  if v_counts is distinct from v_expected then
    raise exception 'plan_changed: plan actual %, plan confirmado %', v_counts, v_expected;
  end if;

  -- «is not true» también bloquea null, aunque la validación de parámetros
  -- se quitara por error.
  if v_deactivate > p_max_deactivations and p_allow_mass_deactivation is not true then
    raise exception 'mass_deactivation_requires_override: % desactivaciones, límite %',
      v_deactivate, p_max_deactivations;
  end if;

  -- ─── 7. Escritura y auditoría (misma transacción) ──────────────────────

  insert into public.lab_catalog_imports (
    source, input_rows, summary, max_deactivations, mass_deactivation_override
  )
  values (
    p_source,
    jsonb_array_length(p_rows),
    v_counts || jsonb_build_object('reactivated', v_reactivated, 'unmanaged', v_unmanaged),
    p_max_deactivations,
    v_deactivate > p_max_deactivations
  )
  returning id into v_import_id;

  with created as (
    insert into public.lab_tests (code, name, category, sample_type, price_bs, active, notes)
    select i.code, i.name, i.category, i.sample_type, i.price_bs, i.active, i.notes
    from pg_temp.lab_catalog_input i
    join pg_temp.lab_catalog_plan p on p.action = 'create' and p.code = i.code
    returning id, code, name, category, sample_type, price_bs, active, notes
  )
  insert into public.lab_catalog_import_changes (import_id, lab_test_id, code, action, before, after)
  select
    v_import_id, c.id, c.code, 'create', null,
    jsonb_build_object(
      'code', c.code, 'name', c.name, 'category', c.category,
      'sample_type', c.sample_type, 'price_bs', c.price_bs,
      'active', c.active, 'notes', c.notes
    )
  from created c;

  with updated as (
    update public.lab_tests lt
    set
      name = i.name,
      category = i.category,
      sample_type = i.sample_type,
      price_bs = i.price_bs,
      active = i.active,
      notes = i.notes
    from pg_temp.lab_catalog_plan p
    join pg_temp.lab_catalog_input i on i.code_key = upper(btrim(p.code))
    where p.action = 'update' and lt.id = p.lab_test_id
    returning
      lt.id, lt.code, p.before,
      jsonb_build_object(
        'code', lt.code, 'name', lt.name, 'category', lt.category,
        'sample_type', lt.sample_type, 'price_bs', lt.price_bs,
        'active', lt.active, 'notes', lt.notes
      ) as after
  )
  insert into public.lab_catalog_import_changes (import_id, lab_test_id, code, action, before, after)
  select v_import_id, u.id, u.code, 'update', u.before, u.after
  from updated u;

  with deactivated as (
    update public.lab_tests lt
    set active = false
    from pg_temp.lab_catalog_plan p
    where p.action = 'deactivate' and lt.id = p.lab_test_id
    returning
      lt.id, lt.code, p.before,
      jsonb_build_object(
        'code', lt.code, 'name', lt.name, 'category', lt.category,
        'sample_type', lt.sample_type, 'price_bs', lt.price_bs,
        'active', lt.active, 'notes', lt.notes
      ) as after
  )
  insert into public.lab_catalog_import_changes (import_id, lab_test_id, code, action, before, after)
  select v_import_id, d.id, d.code, 'deactivate', d.before, d.after
  from deactivated d;

  return jsonb_build_object(
    'import_id', v_import_id,
    'created', v_create,
    'updated', v_update,
    'unchanged', v_unchanged,
    'deactivated', v_deactivate,
    'reactivated', v_reactivated,
    'unmanaged', v_unmanaged,
    'deactivated_codes', (
      select coalesce(jsonb_agg(p.code order by p.code), '[]'::jsonb)
      from pg_temp.lab_catalog_plan p
      where p.action = 'deactivate'
    )
  );
end;
$$;

revoke all
on function public.apply_lab_catalog_import(jsonb, text[], jsonb, jsonb, integer, boolean)
from public;

revoke all
on function public.apply_lab_catalog_import(jsonb, text[], jsonb, jsonb, integer, boolean)
from anon;

revoke all
on function public.apply_lab_catalog_import(jsonb, text[], jsonb, jsonb, integer, boolean)
from authenticated;

grant execute
on function public.apply_lab_catalog_import(jsonb, text[], jsonb, jsonb, integer, boolean)
to service_role;
