-- ─────────────────────────────────────────────────────────────
-- Инструменты модератора: блокировка, снятие объявления, сообщение
--
-- До сих пор модератор мог только смотреть и разрешать споры. Когда в пилот
-- придёт человек, выкладывающий чужие фото или не отдающий вещь, ответить
-- будет нечем: единственный рычаг — сервисный ключ в терминале, а он есть
-- не у того, кто разбирает.
--
-- Три действия, каждое — функция с проверкой права внутри:
--   set_user_blocked()  — закрыть человеку сдачу и аренду, не удаляя историю
--   moderator_hide_item() — снять объявление с публикации
--   moderator_notify()  — написать участнику; доставит бот в Telegram
--
-- Чего здесь намеренно нет: выдачи права модератора. Триггер
-- users_protect_moderator_role запрещает менять is_moderator из сессии, и
-- это правильно: модератор, способный назначить модератора, — это
-- эскалация прав в один клик. Роль по-прежнему выдаётся только сервисным
-- ключом через scripts/moderator.mjs.
-- ─────────────────────────────────────────────────────────────

alter table users add column blocked_at timestamptz;
alter table users add column blocked_reason text;

comment on column users.blocked_at is
  'Заблокирован модератором: не может создавать объявления и брони. История '
  'сделок и отзывы остаются — удаление данных участника это не заменяет.';

create index users_blocked_idx on users (blocked_at) where blocked_at is not null;

-- ── Запрет действий заблокированному ──────────────────────────
--
-- Проверка встраивается в assert_verified(), а не добавляется отдельным
-- триггером на каждую таблицу. Причина: assert_verified уже вызывается из
-- триггеров items и bookings перед любой записью, и это единственная точка,
-- которую нельзя обойти ни из приложения, ни из бота.

create or replace function assert_verified(p_user_id uuid, p_action text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_verified timestamptz;
  v_blocked  timestamptz;
begin
  select verified_at, blocked_at into v_verified, v_blocked
  from users where id = p_user_id;

  if v_verified is null then
    raise exception 'RENTHUB_NOT_VERIFIED: % требует подтверждённого номера телефона', p_action
      using errcode = '42501';
  end if;

  -- Отдельный код ошибки, а не общий отказ: приложение показывает человеку
  -- причину, и «вас заблокировали» — не то же самое, что «подтвердите номер».
  if v_blocked is not null then
    raise exception 'RENTHUB_BLOCKED: доступ ограничен модератором'
      using errcode = '42501';
  end if;
end;
$$;

-- ── Блокировка ────────────────────────────────────────────────

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
begin
  perform assert_moderator();

  -- Себя заблокировать нельзя: это единственный способ остаться без
  -- модератора вообще, а снять блокировку сможет только сервисный ключ.
  if p_user_id = auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: нельзя заблокировать самого себя'
      using errcode = '42501';
  end if;

  if p_blocked and exists (select 1 from users where id = p_user_id and is_moderator) then
    raise exception 'RENTHUB_FORBIDDEN: модератора нельзя заблокировать из приложения'
      using errcode = '42501';
  end if;

  update users
     set blocked_at = case when p_blocked then now() else null end,
         blocked_reason = case when p_blocked then p_reason else null end
   where id = p_user_id;

  -- Человек должен узнать о решении, а не обнаружить его при попытке
  -- забронировать. Уведомление заберёт бот и доставит в Telegram.
  insert into notifications (user_id, type, title, body)
  values (
    p_user_id,
    case when p_blocked then 'blocked' else 'unblocked' end,
    case when p_blocked then 'Доступ ограничен' else 'Доступ восстановлен' end,
    case
      when p_blocked then coalesce(p_reason, 'Решение модератора RentHUB. Ответить можно организатору пилота.')
      else 'Вы снова можете сдавать и арендовать.'
    end
  );
end;
$$;

-- ── Снятие объявления ─────────────────────────────────────────

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

  update items set status = 'hidden' where id = p_item_id;

  insert into notifications (user_id, type, title, body)
  values (
    v_owner,
    'item_hidden',
    'Объявление снято с публикации',
    coalesce(p_reason, 'Решение модератора RentHUB.') || ' Объявление: ' || v_title
  );
end;
$$;

-- ── Сообщение участнику ───────────────────────────────────────
--
-- Модератору нужен способ написать человеку, не выпрашивая его телефон.
-- Сообщение кладётся в ту же таблицу, что и системные уведомления, и
-- уезжает в Telegram тем же ботом — отдельного канала связи заводить не надо.

create or replace function moderator_notify(
  p_user_id uuid,
  p_title   text,
  p_body    text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_moderator();

  if length(trim(coalesce(p_title, ''))) < 3 then
    raise exception 'RENTHUB_BAD_INPUT: у сообщения должен быть заголовок'
      using errcode = '22023';
  end if;

  insert into notifications (user_id, type, title, body)
  values (p_user_id, 'moderator_message', trim(p_title), nullif(trim(coalesce(p_body, '')), ''));
end;
$$;

-- ── Права на вызов ────────────────────────────────────────────

revoke all on function set_user_blocked(uuid, boolean, text) from public;
revoke all on function moderator_hide_item(uuid, text) from public;
revoke all on function moderator_notify(uuid, text, text) from public;

revoke execute on function set_user_blocked(uuid, boolean, text) from anon;
revoke execute on function moderator_hide_item(uuid, text) from anon;
revoke execute on function moderator_notify(uuid, text, text) from anon;

grant execute on function set_user_blocked(uuid, boolean, text) to authenticated;
grant execute on function moderator_hide_item(uuid, text) to authenticated;
grant execute on function moderator_notify(uuid, text, text) to authenticated;

-- ── Список участников: показать блокировку ────────────────────

create or replace function moderation_people()
returns table (
  id uuid,
  full_name text,
  phone text,
  verified boolean,
  telegram boolean,
  is_moderator boolean,
  blocked boolean,
  blocked_reason text,
  items integer,
  bookings integer,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from users u where u.id = auth.uid() and u.is_moderator) then
    raise exception 'RENTHUB_FORBIDDEN: список участников доступен только модератору'
      using errcode = '42501';
  end if;

  return query
  select
    u.id,
    u.full_name,
    u.phone,
    u.verified_at is not null,
    u.telegram_id is not null,
    u.is_moderator,
    u.blocked_at is not null,
    u.blocked_reason,
    (select count(*)::int from items i where i.owner_id = u.id),
    (select count(*)::int from bookings b where b.renter_id = u.id),
    u.created_at
  from users u
  order by u.blocked_at desc nulls last, u.created_at desc
  limit 200;
end;
$$;

revoke all on function moderation_people() from public;
revoke execute on function moderation_people() from anon;
grant execute on function moderation_people() to authenticated;
