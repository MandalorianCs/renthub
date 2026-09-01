-- Бот действует от имени человека: контекст, правила, отказы.
--
-- Проверяется не «функция что-то сделала», а то, ради чего она написана:
-- проверки НЕ продублированы. Статус меняет booking_confirm(), уведомление
-- шлёт она же, отказ чужому приходит её текстом. Если кто-то однажды
-- скопирует правило в обёртку — «чтобы быстрее» или «чтобы понятнее» —
-- проверка статуса продолжит зеленеть, и расхождение придётся ловить
-- руками. Поэтому здесь отдельно проверяется происхождение отказа и
-- побочные следы настоящей функции: уведомление и запланированные выплаты.

\echo ''
\echo '=== Сценарий 5: бот действует от имени участника ==='

-- Привязка к Telegram — пропуск бота. Владельцу и арендатору её выдаём,
-- постороннему нет: на нём проверяется отказ.
update users set telegram_id = 100000001 where id = t.id('owner');
update users set telegram_id = 100000002 where id = t.id('renter');

-- Бронь далеко в будущем: у объявления есть занятые интервалы из прошлых
-- сценариев, а bookings_no_overlap не разбирает, кто виноват. Переходы дат
-- не проверяют — только роли и статусы, — поэтому весь путь проходится.
select t.as(t.id('renter'), format($sql$
  insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, %L, current_date + 60, current_date + 62, 3,
          0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('booking_bot'), t.id('item'), t.id('renter'), t.id('owner')));

do $$
begin
  perform t.assert(
    (select status = 'pending' from bookings where id = t.id('booking_bot')),
    'бронь создана и ждёт подтверждения');
end $$;

-- ── Весь путь сделки из Telegram ──────────────────────────────
--
-- Вызовы идут без сессии — так же, как их сделает бот сервисным ключом.
-- Не выставляйся контекст, booking_confirm увидела бы auth.uid() пустым и
-- отказала: владелец не совпал бы с null.

select bot_booking_confirm(t.id('owner'), t.id('booking_bot'));

do $$
begin
  perform t.assert(
    (select status = 'confirmed' from bookings where id = t.id('booking_bot')),
    'бот подтвердил бронь — auth.uid() внутри увидел владельца');

  -- Уведомление шлёт booking_confirm(), а не обёртка. Его наличие и есть
  -- доказательство, что отработала настоящая функция, а не копия правила.
  perform t.assert(
    (select count(*) from notifications
      where booking_id = t.id('booking_bot') and type = 'booking_confirmed') = 1,
    'арендатору ушло уведомление — работала сама booking_confirm');

  perform t.assert(
    (select count(*) from payouts where booking_id = t.id('booking_bot')) > 0,
    'выплаты запланированы — обёртка не подменяет собой переход');
end $$;

select bot_booking_picked_up(t.id('renter'), t.id('booking_bot'));

do $$
begin
  perform t.assert(
    (select status = 'active' and picked_up_at is not null
       from bookings where id = t.id('booking_bot')),
    'арендатор подтвердил получение из Telegram');
end $$;

select bot_booking_returned(t.id('owner'), t.id('booking_bot'));

do $$
begin
  perform t.assert(
    (select status = 'returned' and damage_claim_ends_at is not null
       from bookings where id = t.id('booking_bot')),
    'владелец принял вещь — окно на претензию открылось');
end $$;

select bot_booking_complete(t.id('owner'), t.id('booking_bot'));

do $$
begin
  perform t.assert(
    (select status = 'completed' from bookings where id = t.id('booking_bot')),
    'сделка закрыта из Telegram целиком');

  perform t.assert(
    (select deposit_status = 'released' from bookings where id = t.id('booking_bot')),
    'депозит отпущен — сработал settle_booking, а не обёртка');
end $$;

-- ── Отзыв ─────────────────────────────────────────────────────
--
-- Раньше приложение писало в таблицу напрямую, и правило держали политика
-- с триггером. Боту этого мало: под сервисным ключом RLS не применяется, а
-- переключить роль внутри security definer Postgres не даёт. Поэтому
-- правило переехало в submit_review(), и вход стал общим.

select bot_submit_review(t.id('renter'), t.id('booking_bot'), t.id('owner'), 5,
  'Забрал и вернул через бота, ни разу не открывал приложение.');

do $$
begin
  perform t.assert(
    (select count(*) from reviews
      where booking_id = t.id('booking_bot') and from_user_id = t.id('renter')) = 1,
    'отзыв из Telegram записан');

  perform t.assert(
    (select ratings_count > 1 from users where id = t.id('owner')),
    'рейтинг владельца пересчитан триггером — правило одно на оба входа');
end $$;

