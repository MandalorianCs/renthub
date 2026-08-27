-- Публикация объявления через функцию — чтобы вход был один.
--
-- Приложение создаёт объявление прямым insert, а правила держат политика
-- items_insert_own и триггер с assert_verified(). Боту этого мало по той же
-- причине, что отмене и отзыву: под сервисным ключом RLS не применяется, а
-- переключить роль внутри security definer Postgres не даёт.
--
-- Дублировать правило в боте нельзя тем более: «сдавать может только
-- подтверждённый и незаблокированный» — это assert_verified(), и второй его
-- экземпляр на Python разошёлся бы с первым молча.
--
-- Владелец не приходит аргументом. Раньше owner_id передавало приложение, а
-- совпадение с вошедшим проверяла политика; теперь подставить чужого нельзя
-- даже по ошибке — функция берёт auth.uid().
--
-- Город тоже не аргумент. Он был у клиента (EXPO_PUBLIC_PILOT_CITY), и это
-- давало ровно один способ сломать витрину: разойтись с дефолтом items.city,
-- после чего объявления создавались бы в одном городе, а искались в другом.
-- Теперь город ставит сама база своим дефолтом, и разойтись нечему.

create or replace function create_item(
  p_category   text,
  p_title      text,
  p_daily_price integer,
  p_deposit_amount integer,
  p_photos     text[],
  p_description text default null
)
returns items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item items%rowtype;
begin
  if auth.uid() is null then
    raise exception 'RENTHUB_FORBIDDEN: нужно войти' using errcode = '42501';
  end if;

  -- Минимум одно фото. Порог обсуждается (см. «Открытые вопросы» в README),
  -- но ноль означал бы объявление, по которому нельзя разобрать спор: фото
  -- «после» не с чем сверять.
  if p_photos is null or array_length(p_photos, 1) is null then
    raise exception 'RENTHUB_BAD_INPUT: нужно хотя бы одно фото вещи'
      using errcode = '22023';
  end if;

  -- Всё остальное — верификацию, блокировку, длину названия, цену больше
  -- нуля — проверяют триггер assert_verified() и ограничения таблицы.
  -- Здесь они не повторяются: отказ придёт их текстом.
  insert into items (owner_id, category, title, description,
                     daily_price, deposit_amount, condition_photos)
  values (auth.uid(), p_category, trim(p_title),
          nullif(trim(coalesce(p_description, '')), ''),
          p_daily_price, p_deposit_amount, p_photos)
  returning * into v_item;

  return v_item;
end;
$$;

comment on function create_item(text, text, integer, integer, text[], text) is
  'Публикация объявления. Владельца берёт из auth.uid(), город — из дефолта '
  'таблицы: оба раньше приходили от клиента и могли разойтись с базой.';

revoke execute on function create_item(text, text, integer, integer, text[], text) from anon;
grant execute on function create_item(text, text, integer, integer, text[], text) to authenticated;

-- ── Обёртка для бота ──────────────────────────────────────────

create or replace function bot_create_item(
  p_actor      uuid,
  p_category   text,
  p_title      text,
  p_daily_price integer,
  p_deposit_amount integer,
  p_photos     text[],
  p_description text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item items%rowtype;
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);

  v_item := create_item(p_category, p_title, p_daily_price, p_deposit_amount,
                        p_photos, p_description);
  return v_item.id;
end;
$$;

revoke all on function bot_create_item(uuid, text, text, integer, integer, text[], text) from public;
revoke execute on function bot_create_item(uuid, text, text, integer, integer, text[], text)
  from anon, authenticated;
