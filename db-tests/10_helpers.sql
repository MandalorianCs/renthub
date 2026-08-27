-- Помощники для сценариев. Живут в схеме t, чтобы не мешаться в public.
--
-- Главное, что они дают: возможность выполнить запрос ОТ ИМЕНИ пользователя.
-- Без этого тесты бессмысленны — postgres владеет таблицами и обходит RLS,
-- поэтому «работает у меня в SQL Editor» ничего не говорит о том, что увидит
-- приложение с anon-ключом.

create schema if not exists t;

create or replace function t.assert(p_cond boolean, p_msg text) returns void
language plpgsql
as $$
begin
  if p_cond is not true then
    raise exception 'ПРОВАЛ: %', p_msg;
  end if;
  raise notice '  ok  %', p_msg;
end
$$;

-- Выполнить SQL от имени пользователя: и роль authenticated, и claims JWT.
-- Одного set role мало — auth.uid() внутри триггеров читает именно claims.
create or replace function t.as(p_sub uuid, p_sql text) returns void
language plpgsql
as $$
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute p_sql;
  execute 'reset role';
end
$$;

-- То же, но с одним значением на выходе — чтобы читать данные глазами
-- конкретного пользователя (проверка select-политик).
create or replace function t.as_value(p_sub uuid, p_sql text) returns text
language plpgsql
as $$
declare
  v_result text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);
  execute 'set local role authenticated';
  execute p_sql into v_result;
  execute 'reset role';
  return v_result;
end
$$;

-- Ожидаемый отказ. Возвращает текст ошибки, чтобы сценарий мог проверить,
-- что упало именно по той причине, по которой должно было упасть.
create or replace function t.expect_fail(
  p_sub    uuid,
  p_sql    text,
  p_expect text default null
) returns text
language plpgsql
as $$
declare
  v_msg text;
begin
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_sub, 'role', 'authenticated')::text, true);

  begin
    execute 'set local role authenticated';
    execute p_sql;
    execute 'reset role';
    raise exception 'T_UNEXPECTED_SUCCESS: запрос прошёл, хотя должен был упасть — %', p_sql;
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg like 'T_UNEXPECTED_SUCCESS%' then
        raise;
      end if;
  end;

  execute 'reset role';

  if p_expect is not null and position(p_expect in v_msg) = 0 then
    raise exception 'ПРОВАЛ: ждали ошибку «%», получили «%»', p_expect, v_msg;
  end if;

  raise notice '  ok  отказано как задумано: %', left(v_msg, 90);
  return v_msg;
end
$$;

-- Аноним: без jwt-claims и с ролью anon. Именно так приходит человек,
-- открывший каталог до регистрации.
create or replace function t.as_anon(p_sql text) returns text
language plpgsql
as $$
declare
  v_result text;
begin
  perform set_config('request.jwt.claims', '', true);
  execute 'set local role anon';
  execute p_sql into v_result;
  execute 'reset role';
  return v_result;
end
$$;

create or replace function t.anon_fails(p_sql text, p_expect text default null)
returns text
language plpgsql
as $$
declare
  v_msg text;
begin
  perform set_config('request.jwt.claims', '', true);
  begin
    execute 'set local role anon';
    execute p_sql;
    execute 'reset role';
    raise exception 'T_UNEXPECTED_SUCCESS: аноним смог выполнить — %', p_sql;
  exception
    when others then
      get stacked diagnostics v_msg = message_text;
      if v_msg like 'T_UNEXPECTED_SUCCESS%' then raise; end if;
  end;
  execute 'reset role';
  if p_expect is not null and position(p_expect in v_msg) = 0 then
    raise exception 'ПРОВАЛ: ждали «%», получили «%»', p_expect, v_msg;
  end if;
  raise notice '  ok  анониму отказано: %', left(v_msg, 80);
  return v_msg;
end
$$;

