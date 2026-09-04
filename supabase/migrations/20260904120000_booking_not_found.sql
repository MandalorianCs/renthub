-- Сделка, которой нет, отвечала английским текстом Postgres.
--
-- `select * into v_b from bookings where id = ...` по несуществующей строке
-- не падает — он оставляет v_b пустым. Дальше проверка владельца снова
-- сравнивает с NULL и снова не срабатывает (та же трёхзначная логика, что и
-- в 20260904110000), функция идёт по пустой строке и валится там, где
-- NOT NULL стоит физически.
--
-- Измерено 04.09.2026 на стенде, от имени вошедшего:
--
--   booking_confirm         null value in column "booking_id" of relation "payouts"
--   booking_mark_picked_up  null value in column "user_id" of relation "notifications"
--   booking_mark_returned   то же
--   booking_complete        то же
--   open_damage_dispute     violates foreign key constraint on "disputes"
--
-- Что видит человек. Ни одна из этих строк не начинается с RENTHUB_ и ни
-- одна не совпадает со списком известных ограничений, поэтому humanizeError
-- показывает её как есть — английский текст с именами таблиц и колонок.
-- В боте она превращается в «Не получилось, попробуйте ещё раз».
--
-- Когда это случается: человек держал открытой карточку сделки или ссылку,
-- а сделку тем временем удалили. README называет этот класс гонкой и уже
-- разбирает его для объявлений.
--
-- Две функции из семи так не делали — booking_cancel и booking_contact
-- проверяют находку и отвечают «не найдена». То есть правильный образец в
-- проекте был, до остальных он просто не дошёл.
--
-- Тела ниже извлечены из последних миграций, где функции определены, и
-- отличаются ровно вставленной проверкой.

-- ── booking_confirm ───────────────────────────────
-- Тело перенесено из 20260904110000_anon_cannot_move_deals.sql без изменений, кроме проверки.

