-- Разрешение системной записи гасится сразу, а не «когда-нибудь».
--
-- Дефект нашёл стенд, и нашёл его в защите, поставленной накануне.
--
-- Флаг renthub.system_write говорит триггерам «эту запись делает система,
-- пропусти». Его ставят функции модератора: без него сторож в
-- users_role_guard и items_before_write запретил бы им ровно то, ради чего
-- их зовут. Ставился он через set_config(..., true) и больше не трогался —
-- в расчёте на то, что предложение SET у функции откатит его на выходе.
--
-- Не откатывает. Измерено прямо на стенде:
--
--   флаг до вызова:                      <не задан>
--   флаг ПОСЛЕ moderator_hide_item:      on
--   попытка вернуть снятое из Telegram:  БЕЗ ОШИБКИ
--
-- «Локальный» у set_config означает транзакцию, а не функцию. Значит одна
-- вызванная функция модератора открывала дверь всему, что писалось в этой
-- же транзакции дальше: и отметку модератора можно было снять, и защищённые
-- поля профиля переписать.
--
-- Почему это не выстрелило на живой базе: PostgREST выполняет каждый
-- запрос в своей транзакции, и после ответа она закрывается. Дыра
-- открывалась ровно на остаток одного запроса. Это везение, а не защита:
-- достаточно функции, которая внутри себя зовёт две таких подряд.
--
-- Заодно это поправка к разбору в 20260828100000_bot_acts_as_user.sql: там
-- сказано, что set_config внутри функции с SET умирает на выходе, и на этом
-- основании общая обёртка bot_assume_user() названа неработающей. Измерение
-- говорит обратное. Дублирование set_config в обёртках bot_* от этого не
-- становится ошибкой — оно просто оказалось не обязательным.
--
-- Исправление одно и скучное: гасить флаг сразу после защищённой записи.
-- Явное окно в две строки надёжнее любых рассуждений о том, где кончается
-- область видимости.

-- ── Снятие объявления модератором ─────────────────────────────

create or replace function moderator_hide_item(
  p_item_id uuid,
  p_reason  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_title text;
begin
  perform assert_moderator();

  select owner_id, title into v_owner, v_title from items where id = p_item_id;
  if v_owner is null then
    raise exception 'RENTHUB_NOT_FOUND: объявление не найдено' using errcode = '42501';
  end if;

  perform set_config('renthub.system_write', 'on', true);

  update items
     set status           = 'hidden',
         moderated_at     = now(),
         moderated_reason = p_reason
   where id = p_item_id;

  -- Окно закрывается здесь. Всё, что случится в этой транзакции дальше,
  -- снова проходит через сторожей.
  perform set_config('renthub.system_write', '', true);

  insert into notifications (user_id, type, title, body)
  values (
    v_owner,
    'item_hidden',
    'Объявление снято с публикации',
    coalesce(p_reason, 'Решение модератора RentHUB.') || ' Объявление: ' || v_title
  );
end;
$$;

-- ── Снятие ограничения ────────────────────────────────────────

create or replace function moderator_restore_item(
  p_item_id uuid,
  p_note    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_title text;
  v_mark  timestamptz;
begin
  perform assert_moderator();

  select owner_id, title, moderated_at
    into v_owner, v_title, v_mark
    from items where id = p_item_id;

  if v_owner is null then
    raise exception 'RENTHUB_NOT_FOUND: объявление не найдено' using errcode = '42501';
  end if;

  if v_mark is null then
    raise exception 'RENTHUB_BAD_STATE: на объявлении нет ограничения'
      using errcode = '42501';
  end if;

  perform set_config('renthub.system_write', 'on', true);

  update items
     set moderated_at     = null,
         moderated_reason = null
   where id = p_item_id;

  perform set_config('renthub.system_write', '', true);

  insert into notifications (user_id, type, title, body)
  values (
    v_owner,
    'item_restored',
    'Ограничение снято',
    coalesce(p_note, 'Модератор снял ограничение.')
      || ' Объявление: ' || v_title
      || '. Вернуть его в каталог можно в «Моих вещах».'
  );
end;
$$;

-- ── Блокировка участника ──────────────────────────────────────
--
-- Тот же флаг и та же утечка. Здесь она опаснее по смыслу: после
-- блокировки в этой же транзакции стал бы доступен весь белый список полей
-- профиля — verified_at, rating, telegram_id.

create or replace function set_user_blocked(
  p_user_id uuid,
  p_blocked boolean,
  p_reason  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hidden integer := 0;
begin
  perform assert_moderator();

  if p_user_id = auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: нельзя заблокировать самого себя'
      using errcode = '42501';
  end if;

  if p_blocked and exists (select 1 from users where id = p_user_id and is_moderator) then
    raise exception 'RENTHUB_FORBIDDEN: модератора нельзя заблокировать из приложения'
      using errcode = '42501';
  end if;

  -- Объявления снимаются ПЕРВЫМИ — до отметки о блокировке. Иначе триггер
  -- items_verify_owner увидит уже заблокированного владельца и не даст
  -- тронуть его же строки.
  if p_blocked then
    with hidden as (
      update items
         set status = 'hidden'
       where owner_id = p_user_id and status = 'active'
      returning 1
    )
    select count(*) into v_hidden from hidden;
  end if;

  perform set_config('renthub.system_write', 'on', true);

  update users
     set blocked_at = case when p_blocked then now() else null end,
         blocked_reason = case when p_blocked then p_reason else null end
   where id = p_user_id;

  perform set_config('renthub.system_write', '', true);

  insert into notifications (user_id, type, title, body)
  values (
    p_user_id,
    case when p_blocked then 'blocked' else 'unblocked' end,
    case when p_blocked then 'Доступ ограничен' else 'Доступ восстановлен' end,
    case
      when p_blocked then
        coalesce(p_reason, 'Решение модератора RentHUB. Ответить можно организатору пилота.')
        || case
             when v_hidden > 0
               then ' Ваши объявления сняты с публикации: ' || v_hidden || '.'
             else ''
           end
      else 'Вы снова можете сдавать и арендовать.'
           || case
                when exists (
                  select 1 from items
                   where owner_id = p_user_id and status = 'hidden'
                )
                  then ' Объявления остались скрытыми — верните в витрину те, что ещё актуальны.'
                else ''
              end
    end
  );
end;
$$;