-- Фиксированные идентификаторы: сценарии должны быть воспроизводимыми,
-- а не зависеть от того, какой uuid выпал.
create or replace function t.id(p_kind text) returns uuid
language sql immutable
as $$
  select case p_kind
    when 'owner'      then 'aaaaaaaa-0000-4000-8000-000000000001'
    when 'renter'     then 'aaaaaaaa-0000-4000-8000-000000000002'
    when 'stranger'   then 'aaaaaaaa-0000-4000-8000-000000000003'
    when 'unverified' then 'aaaaaaaa-0000-4000-8000-000000000004'
    when 'item'       then 'bbbbbbbb-0000-4000-8000-000000000001'
    when 'item_cheap' then 'bbbbbbbb-0000-4000-8000-000000000002'
    when 'booking'    then 'cccccccc-0000-4000-8000-000000000001'
    when 'booking2'   then 'cccccccc-0000-4000-8000-000000000002'
    when 'booking3'   then 'cccccccc-0000-4000-8000-000000000003'
    when 'booking4'   then 'cccccccc-0000-4000-8000-000000000004'
    when 'booking5'   then 'cccccccc-0000-4000-8000-000000000005'
    when 'booking6'   then 'cccccccc-0000-4000-8000-000000000006'
    when 'booking_bot' then 'cccccccc-0000-4000-8000-000000000007'
  end::uuid
$$;

-- Помощники вызываются внутри запросов, которые исполняются от имени
-- authenticated, — значит, эта роль должна их видеть.
grant usage on schema t to anon, authenticated, service_role;
grant execute on all functions in schema t to anon, authenticated, service_role;

-- ── Пользователи ──────────────────────────────────────────────
-- Регистрация идёт двумя шагами, как в жизни: строка в auth.users
-- появляется при запросе SMS-кода (телефон ещё НЕ подтверждён),
-- phone_confirmed_at проставляется отдельным UPDATE после ввода кода.
-- Именно этот второй шаг ловит триггер on_auth_user_phone_confirmed.

-- Номера без плюса — так их хранит GoTrue. Раньше здесь стоял формат
-- E.164, и стенд подтверждал то, чего в жизни не бывает: расхождение
-- форматов между auth.users и профилем он поймать не мог.
insert into auth.users (id, phone, raw_user_meta_data) values
  (t.id('owner'),      '77010000001', '{"full_name": "Ержан Владелец"}'),
  (t.id('renter'),     '77010000002', '{"full_name": "Асель Арендатор"}'),
  (t.id('stranger'),   '77010000003', '{"full_name": "Посторонний"}'),
  (t.id('unverified'), '77010000004', '{"full_name": "Без подтверждения"}');

do $$
begin
  perform t.assert(
    (select count(*) from public.users) = 4,
    'триггер on_auth_user_created создал 4 профиля в public.users');

  perform t.assert(
    (select count(*) from public.users where verified_at is not null) = 0,
    'до подтверждения кода никто не верифицирован');
end $$;

update auth.users set phone_confirmed_at = now()
 where id in (t.id('owner'), t.id('renter'), t.id('stranger'));

do $$
begin
  perform t.assert(
    (select count(*) from public.users where verified_at is not null) = 3,
    'триггер on_auth_user_phone_confirmed проставил verified_at троим');

  perform t.assert(
    (select verified_at is null from public.users where id = t.id('unverified')),
    'не вводивший код остался неверифицированным');

  perform t.assert(
    (select full_name = 'Ержан Владелец' from public.users where id = t.id('owner')),
    'full_name перенесён из raw_user_meta_data');

  perform t.assert(
    (select passive_mode from public.users where id = t.id('owner')),
    'пассивный режим владельца включён по умолчанию');

  -- GoTrue отдаёт номер без плюса, а всё остальное работает с E.164.
  -- Если триггер не приведёт формат, поиск по номеру не найдёт человека,
  -- который в базе есть.
  perform t.assert(
    (select phone = '+77010000001' from public.users where id = t.id('owner')),
    'телефон в профиле приведён к E.164, хотя GoTrue отдал его без плюса');
end $$;
