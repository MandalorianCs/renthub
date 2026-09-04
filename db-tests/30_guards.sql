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
--
-- Идёт через booking_cancel(), а не прямым UPDATE: с миграции
-- 20260831110000 политики на update у bookings нет вовсе. Раньше отмена
-- писалась в таблицу напрямую, и тем же запросом можно было переписать
-- суммы — ради этого политику и убрали.
select t.as(t.id('renter'), format('select booking_cancel(%L)', t.id('booking2')));

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

-- Счётчик сделок — та же история и то же обоснование: витрина открыта без
-- входа, а брони закрыты политикой. Гарантия приватности здесь — тип
-- результата: вернуть что-то кроме одного числа функция не может.
do $$
begin
  perform t.assert(
    t.as_anon(format('select user_deals_count(%L)::text', t.id('owner')))::int >= 1,
    'аноним видит счётчик сделок — профиль владельца открыт без входа');

  perform t.assert(
    (select pg_get_function_result(oid) = 'integer'
       from pg_proc where proname = 'user_deals_count'),
    'счётчик отдаёт одно число — ни сторон сделки, ни сумм, ни дат');

  perform t.assert(
    t.as_anon('select count(*)::text from bookings') = '0',
    'при этом сами брони анониму по-прежнему не видны');
end $$;

-- Убираем за собой, чтобы не мешать следующим сценариям.
--
-- Тоже через booking_cancel(): прямой UPDATE после миграции 20260831110000
-- молча меняет ноль строк, и бронь осталась бы висеть на датах. Вылезло бы
-- это не здесь, а в сценарии 4 — конфликтом bookings_no_overlap на другой
-- брони. Ровно тот случай, ради которого правило «проверять результат, а не
-- отсутствие исключения» и записано.
do $$
declare
  v_id uuid;
begin
  select id into v_id
    from bookings
   where item_id = t.id('item') and renter_id = t.id('stranger') and status = 'pending'
   limit 1;

  if v_id is not null then
    perform t.as(t.id('stranger'), format('select booking_cancel(%L)', v_id));
  end if;

  perform t.assert(
    (select count(*) from bookings
      where item_id = t.id('item') and renter_id = t.id('stranger')
        and status = 'pending') = 0,
    'уборка сработала — сценарий 4 стартует с чистыми датами');
end $$;

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

-- Отзыв от чужого имени. Проверялось, что чужой человек не оставит отзыв о
-- чужой сделке, — но не то, что участник не подпишется ЗА ВТОРУЮ СТОРОНУ.
--
-- Это и есть способ нарисовать себе рейтинг: арендатор вставляет строку,
-- где from_user_id — владелец, а to_user_id — он сам. Правило записано в
-- политике reviews_insert_own как with check (from_user_id = auth.uid()),
-- и до сих пор его никто не пробовал обойти.
--
-- Цена ошибки здесь максимальная из всех: рейтинг — единственное, на что
-- смотрит человек, решая отдать незнакомцу вещь за 90 000 ₸.
select t.expect_fail(t.id('renter'), format($sql$
  insert into reviews (booking_id, from_user_id, to_user_id, rating, comment)
  values (%L, %L, %L, 5, 'подделанный отзыв о себе')
$sql$, t.id('booking'), t.id('owner'), t.id('renter')),
  'row-level security');

-- И в обратную сторону: владелец не подпишется за арендатора.
select t.expect_fail(t.id('owner'), format($sql$
  insert into reviews (booking_id, from_user_id, to_user_id, rating)
  values (%L, %L, %L, 5)
$sql$, t.id('booking'), t.id('renter'), t.id('owner')),
  'row-level security');

-- Выплаты второй стороны не видны. Проверялось, что их не видит посторонний
-- и аноним, — но не то, что арендатор не видит выручку владельца по СВОЕЙ
-- же сделке. Именно у него есть и повод посмотреть, и знание, куда смотреть.
do $$
begin
  perform t.assert(
    t.as_value(t.id('renter'), 'select count(*)::text from payouts') = '0',
    'арендатор не видит выплат владельца — даже по своей сделке');
end $$;

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
--
-- Берём t.id('item') — он создан сценарием 1 и к этому моменту существует.
-- Раньше здесь стоял item_cheap, который заводится только в сценарии 4:
-- проверка «аноним не видит» проходила потому, что видеть было нечего.
-- Зелёный тест, который не может упасть, хуже отсутствующего, поэтому
-- ниже сначала утверждается, что объявление вообще есть.
select t.as(t.id('owner'), format(
  'update items set status = ''hidden'' where id = %L', t.id('item')));

do $$
begin
  perform t.assert(
    t.as_value(t.id('owner'),
      format('select count(*)::text from items where id = %L', t.id('item'))) = '1',
    'объявление на месте — иначе следующая проверка ничего не значит');

  perform t.assert(
    t.as_anon(format('select count(*)::text from items where id = %L', t.id('item'))) = '0',
    'снятое с публикации объявление анониму не видно');
end $$;

select t.as(t.id('owner'), format(
  'update items set status = ''active'' where id = %L', t.id('item')));

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

-- Аноним не должен даже вызывать функцию: дефолтные привилегии проекта
-- выдают execute напрямую роли anon, и отзыв у PUBLIC его не снимает.
-- На живом проекте это отвечало 200 строкой из null — до миграции
-- 20260819110000. Проверка стоит здесь, чтобы право не вернулось молча.
select t.anon_fails('select id from my_profile()', 'permission denied');

-- ── Сводка модератора ─────────────────────────────────────────
--
-- Функция security definer: политики на ней не действуют, право проверяется
-- внутри. Проверяем оба конца — что посторонний получает отказ и что
-- модератору приходят числа, а не пустота.

select t.expect_fail(t.id('renter'),
  'select moderation_overview()',
  'RENTHUB_FORBIDDEN');

select t.anon_fails('select moderation_overview()', 'permission denied');

-- Роль модератора выдаётся только сервисным ключом; в стенде её на время
-- одалживает «посторонний» — тот же приём, что в сценарии споров.
update users set is_moderator = true where id = t.id('stranger');

do $$
begin
  perform t.assert(
    t.as_value(t.id('stranger'), 'select (moderation_overview()->''users''->>''total'')::int > 0')
      = 'true',
    'модератор видит число участников');

  perform t.assert(
    t.as_value(t.id('stranger'), 'select jsonb_typeof(moderation_overview()->''recent'')')
      = 'array',
    'лента событий приходит массивом');

  -- Телефон в сводке не должен появиться ни при каких обстоятельствах:
  -- функция обходит политики, и единственная защита здесь — её текст.
  perform t.assert(
    position('+7' in t.as_value(t.id('stranger'), 'select moderation_overview()::text')) = 0,
    'в сводке нет телефонов');
end $$;

-- Флаг возвращаем: следующие сценарии рассчитывают на обычного постороннего.
update users set is_moderator = false where id = t.id('stranger');

-- ── Поимённый список участников ───────────────────────────────
--
-- Телефоны здесь есть намеренно (оператор пилота обзванивает людей сам),
-- поэтому проверяем ровно два края: посторонний не получает ничего, а
-- модератор получает строки. Сводка при этом обязана оставаться без
-- телефонов — та проверка выше.

select t.expect_fail(t.id('renter'),
  'select * from moderation_people()',
  'RENTHUB_FORBIDDEN');

select t.anon_fails('select * from moderation_people()', 'permission denied');

update users set is_moderator = true where id = t.id('stranger');

