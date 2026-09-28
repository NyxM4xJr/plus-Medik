# Diseño: carga transaccional del catálogo

Estado: **segunda versión aprobada e implementada** en
`supabase/migrations/20260924180000_catalog_import_apply.sql`, **aplicada** en
Supabase. `catalog:plan` sigue siendo solo lectura. `catalog:apply` existe
(`src/lib/catalog/apply-command.ts`, reglas en `docs/BITACORA.md`, «Catálogo:
carga») y nunca se ejecutó contra Supabase. Las decisiones aprobadas están en
[Decisiones aprobadas](#decisiones-aprobadas); las diferencias entre este
documento y la implementación, en
[Notas de implementación](#notas-de-implementación).

## Objetivo

Aplicar un catálogo validado a `lab_tests` en **una sola transacción**: o se
aplica todo o no se aplica nada. Nunca se borra; lo ausente se desactiva. La
función vuelve a comprobar todo dentro de la transacción y no confía en el
plan calculado antes en TypeScript.

## Flujo previsto

```text
CSV ──validateCatalogCsv──► reporte ──planCatalogImport──► plan (dry-run, se muestra)
                                                               │
                      el operador revisa y confirma las desactivaciones
                                                               │
catalog:apply ──► rpc apply_lab_catalog_import(filas, códigos confirmados, ...)
                     └─ una transacción en Postgres: valida, compara, aplica, audita
```

`catalog:apply` solo llama al RPC si el plan local tiene `canApply = true`. Aun
así, la función repite todas las validaciones: el cliente nunca es la única
barrera.

## Firma propuesta

```sql
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
security invoker
set search_path = public
```

Los cuatro primeros parámetros **no tienen default**: quien llama debe pasarlos
siempre, aunque sea `'{}'` para la lista de confirmación. Así, olvidar la
confirmación es un error de llamada y no una confirmación vacía implícita.
`p_expected_counts` es nuevo respecto de la primera versión del diseño (ver
[Cambios entre el plan y la carga](#cambios-entre-el-plan-y-la-carga)).

Permisos: `revoke` a `public`, `anon` y `authenticated`; `grant execute` solo a
`service_role`, igual que el resto de RPCs.

| Parámetro | Uso |
|---|---|
| `p_rows` | Catálogo completo validado (formato abajo). Es la lista **completa**: lo que no esté se desactiva. |
| `p_confirm_deactivate_codes` | Lista exacta de códigos que el operador vio en el plan y acepta desactivar. `'{}'` si el plan no desactiva nada. |
| `p_expected_counts` | Conteos del plan que vio el operador: `{"create": n, "update": n, "unchanged": n, "deactivate": n}`. |
| `p_source` | Metadatos para auditoría: `csv_sha256`, `operator`, `filename`, `command_version`. Sin datos de pacientes. |
| `p_max_deactivations` | Protección técnica: más desactivaciones que esto exige `p_allow_mass_deactivation`. **10** (aprobado). |
| `p_allow_mass_deactivation` | Confirmación especial para superar `p_max_deactivations`. |

## Validación de parámetros

Es lo primero que hace la función, antes de tomar locks. En plpgsql una
comparación con `null` da `null` y un `if` con `null` no entra en la rama:
por eso **cada** parámetro se comprueba con `is null` explícito y nunca se
confía en que un `null` se comporte como `false` o como lista vacía.

| Parámetro | Regla | Error |
|---|---|---|
| `p_rows` | No nulo, `jsonb_typeof = 'array'`, al menos 1 elemento, cada elemento un objeto. | `invalid_input` |
| `p_confirm_deactivate_codes` | **No nulo** (se rechaza, no se trata como vacío). Sin elementos nulos ni vacíos después de `trim`. Sin repetidos después de normalizar. | `invalid_confirmation` |
| `p_expected_counts` | No nulo, objeto con exactamente las claves `create`, `update`, `unchanged`, `deactivate`, cada una entero ≥ 0. | `invalid_expected_counts` |
| `p_source` | No nulo, `jsonb_typeof = 'object'`, con `csv_sha256` (64 hex) y `operator` (texto no vacío). Tamaño máximo 4 KB. | `invalid_source` |
| `p_max_deactivations` | No nulo, entero ≥ 0. | `invalid_max_deactivations` |
| `p_allow_mass_deactivation` | **No nulo.** Un `null` se rechaza; no se convierte en `false` ni en `true`. | `invalid_mass_deactivation_flag` |

Se rechaza el `null` en lugar de convertirlo porque un `coalesce` mal puesto
es justo el tipo de error que abriría la protección. Con el rechazo, la única
forma de superar el límite es pasar literalmente `true`.

La protección de desactivaciones masivas se escribe en su forma segura:

```sql
if v_deactivate_count > p_max_deactivations
   and p_allow_mass_deactivation is not true then
  raise exception 'mass_deactivation_requires_override';
end if;
```

`is not true` es verdadero para `false` **y** para `null`: aunque la
validación anterior se quitara por error, un `null` seguiría sin poder saltarse
el límite. Hay un test para cada una de las dos capas.

## Formato de entrada (`p_rows`)

Arreglo JSON, un objeto por fila `ok` del validador:

```json
[
  {
    "code": "HP-IGG",
    "name": "Helicobacter pylori IgG",
    "category": "Microbiología",
    "sample_type": "Sangre",
    "price_bs": "90.00",
    "active": true,
    "notes": null,
    "status": "ok"
  }
]
```

- `price_bs` va como **texto decimal**, no como número JSON, para no perder
  precisión; en SQL se convierte a `numeric(10,2)`.
- `status` viaja como defensa adicional: la función rechaza cualquier valor
  distinto de `"ok"`.
- `proposedCode` **no se envía**. Una fila sin código definitivo nunca llega a
  la función (y si llega, se rechaza por `code` vacío).

## Mecanismo de concurrencia

1. `set local lock_timeout = '5s'` para no quedar esperando indefinidamente.
2. `pg_try_advisory_xact_lock(hashtext('lab_catalog_import'))`. Si otra
   importación tiene el lock → `raise 'catalog_import_in_progress'` en lugar de
   esperar. El lock se libera solo al terminar la transacción (commit o
   rollback).
3. `lock table public.lab_tests in share row exclusive mode`. Bloquea
   escrituras de cualquier otro origen (ediciones manuales, otra función)
   mientras dura la carga, pero **permite lecturas**: el webhook y la búsqueda
   siguen funcionando.
4. Todo el estado actual se lee **después** de tomar los locks. El plan que vio
   el operador se usa solo para la confirmación; la función recalcula todo.

## Validaciones (antes de escribir nada)

Cada una aborta con un error estable y, cuando aplica, hasta 20 códigos de
ejemplo (nunca precios ni notas):

| Error | Condición |
|---|---|
| `invalid_input` | `p_rows` no es un arreglo, está vacío, o una fila no tiene la forma esperada. |
| `row_not_ok` | Alguna fila con `status` distinto de `"ok"`. |
| `missing_code` | `code` vacío o solo espacios. |
| `missing_name` | `normalize_lab_text(name)` vacío. |
| `invalid_price` | `price_bs` no numérico, ≤ 0, con más de 2 decimales o > 99 999 999.99. |
| `invalid_active` | `active` no booleano. |
| `duplicate_codes` | Códigos repetidos en la entrada sin distinguir mayúsculas. |
| `name_collisions` | Nombres normalizados repetidos en la entrada (hoy el validador los deja en revisión; ver decisiones abiertas). |
| `existing_code_conflicts` | En `lab_tests` hay códigos que solo difieren en mayúsculas. |
| `code_case_mismatch` | Un código de la entrada coincide con uno existente salvo mayúsculas. |
| `deactivation_confirmation_mismatch` | El conjunto de desactivaciones recalculado no es **exactamente** igual a `p_confirm_deactivate_codes`. Cubre dos casos: el operador no confirmó, o `lab_tests` cambió desde el plan. |
| `plan_changed` | Los conteos recalculados no coinciden con `p_expected_counts`. |
| `mass_deactivation_requires_override` | Desactivaciones > `p_max_deactivations` y `p_allow_mass_deactivation` no es `true`. |

Los errores de parámetros (`invalid_confirmation`, `invalid_source`, etc.)
están en [Validación de parámetros](#validación-de-parámetros).

Reglas de emparejamiento, iguales a `planCatalogImport`:

- Solo por `code`, comparación exacta después de pasar el control de
  mayúsculas. Nunca por nombre.
- `lab_tests` sin código: no se tocan (`unmanaged`).
- Se desactiva un examen **activo** con código cuyo código no está en la
  entrada. Uno ya inactivo no cuenta.
- Precios comparados como `numeric` (45 = 45.00).

## Aplicación

Con todas las validaciones superadas, en este orden y como sentencias de
conjunto (no fila por fila desde el cliente):

1. `insert` de los códigos nuevos.
2. `update` de los existentes que cambian, solo en las columnas que difieren.
   Incluye reactivar (`active` false → true) si el archivo lo trae activo.
3. `update ... set active = false` de los ausentes confirmados.
4. Nunca `delete`.

`updated_at` lo mantiene el trigger existente `lab_tests_updated_at`.

## Estrategia de rollback

- La función corre dentro de la transacción de la llamada RPC (PostgREST abre
  una por request). Cualquier `raise` o error de Postgres revierte **todas**
  las escrituras de la llamada, incluida la auditoría.
- Todas las validaciones van antes de la primera escritura, así que los
  rechazos normales no llegan a escribir nada.
- Las restricciones existentes (`price_bs >= 0`, índice único de `code`) son
  una segunda red: si algo pasa las validaciones y viola una restricción, la
  transacción entera se revierte.
- **Aprobado** para la misma migración: índice único
  `lab_tests (upper(code)) where code is not null`. Hace imposibles los
  conflictos de mayúsculas a futuro. Fallaría al crearse si ya existieran
  conflictos; hoy el catálogo está vacío. Se mantiene igual la validación
  `existing_code_conflicts` como defensa en la función.

## Confirmación de desactivaciones

- Sin desactivaciones: `p_confirm_deactivate_codes = '{}'` y la carga procede.
- Con desactivaciones: el operador debe pasar **la lista exacta** que vio en el
  plan. No basta un «sí» ni un número.
- Más de `p_max_deactivations` (10): además hace falta
  `p_allow_mass_deactivation = true`.

**Comparación normalizada y exacta.**

1. Normalización de cada lado: `upper(trim(code))`. Es la misma clave que usa
   el índice único `upper(code)`, así que no puede haber dos exámenes con la
   misma clave normalizada.
2. La lista confirmada no puede tener elementos nulos, vacíos ni repetidos
   después de normalizar (`invalid_confirmation`). Un repetido no se
   deduplica en silencio: indica un error del comando.
3. Se comparan como **conjuntos**, con igualdad exacta: ni un código de más
   ni uno de menos. El orden no importa.

```sql
if (select coalesce(array_agg(c order by c), '{}') from unnest(v_confirmed) c)
   is distinct from
   (select coalesce(array_agg(c order by c), '{}') from unnest(v_to_deactivate) c) then
  raise exception 'deactivation_confirmation_mismatch';
end if;
```

`is distinct from` en lugar de `<>`: con `<>`, un `null` en cualquier lado
haría que la condición no se cumpla y la comparación pasaría sin rechazar.

## Cambios entre el plan y la carga

El operador ve el plan (dry-run) y después ejecuta la carga. Entre ambos
momentos `lab_tests` puede cambiar. La función recalcula todo con los locks
tomados y compara con lo que el operador aprobó por dos vías:

- **Desactivaciones:** conjunto exacto de códigos (`p_confirm_deactivate_codes`).
- **Resto del plan:** conteos exactos (`p_expected_counts`).

| Cambio entre plan y carga | Resultado |
|---|---|
| Alguien agrega a mano un examen con código que no está en el CSV | Aparece una desactivación no confirmada → `deactivation_confirmation_mismatch`. |
| Alguien desactiva a mano un examen que el plan iba a desactivar | La desactivación ya no se recalcula → `deactivation_confirmation_mismatch`. |
| Alguien edita a mano un examen que está en el CSV (antes `unchanged`) | Pasa a `update`: los conteos cambian → `plan_changed`. |
| Alguien crea a mano un código que el CSV iba a crear | `create` pasa a `update` o `unchanged` → `plan_changed`. |
| Alguien borra una fila a mano | Un `unchanged` pasa a `create` → `plan_changed`. |
| Alguien crea `hem01` junto a `HEM01` | Imposible con el índice único `upper(code)`; sin él, `existing_code_conflicts`. |
| Otra carga está en curso | `catalog_import_in_progress`, sin esperar. |

En todos los casos no se escribe nada: hay que volver a ejecutar
`catalog:plan`, revisar y confirmar de nuevo.

**Límite conocido.** Los conteos no detectan dos cambios que se compensan
exactamente (por ejemplo, una edición manual que convierte un `unchanged` en
`update` mientras otra edición convierte un `update` en `unchanged`). En ese
caso el CSV se aplica igual y sobrescribe la edición manual, que queda en
`before` de la auditoría. Se acepta porque el CSV es la fuente de verdad del
catálogo y la edición manual de `lab_tests` no es un flujo previsto. Si
hiciera falta más, la alternativa es una huella (hash) del plan completo
calculada igual en TypeScript y SQL; queda anotada como posible mejora.
- En `catalog:apply` esto se traduce en opciones explícitas:
  `--confirm-deactivations=HEM01,GLU01` y `--allow-mass-deactivation`. El
  umbral sale de `CATALOG_MAX_DEACTIVATIONS` (10), documentado en la tabla de
  valores de la bitácora.

## Auditoría

Dos tablas nuevas, con RLS activado y acceso solo por `service_role`. Son un
registro de cargas, **no** un catálogo paralelo: nunca se consultan para
buscar exámenes.

```sql
lab_catalog_imports (
  id uuid primary key,
  applied_at timestamptz not null default now(),
  source jsonb not null,             -- p_source
  input_rows integer not null,
  summary jsonb not null,            -- conteos por clase
  max_deactivations integer not null,
  mass_deactivation_override boolean not null
)

lab_catalog_import_changes (
  import_id uuid references lab_catalog_imports(id),
  lab_test_id uuid references lab_tests(id),
  code text not null,
  action text check (action in ('create', 'update', 'deactivate')),
  before jsonb,                      -- null en create
  after jsonb not null
)
```

- Se escriben en la misma transacción. Si la carga falla, tampoco queda
  auditoría; el comando registra el error en su propia salida.
- `unchanged` no genera filas de cambio, solo cuenta en `summary`.

## Resultado

```json
{
  "import_id": "…",
  "created": 12,
  "updated": 3,
  "unchanged": 140,
  "deactivated": 2,
  "reactivated": 1,
  "unmanaged": 0,
  "deactivated_codes": ["GLU01", "OLD01"]
}
```

`reactivated` es un subconjunto de `updated`, informado aparte porque cambia
lo que ven los pacientes.

## Plan de pruebas con PGlite

Las pruebas corren sobre todas las migraciones del repo en memoria, igual que
las actuales. Ninguna toca Supabase.

1. **Paridad con TypeScript.** Para cada escenario, el resumen de la función
   debe coincidir con `planCatalogImport` sobre los mismos datos. Así, la
   lógica duplicada en SQL no puede divergir sin que falle un test.
2. **Camino feliz.** Crea, actualiza, deja sin cambios y desactiva; los
   exámenes sin código quedan intactos; nada se borra (el total de filas nunca
   baja).
3. **Idempotencia.** La misma carga dos veces: la segunda da todo `unchanged` y
   no genera filas de cambio.
4. **Rechazos.** Uno por cada error de la tabla de validaciones, comprobando
   además que `lab_tests` y las tablas de auditoría quedan **idénticas** a
   antes.
5. **Rollback real.** Forzar un fallo después de las validaciones (por ejemplo
   con un trigger de prueba que lance error en el tercer `update`) y comprobar
   que no quedó ninguna escritura.
6. **Confirmación.** Sin confirmar, rechaza; con la lista exacta, aplica
   (también en otro orden, con espacios o en minúsculas); con un código de
   más o de menos, rechaza; con repetidos, nulos o vacíos en la lista,
   rechaza.
7. **Protección masiva.** 11 desactivaciones con el límite en 10: rechaza con
   la bandera en `false`, **rechaza con la bandera en `null`**, aplica solo
   con `true`. Un test aparte comprueba que la condición `is not true` bloquea
   el `null` aunque se omita la validación de parámetros.
8. **Parámetros nulos.** Un test por cada parámetro en `null` y por cada forma
   inválida (`p_source` que no es objeto o sin `csv_sha256`,
   `p_expected_counts` con claves de más o de menos, `p_rows` que no es
   arreglo). En todos, nada se escribe.
9. **Cambios entre plan y carga.** Un test por cada fila de la tabla de
   [Cambios entre el plan y la carga](#cambios-entre-el-plan-y-la-carga),
   simulando la edición manual entre el cálculo del plan y la llamada.
10. **Índice `upper(code)`.** Insertar `hem01` con `HEM01` existente falla.
11. **Variantes.** Helicobacter y nombres parecidos se mantienen como filas
    separadas; ningún emparejamiento por nombre.
12. **Auditoría.** Una fila por carga y una por cambio, con `before` y `after`
    correctos.
13. **Permisos.** Solo `service_role` puede ejecutar la función y leer las
    tablas de auditoría.

**Límite conocido:** PGlite usa una sola conexión y los advisory locks son
reentrantes dentro de la misma sesión, así que la concurrencia **no** se puede
probar ahí. Se verifica en las pruebas previas a producción con dos sesiones
reales contra un entorno de pruebas. Nunca contra el catálogo de producción.

## Decisiones aprobadas

| Tema | Decisión |
|---|---|
| Límite de desactivaciones | `p_max_deactivations` = **10**. Con un catálogo de ~487 exámenes, más de 10 desactivaciones exige autorización especial. |
| Colisiones de nombre | **Bloqueadas.** No se aprueban nombres normalizados iguales hasta tener la lista real y confirmar cada variante. |
| Alias | **Carga separada**, después del catálogo. Una carga de exámenes no puede alterar la resolución de nombres. |
| Índice `upper(code)` | **Aprobado.** Va en la misma migración que la función. |
| Quién ejecuta | `catalog:apply` solo desde una **máquina local controlada** con `.env.local`. Nunca desde Vercel ni un endpoint público. |
| Auditoría | Se conserva **indefinidamente** en esta etapa. La retención se define cuando se conozca el volumen. |

También aprobados en la segunda versión: `p_expected_counts` con
`plan_changed`, `csv_sha256` y `operator` obligatorios en `p_source`, y
rechazar `null` en `p_allow_mass_deactivation`.

## Notas de implementación

Diferencias o precisiones respecto de lo escrito arriba:

- **`update` escribe todas las columnas comparables** (nueve desde las
  cuatro tarifas), no solo las que
  cambiaron. El resultado es el mismo (las que no cambiaron reciben su propio
  valor) y la sentencia es de conjunto; la auditoría guarda el estado completo
  antes y después.
- **Precio:** el texto debe cumplir `^[0-9]{1,8}(\.[0-9]{1,2})?$`, que ya
  limita a 99 999 999.99; además debe ser > 0. Un número JSON se rechaza.
- **Claves de cada fila:** solo `code`, `name`, `category`, `sample_type`,
  `price_bs`, `active`, `notes` y `status`. Cualquier otra (por ejemplo
  `proposedCode`) da `invalid_input`.
- **Textos:** se recortan y un texto vacío se guarda como `null`, igual que
  el validador TypeScript.
- **Código vacío (`''`) en `lab_tests`:** cuenta como sin código
  (`unmanaged`), igual que en TypeScript.
- **Carga sin cambios:** también se registra en `lab_catalog_imports` (con
  todo en `unchanged`), pero no genera filas en `lab_catalog_import_changes`.
- **`lab_catalog_import_changes.lab_test_id` sin cascade:** un examen con
  historial de cargas no se puede borrar.
- **Marcadores `-- [check:mass_flag]`** alrededor de la validación de la
  bandera masiva: los usa el test que comprueba la segunda capa
  (`is not true`). No quitarlos.
- **Nombre:** la función se llama `apply_lab_catalog_import`, como en este
  diseño.
- **Cuatro tarifas (2026-09-28):** la migración
  `20260928120000_lab_test_tariffs.sql` reemplaza la función con la misma
  firma. Cada fila lleva además `price_convenio_bs`, `price_medicos_bs` y
  `price_emergencia_bs`, con las mismas reglas que `price_bs` (que es la
  tarifa Paciente); las cuatro entran en la comparación, en `update` y en
  `before`/`after` de la auditoría. Ver `docs/BITACORA.md`, registro
  2026-09-28.
- **`catalog:apply` compara una huella del plan completo** entre lo que vio el
  operador y el momento de aplicar, además de lo que compara la función. Eso
  cubre el límite de los cambios que se compensan, salvo en el intervalo
  entre esa última lectura y el RPC.
