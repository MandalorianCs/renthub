-- Бот двигает сделки, не дублируя правил.
--
-- До сих пор бот умел только читать и доставлять уведомления. Причина
-- записана в bot/README.md: переходы живут в RPC и опираются на auth.uid(),
-- а у сервисного ключа его нет — функция не понимает, от чьего имени её
-- позвали, и отказывает.
--
-- Там же «правильным» назван путь с пользовательским токеном: бот получает
-- access token человека и ходит в PostgREST как он. Путь упирается в то,
-- что admin/generate_link выдаёт ссылки только по email, а участники здесь
-- заводятся по телефону. Остаётся legacy JWT-секрет из панели — внешний
-- секрет, который надо держать рядом с ботом и однажды ротировать.
--
-- Здесь другой способ, дающий тот же результат без нового секрета.
-- auth.uid() читает не «сессию», а параметр request.jwt.claims. Обёртка
-- выставляет его и вызывает ТУ ЖЕ функцию, что зовёт приложение. Правило
-- остаётся одно на оба входа: booking_confirm() сама проверит, что
-- подтверждает владелец, сама запланирует выплаты и сама пришлёт
-- уведомление. Обёртка не знает, кто владелец, и знать не должна.
--
-- Прав это боту не добавляет. Сервисный ключ и так обходит RLS целиком —
-- прямой `update bookings set status` ему доступен и сегодня, мимо всех
-- проверок. Обёртка не расширяет доступ, а сужает: заставляет действия
-- бота проходить ровно те же проверки, что и действия приложения.
--
-- Опасен ровно один сценарий: если такая функция получит право на вызов
-- для authenticated, любой вошедший сможет действовать от чужого имени —
-- достаточно передать чужой uuid аргументом. Поэтому ниже явный revoke на
-- каждую, а стенд проверяет отказ и вошедшему, и анониму.
--
-- ── Подводный камень, из-за которого set_config стоит в каждом теле ──
--
-- Выставление контекста намеренно не вынесено во вспомогательную функцию.
-- Функция с предложением SET (у нас у всех стоит `set search_path =
-- public`) открывает свой уровень параметров, и всё, что set_config
-- поставил внутри неё, откатывается на выходе. Общая bot_assume_user()
-- выглядела бы работающей и не делала бы ничего: контекст умирал бы
-- раньше, чем обёртка дойдёт до вызова. Проверка привязки вынесена —
-- она ничего не выставляет, и её можно звать откуда угодно.

-- ── Пропуск бота ──────────────────────────────────────────────

create or replace function bot_actor_ok(p_actor uuid)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Привязка к Telegram и есть доказательство, что бот говорит с тем, за
  -- кого себя выдаёт: telegram_id появляется в профиле только после
  -- «Поделиться номером», когда номер подтвердил сам Telegram.
  if not exists (select 1 from users where id = p_actor and telegram_id is not null) then
    raise exception 'RENTHUB_FORBIDDEN: участник не привязан к Telegram'
      using errcode = '42501';
  end if;
end;
$$;

-- ── Переходы статусов ─────────────────────────────────────────