do $$
begin
  perform t.assert(
    t.as_value(t.id('stranger'), 'select count(*)::text from moderation_people()')::int >= 4,
    'модератор видит список участников');

  -- Сигналы, ради которых блокировка обычно и случается. Без них кнопка
  -- «заблокировать» нажимается вслепую: «4 объявления · 2 аренды» не
  -- отвечает на вопрос, что с человеком не так.
  perform t.assert(
    t.as_value(t.id('stranger'), format(
      'select coalesce(rating::text, ''нет'') from moderation_people() where id = %L',
      t.id('owner'))) <> '',
    'в списке виден рейтинг участника');

  perform t.assert(
    t.as_value(t.id('stranger'), format(
      'select disputes::text from moderation_people() where id = %L', t.id('owner')))::int >= 0,
    'в списке видно число споров');

  -- Разбор человеком считается отдельно: спор ниже порога закрывается сам
  -- и о поведении говорит мало, а дошедший до модератора означает, что
  -- договориться не вышло.
  perform t.assert(
    t.as_value(t.id('stranger'), format(
      'select (disputes >= disputes_manual)::text from moderation_people() where id = %L',
      t.id('owner'))) = 'true',
    'разобранных человеком не больше, чем споров всего');

  perform t.assert(
    left(t.as_value(t.id('stranger'),
      format('select phone from moderation_people() where id = %L', t.id('owner'))), 2) = '+7',
    'в списке участников телефон есть — это и есть смысл списка');

  perform t.assert(
    t.as_value(t.id('stranger'),
      format('select items::text from moderation_people() where id = %L', t.id('owner')))::int >= 1,
    'у владельца посчитаны его объявления');
end $$;

update users set is_moderator = false where id = t.id('stranger');

-- ── Инструменты модератора ────────────────────────────────────
--
-- Блокировка, снятие объявления и сообщение участнику. Проверяем оба края
-- каждого действия: посторонний получает отказ, модератор — результат.
-- Отдельно проверяется то, чего быть не должно: выдача роли из приложения
-- и блокировка самого себя.

select t.expect_fail(t.id('renter'),
  format('select set_user_blocked(%L, true)', t.id('owner')),
  'RENTHUB_FORBIDDEN');

update users set is_moderator = true where id = t.id('stranger');

-- Модератор не может заблокировать себя: иначе пилот останется без разбора
-- споров, а снять блокировку сможет только сервисный ключ.
select t.expect_fail(t.id('stranger'),
  format('select set_user_blocked(%L, true)', t.id('stranger')),
  'нельзя заблокировать самого себя');

do $$
begin
  perform t.as(t.id('stranger'),
    format('select set_user_blocked(%L, true, ''Тестовая причина'')', t.id('unverified')));

  perform t.assert(
    t.as_value(t.id('stranger'),
      format('select blocked::text from moderation_people() where id = %L', t.id('unverified'))) = 'true',
    'блокировка видна в списке участников');

  -- Читаем из сессии самого адресата, а не модератора: политика
  -- notifications_read_own пускает только к своим строкам, и модератор
  -- чужих уведомлений не видит. Это не мешает проверке — важно ровно то,
  -- что уведомление дошло до того, кого заблокировали.
  perform t.assert(
    t.as_value(t.id('unverified'),
      'select count(*)::text from notifications where type = ''blocked''')::int >= 1,
    'заблокированный получил уведомление — узнает о решении, а не упрётся в отказ');

  perform t.as(t.id('stranger'), format('select set_user_blocked(%L, false)', t.id('unverified')));

  perform t.assert(
    t.as_value(t.id('stranger'),
      format('select blocked::text from moderation_people() where id = %L', t.id('unverified'))) = 'false',
    'разблокировка снимает отметку');
end $$;

-- Заблокированный не может ни сдавать, ни арендовать. Проверка встроена в
-- assert_verified(), то есть в ту же точку, что и проверка номера.
do $$
begin
  perform t.as(t.id('stranger'), format('select set_user_blocked(%L, true)', t.id('owner')));
end $$;

select t.expect_fail(t.id('owner'),
  format('insert into items (owner_id, category, title, description, daily_price, deposit_amount, condition_photos) '
      || 'values (%L, ''drills'', ''Дрель после блокировки'', '''', 1000, 5000, array[''x''])', t.id('owner')),
  'RENTHUB_BLOCKED');

do $$
begin
  perform t.as(t.id('stranger'), format('select set_user_blocked(%L, false)', t.id('owner')));
end $$;

-- Снятие объявления модератором и сообщение участнику.
do $$
begin
  perform t.as(t.id('stranger'),
    format('select moderator_hide_item(%L, ''Фото не соответствуют вещи'')', t.id('item')));

  perform t.assert(
    t.as_value(t.id('stranger'), format('select status::text from items where id = %L', t.id('item')))
      = 'hidden',
    'модератор снял объявление с публикации');

  perform t.as(t.id('stranger'),
    format('select moderator_notify(%L, ''Вопрос по объявлению'', ''Уточните комплектацию'')', t.id('owner')));

  perform t.assert(
    t.as_value(t.id('owner'),
      'select count(*)::text from notifications where type = ''moderator_message''')::int = 1,
    'сообщение модератора легло в уведомления — бот доставит его в Telegram');
end $$;

-- ── Заявки на участие ─────────────────────────────────────────
--
-- Реклама приводит незнакомого человека: витрина открыта всем, но
-- забронировать он не может, а пути «у меня нет приглашения» до сих пор
-- не было ни на экране входа, ни в боте. Заявка — этот путь.

do $$
declare v_res text;
begin
  perform set_config('request.jwt.claims', '', true);

  v_res := submit_join_request('+77011112233', 'Асхат', 555, 'ashat', 'есть леса');
  perform t.assert(v_res = 'accepted', 'заявка от незнакомого номера принята');

  -- Повтор не плодит строки: человек, нажавший кнопку трижды, не должен
  -- превращаться в три заявки — список модерации станет списком
  -- нетерпеливых, а не списком людей.
  v_res := submit_join_request('+77011112233', null, null, null, 'и ещё бетономешалка');
  perform t.assert(v_res = 'already_waiting', 'повторная заявка не создаёт вторую строку');

  perform t.assert(
    (select count(*) from join_requests where phone = '+77011112233') = 1,
    'в очереди по-прежнему одна строка на номер');

  -- Но дописывает то, что человек добавил со второго раза.
  perform t.assert(
    (select note = 'и ещё бетономешалка' from join_requests where phone = '+77011112233'),
    'пояснение со второго раза сохранилось, имя из первого не затёрлось');

  perform t.assert(
    (select full_name = 'Асхат' from join_requests where phone = '+77011112233'),
    'имя из первой заявки на месте — coalesce, а не перезапись пустым');
end $$;

-- Участнику заявка не нужна, и сказать об этом надо прямо: «принято»
-- отправило бы человека ждать того, что у него уже есть.
do $$
declare v_res text;
begin
  v_res := submit_join_request((select phone from users where id = t.id('owner')));
  perform t.assert(v_res = 'already_member', 'участнику отвечают, что аккаунт уже есть');
end $$;

-- Кривой номер не попадает в очередь: организатор звонит по этим
-- номерам, и «+7701» в списке — это потраченное время.
do $$
declare v_err text;
begin
  begin
    perform submit_join_request('+7701');
    v_err := 'без ошибки';
  exception when others then v_err := sqlerrm;
  end;
  perform t.assert(v_err like '%формате%', 'короткий номер отклонён');
end $$;

-- Список заявок — это список чужих телефонов. Вошедшему он закрыт и
-- политикой на таблицу, и правом на функцию.
select t.expect_fail(t.id('renter'),
  'select * from join_requests_open()',
  'только модератор');

