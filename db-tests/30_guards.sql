-- Запреты. Каждый из них — деньги: если проверка живёт только в React,
-- её обойдёт и curl, и будущий Telegram-бот.

\echo ''
\echo '=== Сценарий 2: чего база не должна разрешать ==='

-- ── ПРАВИЛО 1. Верификация ────────────────────────────────────

select t.expect_fail(t.id('unverified'), $sql$
  insert into items (owner_id, category, title, daily_price, deposit_amount)
  values (t.id('unverified'), 'drills', 'Шуруповёрт без верификации', 2000, 5000)
$sql$, 'RENTHUB_NOT_VERIFIED');

select t.expect_fail(t.id('unverified'), format($sql$
  insert into bookings (item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, current_date + 30, current_date + 31, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('item'), t.id('unverified'), t.id('unverified')), 'RENTHUB_NOT_VERIFIED');

-- ── Здравый смысл сделки ──────────────────────────────────────

select t.expect_fail(t.id('owner'), format($sql$
  insert into bookings (item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, current_date + 30, current_date + 31, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('item'), t.id('owner'), t.id('owner')), 'RENTHUB_SELF_BOOKING');

select t.expect_fail(t.id('renter'), format($sql$
  insert into bookings (item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, current_date - 5, current_date - 3, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('item'), t.id('renter'), t.id('renter')), 'RENTHUB_PAST_DATE');

-- ── Подделка чужой личности ───────────────────────────────────
-- Здесь работает не триггер, а RLS: with check не пустит строку,
-- в которой владелец или арендатор — не ты.

select t.expect_fail(t.id('renter'), $sql$
  insert into items (owner_id, category, title, daily_price, deposit_amount)
  values (t.id('owner'), 'saws', 'Объявление от чужого имени', 3000, 5000)
$sql$, 'row-level security');

select t.expect_fail(t.id('stranger'), format($sql$
  insert into bookings (item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, current_date + 40, current_date + 41, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('item'), t.id('renter'), t.id('owner')), 'row-level security');

-- ── Видимость сделки ──────────────────────────────────────────

do $$
begin
  perform t.assert(
    t.as_value(t.id('stranger'),
      format('select count(*)::text from bookings where id = %L', t.id('booking'))) = '0',
    'посторонний не видит чужую сделку');

  perform t.assert(
    t.as_value(t.id('renter'),
      format('select count(*)::text from bookings where id = %L', t.id('booking'))) = '1',
    'арендатор видит свою сделку');

  perform t.assert(
    t.as_value(t.id('owner'),
      format('select count(*)::text from bookings where id = %L', t.id('booking'))) = '1',
    'владелец видит сделку по своей вещи');

  perform t.assert(
    t.as_value(t.id('stranger'), 'select count(*)::text from payouts') = '0',
    'начисления владельца не видны посторонним');

  perform t.assert(
    t.as_value(t.id('stranger'), 'select count(*)::text from notifications') = '0',
    'чужие уведомления не читаются');
end $$;

-- ── Переходы статусов делает не тот, кто хочет ────────────────

-- Готовим свежую бронь: предыдущая уже completed.
select t.as(t.id('renter'), format($sql$
  insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, %L, current_date + 10, current_date + 12,
          1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('booking2'), t.id('item'), t.id('renter'), t.id('renter')));

select t.expect_fail(t.id('renter'),
  format('select booking_confirm(%L)', t.id('booking2')), 'RENTHUB_FORBIDDEN');

select t.expect_fail(t.id('stranger'),
  format('select booking_confirm(%L)', t.id('booking2')), 'RENTHUB_FORBIDDEN');

-- Личность проверяется раньше статуса: посторонний не должен по тексту
-- ошибки узнавать, в каком состоянии чужая сделка.
select t.expect_fail(t.id('owner'),
  format('select booking_mark_picked_up(%L)', t.id('booking2')), 'RENTHUB_FORBIDDEN');

-- А вот арендатору статус уже сообщается: бронь ещё не подтверждена.
select t.expect_fail(t.id('renter'),
  format('select booking_mark_picked_up(%L)', t.id('booking2')), 'RENTHUB_BAD_STATE');

select t.expect_fail(t.id('owner'),
  format('select booking_complete(%L)', t.id('booking2')), 'RENTHUB_BAD_STATE');

-- Прямой UPDATE не запрещается ошибкой — под RLS он просто ничего
-- не находит и меняет ноль строк. Для клиента это выглядит как «ок»,
-- поэтому проверяем не отсутствие ошибки, а неизменность данных.
select t.as(t.id('owner'), format($sql$
  update bookings set status = 'completed', owner_payout_total = 999999 where id = %L
$sql$, t.id('booking2')));

do $$
begin
  -- 12000 — то, что посчитал триггер при вставке (5000 × 3 минус 20%),
  -- а не то, что прислал клиент.
  perform t.assert(
    (select status = 'pending' and owner_payout_total = 12000
       from bookings where id = t.id('booking2')),
    'владелец не может двигать статус и суммы прямым update — только через RPC');
end $$;

select t.as(t.id('renter'), $sql$
  update app_settings set value = 0 where key = 'commission_pct'
$sql$);

do $$
begin
  perform t.assert(
    (select value = 20 from app_settings where key = 'commission_pct'),
    'комиссию нельзя обнулить из клиента');
end $$;

-- ── Двойное бронирование ──────────────────────────────────────

select t.expect_fail(t.id('stranger'), format($sql$
  insert into bookings (item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, current_date + 11, current_date + 13, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('item'), t.id('stranger'), t.id('stranger')), 'bookings_no_overlap');

-- Отмена освобождает даты: тот же диапазон проходит после cancel.
select t.as(t.id('renter'), format(
  'update bookings set status = ''cancelled'' where id = %L', t.id('booking2')));

do $$
begin
  perform t.assert(
    (select status = 'cancelled' from bookings where id = t.id('booking2')),
    'арендатор отменил свою неподтверждённую заявку сам');
end $$;

select t.as(t.id('stranger'), format($sql$
  insert into bookings (item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, current_date + 11, current_date + 13, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('item'), t.id('stranger'), t.id('stranger')));

do $$
begin
  perform t.assert(
    (select count(*) from bookings
      where item_id = t.id('item') and renter_id = t.id('stranger')
        and status = 'pending') = 1,
    'отменённая бронь освободила даты для другого арендатора');
end $$;

-- ── Занятые даты видны тому, кто ещё не участник ──────────────
-- Сама бронь посторонним закрыта (проверено выше), но выбирающий даты
-- обязан видеть, что занято. Иначе он упрётся в ограничение уже после
-- нажатия «Забронировать».

do $$
begin
  perform t.assert(
    t.as_value(t.id('stranger'),
      format('select count(*)::text from item_busy_dates(%L)', t.id('item'))) = '1',
    'посторонний видит занятый интервал через item_busy_dates');

  -- Проверяем саму сигнатуру: security definer обходит RLS, поэтому
  -- гарантией приватности здесь служит то, что функция физически не
  -- может вернуть ничего, кроме двух дат.
  perform t.assert(
    (select pg_get_function_result(oid) = 'TABLE(start_date date, end_date date)'
       from pg_proc where proname = 'item_busy_dates'),
    'функция отдаёт только даты — ни арендатора, ни сумм');

  perform t.assert(
    t.as_value(t.id('stranger'),
      format('select (start_date is not null and end_date is not null)::text
                from item_busy_dates(%L) limit 1', t.id('item'))) = 'true',
    'обе границы интервала заполнены');
end $$;

-- Убираем за собой, чтобы не мешать следующим сценариям.
select t.as(t.id('stranger'), format($sql$
  update bookings set status = 'cancelled'
   where item_id = %L and renter_id = %L and status = 'pending'
$sql$, t.id('item'), t.id('stranger')));

-- ── ПРАВИЛО 2. Отзывы ─────────────────────────────────────────

select t.expect_fail(t.id('renter'), format($sql$
  insert into reviews (booking_id, from_user_id, to_user_id, rating)
  values (%L, %L, %L, 5)
$sql$, t.id('booking2'), t.id('renter'), t.id('owner')), 'RENTHUB_BAD_STATE');

select t.expect_fail(t.id('stranger'), format($sql$
  insert into reviews (booking_id, from_user_id, to_user_id, rating)
  values (%L, %L, %L, 1)
$sql$, t.id('booking'), t.id('stranger'), t.id('owner')), 'RENTHUB_FORBIDDEN');

select t.expect_fail(t.id('renter'), format($sql$
  insert into reviews (booking_id, from_user_id, to_user_id, rating)
  values (%L, %L, %L, 1)
$sql$, t.id('booking'), t.id('renter'), t.id('owner')), 'duplicate key');

-- ── Storage ───────────────────────────────────────────────────

select t.expect_fail(t.id('renter'), format($sql$
  insert into storage.objects (bucket_id, name)
  values ('item-photos', %L)
$sql$, t.id('owner') || '/подделка.jpg'), 'row-level security');

select t.as(t.id('renter'), format($sql$
  insert into storage.objects (bucket_id, name)
  values ('item-photos', %L)
$sql$, t.id('renter') || '/свои-фото.jpg'));

do $$
begin
  perform t.assert(
    (select count(*) from storage.objects) = 1,
    'в свою папку писать можно, в чужую — нет');
end $$;

\echo '--- сценарий 2 пройден ---'

-- ── Избранное: своё видно, чужое нет ──────────────────────────

select t.as(t.id('renter'), format(
  'insert into favorites (user_id, item_id) values (%L, %L)',
  t.id('renter'), t.id('item')));

do $$
begin
  perform t.assert(
    t.as_value(t.id('renter'), 'select count(*)::text from favorites') = '1',
    'арендатор видит своё избранное');

  perform t.assert(
    t.as_value(t.id('stranger'), 'select count(*)::text from favorites') = '0',
    'чужое избранное не видно никому');
end $$;

select t.expect_fail(t.id('stranger'), format(
  'insert into favorites (user_id, item_id) values (%L, %L)',
  t.id('renter'), t.id('item')), 'row-level security');

-- Повторное добавление невозможно на уровне базы, а не проверкой в коде.
select t.expect_fail(t.id('renter'), format(
  'insert into favorites (user_id, item_id) values (%L, %L)',
  t.id('renter'), t.id('item')), 'duplicate key');

select t.as(t.id('renter'), format(
  'delete from favorites where item_id = %L', t.id('item')));

do $$
begin
  perform t.assert(
    t.as_value(t.id('renter'), 'select count(*)::text from favorites') = '0',
    'из избранного можно удалить');
end $$;

-- ── Каталог без входа ─────────────────────────────────────────
-- Аноним должен увидеть витрину, но не личные данные и не сделки.

do $$
begin
  perform t.assert(
    t.as_anon('select count(*)::text from items where status = ''active''')::int >= 1,
    'аноним видит активные объявления');

  perform t.assert(
    t.as_anon('select count(*)::text from categories') = '8',
    'аноним видит справочник категорий');

  perform t.assert(
    t.as_anon(format('select full_name from users where id = %L', t.id('owner')))
      = 'Ержан Владелец',
    'аноним видит имя владельца — без него карточка бессмысленна');
end $$;

-- Телефон закрыт грантом на колонки, а не политикой: строка видна, поле нет.
select t.anon_fails(
  format('select phone from users where id = %L', t.id('owner')),
  'permission denied');

-- Сделки, выплаты и уведомления анониму закрыты целиком.
do $$
begin
  perform t.assert(t.as_anon('select count(*)::text from bookings') = '0',
    'аноним не видит ни одной сделки');
  perform t.assert(t.as_anon('select count(*)::text from payouts') = '0',
    'аноним не видит начислений');
  perform t.assert(t.as_anon('select count(*)::text from notifications') = '0',
    'аноним не видит уведомлений');
end $$;

-- Скрытое объявление остаётся скрытым.
select t.as(t.id('owner'), format(
  'update items set status = ''hidden'' where id = %L', t.id('item_cheap')));

do $$
begin
  perform t.assert(
    t.as_anon(format('select count(*)::text from items where id = %L', t.id('item_cheap'))) = '0',
    'снятое с публикации объявление анониму не видно');
end $$;

select t.as(t.id('owner'), format(
  'update items set status = ''active'' where id = %L', t.id('item_cheap')));

-- Отзывы — часть витрины: рейтинг без них цифра без объяснения.
do $$
begin
  perform t.assert(
    t.as_anon(format('select count(*)::text from reviews where to_user_id = %L',
      t.id('owner')))::int >= 1,
    'аноним читает отзывы о владельце');
end $$;

-- ── Личные колонки закрыты и от вошедших ──────────────────────
--
-- Политика users_read разрешает читать строки всем вошедшим, и до миграции
-- 20260819100000 это означало, что телефон соседа достаётся обычным запросом
-- к API. Ни один экран его не показывал — но API это не экран.
--
-- Проверяется именно право на колонку, а не наличие строки: строка видна,
-- поле — нет. Тот же механизм, что закрывает телефон от анонима.

select t.expect_fail(t.id('renter'),
  format('select phone from users where id = %L', t.id('owner')),
  'permission denied');

select t.expect_fail(t.id('renter'),
  format('select telegram_id from users where id = %L', t.id('owner')),
  'permission denied');

-- Своё — можно, но только через функцию: она читает по auth.uid(),
-- поэтому подставить чужой идентификатор физически некуда.
do $$
begin
  perform t.assert(
    t.as_value(t.id('renter'), 'select id::text from my_profile()') = t.id('renter')::text,
    'my_profile() возвращает строку вызывающего');

  perform t.assert(
    left(t.as_value(t.id('renter'), 'select coalesce(phone, ''нет'') from my_profile()'), 2) = '+7',
    'свой телефон через my_profile() читается');

  perform t.assert(
    t.as_value(t.id('renter'), 'select count(*)::text from users') <> '0',
    'строки users вошедшему по-прежнему видны — закрыты колонки, не строки');
end $$;