create or replace function booking_confirm(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  perform assert_signed_in();

  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.id is null then
    raise exception 'RENTHUB_NOT_FOUND: сделка не найдена' using errcode = '42501';
  end if;

  if v_b.owner_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: подтверждать бронь может только владелец';
  end if;

  if v_b.status <> 'pending' then
    raise exception 'RENTHUB_BAD_STATE: бронь уже в статусе %', v_b.status;
  end if;

  update bookings set status = 'confirmed' where id = p_booking_id returning * into v_b;

  perform schedule_payouts(v_b.id);

  perform notify_user(v_b.renter_id, v_b.id, 'booking_confirmed',
    'Бронь подтверждена', 'Владелец подтвердил аренду. Депозит заблокирован.');

  return v_b;
end;
$$;

-- ── booking_mark_picked_up ────────────────────────
-- Тело перенесено из 20260904110000_anon_cannot_move_deals.sql без изменений, кроме проверки.

create or replace function booking_mark_picked_up(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  perform assert_signed_in();

  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.id is null then
    raise exception 'RENTHUB_NOT_FOUND: сделка не найдена' using errcode = '42501';
  end if;

  if v_b.renter_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: подтвердить получение может только арендатор';
  end if;

  if v_b.status <> 'confirmed' then
    raise exception 'RENTHUB_BAD_STATE: ожидался статус confirmed, получен %', v_b.status;
  end if;

  update bookings
     set status = 'active', picked_up_at = now()
   where id = p_booking_id
  returning * into v_b;

  perform notify_user(v_b.owner_id, v_b.id, 'item_picked_up',
    'Вещь забрали', 'Арендатор подтвердил получение. Вернуть до ' || v_b.end_date || '.');

  return v_b;
end;
$$;

-- ── booking_mark_returned ─────────────────────────
-- Тело перенесено из 20260904110000_anon_cannot_move_deals.sql без изменений, кроме проверки.

create or replace function booking_mark_returned(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  perform assert_signed_in();

  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.id is null then
    raise exception 'RENTHUB_NOT_FOUND: сделка не найдена' using errcode = '42501';
  end if;

  if v_b.owner_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: принять вещь может только владелец';
  end if;

  if v_b.status not in ('active', 'disputed') then
    raise exception 'RENTHUB_BAD_STATE: вещь не находится в аренде (статус %)', v_b.status;
  end if;

  -- Из disputed возврат отмечается только тогда, когда вещь действительно
  -- не вернули: открыт спор о невозврате. Разбор порчи идёт по вещи,
  -- которая уже у владельца, и «принять её обратно» второй раз нечего.
  if v_b.status = 'disputed'
     and not exists (
       select 1 from disputes
        where booking_id = p_booking_id
          and type = 'non_return'
          and resolution_status = 'manual_review'
     )
  then
    raise exception
      'RENTHUB_BAD_STATE: вещь уже возвращена, идёт разбор претензии — дождитесь решения модератора'
      using errcode = '42501';
  end if;

  update bookings
     set status               = 'returned',
         returned_at          = now(),
         damage_claim_ends_at = now() + (setting('damage_claim_window_hours') || ' hours')::interval
   where id = p_booking_id
  returning * into v_b;

  -- Если вещь вернули после автоспора о невозврате — спор закрываем,
  -- депозит возвращается в held до истечения окна на претензию по порче.
  update disputes
     set resolution_status = 'resolved',
         resolution_note   = 'Вещь возвращена после открытия спора',
         resolved_at       = now()
   where booking_id = p_booking_id
     and type = 'non_return'
     and resolution_status = 'manual_review';

  -- Депозит возвращается в held только если по сделке ничего не удержано.
  -- Безусловный held стирал бы уже присуждённую компенсацию за порчу.
  update bookings set deposit_status = 'held'
   where id = p_booking_id
     and not exists (
       select 1 from disputes
        where booking_id = p_booking_id and payout_amount > 0
     );

  perform notify_user(v_b.renter_id, v_b.id, 'item_returned',
    'Вещь принята', 'Владелец подтвердил возврат. Депозит разблокируется после проверки состояния.');

  return v_b;
end;
$$;

-- ── booking_complete ──────────────────────────────
-- Тело перенесено из 20260904110000_anon_cannot_move_deals.sql без изменений, кроме проверки.

create or replace function booking_complete(p_booking_id uuid, p_force boolean default false)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  -- coalesce обязателен, и это не перестраховка: первая версия этой
  -- заплатки написала «if not p_force», и вызов с p_force => null прошёл
  -- мимо проверки — та же трёхзначная логика, которая и породила всю
  -- находку. Поймал стенд, через один прогон после того, как правило
  -- было написано.
  if not coalesce(p_force, false) then
    perform assert_signed_in();
  end if;

  select * into v_b from bookings where id = p_booking_id;

  if v_b.id is null then
    raise exception 'RENTHUB_NOT_FOUND: сделка не найдена' using errcode = '42501';
  end if;

  if not p_force and v_b.owner_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN';
  end if;

  if v_b.status not in ('returned', 'disputed') then
    raise exception 'RENTHUB_BAD_STATE: закрыть можно только возвращённую сделку (статус %)', v_b.status;
  end if;

  if has_open_disputes(p_booking_id) then
    raise exception 'RENTHUB_OPEN_DISPUTE: по сделке есть неразрешённый спор';
  end if;

  perform settle_booking(p_booking_id);

  select * into v_b from bookings where id = p_booking_id;
  return v_b;
end;
$$;

-- ── open_damage_dispute ───────────────────────────
-- Тело перенесено из 20260904110000_anon_cannot_move_deals.sql без изменений, кроме проверки.

create or replace function open_damage_dispute(
  p_booking_id   uuid,
  p_claim_amount integer,
  p_photos       text[],
  p_description  text default null
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b         bookings%rowtype;
  v_item      items%rowtype;
  v_threshold integer := setting('dispute_auto_threshold')::integer;
  v_dispute   disputes%rowtype;
  v_payout    integer;
begin
  perform assert_signed_in();

  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.id is null then
    raise exception 'RENTHUB_NOT_FOUND: сделка не найдена' using errcode = '42501';
  end if;

  if v_b.owner_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: заявить о порче может только владелец';
  end if;

  if v_b.status <> 'returned' then
    raise exception 'RENTHUB_BAD_STATE: претензия по порче подаётся после возврата вещи';
  end if;

  if v_b.damage_claim_ends_at is not null and now() > v_b.damage_claim_ends_at then
    raise exception 'RENTHUB_CLAIM_WINDOW_CLOSED: окно для претензии истекло %', v_b.damage_claim_ends_at;
  end if;

  if coalesce(array_length(p_photos, 1), 0) = 0 then
    raise exception 'RENTHUB_NO_EVIDENCE: нужны фото «после» для сверки с фото «до»';
  end if;

  select * into v_item from items where id = v_b.item_id;

  insert into disputes (booking_id, opened_by, type, description, evidence_photos, claim_amount)
  values (p_booking_id, auth.uid(), 'damage', p_description, p_photos, p_claim_amount)
  returning * into v_dispute;

  update bookings set status = 'disputed', deposit_status = 'claimed' where id = p_booking_id;

  if p_claim_amount <= v_threshold then
    -- Ниже порога — решаем автоматически, без ручной модерации.
    v_payout := decide_dispute_payout(p_claim_amount, v_b.deposit_snapshot);

    update disputes
       set resolution_status = 'auto_resolved',
           payout_amount     = v_payout,
           resolution_note   = 'Автоматически: сумма ниже порога ' || v_threshold || ' ₸',
           resolved_at       = now()
     where id = v_dispute.id
    returning * into v_dispute;

    perform notify_user(v_b.renter_id, v_b.id, 'dispute_auto_resolved',
      'Претензия по состоянию вещи',
      'Из депозита удержано ' || v_payout || ' ₸.',
      jsonb_build_object('payout_amount', v_payout,
                         'evidence_before', to_jsonb(v_item.condition_photos),
                         'evidence_after', to_jsonb(p_photos)));

    perform notify_user(v_b.owner_id, v_b.id, 'dispute_auto_resolved',
      'Компенсация начислена', 'Вам будет выплачено ' || v_payout || ' ₸ из депозита.');

    -- Спор решён без человека — держать сделку больше нечем, закрываем
    -- тем же шлюзом, что и обычную. Владельцу ничего нажимать не нужно.
    perform settle_booking(p_booking_id);
  else
    perform notify_user(v_b.renter_id, v_b.id, 'dispute_manual_review',
      'Открыт спор по состоянию вещи', 'Сумма выше порога, решение примет модератор.');
    perform notify_user(v_b.owner_id, v_b.id, 'dispute_manual_review',
      'Спор передан на модерацию', 'Сумма выше порога авторазрешения.');
  end if;

  return v_dispute;
end;
$$;