do $$
begin
  perform t.assert(
    t.as_value(t.id('renter'), 'select count(*)::text from join_requests')::int = 0,
    'вошедший не видит ни одной заявки — политика фильтрует строки');
end $$;

-- Модератор видит очередь и закрывает заявку.
do $$
declare
  v_id  uuid;
  v_err text;
  v_was boolean;
begin
  perform set_config('request.jwt.claims', '', true);
  -- Прежнее значение возвращается в конце: соседние блоки тоже полагаются
  -- на роль модератора, и жёсткий false здесь ломал бы их через один.
  select is_moderator into v_was from users where id = t.id('stranger');
  update users set is_moderator = true where id = t.id('stranger');

  perform t.assert(
    t.as_value(t.id('stranger'), 'select count(*)::text from join_requests_open()')::int = 1,
    'модератор видит открытую заявку');

  select id into v_id from join_requests where phone = '+77011112233';
  perform t.as(t.id('stranger'), format('select join_request_close(%L)', v_id));

  perform t.assert(
    t.as_value(t.id('stranger'), 'select count(*)::text from join_requests_open()')::int = 0,
    'закрытая заявка ушла из очереди');

  -- Закрыть дважды нельзя: «готово» на второе нажатие означало бы, что
  -- модератор закрыл что-то ещё, чего не видел.
  begin
    perform t.as(t.id('stranger'), format('select join_request_close(%L)', v_id));
    v_err := 'без ошибки';
  exception when others then v_err := sqlerrm;
  end;
  perform t.assert(v_err like '%уже закрыта%', 'повторное закрытие отклонено');

  -- Освободившийся номер снова может подать заявку: частичный уникальный
  -- индекс сторожит только открытые.
  perform set_config('request.jwt.claims', '', true);
  perform t.assert(
    submit_join_request('+77011112233') = 'accepted',
    'после закрытия человек может обратиться снова');

  perform set_config('request.jwt.claims', '', true);
  update users set is_moderator = v_was where id = t.id('stranger');
end $$;


-- ── Заявка встречается со своим аккаунтом ─────────────────────
--
-- Бот обещает: «организатор заведёт аккаунт, и вы получите сообщение
-- сюда же». Проверяем, что обещание выполняется, а не просто написано.

do $$
declare
  v_id    uuid := gen_random_uuid();
  v_phone text := '+77015550001';
begin
  perform set_config('request.jwt.claims', '', true);
  perform submit_join_request(v_phone, 'Марат', 987654, 'marat');

  -- Так участника заводит invite.mjs: строку в public.users создаёт
  -- триггер на auth.users.
  insert into auth.users (id) values (v_id);
  update users set phone = v_phone where id = v_id;
  -- Обновление номера не создаёт участника заново, поэтому повторяем
  -- путь скрипта: строка появляется сразу с номером.
  delete from users where id = v_id;
  insert into users (id, phone, full_name) values (v_id, v_phone, 'Марат');

  perform t.assert(
    (select telegram_id = 987654 from users where id = v_id),
    'привязка Telegram перенесена из заявки — второй раз номер не спрашивают');

  perform t.assert(
    (select telegram_username = 'marat' from users where id = v_id),
    'ник тоже перенесён — боту есть чем подписать сообщения');

  perform t.assert(
    (select handled_at is not null from join_requests where phone = v_phone),
    'заявка закрылась сама — очередь не показывает сделанное');

  perform t.assert(
    (select count(*) from notifications where user_id = v_id and type = 'invite_ready') = 1,
    'человек получил сообщение в тот же чат, где оставлял заявку');
end $$;

-- Занятый чат не переносится: telegram_id уникален, и слепой перенос
-- уронил бы создание участника ошибкой базы вместо понятного отказа.
do $$
declare
  v_id    uuid := gen_random_uuid();
  v_phone text := '+77015550002';
  v_busy  bigint;
begin
  perform set_config('request.jwt.claims', '', true);

  select telegram_id into v_busy from users
   where telegram_id is not null limit 1;
  perform t.assert(v_busy is not null, 'для проверки нужен занятый чат');

  perform submit_join_request(v_phone, 'Двойник', v_busy, 'dup');
  insert into auth.users (id) values (v_id);
  delete from users where id = v_id;
  insert into users (id, phone) values (v_id, v_phone);

  perform t.assert(
    (select telegram_id is null from users where id = v_id),
    'чужой чат не привязался — участник создан без ошибки базы');

  perform t.assert(
    (select handled_at is not null from join_requests where phone = v_phone),
    'заявка всё равно закрыта — организатор своё дело сделал');
end $$;

-- Обычный участник без заявки создаётся как раньше: триггер не должен
-- вмешиваться туда, где заявки не было.
do $$
declare v_id uuid := gen_random_uuid();
begin
  perform set_config('request.jwt.claims', '', true);
  insert into auth.users (id) values (v_id);
  delete from users where id = v_id;
  insert into users (id, phone) values (v_id, '+77015559999');

  perform t.assert(
    (select count(*) from notifications
      where user_id = v_id and type = 'invite_ready') = 0,
    'без заявки сообщения нет — триггер не выдумывает событий');
end $$;


-- Разрешение системной записи гаснет сразу.
--
-- Флаг renthub.system_write говорит сторожам «пропусти, это система».
-- Ставят его функции модератора: без него сторож запретил бы им ровно
-- то, ради чего их зовут. Ставился он и не гасился — в расчёте на то,
-- что предложение SET у функции откатит его на выходе. Не откатывает:
-- «локальный» у set_config означает транзакцию, а не функцию.
--
-- Цена ошибки: одна вызванная функция модератора открывала дверь всему,
-- что писалось в этой транзакции дальше. Проверяем сам флаг, а не только
-- его последствия: последствия ловятся ниже, а причина — здесь.
do $$
begin
  perform t.assert(
    coalesce(current_setting('renthub.system_write', true), '') <> 'on',
    'после moderator_hide_item разрешение системной записи снято');
end $$;

-- Снятое модератором владелец не возвращает.
--
-- Раньше на этом месте стоял ровно один запрос — тот самый, что ниже
-- помечен как обход, — и стенд считал его уборкой. Он и был дырой:
-- status hidden означал сразу «владелец поставил на паузу» и «модератор
-- снял с публикации», а раз состояния неразличимы, неразличимы и права
-- на выход из них.

select t.expect_fail(t.id('owner'), format(
  'update items set status = ''active'' where id = %L', t.id('item')),
  'вернуть его в каталог может только модератор');

-- Обход через обнуление отметки. Без этой проверки защита была бы
-- декоративной: политика разрешает менять строку целиком, и снять
-- запрет можно было бы тем же update, что его нарушает.
select t.expect_fail(t.id('owner'), format(
  'update items set moderated_at = null, status = ''active'' where id = %L',
  t.id('item')),
  'отметку модератора снимает только модератор');

-- А вот исправлять объявление владелец обязан мочь: этим он и
-- отвечает на замечание. Запрет на правку превратил бы снятие с
-- публикации в приговор без обжалования.
do $$
begin
  perform t.as(t.id('owner'), format(
    'update items set description = ''Добавил фото шильдика'' where id = %L',
    t.id('item')));

  perform t.assert(
    (select description = 'Добавил фото шильдика' from items where id = t.id('item')),
    'снятое объявление владелец может править — иначе замечание не исправить');
end $$;