create or replace function bot_booking_confirm(p_actor uuid, p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform booking_confirm(p_booking_id);
end;
$$;

create or replace function bot_booking_picked_up(p_actor uuid, p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform booking_mark_picked_up(p_booking_id);
end;
$$;

create or replace function bot_booking_returned(p_actor uuid, p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform booking_mark_returned(p_booking_id);
end;
$$;

create or replace function bot_booking_complete(p_actor uuid, p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform booking_complete(p_booking_id);
end;
$$;

-- ── Претензия по порче ────────────────────────────────────────
--
-- Фото приходят ссылками: бот кладёт файл из Telegram в тот же bucket
-- item-photos, что и приложение, и передаёт сюда публичные адреса. Порог
-- авторешения, обрезка размером депозита и выбор «сам или модератор»
-- остаются внутри open_damage_dispute().

create or replace function bot_open_damage_dispute(
  p_actor        uuid,
  p_booking_id   uuid,
  p_claim_amount integer,
  p_photos       text[],
  p_description  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform open_damage_dispute(p_booking_id, p_claim_amount, p_photos, p_description);
end;
$$;

-- ── Отмена и отзыв переезжают в RPC ───────────────────────────
--
-- Эти два действия приложение делает прямым запросом в таблицу, а правила
-- держат политика RLS и триггер. Боту этого мало: под сервисным ключом RLS
-- не применяется вовсе, а переключить роль внутри security definer нельзя —
-- Postgres отвечает «cannot set parameter role within security-definer
-- function». Дублировать правило в обёртке нельзя тем более.
--
-- Значит правилу место там же, где живут остальные переходы, — в функции.
-- Тогда вход один и для приложения, и для бота, а обёртке хватает
-- auth.uid().
--
-- Отмена заодно закрывает давний открытый вопрос из README. Политика
-- bookings_cancel_pending проверяет в `with check` только renter_id и
-- status, поэтому арендатор мог тем же UPDATE переписать суммы своей
-- неподтверждённой брони. Пока деньги не двигаются, это безвредно, но на
-- этапе реальных платежей суммы отменённых броней начнут читаться при
-- возвратах. Функция меняет один столбец — переписывать нечего.

create or replace function booking_cancel(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.id is null then
    raise exception 'RENTHUB_NOT_FOUND: бронь не найдена' using errcode = '42501';
  end if;

  if v_b.renter_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: отменить бронь может только арендатор'
      using errcode = '42501';
  end if;

  if v_b.status <> 'pending' then
    raise exception 'RENTHUB_BAD_STATE: отменить можно только неподтверждённую бронь (статус %)', v_b.status
      using errcode = '42501';
  end if;

  update bookings set status = 'cancelled' where id = p_booking_id;

  -- Владелец в пассивном режиме не следит за списком заявок, и отменённая
  -- бронь иначе просто исчезла бы у него из «ждёт подтверждения» без
  -- объяснения. Молчание здесь читается как сбой.
  perform notify_user(v_b.owner_id, v_b.id, 'booking_cancelled',
    'Заявка отменена', 'Арендатор отменил неподтверждённую заявку. Даты снова свободны.');
end;
$$;

comment on function booking_cancel(uuid) is
  'Отмена неподтверждённой брони. Меняет только статус — в отличие от '
  'прямого UPDATE, которым можно было переписать и суммы.';

create or replace function submit_review(
  p_booking_id uuid,
  p_to_user    uuid,
  p_rating     integer,
  p_comment    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  -- Автор — всегда вызывающий. Раньше это держала политика
  -- reviews_insert_own через `with check (from_user_id = auth.uid())`;
  -- теперь автор не приходит аргументом вовсе, и подставить чужого нельзя
  -- даже по ошибке. Остальное — что отзыв только после закрытой сделки и
  -- только от стороны — проверяет триггер reviews_validate.
  insert into reviews (booking_id, from_user_id, to_user_id, rating, comment)
  values (p_booking_id, auth.uid(), p_to_user, p_rating,
          nullif(trim(coalesce(p_comment, '')), ''));
end;
$$;

comment on function submit_review(uuid, uuid, integer, text) is
  'Отзыв о второй стороне. Автора берёт из auth.uid(), а не из аргумента.';

grant execute on function booking_cancel(uuid) to authenticated;
grant execute on function submit_review(uuid, uuid, integer, text) to authenticated;
revoke execute on function booking_cancel(uuid) from anon;
revoke execute on function submit_review(uuid, uuid, integer, text) from anon;

-- ── Обёртки для них ───────────────────────────────────────────

create or replace function bot_cancel_booking(p_actor uuid, p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform booking_cancel(p_booking_id);
end;
$$;

create or replace function bot_submit_review(
  p_actor      uuid,
  p_booking_id uuid,
  p_to_user    uuid,
  p_rating     integer,
  p_comment    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform submit_review(p_booking_id, p_to_user, p_rating, p_comment);
end;
$$;

-- ── Права на вызов ────────────────────────────────────────────
--
-- Право позвать любую из этих функций равно праву действовать от чужого
-- имени: получатель auth.uid() приходит аргументом. Оно должно быть
-- только у сервисного ключа, то есть у бота.

revoke all on function bot_actor_ok(uuid) from public;
revoke all on function bot_booking_confirm(uuid, uuid) from public;
revoke all on function bot_booking_picked_up(uuid, uuid) from public;
revoke all on function bot_booking_returned(uuid, uuid) from public;
revoke all on function bot_booking_complete(uuid, uuid) from public;
revoke all on function bot_open_damage_dispute(uuid, uuid, integer, text[], text) from public;
revoke all on function bot_cancel_booking(uuid, uuid) from public;
revoke all on function bot_submit_review(uuid, uuid, uuid, integer, text) from public;

revoke execute on function bot_actor_ok(uuid) from anon, authenticated;
revoke execute on function bot_booking_confirm(uuid, uuid) from anon, authenticated;
revoke execute on function bot_booking_picked_up(uuid, uuid) from anon, authenticated;
revoke execute on function bot_booking_returned(uuid, uuid) from anon, authenticated;
revoke execute on function bot_booking_complete(uuid, uuid) from anon, authenticated;
revoke execute on function bot_open_damage_dispute(uuid, uuid, integer, text[], text) from anon, authenticated;
revoke execute on function bot_cancel_booking(uuid, uuid) from anon, authenticated;
revoke execute on function bot_submit_review(uuid, uuid, uuid, integer, text) from anon, authenticated;

comment on function bot_booking_confirm(uuid, uuid) is
  'Подтверждение брони из Telegram. Проверок не дублирует — выставляет '
  'auth.uid() и зовёт booking_confirm(). Только для сервисного ключа.';
