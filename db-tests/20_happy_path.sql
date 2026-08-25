-- Петля «выложил → нашли → забронировали → вернули → оценили».
-- Всё делается от имени пользователей через t.as, то есть с включённым RLS:
-- это ровно те права, с которыми работает приложение по anon-ключу.

\echo ''
\echo '=== Сценарий 1: обычная сделка без происшествий ==='

-- ── Владелец выкладывает вещь ─────────────────────────────────

select t.as(t.id('owner'), $sql$
  insert into items (id, owner_id, category, title, description,
                     daily_price, deposit_amount, condition_photos)
  values (
    t.id('item'), t.id('owner'), 'rotary_hammers',
    'Перфоратор Bosch GBH 2-26',
    'С кейсом и тремя бурами. Есть режим долбления.',
    5000, 20000,
    array['https://example.test/before-1.jpg', 'https://example.test/before-2.jpg']
  )
$sql$);

do $$
begin
  perform t.assert(
    (select count(*) from items where id = t.id('item')) = 1,
    'верифицированный владелец создал объявление');

  perform t.assert(
    (select city = 'kokshetau' and status = 'active' from items where id = t.id('item')),
    'город и статус проставились по умолчанию');
end $$;

-- ── Арендатор видит объявление в каталоге ─────────────────────

do $$
begin
  perform t.assert(
    t.as_value(t.id('renter'),
      'select count(*)::text from items where status = ''active'' and city = ''kokshetau''') = '1',
    'арендатор видит чужое активное объявление в каталоге');
end $$;

-- ── Бронирование ──────────────────────────────────────────────
-- Клиент намеренно шлёт мусор в денежных полях и чужой owner_id:
-- проверяем, что триггер bookings_prepare всё это перезаписывает.

select t.as(t.id('renter'), format($sql$
  insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date,
                        days, insurance_selected,
                        daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, %L, current_date, current_date + 2,
          999, true,
          1, 1, 1, 1, 1, 1, 999999)
$sql$, t.id('booking'), t.id('item'), t.id('renter'), t.id('renter')));

do $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = t.id('booking');

  perform t.assert(b.owner_id = t.id('owner'),
    'owner_id подставлен из объявления, а не из запроса клиента');
  perform t.assert(b.days = 3,
    'дни считаются включительно: с 1 по 3 число — это 3 дня, а не 2');
  perform t.assert(b.daily_price_snapshot = 5000,
    'цена снята с объявления');
  perform t.assert(b.deposit_snapshot = 20000,
    'депозит снят с объявления');
  perform t.assert(b.rent_total = 15000,
    'аренда = 5000 × 3');
  perform t.assert(b.platform_fee = 3000,
    'комиссия 20% = 3000');
  perform t.assert(b.insurance_fee = 150,
    'страховой сбор 150 ₸, потому что арендатор его выбрал');
  perform t.assert(b.renter_total = 15150,
    'арендатор платит 15150 — депозит сюда не входит');
  perform t.assert(b.owner_payout_total = 12000,
    'владельцу 12000 = аренда минус комиссия, вместо присланных 999999');
  perform t.assert(b.status = 'pending',
    'бронь создана в статусе pending');
  perform t.assert(b.deposit_status = 'held',
    'ПРАВИЛО 3: депозит сразу held');
  perform t.assert(b.grace_period_ends_at is not null,
    'дедлайн возврата проставлен');

  -- Дедлайн обязан считаться по местному времени, а не по времени сервера.
  -- Ожидаем полночь по Кокшетау в конце последних суток плюс 12 часов
  -- запаса из app_settings. Стенд работает в UTC, как и Supabase, поэтому
  -- расхождение поясов здесь проявится так же, как на проде.
  perform t.assert(
    b.grace_period_ends_at
      = ((b.end_date + 1)::timestamp at time zone 'Asia/Almaty') + interval '12 hours',
    'дедлайн посчитан в поясе пилота, а не сервера');

  -- И контрольная проверка на саму ошибку: наивное приведение к timestamptz
  -- на UTC-сервере дало бы результат на пять часов позже.
  perform t.assert(
    b.grace_period_ends_at
      <> ((b.end_date + 1)::timestamptz + interval '12 hours'),
    'наивное приведение к timestamptz дало бы другой момент — ошибка воспроизводится');

  perform t.assert(
    (select count(*) from notifications
      where user_id = t.id('owner') and booking_id = b.id
        and type = 'booking_requested') = 1,
    'владельцу ушло уведомление о запросе — опора пассивного режима');
end $$;

-- ── Владелец подтверждает ─────────────────────────────────────

select t.as(t.id('owner'), format('select booking_confirm(%L)', t.id('booking')));