-- Не-модератору снятие ограничения недоступно: иначе владелец снимал бы
-- его сам, и весь разбор выше не стоил бы ничего.
select t.expect_fail(t.id('owner'), format(
  'select moderator_restore_item(%L)', t.id('item')),
  'только модератор');

-- Модератор снимает ограничение — и объявление остаётся скрытым.
-- Публикация чужой вещи от лица модератора была бы действием за
-- человека: «теперь можно» и «публикую» решают разные люди.
do $$
begin
  perform t.as(t.id('stranger'), format(
    'select moderator_restore_item(%L, ''Фото поправлены'')', t.id('item')));

  perform t.assert(
    (select moderated_at is null and status = 'hidden' from items where id = t.id('item')),
    'ограничение снято, объявление осталось скрытым — публикует владелец');

  perform t.assert(
    t.as_value(t.id('owner'),
      'select count(*)::text from notifications where type = ''item_restored''')::int = 1,
    'владелец узнал, что ограничение снято, — иначе объявление лежало бы молча');
end $$;

-- Снять то, чего нет, — внятный отказ, а не тишина. Модератор нажал
-- кнопку, и «ничего не произошло» он прочитает как сбой.
select t.expect_fail(t.id('stranger'), format(
  'select moderator_restore_item(%L)', t.id('item')),
  'нет ограничения');

-- И только теперь владелец возвращает вещь в каталог сам.
do $$
begin
  perform t.as(t.id('owner'), format(
    'update items set status = ''active'' where id = %L', t.id('item')));

  perform t.assert(
    (select status = 'active' from items where id = t.id('item')),
    'после снятия ограничения владелец публикует вещь обычной кнопкой');
end $$;

-- Роль модератора из приложения по-прежнему не выдаётся. Защищают её два
-- разных механизма, и проверять их надо порознь.
--
-- Чужую строку закрывает RLS: users_update_own пускает только к своей.
-- Запрос к чужой при этом НЕ падает — политика фильтрует строки, а не
-- отклоняет запрос, и update молча меняет ноль строк. Ждать здесь
-- исключения бессмысленно: проверять надо результат.
do $$
begin
  perform t.as(t.id('stranger'),
    format('update users set is_moderator = true where id = %L', t.id('renter')));

  perform t.assert(
    (select not is_moderator from users where id = t.id('renter')),
    'модератор не выдал роль другому — чужую строку закрывает RLS');
end $$;

-- Свою строку RLS пускает, и вот здесь работает триггер
-- users_protect_moderator_role. Это и есть настоящий путь эскалации:
-- без триггера любой вошедший поставил бы себе is_moderator одним запросом.
select t.expect_fail(t.id('renter'),
  format('update users set is_moderator = true where id = %L', t.id('renter')),
  'роль модератора выдаётся только сервисным ключом');

update users set is_moderator = false where id = t.id('stranger');

-- ── Отмена подтверждённой брони ───────────────────────────────
--
-- Раньше отменить можно было только pending, и только арендатору. Бронь
-- в confirmed, которую не забрали, не трогал никто — а confirmed входит
-- в bookings_no_overlap, и даты висели занятыми навсегда.
--
-- Брони здесь проходят настоящий путь: триггер принудительно ставит при
-- вставке pending, и подсунуть готовый confirmed нельзя — это правило, а
-- не мелочь. Значит подтверждаем через booking_confirm, как в жизни.

-- Владелец отменяет подтверждённую: вещь сломалась до передачи.
do $$
declare
  v_id uuid := 'eeeeeeee-0000-4000-8000-000000000001';
begin
  perform t.as(t.id('renter'), format(
    'insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date) '
    || 'values (%L, %L, %L, %L, current_date + 40, current_date + 41)',
    v_id, t.id('item'), t.id('renter'), t.id('owner')));

  perform t.as(t.id('owner'), format('select booking_confirm(%L)', v_id));
  perform t.as(t.id('owner'), format('select booking_cancel(%L)', v_id));

  perform t.assert(
    (select status = 'cancelled' from bookings where id = v_id),
    'владелец может отменить подтверждённую бронь — встреча не всегда состоится');

  perform t.assert(
    t.as_value(t.id('renter'),
      'select count(*)::text from notifications where type = ''booking_cancelled''')::int >= 1,
    'арендатор узнал об отмене, а не обнаружил пропажу брони');
end $$;

-- После передачи вещи отмены нет: вещь на руках, путь один — вернуть.
do $$
declare
  v_id uuid := 'eeeeeeee-0000-4000-8000-000000000002';
  v_err text;
begin
  perform t.as(t.id('renter'), format(
    'insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date) '
    || 'values (%L, %L, %L, %L, current_date + 50, current_date + 51)',
    v_id, t.id('item'), t.id('renter'), t.id('owner')));

  perform t.as(t.id('owner'), format('select booking_confirm(%L)', v_id));
  perform t.as(t.id('renter'), format('select booking_mark_picked_up(%L)', v_id));

  begin
    perform t.as(t.id('renter'), format('select booking_cancel(%L)', v_id));
    v_err := 'без ошибки';
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%до передачи вещи%',
    'после передачи бронь не отменяется — вещь уже на руках');

  delete from bookings where id = v_id;
end $$;

-- Неподтверждённую заявку отменяет тот, кто её подал: владельцу для
-- отказа хватает того, что он её просто не подтвердит.
do $$
declare
  v_id uuid := 'eeeeeeee-0000-4000-8000-000000000003';
  v_err text;
begin
  perform t.as(t.id('renter'), format(
    'insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date) '
    || 'values (%L, %L, %L, %L, current_date + 60, current_date + 61)',
    v_id, t.id('item'), t.id('renter'), t.id('owner')));

  begin
    perform t.as(t.id('owner'), format('select booking_cancel(%L)', v_id));
    v_err := 'без ошибки';
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%отменяет арендатор%',
    'заявку отменяет арендатор — владелец её просто не подтверждает');

  delete from bookings where id = v_id;
end $$;

-- ── Занятость: два списка статусов обязаны совпадать ──────────
--
-- «Живые» статусы перечислены дважды: в ограничении bookings_no_overlap,
-- которое реально запрещает пересечение, и в item_busy_dates(), по
-- которой рисуется календарь. DESIGN.md требует их совпадения, но до сих
-- пор это держалось на внимательности.
--
-- Разойдутся — календарь начнёт врать в одну из двух сторон: покажет
-- занятым то, что забронировать можно, или свободным то, на чём бронь
-- упрётся в ограничение уже после нажатия «Забронировать». Второе хуже:
-- человек выбирает даты, доходит до конца и получает отказ.

do $$
declare
  v_con text;
  v_fun text;
  v_con_st text[];
  v_fun_st text[];
