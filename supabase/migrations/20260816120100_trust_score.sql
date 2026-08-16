-- RentHUB — Trust Score как явные бизнес-правила.
--
-- Важно: правила живут в базе, а не в приложении. К этой же базе позже
-- подключится Telegram-бот на aiogram — если проверки будут только в
-- React-компонентах, бот их просто обойдёт. Инвариант, который стоит денег,
-- должен быть невозможно нарушить ни из какого клиента.

-- ─────────────────────────────────────────────────────────────
-- Уведомления: сердце «пассивного режима» владельца
-- ─────────────────────────────────────────────────────────────

create or replace function notify_user(
  p_user_id    uuid,
  p_booking_id uuid,
  p_type       text,
  p_title      text,
  p_body       text default null,
  p_payload    jsonb default '{}'
) returns void
language sql
security definer
set search_path = public
as $$
  insert into notifications (user_id, booking_id, type, title, body, payload)
  values (p_user_id, p_booking_id, p_type, p_title, p_body, p_payload);
$$;

-- ─────────────────────────────────────────────────────────────
-- ПРАВИЛО 1. Верификация
-- Без verified_at нельзя ни создать объявление, ни забронировать.
-- ─────────────────────────────────────────────────────────────

create or replace function assert_verified(p_user_id uuid, p_action text)
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_verified timestamptz;
begin
  select verified_at into v_verified from users where id = p_user_id;

  if v_verified is null then
    raise exception 'RENTHUB_NOT_VERIFIED: % требует подтверждённого номера телефона', p_action
      using errcode = '42501';
  end if;
end;
$$;

create or replace function items_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_verified(new.owner_id, 'Создание объявления');
  new.updated_at := now();
  return new;
end;
$$;

create trigger items_verify_owner
  before insert or update on items
  for each row execute function items_before_write();

-- ─────────────────────────────────────────────────────────────
-- Расчёт стоимости — один источник правды.
-- Клиент показывает те же цифры, но авторитет здесь: сумму сделки
-- нельзя подделать, отправив свои числа в insert.
-- ─────────────────────────────────────────────────────────────