-- ── Отказы ────────────────────────────────────────────────────

-- Чужую бронь не подтвердить, и отказ приходит текстом booking_confirm.
-- Это важнее самого факта отказа: обёртка не знает, кто владелец.
do $$
declare
  v_err text;
begin
  begin
    perform bot_booking_confirm(t.id('renter'), t.id('booking_bot'));
    perform t.assert(false, 'подтверждение чужой брони должно было упасть');
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(
    v_err like '%подтверждать бронь может только владелец%'
      or v_err like '%бронь уже в статусе%',
    'отказ пришёл текстом booking_confirm — правило не продублировано');
end $$;

-- Без привязки к Telegram бот не действует: связь telegram_id появляется
-- только после «Поделиться номером», то есть после подтверждения номера
-- самим Telegram. Без неё бот не знает, с кем говорит.
do $$
declare
  v_err text;
begin
  begin
    perform bot_booking_confirm(t.id('stranger'), t.id('booking_bot'));
    perform t.assert(false, 'участник без Telegram должен был получить отказ');
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(
    v_err like '%не привязан к Telegram%',
    'без привязки к Telegram бот действовать не может');
end $$;

-- Отмена закрытой сделки обязана упасть, а не пройти молча. Прямым
-- UPDATE она проходила бы: политика bookings_cancel_pending фильтрует
-- строки, а не отклоняет запрос, и ноль изменённых строк выглядит как
-- успех. В приложении это видно по неизменившемуся экрану, а в чате
-- человек получил бы «готово» на невыполненное действие.
do $$
declare
  v_err text;
begin
  begin
    perform bot_cancel_booking(t.id('renter'), t.id('booking_bot'));
    perform t.assert(false, 'отмена закрытой сделки должна была упасть');
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(
    v_err like '%отменить можно до передачи вещи%',
    'отказ пришёл текстом booking_cancel — обёртка правил не знает');
end $$;

-- Суммы отменённой брони переписать нельзя.
--
-- Проверка была слабой: она смотрела, что booking_cancel() не трогает
-- суммы, — но функция их и не трогает по определению. Главное осталось
-- непроверенным: закрыт ли ПРЯМОЙ путь, которым дыра и была. До миграции
-- 20260831110000 политика bookings_cancel_pending разрешала арендатору
-- сменить статус своим UPDATE, а `with check` смотрел только renter_id и
-- status — суммы ехали тем же запросом.
--
-- Ждать здесь исключения нельзя: RLS фильтрует строки, а не отклоняет
-- запрос. Без политики UPDATE просто не находит строк и завершается
-- успехом, изменив ноль. Проверять надо результат.
do $$
declare
  v_before integer;
begin
  select renter_total into v_before from bookings where id = t.id('booking4');

  perform t.as(t.id('renter'), format(
    'update bookings set status = ''cancelled'', renter_total = 1 where id = %L',
    t.id('booking4')));

  perform t.assert(
    (select renter_total from bookings where id = t.id('booking4')) = v_before,
    'прямой UPDATE не переписал суммы брони');

  perform t.assert(
    (select status from bookings where id = t.id('booking4')) <> 'cancelled',
    'прямой UPDATE не сменил и статус — политики на update больше нет');
exception when others then
  -- Отказ вместо тихого нуля тоже годится: важно, что суммы целы.
  perform t.assert(
    (select renter_total from bookings where id = t.id('booking4')) = v_before,
    'прямой UPDATE не переписал суммы брони');
end $$;

-- ── Контакт второй стороны из чата ────────────────────────────
--
-- То же правило, что в приложении, и та же функция под ним: обёртка
-- только выставляет auth.uid(). Проверяем, что из чата приходит контакт
-- ВТОРОЙ стороны и что посторонний получает отказ её же текстом.

do $$
declare
  v_who   uuid;
  v_phone text;
  v_err   text;
begin
  select user_id, phone into v_who, v_phone
    from bot_booking_contact(t.id('owner'), t.id('booking'));

  perform t.assert(v_who = t.id('renter'),
    'из чата пришёл контакт второй стороны');
  perform t.assert(v_phone = '+77010000002',
    'телефон тот же, что отдаёт приложение — функция под ними одна');

  -- Постороннему нужен telegram_id, иначе bot_actor_ok откажет раньше — и
  -- проверялась бы привязка к Telegram, а не защита контакта. Первая
  -- версия теста целила именно в эту недостижимую ветку.
  --
  -- Сброс claims обязателен: t.as снимает роль, но оставляет
  -- request.jwt.claims до конца транзакции, и прямой update внутри блока
  -- пошёл бы «от имени» последнего пользователя. С белым списком полей
  -- профиля такой update теперь запрещён — как и должен быть.
  perform set_config('request.jwt.claims', '', true);
  update users set telegram_id = 100000003 where id = t.id('stranger');

  begin
    perform bot_booking_contact(t.id('stranger'), t.id('booking'));
    v_err := 'без ошибки';
  exception when others then
    v_err := sqlerrm;
  end;

  perform set_config('request.jwt.claims', '', true);
  update users set telegram_id = null where id = t.id('stranger');

  perform t.assert(
    v_err like '%только сторонам сделки%',
    'отказ пришёл текстом booking_contact — обёртка правил не знает');