begin
  select pg_get_constraintdef(oid) into v_con
    from pg_constraint where conname = 'bookings_no_overlap';

  select pg_get_functiondef(oid) into v_fun
    from pg_proc
   where proname = 'item_busy_dates' and pronamespace = 'public'::regnamespace;

  perform t.assert(v_con is not null and v_fun is not null,
    'ограничение и функция занятости на месте — иначе сравнивать нечего');

  -- Ищем не любые слова в кавычках, а только те, что действительно
  -- являются статусами брони: в тексте функции есть и другие строки.
  select array_agg(v order by v) into v_con_st
    from unnest(enum_range(null::booking_status)) v
   where position('''' || v::text || '''' in v_con) > 0;

  select array_agg(v order by v) into v_fun_st
    from unnest(enum_range(null::booking_status)) v
   where position('''' || v::text || '''' in v_fun) > 0;

  perform t.assert(v_con_st = v_fun_st,
    'списки живых статусов совпадают: календарь обещает ровно то, что запретит база');
end $$;

-- ── Контакт второй стороны ────────────────────────────────────
--
-- Телефон закрыт грантом на колонки даже вошедшему, поэтому связаться
-- участники подтверждённой сделки могут только через booking_contact().
-- Проверяем оба края: посторонний не получает ничего, сторона получает
-- контакт ВТОРОЙ стороны, а не свой.

do $$
begin
  -- booking создан сценарием 1 и закрыт (completed): контакт там доступен
  -- намеренно — вещь могли забыть вернуть, и связаться нужно как раз после.
  perform t.assert(
    t.as_value(t.id('owner'),
      format('select user_id::text from booking_contact(%L)', t.id('booking')))
      = t.id('renter')::text,
    'владельцу отдан контакт арендатора, а не его собственный');

  perform t.assert(
    t.as_value(t.id('renter'),
      format('select user_id::text from booking_contact(%L)', t.id('booking')))
      = t.id('owner')::text,
    'арендатору — контакт владельца: функция смотрит, кто спрашивает');

  perform t.assert(
    t.as_value(t.id('owner'),
      format('select phone from booking_contact(%L)', t.id('booking')))
      = '+77010000002',
    'телефон второй стороны пришёл целиком — ради этого функция и нужна');
end $$;

-- Посторонний не сторона этой сделки: отказ, а не пустой список. Пустой
-- список человек прочитал бы как «телефона нет», а это разные вещи.
select t.expect_fail(t.id('stranger'),
  format('select * from booking_contact(%L)', t.id('booking')),
  'контакт доступен только сторонам сделки');

select t.anon_fails(
  format('select * from booking_contact(%L)', t.id('booking')),
  'permission denied');

-- ── Уведомления: только отметка о прочтении ───────────────────
--
-- Политика пускает к своей строке целиком — RLS фильтрует строки, а не
-- колонки. Из клиента можно было обнулить sent_at и заставить бота
-- доставить уведомление заново, сколько угодно раз.

do $$
declare
  v_id uuid;
begin
  select id into v_id from notifications where user_id = t.id('owner') limit 1;

  perform t.assert(v_id is not null,
    'уведомление для проверки есть — иначе проверять нечего');

  -- Отметить прочитанным можно: ради этого политика и существует.
  perform t.as(t.id('owner'), format(
    'update notifications set read_at = now() where id = %L', v_id));

  perform t.assert(
    (select read_at is not null from notifications where id = v_id),
    'своё уведомление отмечается прочитанным');
end $$;

do $$
declare
  v_id uuid;
  v_err text;
begin
  select id into v_id from notifications where user_id = t.id('owner') limit 1;

  begin
    perform t.as(t.id('owner'), format(
      'update notifications set sent_at = null where id = %L', v_id));
    v_err := 'без ошибки';
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%permission denied%',
    'sent_at не сбросить — иначе бот слал бы одно и то же заново');

  begin
    perform t.as(t.id('owner'), format(
      'update notifications set title = ''Подделка'' where id = %L', v_id));
    v_err := 'без ошибки';
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%permission denied%',
    'текст уведомления переписать нельзя — его пишет система');
end $$;

-- ── Профиль: белый список полей ───────────────────────────────
--
-- Политика users_update_own разрешает менять свою строку целиком, а
-- триггер сторожил одно поле — is_moderator. Два случая из открытых
-- остальных были не мелочью, и оба проверены на стенде ДО правки:
-- запросы проходили.
--
--   update users set verified_at = now()  — обход ПРАВИЛА 1: после него
--   можно сдавать и арендовать, не подтверждая номер кодом;
--   update users set rating = 5.00        — подделка Trust Score, по
--   которому решают, отдать ли незнакомцу вещь за 90 000 ₸.

select t.expect_fail(t.id('unverified'), format(
  'update users set verified_at = now() where id = %L', t.id('unverified')),
  'остальное проставляет система');

select t.expect_fail(t.id('renter'), format(
  'update users set rating = 5.00, ratings_count = 99 where id = %L', t.id('renter')),
  'остальное проставляет система');

-- Именно изменение, а не запись того же значения: blocked_at у арендатора
-- и так null, и `set blocked_at = null` триггер пропустит правильно —
-- is distinct from там false. Первая версия теста этого не учла и
-- проверяла случай, которого защита касаться не должна.
select t.expect_fail(t.id('renter'), format(
  'update users set blocked_reason = ''снимаю с себя'' where id = %L', t.id('renter')),
  'остальное проставляет система');

select t.expect_fail(t.id('renter'), format(
  'update users set telegram_id = 42 where id = %L', t.id('renter')),
  'остальное проставляет система');

-- Разрешённое остаётся разрешённым: иначе защита превратилась бы в
-- запрет менять профиль вообще, а это другая поломка.
do $$
begin
  perform t.as(t.id('renter'), format(
    'update users set full_name = ''Асель Арендатор'', passive_mode = false where id = %L',
    t.id('renter')));

  perform t.assert(
    (select not passive_mode from users where id = t.id('renter')),
    'имя и пассивный режим человек меняет сам — это про него, а не о нём');
end $$;

-- Рейтинг по-прежнему считает триггер: белый список не должен мешать
-- системе делать свою работу в сессии человека.
do $$
begin
  perform t.assert(
    (select rating is not null from users where id = t.id('owner')),
    'рейтинг из отзывов на месте — пересчёт триггером не сломан');
end $$;

-- ── Фото: от одного до шести, и это правило базы ──────────────
--
-- Границы были в форме, в боте и в create_item(), но не в таблице — а
-- политика items_insert_own разрешает и прямой insert мимо всех троих.
--
-- Ноль фото ломает ПРАВИЛО 6: спор о порче сверяет фото «после» с фото
-- «до», и без вторых сверять не с чем. Первая версия ограничения этот
-- случай пропускала: array_length пустого массива — NULL, а CHECK
-- отклоняет только при false.

select t.expect_fail(t.id('owner'), format(
  'insert into items (owner_id, category, title, daily_price, deposit_amount) '
  || 'values (%L, ''drills'', ''Совсем без фото'', 1000, 5000)', t.id('owner')),
  'items_photos_count');

select t.expect_fail(t.id('owner'), format(
  'insert into items (owner_id, category, title, daily_price, deposit_amount, condition_photos) '
  || 'values (%L, ''drills'', ''Семь снимков'', 1000, 5000, '
  || 'array[''a'',''b'',''c'',''d'',''e'',''f'',''g''])', t.id('owner')),
  'items_photos_count');

-- ── Ориентир: свободный, но не любой ──────────────────────────
--
-- Поле необязательное — у части владельцев вещь лежит там, где ориентира
-- нет. Но если он задан, длина ограничена: пустая строка и роман на две
-- страницы одинаково бесполезны в карточке каталога.

-- Объявление без ориентира создаётся: проверяем результат, а не count >= 0
-- (такое сравнение истинно всегда и упасть не может).
do $$
declare
  v_id uuid;
begin
  perform t.as(t.id('owner'), format(
    'insert into items (id, owner_id, category, title, daily_price, deposit_amount, '
    || 'condition_photos) values (%L, %L, ''drills'', ''Без ориентира'', 1000, 5000, array[''x''])',
    'dddddddd-0000-4000-8000-000000000001'::uuid, t.id('owner')));

  perform t.assert(
    (select pickup_area is null from items where id = 'dddddddd-0000-4000-8000-000000000001'),
    'поле необязательное — объявление без ориентира создалось');

  delete from items where id = 'dddddddd-0000-4000-8000-000000000001';