create or replace function calc_booking_price(
  p_daily_price integer,
  p_days        integer,
  p_insurance   boolean
) returns table (
  rent_total         integer,
  platform_fee       integer,
  insurance_fee      integer,
  renter_total       integer,
  owner_payout_total integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_rent      integer := p_daily_price * p_days;
  v_fee       integer := round(v_rent * setting('commission_pct') / 100.0);
  v_insurance integer := case when p_insurance then setting('insurance_fee')::integer else 0 end;
begin
  return query select
    v_rent,
    v_fee,
    v_insurance,
    v_rent + v_insurance,  -- депозит сюда не входит: он блокируется отдельно
    v_rent - v_fee;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- ПРАВИЛО 3. Создание брони: депозит уходит в 'held'
-- (эмуляция блокировки средств — в MVP это просто статус)
-- ─────────────────────────────────────────────────────────────

create or replace function bookings_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item  items%rowtype;
  v_price record;
  v_days  integer;
begin
  select * into v_item from items where id = new.item_id;

  if v_item.id is null then
    raise exception 'RENTHUB_ITEM_NOT_FOUND';
  end if;

  if v_item.status <> 'active' then
    raise exception 'RENTHUB_ITEM_HIDDEN: объявление снято с публикации';
  end if;

  perform assert_verified(new.renter_id, 'Бронирование');

  if v_item.owner_id = new.renter_id then
    raise exception 'RENTHUB_SELF_BOOKING: нельзя забронировать собственную вещь';
  end if;

  if new.start_date < current_date then
    raise exception 'RENTHUB_PAST_DATE: аренда не может начинаться в прошлом';
  end if;

  -- Оба дня включительно: аренда «с 1 по 1 число» — это один день.
  v_days := (new.end_date - new.start_date) + 1;

  select * into v_price
  from calc_booking_price(v_item.daily_price, v_days, coalesce(new.insurance_selected, false));

  new.owner_id             := v_item.owner_id;
  new.days                 := v_days;
  new.status               := 'pending';
  new.deposit_status       := 'held';
  new.daily_price_snapshot := v_item.daily_price;
  new.deposit_snapshot     := v_item.deposit_amount;
  new.rent_total           := v_price.rent_total;
  new.platform_fee         := v_price.platform_fee;
  new.insurance_fee        := v_price.insurance_fee;
  new.renter_total         := v_price.renter_total;
  new.owner_payout_total   := v_price.owner_payout_total;

  -- Дедлайн возврата = конец последних суток аренды + grace period
  new.grace_period_ends_at :=
    (new.end_date + 1)::timestamptz + (setting('grace_period_hours') || ' hours')::interval;

  return new;
end;
$$;

create trigger bookings_prepare
  before insert on bookings
  for each row execute function bookings_before_insert();

create or replace function bookings_after_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform notify_user(
    new.owner_id, new.id, 'booking_requested',
    'Новый запрос на аренду',
    'Вашу вещь хотят арендовать с ' || new.start_date || ' по ' || new.end_date,
    jsonb_build_object('renter_total', new.renter_total, 'days', new.days)
  );
  return new;
end;
$$;

create trigger bookings_notify_owner
  after insert on bookings
  for each row execute function bookings_after_insert();

-- ─────────────────────────────────────────────────────────────
-- Выплаты владельцу.
--
-- Одна выплата за сделку, начисляется при закрытии. Периодические транши
-- для длинной аренды отложены: строка payouts уже описывает период
-- (period_start/period_end), поэтому включить их позже — переписать
-- только эту функцию, миграция схемы не понадобится.
-- ─────────────────────────────────────────────────────────────

create or replace function schedule_payouts(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id;

  -- Пересчёт идемпотентен: неотпущенные начисления за аренду перезаписываем,
  -- уже released не трогаем. Компенсации ущерба сюда не относятся — они
  -- начисляются шлюзом закрытия и пересчёту по цене объявления не подлежат.
  delete from payouts
   where booking_id = p_booking_id and status = 'scheduled' and kind = 'rent';

  insert into payouts (booking_id, owner_id, period_start, period_end, amount, kind)
  values (v_b.id, v_b.owner_id, v_b.start_date, v_b.end_date, v_b.owner_payout_total, 'rent');
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- Переходы статусов сделки.
-- Отдельные RPC вместо «update bookings set status = ...» из клиента:
-- каждый переход проверяет, кто его делает и из какого состояния.
-- ─────────────────────────────────────────────────────────────

create or replace function booking_confirm(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id for update;

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

-- Факт передачи вещи подтверждает арендатор: он единственный, кто
-- физически знает, что вещь у него на руках.
create or replace function booking_mark_picked_up(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id for update;

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

-- ПРАВИЛО 4. Возврат вовремя → депозит отпускается.
-- Отмечает владелец: он принимает вещь и отвечает за оценку состояния.
create or replace function booking_mark_returned(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.owner_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: принять вещь может только владелец';
  end if;

  if v_b.status not in ('active', 'disputed') then
    raise exception 'RENTHUB_BAD_STATE: вещь не находится в аренде (статус %)', v_b.status;
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

-- ─────────────────────────────────────────────────────────────
-- ЗАКРЫТИЕ СДЕЛКИ — единый шлюз.
--
-- Закрыть сделку хотят четверо: владелец кнопкой, авторешение спора,
-- модератор и планировщик по таймеру. Раньше каждый пытался бы делать это
-- сам, и сделка со спором не закрывалась вообще ни одним из путей.
-- Теперь логика закрытия живёт в одном месте, а четверо решают только
-- МОМЕНТ вызова. Шлюз сам проверяет, не держит ли сделку что-то ещё.
-- ─────────────────────────────────────────────────────────────

-- Открытым считается только спор, ждущий человека. auto_resolved и resolved
-- — это уже закрытые споры; путать их с открытыми и означало вечный disputed.
create or replace function has_open_disputes(p_booking_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from disputes
     where booking_id = p_booking_id
       and resolution_status = 'manual_review'
  );
$$;

-- Довести сделку до конца, если больше ничто не мешает.
-- Возвращает true, если сделка закрыта именно этим вызовом.
-- Идемпотентна: повторный вызов на закрытой сделке ничего не делает.
create or replace function settle_booking(p_booking_id uuid)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b            bookings%rowtype;
  v_compensation integer;
begin
  select * into v_b from bookings where id = p_booking_id for update;

  -- Закрывать можно вернувшуюся сделку и сделку, вышедшую из спора.
  -- Всё остальное (pending, confirmed, active) ещё живёт своей жизнью.
  if v_b.status not in ('returned', 'disputed') then
    return false;
  end if;

  if has_open_disputes(p_booking_id) then
    return false;
  end if;

  -- Сколько удержано из депозита по всем закрытым спорам этой сделки.
  select coalesce(sum(payout_amount), 0) into v_compensation
    from disputes where booking_id = p_booking_id;

  update bookings
     set status         = 'completed',
         completed_at   = now(),
         -- Депозит удержан частично либо полностью, если была компенсация.
         deposit_status = (case when v_compensation > 0 then 'claimed' else 'released' end)::deposit_status
   where id = p_booking_id
  returning * into v_b;

  -- Компенсация — отдельная строка выписки, а не прибавка к аренде:
  -- владелец должен видеть, из чего сложилась сумма. Комиссия с неё
  -- не берётся, это возмещение ущерба, а не доход платформы.
  if v_compensation > 0 then
    insert into payouts (booking_id, owner_id, period_start, period_end, amount, kind)
    values (v_b.id, v_b.owner_id, v_b.start_date, v_b.end_date, v_compensation, 'damage_compensation')
    on conflict (booking_id, kind, period_start) do nothing;
  end if;

  update payouts
     set status = 'released', released_at = now()
   where booking_id = p_booking_id and status = 'scheduled';

  perform notify_user(v_b.owner_id, v_b.id, 'payout_released',
    'Деньги начислены',
    case
      when v_compensation > 0 then
        'Сделка закрыта. Начислено ' || v_b.owner_payout_total ||
        ' ₸ за аренду и ' || v_compensation || ' ₸ компенсации.'
      else
        'Сделка закрыта. Начислено ' || v_b.owner_payout_total || ' ₸.'
    end,
    jsonb_build_object('amount', v_b.owner_payout_total,
                       'compensation', v_compensation));

  perform notify_user(v_b.renter_id, v_b.id, 'deposit_released',
    case when v_compensation > 0 then 'Депозит возвращён частично' else 'Депозит разблокирован' end,
    case
      when v_compensation > 0 then
        'Сделка закрыта. Из депозита удержано ' || v_compensation ||
        ' ₸, остальное вернулось.'
      else 'Сделка закрыта, депозит вернулся.'
    end,
    jsonb_build_object('compensation', v_compensation));

  return true;
end;
$$;

-- Кнопка владельца «всё в порядке — закрыть сделку». В отличие от шлюза
-- объясняет, почему закрыть нельзя: пользователю нужен текст ошибки,
-- а планировщику — тихий отказ.
create or replace function booking_complete(p_booking_id uuid, p_force boolean default false)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  select * into v_b from bookings where id = p_booking_id;

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

-- ─────────────────────────────────────────────────────────────
-- ПРАВИЛО 5. Просрочка возврата → grace period → автоспор
-- Запускается по расписанию (pg_cron / Edge Function).
-- ─────────────────────────────────────────────────────────────

create or replace function process_overdue_bookings()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b     bookings%rowtype;
  v_count integer := 0;
begin
  -- Напоминание в день возврата — часть пассивного режима:
  -- владелец не следит сам, система напоминает обеим сторонам.
  for v_b in
    select * from bookings
     where status = 'active'
       and end_date = current_date
       and not exists (
         select 1 from notifications
          where booking_id = bookings.id and type = 'return_due_today'
       )
  loop
    perform notify_user(v_b.renter_id, v_b.id, 'return_due_today',
      'Сегодня нужно вернуть вещь', 'Аренда заканчивается сегодня.');
    perform notify_user(v_b.owner_id, v_b.id, 'return_due_today',
      'Вещь должны вернуть сегодня', null);
  end loop;

  -- Grace period истёк, вещь не вернули → спор о невозврате,
  -- депозит переходит в claimed.
  for v_b in
    select * from bookings
     where status = 'active'
       and grace_period_ends_at < now()
     for update
  loop
    insert into disputes (booking_id, opened_by, type, description, claim_amount, resolution_status)
    values (
      v_b.id, null, 'non_return',
      'Автоматически: вещь не возвращена после grace period',
      v_b.deposit_snapshot,
      'manual_review'
    )
    on conflict (booking_id, type) do nothing;

    update bookings
       set status = 'disputed', deposit_status = 'claimed'
     where id = v_b.id;

    perform notify_user(v_b.owner_id, v_b.id, 'dispute_non_return',
      'Вещь не вернули вовремя', 'Открыт спор о невозврате, депозит удержан.');
    perform notify_user(v_b.renter_id, v_b.id, 'dispute_non_return',
      'Просрочен возврат', 'Открыт спор о невозврате. Верните вещь как можно скорее.');

    v_count := v_count + 1;
  end loop;

  -- Подметание: закрываем всё, что созрело, — одним проходом по всем
  -- сделкам сразу, а не по одной по требованию. Сюда попадают два случая:
  --   • окно претензии истекло, спора так и не было;
  --   • спор был, но уже решён — авторешением или модератором.
  -- Владельцу в обоих случаях ничего делать не нужно: он получает
  -- готовый итог «деньги начислены».
  for v_b in
    select * from bookings
     where (
             (status = 'returned' and damage_claim_ends_at < now())
             or status = 'disputed'
           )
       and not has_open_disputes(id)
  loop
    if settle_booking(v_b.id) then
      v_count := v_count + 1;
    end if;
  end loop;

  return v_count;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- ПРАВИЛО 6-7. Спор о порче и автоматическое разрешение
-- ─────────────────────────────────────────────────────────────

-- ┌─ РЕШЕНИЕ, КОТОРОГО НЕТ В ТЗ ────────────────────────────────┐
-- │ ТЗ говорит «выплата из депозита без ручной модерации», но не │
-- │ говорит СКОЛЬКО. Здесь принято: платим меньшее из заявленной │
-- │ суммы и размера депозита — платформа не может выплатить      │
-- │ больше, чем заблокировала. Альтернативы, если решите иначе:  │
-- │  • фиксированный процент от депозита (проще, но грубее)      │
-- │  • требовать N фото-доказательств до авторазрешения          │
-- │  • делить ущерб пополам, если фото «до» отсутствуют          │
-- └──────────────────────────────────────────────────────────────┘
create or replace function decide_dispute_payout(
  p_claim_amount integer,
  p_deposit      integer
) returns integer
language sql
immutable
as $$
  select least(greatest(p_claim_amount, 0), greatest(p_deposit, 0));
$$;

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
  select * into v_b from bookings where id = p_booking_id for update;

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

-- Ручное решение модератора (сумма выше порога).
-- В MVP вызывается сервисным ключом, не из клиентского приложения.
--
-- p_finalize=false — та самая «пауза перед финализацией»: модератор
-- фиксирует решение, но сделку не закрывает. Закроет он повторным вызовом
-- booking_complete или планировщик следующим проходом.
create or replace function resolve_dispute_manually(
  p_dispute_id    uuid,
  p_payout_amount integer,
  p_note          text default null,
  p_finalize      boolean default true
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d disputes%rowtype;
  v_b bookings%rowtype;
begin
  select * into v_d from disputes where id = p_dispute_id for update;
  select * into v_b from bookings where id = v_d.booking_id for update;

  if p_payout_amount > v_b.deposit_snapshot then
    raise exception 'RENTHUB_OVER_DEPOSIT: нельзя выплатить больше депозита (% ₸)', v_b.deposit_snapshot;
  end if;

  update disputes
     set resolution_status = 'resolved',
         payout_amount     = p_payout_amount,
         resolution_note   = p_note,
         resolved_at       = now()
   where id = p_dispute_id
  returning * into v_d;

  -- Приведение обязательно: CASE с двумя литералами Postgres типизирует
  -- как text, а неявного приведения text → enum при присваивании нет.
  update bookings
     set deposit_status = (case when p_payout_amount > 0 then 'claimed' else 'released' end)::deposit_status
   where id = v_d.booking_id;

  if p_finalize then
    perform settle_booking(v_d.booking_id);
  end if;

  return v_d;
end;
$$;

-- ─────────────────────────────────────────────────────────────
-- ПРАВИЛО 2. Рейтинг после completed — обе стороны оценивают друг друга
-- ─────────────────────────────────────────────────────────────

create or replace function reviews_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  select * into v_b from bookings where id = new.booking_id;

  if v_b.id is null then
    raise exception 'RENTHUB_BOOKING_NOT_FOUND';
  end if;

  if v_b.status <> 'completed' then
    raise exception 'RENTHUB_BAD_STATE: отзыв можно оставить только после завершения сделки';
  end if;

  -- Оценивать могут только участники сделки, и только друг друга.
  if new.from_user_id not in (v_b.renter_id, v_b.owner_id)
     or new.to_user_id not in (v_b.renter_id, v_b.owner_id) then
    raise exception 'RENTHUB_FORBIDDEN: отзыв доступен только сторонам сделки';
  end if;

  return new;
end;
$$;

create trigger reviews_validate
  before insert on reviews
  for each row execute function reviews_before_insert();

create or replace function reviews_recalc_rating()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_target uuid;
begin
  -- В DELETE-триггере переменная NEW не назначена: обращение к new.*
  -- там падает с ошибкой, поэтому ветвимся по TG_OP, а не по coalesce.
  if tg_op = 'DELETE' then
    v_target := old.to_user_id;
  else
    v_target := new.to_user_id;
  end if;

  update users u
     set rating        = agg.avg_rating,
         ratings_count = agg.cnt
    from (
      select round(avg(rating)::numeric, 2) as avg_rating, count(*) as cnt
        from reviews where to_user_id = v_target
    ) agg
   where u.id = v_target;

  return null;
end;
$$;

create trigger reviews_update_rating
  after insert or update or delete on reviews
  for each row execute function reviews_recalc_rating();

-- ─────────────────────────────────────────────────────────────
-- Профиль создаётся автоматически при регистрации через Supabase Auth.
--
-- Тонкость с verified_at: строка в auth.users появляется в момент запроса
-- кода, когда телефон ещё НЕ подтверждён. Подтверждение приходит позже —
-- отдельным UPDATE, который проставляет phone_confirmed_at. Поэтому одного
-- AFTER INSERT мало: без второго триггера пользователь навсегда остался бы
-- неверифицированным и не смог бы ни сдать вещь, ни забронировать.
-- ─────────────────────────────────────────────────────────────

create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, phone, full_name, verified_at)
  values (
    new.id,
    coalesce(new.phone, new.email, new.id::text),
    new.raw_user_meta_data ->> 'full_name',
    new.phone_confirmed_at
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_auth_user();

create or replace function sync_phone_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users
     set verified_at = new.phone_confirmed_at,
         phone       = coalesce(new.phone, phone)
   where id = new.id
     and verified_at is distinct from new.phone_confirmed_at;

  return new;
end;
$$;

create trigger on_auth_user_phone_confirmed
  after update of phone_confirmed_at on auth.users
  for each row
  when (new.phone_confirmed_at is not null)
  execute function sync_phone_verification();