end $$;

-- ── Публикация объявления из Telegram ─────────────────────────

do $$
declare
  v_id uuid;
begin
  v_id := bot_create_item(
    t.id('owner'), 'saws', 'Сабельная пила из бота', 2500, 8000,
    array['https://example.test/saw.jpg'], 'Проверка публикации через бота',
    '  мкр. Васильковский  ');

  perform t.assert(v_id is not null, 'бот опубликовал объявление');

  -- Ориентир доезжает и через бота, а не только из приложения: обёртка
  -- пробрасывает его в ту же create_item, и второго пути в таблицу нет.
  -- Пробелы по краям срезаются там же — иначе в витрине появился бы
  -- отступ, которого владелец не набирал.
  perform t.assert(
    (select pickup_area from items where id = v_id) = 'мкр. Васильковский',
    'ориентир записан и обрезан по краям');

  -- Владелец и город не приходят аргументами: первый берётся из auth.uid(),
  -- второй — из дефолта таблицы. Раньше оба слал клиент, и город мог
  -- разойтись с тем, по которому фильтруется витрина.
  perform t.assert(
    (select owner_id = t.id('owner') from items where id = v_id),
    'владелец взят из контекста, а не из аргумента');

  perform t.assert(
    (select city = 'kokshetau' from items where id = v_id),
    'город проставила база — клиент его не передаёт');

  perform t.assert(
    (select status = 'active' from items where id = v_id),
    'объявление сразу на витрине');

  -- Убираем: следующие сценарии считают объявления владельца.
  delete from items where id = v_id;
end $$;

-- Без фото объявление не создаётся: спор разбирают сверкой «до» и «после»,
-- и объявление без снимков делает претензию неразрешимой.
do $$
declare
  v_err text;
begin
  begin
    perform bot_create_item(t.id('owner'), 'saws', 'Пила без фото', 1000, 2000, null);
    perform t.assert(false, 'объявление без фото должно было упасть');
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%хотя бы одно фото%',
    'без фото объявление не публикуется');
end $$;

-- Заблокированный не публикует. Правило живёт в assert_verified(), и здесь
-- проверяется, что через бота его не обойти.
do $$
declare
  v_err text;
begin
  update users set blocked_at = now() where id = t.id('owner');

  begin
    perform bot_create_item(t.id('owner'), 'saws', 'Пила заблокированного',
      1000, 2000, array['https://example.test/x.jpg']);
    perform t.assert(false, 'заблокированный не должен публиковать');
  exception when others then
    v_err := sqlerrm;
  end;

  update users set blocked_at = null where id = t.id('owner');

  perform t.assert(v_err like '%RENTHUB_BLOCKED%',
    'блокировка действует и через бота — отказ пришёл из assert_verified');
end $$;

select t.expect_fail(t.id('renter'),
  format('select bot_create_item(%L, ''saws'', ''Чужая пила'', 1000, 2000, array[''x''])',
    t.id('owner')),
  'permission denied');

-- Главная проверка этой миграции. Обёртка выставляет auth.uid() по
-- аргументу, поэтому право её вызвать равно праву действовать от любого
-- имени. Оно должно быть только у сервисного ключа.
select t.expect_fail(t.id('renter'),
  format('select bot_booking_confirm(%L, %L)', t.id('owner'), t.id('booking_bot')),
  'permission denied');

select t.expect_fail(t.id('renter'),
  format('select bot_submit_review(%L, %L, %L, 5)',
    t.id('owner'), t.id('booking_bot'), t.id('renter')),
  'permission denied');

select t.expect_fail(t.id('renter'),
  format('select bot_cancel_booking(%L, %L)', t.id('owner'), t.id('booking_bot')),
  'permission denied');

do $$
declare
  v_err text;
begin
  begin
    perform t.as_anon(format('select bot_booking_confirm(%L, %L)::text',
      t.id('owner'), t.id('booking_bot')));
    perform t.assert(false, 'анониму вызов должен быть закрыт');
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%permission denied%',
    'анониму отказано: ' || v_err);
end $$;

\echo '--- сценарий 5 пройден ---'