do $$
begin
  perform t.assert(
    (select status = 'confirmed' from bookings where id = t.id('booking')),
    'владелец подтвердил бронь');

  perform t.assert(
    (select count(*) from payouts
      where booking_id = t.id('booking') and status = 'scheduled' and amount = 12000) = 1,
    'начисление владельцу запланировано на 12000 ₸');

  perform t.assert(
    (select period_start = current_date and period_end = current_date + 2
       from payouts where booking_id = t.id('booking')),
    'период начисления совпадает с периодом аренды');

  perform t.assert(
    (select count(*) from notifications
      where user_id = t.id('renter') and type = 'booking_confirmed') = 1,
    'арендатор уведомлён о подтверждении');
end $$;

-- ── Арендатор забрал вещь ─────────────────────────────────────

select t.as(t.id('renter'), format('select booking_mark_picked_up(%L)', t.id('booking')));

do $$
begin
  perform t.assert(
    (select status = 'active' and picked_up_at is not null
       from bookings where id = t.id('booking')),
    'вещь у арендатора, статус active');

  perform t.assert(
    (select count(*) from notifications
      where user_id = t.id('owner') and type = 'item_picked_up') = 1,
    'владелец уведомлён, что вещь забрали');
end $$;

-- ── Владелец принял вещь обратно ──────────────────────────────

select t.as(t.id('owner'), format('select booking_mark_returned(%L)', t.id('booking')));

do $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = t.id('booking');

  perform t.assert(b.status = 'returned', 'вещь принята, статус returned');
  perform t.assert(b.returned_at is not null, 'время возврата записано');
  perform t.assert(b.deposit_status = 'held',
    'депозит ещё held: идёт окно на претензию по порче');
  perform t.assert(
    b.damage_claim_ends_at between now() + interval '47 hours' and now() + interval '49 hours',
    'окно претензии — 48 часов из app_settings');
end $$;

-- ── Владелец закрывает сделку ─────────────────────────────────

select t.as(t.id('owner'), format('select booking_complete(%L)', t.id('booking')));

do $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = t.id('booking');

  perform t.assert(b.status = 'completed', 'сделка закрыта');
  perform t.assert(b.deposit_status = 'released',
    'ПРАВИЛО 4: вернули вовремя — депозит отпущен');
  perform t.assert(b.completed_at is not null, 'время закрытия записано');

  perform t.assert(
    (select count(*) from payouts
      where booking_id = b.id and status = 'released' and released_at is not null) = 1,
    'начисление владельцу переведено в released');

  perform t.assert(
    (select count(*) from notifications where type = 'payout_released'
       and user_id = t.id('owner')) = 1,
    'владелец получил «деньги начислены» — итог, а не приглашение что-то сделать');

  perform t.assert(
    (select count(*) from notifications where type = 'deposit_released'
       and user_id = t.id('renter')) = 1,
    'арендатор получил «депозит вернулся»');
end $$;

-- ── Взаимные отзывы ───────────────────────────────────────────

select t.as(t.id('renter'), format($sql$
  insert into reviews (booking_id, from_user_id, to_user_id, rating, comment)
  values (%L, %L, %L, 5, 'Инструмент как на фото, отдал вовремя.')
$sql$, t.id('booking'), t.id('renter'), t.id('owner')));

select t.as(t.id('owner'), format($sql$
  insert into reviews (booking_id, from_user_id, to_user_id, rating, comment)
  values (%L, %L, %L, 4, 'Вернули чистым, но на час позже.')
$sql$, t.id('booking'), t.id('owner'), t.id('renter')));

do $$
begin
  perform t.assert(
    (select rating = 5.00 and ratings_count = 1 from users where id = t.id('owner')),
    'ПРАВИЛО 2: рейтинг владельца пересчитан триггером');

  perform t.assert(
    (select rating = 4.00 and ratings_count = 1 from users where id = t.id('renter')),
    'рейтинг арендатора пересчитан — оценивают обе стороны');
end $$;

-- ── Счётчик сделок для витрины ────────────────────────────────
--
-- Число в профиле владельца. Считает обе роли, поэтому после одной
-- закрытой сделки равен единице и у владельца, и у арендатора: человек в
-- пилоте бывает и тем и другим, а счётчик только по владению показывал бы
-- ноль тому, кто пока лишь брал.

do $$
begin
  perform t.assert(
    user_deals_count(t.id('owner')) = 1,
    'счётчик сделок владельца — одна закрытая');

  perform t.assert(
    user_deals_count(t.id('renter')) = 1,
    'счётчик считает и сторону арендатора');

  perform t.assert(
    user_deals_count(t.id('stranger')) = 0,
    'у постороннего закрытых сделок нет');
end $$;

\echo '--- сценарий 1 пройден ---'