end $$;

select t.expect_fail(t.id('owner'), format(
  'insert into items (owner_id, category, title, daily_price, deposit_amount, '
  || 'condition_photos, pickup_area) values (%L, ''drills'', ''С пустым ориентиром'', '
  || '1000, 5000, array[''x''], '' '')', t.id('owner')),
  'items_pickup_area_check');

-- repeat(), а не умножение строки: '*' для text в Postgres не определён,
-- это питоновская привычка.
select t.expect_fail(t.id('owner'), format(
  'insert into items (owner_id, category, title, daily_price, deposit_amount, '
  || 'condition_photos, pickup_area) values (%L, ''drills'', ''С длинным ориентиром'', '
  || '1000, 5000, array[''x''], repeat(''x'', 81))', t.id('owner')),
  'items_pickup_area_check');

-- ── Блокировка снимает объявления ─────────────────────────────
--
-- Пробел, который видно только в сценарии: заблокированный не может выложить
-- новое, а старые остаются в каталоге и их бронируют. Проверяем три вещи —
-- что свои объявления скрылись, что чужие не задеты и что разблокировка их
-- НЕ возвращает: за время блокировки вещь могла быть продана или сломана.

update users set is_moderator = true where id = t.id('stranger');

do $$
declare
  v_owner_items integer;
begin
  perform t.as(t.id('owner'), format('update items set status = ''active'' where owner_id = %L', t.id('owner')));

  select count(*) into v_owner_items
  from items where owner_id = t.id('owner') and status = 'active';

  perform t.assert(v_owner_items > 0, 'до блокировки у владельца есть активные объявления');

  -- Чужое объявление: без него «блокировка не задела остальных» проверить
  -- не на чем — в фикстурах все объявления принадлежат owner. Заводим здесь
  -- и убираем в конце блока, чтобы не влиять на сценарий 4.
  perform t.as(t.id('stranger'), format(
    'insert into items (owner_id, category, title, daily_price, deposit_amount, condition_photos) '
    || 'values (%L, ''saws'', ''Пила постороннего'', 2000, 4000, array[''x''])', t.id('stranger')));

  perform t.as(t.id('stranger'),
    format('select set_user_blocked(%L, true, ''Чужие фото в объявлении'')', t.id('owner')));

  perform t.assert(
    (select count(*)::text from items where owner_id = t.id('owner') and status = 'active') = '0',
    'блокировка сняла объявления с публикации');

  -- Раньше здесь стояло `count(*) >= 0`. Оно истинно всегда: count не бывает
  -- отрицательным, то есть проверка не могла упасть ни при какой поломке.
  -- Проверять надо следствие блокировки, а его видно с двух сторон.
  perform t.assert(
    t.as_anon(format('select count(*)::text from items where owner_id = %L', t.id('owner'))) = '0',
    'снятые объявления пропали и из витрины анонима');

  perform t.assert(
    (select count(*)::text from items where owner_id = t.id('stranger') and status = 'active') = '1',
    'блокировка не задела чужие объявления');

  -- Разблокировка возвращает право сдавать, но не витрину.
  perform t.as(t.id('stranger'), format('select set_user_blocked(%L, false)', t.id('owner')));

  perform t.assert(
    (select count(*)::text from items where owner_id = t.id('owner') and status = 'active') = '0',
    'разблокировка не вернула объявления сама — это решение владельца');

  perform t.assert(
    t.as_value(t.id('owner'),
      'select count(*)::text from notifications where type = ''unblocked''')::int >= 1,
    'владелец уведомлён о снятии блокировки');

  -- Возвращаем витрину руками владельца — как это и задумано в продукте.
  perform t.as(t.id('owner'),
    format('update items set status = ''active'' where owner_id = %L', t.id('owner')));

  -- Убираем чужое объявление: дальше идёт сценарий 4, и лишняя строка в
  -- items сместила бы его подсчёты.
  delete from items where owner_id = t.id('stranger');
end $$;

update users set is_moderator = false where id = t.id('stranger');

-- ── Посторонний не может быть кем-то другим ───────────────────
--
-- Обёртки bot_* принимают того, за кого действуют, аргументом, и
-- bot_actor_ok(p_actor) проверяет ЖЕРТВУ — что у неё привязан Telegram, —
-- а не вызывающего. Опознать вызывающего здесь нечем. Значит право
-- вызвать любую bot_* равно праву действовать от чужого имени, и держится
-- всё на одном гранте.
--
-- 03.09.2026 замер показал, что грант был выдан: пять обёрток и
-- submit_support_message оказались доступны роли anon — тому самому
-- публикуемому ключу, что вшит в веб-сборку и в APK. Причина в том, что
-- `revoke all ... from public` не отбирает право у anon: Supabase выдаёт
-- этой роли собственный грант через alter default privileges.
--
-- Проверки ниже держат каждый измеренный путь поимённо. Правило целиком —
-- в сценарии 2, где список доступного анониму сверяется со списком
-- разрешённого.

do $$
declare
  v_price integer;
  v_st    text;
  v_cnt   integer;
begin
  select daily_price, status into v_price, v_st from items where id = t.id('item');
  select count(*) into v_cnt from support_messages where user_id = t.id('owner');

  -- Цена. Опустив её до рубля, посторонний бронирует чужой перфоратор за
  -- ничто: в bookings уезжает daily_price_snapshot, снятый в момент заявки.
  perform t.anon_fails(format('select bot_set_item_price(%L, %L, 1)',
    t.id('owner'), t.id('item')), 'permission denied');

  -- Публикация. Тише и злее: владелец неделю ждёт заявок и решает, что
  -- платформа не работает.
  perform t.anon_fails(format('select bot_set_item_status(%L, %L, ''hidden'')',
    t.id('owner'), t.id('item')), 'permission denied');

  perform t.anon_fails(format('select count(*) from bot_my_items(%L)', t.id('owner')),
    'permission denied');
  perform t.anon_fails(format('select count(*) from bot_profile(%L)', t.id('owner')),
    'permission denied');
  perform t.anon_fails(format('select count(*) from bot_pending_reviews(%L)', t.id('owner')),
    'permission denied');
  perform t.anon_fails(format(
    'select submit_support_message(%L, ''Обращение, которого владелец не писал'')',
    t.id('owner')), 'permission denied');

  -- Проверяем не только отказ, но и его следствие. Отказ, после которого
  -- запись всё-таки появилась, — это не отказ.
  perform t.assert(
    (select daily_price from items where id = t.id('item')) = v_price
    and (select status from items where id = t.id('item'))::text = v_st
    and (select count(*) from support_messages where user_id = t.id('owner')) = v_cnt,
    'после отказов ничего не изменилось — ни цена, ни публикация, ни обращения');
end $$;

-- Уведомление участнику. Пока право было у anon, бот работал каналом
-- доставки чужого текста: сообщение приходило в Telegram подписанным
-- платформой, и отличить его от настоящего человек не мог.
do $$
declare v_cnt integer;
begin
  select count(*) into v_cnt from notifications where user_id = t.id('owner');

  perform t.anon_fails(format(
    'select notify_user(%L, null, ''moderator_message'', ''Срочно'', ''Перейдите по ссылке'')',
    t.id('owner')), 'permission denied');

  perform t.assert(
    (select count(*) from notifications where user_id = t.id('owner')) = v_cnt,
    'постороннему нечем написать участнику от имени платформы');
end $$;

-- Шлюз закрытия сделки и начисление выплат. Своей проверки вызывающего у
-- них нет и быть не может: их зовут другие security definer функции,
-- каждая после собственной проверки. Единственная защита — грант.
select t.anon_fails(format('select settle_booking(%L)', t.id('booking')),
  'permission denied');
