-- Профиль: человек меняет только то, что про него, а не то, что о нём.
--
-- Политика users_update_own разрешает менять СВОЮ СТРОКУ ЦЕЛИКОМ, а триггер
-- сторожил ровно одно поле — is_moderator. Всё остальное было открыто, и
-- два случая из этого — не мелочь.
--
--   update users set verified_at = now() where id = auth.uid();
--
-- Это обход ПРАВИЛА 1. Верификация ставится триггером из auth.users, когда
-- человек подтвердил номер кодом; здесь она проставлялась одним запросом
-- без всякого кода. После этого можно и сдавать, и арендовать.
--
--   update users set rating = 5.00, ratings_count = 99 where id = auth.uid();
--
-- Это подделка Trust Score. Рейтинг пересчитывает триггер из настоящих
-- отзывов по закрытым сделкам — и он же был перезаписываем поверх. Витрина
-- показывает эту цифру как главный признак доверия: по ней решают, отдать
-- ли незнакомцу вещь за 90 000 ₸.
--
-- Проверено на стенде до правки: оба запроса проходили.
--
-- ── Почему белый список, а не перечень запретов ───────────────
--
-- Запрещать по одному — значит открывать каждое новое поле по умолчанию:
-- добавили колонку, забыли строку в триггере, и она редактируема. Белый
-- список ошибается в другую сторону — новое поле закрыто, пока его не
-- впишут сознательно. Для таблицы, где лежат верификация и рейтинг, это
-- единственный безопасный порядок.
--
-- Менять человеку разрешено ровно три вещи, и все они про него самого:
-- как его зовут, кем он себя считает и хочет ли следить за сделками сам.

create or replace function users_role_guard()
returns trigger
language plpgsql
as $$
begin
  -- Сервисный ключ и планировщик работают без сессии: у них auth.uid()
  -- пуст. Скрипты приглашения, модератора и привязки Telegram пишут сюда
  -- именно так, и запрещать им — значит запретить заводить участников.
  if auth.uid() is null then
    return new;
  end if;

  -- Изменение пришло из другого триггера — значит его сделала система, а не
  -- человек. Так работают два законных пути: reviews_recalc_rating
  -- пересчитывает rating после отзыва, sync_phone_verification проставляет
  -- verified_at после подтверждения номера. Оба идут В СЕССИИ человека, и
  -- без этой проверки белый список запретил бы им то, ради чего они есть.
  --
  -- Первая версия миграции этого не учитывала, и стенд упал на обычном
  -- отзыве: пересчёт рейтинга получил отказ от собственной защиты.
  if pg_trigger_depth() > 1 then
    return new;
  end if;

  -- Явное системное изменение из функции: set_user_blocked() работает от
  -- имени модератора, то есть с сессией, и меняет blocked_at. Флаг ставится
  -- прямо перед update и живёт только внутри той функции — у неё своё
  -- предложение SET, и параметр откатывается на выходе.
  if coalesce(current_setting('renthub.system_write', true), '') = 'on' then
    return new;
  end if;

  -- Роль модератора — отдельным сообщением, а не общим: «выдаётся только
  -- сервисным ключом» объясняет, ЧТО делать дальше, а общий текст про
  -- белый список здесь звучал бы как отказ без причины.
  if new.is_moderator is distinct from old.is_moderator then
    raise exception 'RENTHUB_FORBIDDEN: роль модератора выдаётся только сервисным ключом'
      using errcode = '42501';
  end if;

  if new.id is distinct from old.id
     or new.phone is distinct from old.phone
     or new.verified_at is distinct from old.verified_at
     or new.rating is distinct from old.rating
     or new.ratings_count is distinct from old.ratings_count
     or new.telegram_id is distinct from old.telegram_id
     or new.telegram_username is distinct from old.telegram_username
     or new.blocked_at is distinct from old.blocked_at
     or new.blocked_reason is distinct from old.blocked_reason
     or new.created_at is distinct from old.created_at
  then
    raise exception
      'RENTHUB_FORBIDDEN: в профиле можно менять имя, роль и пассивный режим — '
      'остальное проставляет система'
      using errcode = '42501';
  end if;

  return new;
end;
$$;

comment on function users_role_guard() is
  'Белый список полей профиля. Человеку доступны full_name, role_hint и '
  'passive_mode; верификацию, рейтинг, роль, привязку Telegram и блокировку '
  'проставляет система. Без сессии (сервисный ключ) проверка не применяется.';

-- ── set_user_blocked теперь помечает свою запись системной ─────
--
-- Она меняет blocked_at от имени модератора, то есть с сессией, и попала бы
-- под белый список. Флаг ставится перед самым update и не переживает выхода
-- из функции: у неё есть предложение SET search_path, а оно открывает свой
-- уровень параметров.

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