select t.anon_fails(format('select schedule_payouts(%L)', t.id('booking')),
  'permission denied');
select t.anon_fails('select process_overdue_bookings()', 'permission denied');

-- Функции модератора. Здесь дело было не только в гранте:
-- assert_moderator() пропускала любой вызов с пустым auth.uid(), считая
-- такой вызов сервисным. У anon он тоже пуст, и на этом держались все
-- функции модератора разом — включая ту, что отдаёт телефон заявителя.
select t.anon_fails('select count(*) from join_requests_open()', 'permission denied');
select t.anon_fails('select count(*) from support_open()', 'permission denied');
select t.anon_fails(format('select moderator_restore_item(%L, ''ок'')', t.id('item')),
  'permission denied');

-- Корень отдельно от гранта: даже если грант однажды вернут, проверка
-- обязана отличать пустой uid анонима от пустого uid сервисного ключа.
-- Зовём через функцию, право на которую у anon есть намеренно.
do $$
declare v_err text;
begin
  begin
    perform t.as_anon('select assert_moderator()::text');
    v_err := 'ПРОШЛО';
  exception when others then v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%только модератор%',
    'проверка модератора не верит пустому uid: у анонима он тоже пуст');
end $$;

-- Обратная сторона того же правила: сервисному ключу и планировщику
-- проверка обязана разрешать, иначе бот и pg_cron перестанут работать.
-- Без этой проверки предыдущую можно было бы «починить» безусловным
-- запретом, и стенд бы этого не заметил.
do $$
declare v_err text;
begin
  perform set_config('request.jwt.claims', '', true);

  begin
    execute 'set local role service_role';
    perform assert_moderator();
    execute 'reset role';
    v_err := 'разрешено';
  exception when others then
    execute 'reset role';
    v_err := sqlerrm;
  end;
  perform t.assert(v_err = 'разрешено', 'сервисному ключу проверка модератора разрешает');

  begin
    perform assert_moderator();
    v_err := 'разрешено';
  exception when others then v_err := sqlerrm;
  end;
  perform t.assert(v_err = 'разрешено', 'планировщику проверка модератора разрешает');
end $$;


-- ── Что вообще доступно постороннему ──────────────────────────
--
-- Самая дорогая находка 03.09.2026 держалась на одной строке, которую
-- никто не писал: Supabase выдаёт роли anon грант на каждую новую функцию
-- в public через `alter default privileges`, а `revoke all ... from
-- public` его не отбирает — PUBLIC и anon это разные грантополучатели.
--
-- Значит по умолчанию открыто ВСЁ, и каждая функция закрыта ровно
-- настолько, насколько автор миграции об этом вспомнил. Семь миграций
-- подряд не вспомнили, и посторонний с публикуемым ключом мог менять цену
-- чужого объявления, снимать его с публикации и читать телефоны
-- заявителей.
--
-- Поэтому проверка идёт не по списку известных дыр, а от обратного:
-- перечислено то, что анониму МОЖНО. Новая функция без отзыва прав уронит
-- стенд, и автор решит осознанно, а не по умолчанию платформы.
--
-- Расширения (pgcrypto, btree_gist) отсеиваются по pg_depend: их функции
-- не наши, и держать их в списке значило бы утопить его в шуме.

do $$
declare
  v_allowed text[] := array[
    -- Витрина без входа. Ради них каталог и открыт: человек должен
    -- увидеть, что перфораторы есть, до того как введёт номер.
    'item_busy_dates', 'user_deals_count', 'calc_booking_price', 'setting',

    -- Действия, которые сами говорят «нужно войти». Отказ приходит
    -- по-русски и текстом функции, а не «permission denied» — это лучше
    -- для человека, и потому грант оставлен намеренно.
    'create_item', 'item_set_price', 'item_set_status', 'open_damage_dispute',
    'submit_review', 'support_submit', 'assert_item_owner',
    'booking_cancel', 'booking_complete', 'booking_confirm',
    'booking_mark_picked_up', 'booking_mark_returned',

    -- Проверки. Ничего не делают, кроме отказа.
    'assert_verified', 'assert_moderator', 'has_open_disputes',
    'decide_dispute_payout',

    -- Триггерные. Вызвать их напрямую нельзя — вне триггера у них нет NEW,
    -- — а право на них Postgres проверяет при создании триггера, не при
    -- срабатывании.
    'bookings_after_insert', 'bookings_before_insert', 'items_before_write',
    'reviews_before_insert', 'reviews_recalc_rating', 'handle_new_auth_user',
    'sync_phone_verification', 'users_role_guard', 'link_join_request'
  ];
  v_open  text[];
  v_extra text[];
begin
  select array_agg(distinct p.proname order by p.proname) into v_open
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and has_function_privilege('anon', p.oid, 'EXECUTE')
     and not exists (
       select 1 from pg_depend d
        where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e');

  select array_agg(x order by x) into v_extra
    from unnest(v_open) x where x <> all (v_allowed);

  perform t.assert(v_extra is null,
    'анониму доступно только разрешённое; лишнее: '
      || coalesce(array_to_string(v_extra, ', '), '—'));
end $$;

-- ── Сделки, которой нет, отвечают по-русски ───────────────────
--
-- `select * into v_b` по несуществующей строке не падает, а оставляет v_b
-- пустым. Проверка владельца дальше сравнивает с NULL и не срабатывает —
-- та же трёхзначная логика, что и у анонима, только с другой стороны.
-- Функция идёт по пустой строке и валится там, где NOT NULL стоит
-- физически.
--
-- Что видел человек: ни одна такая ошибка не начинается с RENTHUB_ и ни
-- одна не совпадает со списком известных ограничений, поэтому
-- humanizeError показывала её как есть — «null value in column "user_id"
-- of relation "notifications"». Измерено 04.09.2026; так отвечали пять
-- функций из семи.
--
-- Проверка идёт по всем сразу, а не по списку исправленных: важно не то,
-- что эти пять починены, а то, что ни одна не отвечает сырым текстом.

do $$
declare
  v_nowhere uuid := '11111111-2222-3333-4444-555555555555';
  v_err     text;
  v_bad     text[] := '{}';
  v_calls   text[][] := array[
    ['booking_confirm',        'select booking_confirm(%L)'],
    ['booking_cancel',         'select booking_cancel(%L)'],
    ['booking_mark_picked_up', 'select booking_mark_picked_up(%L)'],
    ['booking_mark_returned',  'select booking_mark_returned(%L)'],
    ['booking_complete',       'select booking_complete(%L)'],
    ['booking_contact',        'select * from booking_contact(%L)'],
    ['open_damage_dispute',
     'select open_damage_dispute(%L, 1000, array[''https://x.test/a.jpg''], ''нет такой'')']
  ];
begin
  for i in 1 .. array_length(v_calls, 1) loop
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', t.id('owner'), 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      execute format(v_calls[i][2], v_nowhere);
      execute 'reset role';
      v_err := 'ПРОШЛО БЕЗ ОТКАЗА';
    exception when others then
      execute 'reset role';
      v_err := sqlerrm;
    end;

    -- Годится любой свой отказ: важно, что он наш и по-русски, а не текст
    -- Postgres с именами таблиц.
    if v_err not like 'RENTHUB_%' then
      v_bad := v_bad || (v_calls[i][1] || ' → ' || left(v_err, 55));
    end if;
  end loop;

  perform t.assert(array_length(v_bad, 1) is null,
    'несуществующая сделка всюду отвечает своим текстом; сырыми отвечают: '
      || coalesce(array_to_string(v_bad, ' | '), '—'));
end $$;

-- ── То же для функций модератора ──────────────────────────────
--
-- Экран модерации держит список, загруженный минуту назад. Участника
-- удалили, модератор нажимает «Заблокировать» — и до 04.09.2026 читал
-- «insert or update on table "notifications" violates foreign key
-- constraint». Восемь функций из десяти на том же наборе отвечали своим
-- текстом; эти две — нет.

do $$
declare
  v_none uuid := '11111111-2222-3333-4444-555555555555';
  v_err  text;
  v_bad  text[] := '{}';
  v_calls text[][] := array[
    ['moderator_hide_item',      'select moderator_hide_item(%L, ''причина'')'],
    ['moderator_restore_item',   'select moderator_restore_item(%L, ''причина'')'],
    ['resolve_dispute_manually', 'select resolve_dispute_manually(%L, 0, ''решение'')'],
    ['set_user_blocked',         'select set_user_blocked(%L, true, ''причина'')'],
    ['moderator_notify',         'select moderator_notify(%L, ''тема'', ''текст'')'],
    ['join_request_close',       'select join_request_close(%L)']
  ];
begin
  -- Право нужно, чтобы дойти до тела: без него мерялась бы проверка права.
  perform set_config('request.jwt.claims', '', true);
  update users set is_moderator = true where id = t.id('owner');

  for i in 1 .. array_length(v_calls, 1) loop
    begin
      perform set_config('request.jwt.claims',
        json_build_object('sub', t.id('owner'), 'role', 'authenticated')::text, true);
      execute 'set local role authenticated';
      execute format(v_calls[i][2], v_none);
      execute 'reset role';
      v_err := 'ПРОШЛО БЕЗ ОТКАЗА';
    exception when others then
      execute 'reset role';
      v_err := sqlerrm;
    end;

    if v_err not like 'RENTHUB_%' then
      v_bad := v_bad || (v_calls[i][1] || ' → ' || left(v_err, 55));
    end if;
  end loop;

  perform set_config('request.jwt.claims', '', true);
  update users set is_moderator = false where id = t.id('owner');

  perform t.assert(array_length(v_bad, 1) is null,
    'функции модератора отвечают своим текстом на то, чего нет; сырыми отвечают: '
      || coalesce(array_to_string(v_bad, ' | '), '—'));
end $$;

-- ── Доступное анониму обязано отказывать ──────────────────────
--
-- Список выше отвечает на вопрос «что анониму доступно». Он не отвечает на
-- второй: доступное — отказывает ли оно на самом деле. Комментарий рядом со
-- списком утверждал, что эти функции «сами говорят нужно войти». Восемь из
-- них не говорили.
--
-- Причина в трёхзначной логике, а не в забытой строке. Проверка владельца
-- написана как `v_b.owner_id <> auth.uid()`; у анонима auth.uid() пуст, а
-- `uuid <> null` даёт NULL, и `if` не срабатывает. Условие выглядит верным
-- и читается верным.
--
-- Измерено 04.09.2026 ролью anon, каждая функция — из статуса, в котором
-- она разрешена: booking_cancel, booking_mark_picked_up,
-- booking_mark_returned, booking_complete и open_damage_dispute проводили
-- чужую сделку по всему жизненному циклу.
--
-- Поэтому проверка идёт от обратного и по признаку: берём всё, что доступно
-- анониму, отбрасываем чтение (stable/immutable — они ничего не меняют) и
-- требуем от остального отказа со словами «нужно войти». Новая функция,
-- забывшая проверку, уронит стенд, даже если её никто не впишет в список.

do $$
declare
  v_name  text;
  v_args  text;
  v_err   text;
  v_bad   text[] := '{}';
  v_seen  integer := 0;
begin
  for v_name, v_args in
    select p.proname, pg_get_function_identity_arguments(p.oid)
      from pg_proc p
     where p.pronamespace = 'public'::regnamespace
       and has_function_privilege('anon', p.oid, 'EXECUTE')
       -- volatile = меняет данные. Читающие функции витрины сюда не
       -- попадают: им отказывать не в чем, каталог открыт по замыслу.
       and p.provolatile = 'v'
       -- Триггерные вызвать напрямую нельзя: вне триггера у них нет NEW.
       and p.prorettype <> 'trigger'::regtype
       and not exists (
         select 1 from pg_depend d
          where d.objid = p.oid and d.classid = 'pg_proc'::regclass and d.deptype = 'e')
  loop
    v_seen := v_seen + 1;

    begin
      perform set_config('request.jwt.claims', '', true);
      execute 'set local role anon';
      -- Аргументы не подбираем: до тела дойдёт вызов с NULL, а проверка
      -- входа стоит первой строкой — именно это и проверяется.
      execute format(
        'select %I(%s)', v_name,
        (select string_agg('null::' || split_part(a, ' ', 2), ', ')
           from unnest(string_to_array(v_args, ', ')) a
          where a <> ''));
      execute 'reset role';
      v_err := 'ПРОШЛО БЕЗ ОТКАЗА';
    exception when others then
      execute 'reset role';
      v_err := sqlerrm;
    end;

    if position('нужно войти' in v_err) = 0 then
      v_bad := v_bad || (v_name || ' → ' || left(v_err, 60));
    end if;
  end loop;

  -- Ноль функций означал бы, что образец перестал их находить, и проверка
  -- зеленела бы ни на чём. Три ловушки такого вида уже находились.
  perform t.assert(v_seen >= 5,
    format('функций-действий, доступных анониму, найдено %s — образец жив', v_seen));

  perform t.assert(array_length(v_bad, 1) is null,
    'каждое доступное анониму действие отвечает «нужно войти»; молчат: '
      || coalesce(array_to_string(v_bad, ' | '), '—'));
end $$;

-- Отдельно и словами: функция, принимающая того, за кого действуют,
-- аргументом, не может быть доступна сессионной роли. Вызывающего в ней
-- опознать нечем — bot_actor_ok(p_actor) проверяет жертву, а не звонящего.
--
-- Правило держится на соглашении об имени параметра, и это осознанно:
-- p_actor в этом проекте означает ровно «тот, за кого действуем», и все
-- шестнадцать таких функций названы так с самого начала. Проверка по
-- имени параметра ловит и ту, которую напишут завтра.
do $$
declare v_open text[];
begin
  select array_agg(p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')'
                   order by p.proname) into v_open
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and 'p_actor' = any (coalesce(p.proargnames, array[]::text[]))
     and (has_function_privilege('anon', p.oid, 'EXECUTE')
       or has_function_privilege('authenticated', p.oid, 'EXECUTE'));

  perform t.assert(v_open is null,
    'функции с p_actor закрыты обеим сессионным ролям; открыты: '
      || coalesce(array_to_string(v_open, ', '), '—'));
end $$;

-- И проверка самой проверки: список p_actor-функций не должен внезапно
-- опустеть. Пустой массив прошёл бы предыдущий тест с тем же успехом, что
-- и правильно закрытые шестнадцать, — а означал бы, что соглашение об
-- имени сломали и правило больше ничего не сторожит.
do $$
declare v_count integer;
begin
  select count(*) into v_count
    from pg_proc p
   where p.pronamespace = 'public'::regnamespace
     and 'p_actor' = any (coalesce(p.proargnames, array[]::text[]));

  perform t.assert(v_count >= 16,
    'функций с p_actor найдено ' || v_count || ' — соглашение об имени живо');
end $$;
