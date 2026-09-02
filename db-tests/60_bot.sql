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

-- ── Пауза объявления из чата ──────────────────────────────────
--
-- Инструмент ломается не тогда, когда владелец сидит в приложении.
-- Проверяем главное: правило владения не потерялось по дороге. Обёртка
-- работает через security definer, и RLS к её запросам не применяется —
-- значит владельца должна проверять сама функция.

do $$
begin
  perform bot_set_item_status(t.id('owner'), t.id('item'), 'hidden');

  perform t.assert(
    (select status = 'hidden' from items where id = t.id('item')),
    'владелец снял вещь с публикации из Telegram');

  perform bot_set_item_status(t.id('owner'), t.id('item'), 'active');

  perform t.assert(
    (select status = 'active' from items where id = t.id('item')),
    'и вернул обратно — пауза обратима');
end $$;

-- Чужое объявление боту недоступно. Это ровно та проверка, которая
-- исчезла бы, скопируй мы update прямо в обёртку.
do $$
declare v_err text;
begin
  begin
    perform bot_set_item_status(t.id('renter'), t.id('item'), 'hidden');
    v_err := 'без ошибки';
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%принадлежит другому участнику%',
    'чужую вещь из чата не снять — правило владения пережило обёртку');
end $$;

-- Ограничение модератора действует и через бота: сторожит его триггер,
-- а триггер стоит перед любой записью в items, чей бы ни был вход.
do $$
declare v_err text;
begin
  perform set_config('request.jwt.claims', '', true);
  update users set is_moderator = true where id = t.id('stranger');

  perform t.as(t.id('stranger'), format(
    'select moderator_hide_item(%L, ''Проверка ограничения'')', t.id('item')));
  perform set_config('request.jwt.claims', '', true);

  begin
    perform bot_set_item_status(t.id('owner'), t.id('item'), 'active');
    v_err := 'без ошибки';
  exception when others then
    v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%только модератор%',
    'снятое модератором не вернуть и из Telegram — правило одно на оба входа');

  perform t.as(t.id('stranger'), format('select moderator_restore_item(%L)', t.id('item')));
  perform set_config('request.jwt.claims', '', true);
  update users set is_moderator = false where id = t.id('stranger');

  perform bot_set_item_status(t.id('owner'), t.id('item'), 'active');
end $$;

-- Список вещей для чата: своё видно, чужого нет.
do $$
declare
  v_mine  integer;
  v_alien integer;
begin
  select count(*) into v_mine from bot_my_items(t.id('owner'));

  select count(*) into v_alien
    from bot_my_items(t.id('owner')) b
    join items i on i.id = b.id
   where i.owner_id <> t.id('owner');

  perform t.assert(v_mine > 0, 'владелец видит свои вещи в чате');
  perform t.assert(v_alien = 0,
    'чужие в список не попали — граница проходит по типу возврата');
end $$;

-- ── Цена из чата ──────────────────────────────────────────────
--
-- Цену владелец правит чаще всего: сосед сдаёт дешевле, кончился сезон.
-- Главное, что здесь проверяется, — что уже оформленные брони от этого
-- не дешевеют и не дорожают.

do $$
declare
  v_before integer;
  v_snap   integer;
  v_after  integer;
begin
  select daily_price into v_before from items where id = t.id('item');

  select daily_price_snapshot into v_snap from bookings
   where item_id = t.id('item') order by created_at limit 1;

  perform bot_set_item_price(t.id('owner'), t.id('item'), v_before + 700);

  select daily_price into v_after from items where id = t.id('item');
  perform t.assert(v_after = v_before + 700, 'цена изменилась из чата');

  perform t.assert(
    (select daily_price_snapshot = v_snap from bookings
      where item_id = t.id('item') order by created_at limit 1),
    'у оформленной брони цена не поехала — там снимок на момент заявки');

  perform bot_set_item_price(t.id('owner'), t.id('item'), v_before);
end $$;

-- Ноль и минус отклоняются понятным текстом, а не именем ограничения.
do $$
declare v_err text;
begin
  begin
    perform bot_set_item_price(t.id('owner'), t.id('item'), 0);
    v_err := 'без ошибки';
  exception when others then v_err := sqlerrm;
  end;
  perform t.assert(v_err like '%больше нуля%', 'нулевая цена отклонена');
end $$;

-- Лишний ноль в цене — не ошибка базы, а опечатка человека: объявление
-- становится невидимым, и он узнаёт об этом через неделю тишины.
do $$
declare v_err text;
begin
  begin
    perform bot_set_item_price(t.id('owner'), t.id('item'), 35000000);
    v_err := 'без ошибки';
  exception when others then v_err := sqlerrm;
  end;
  perform t.assert(v_err like '%лишнего нуля%', 'подозрительно большая цена отклонена');
end $$;

-- Чужую цену из чата не поменять: проверка владельца теперь одна на все
-- операции, и это тот же assert_item_owner, что сторожит публикацию.
do $$
declare v_err text;
begin
  begin
    perform bot_set_item_price(t.id('renter'), t.id('item'), 100);
    v_err := 'без ошибки';
  exception when others then v_err := sqlerrm;
  end;
  perform t.assert(v_err like '%принадлежит другому участнику%',
    'чужую цену не поменять — проверка владельца общая');
end $$;


-- ── Что осталось оценить ──────────────────────────────────────
--
-- Таблица «чей ход» говорит про закрытую сделку: «оцените вторую
-- сторону — это единственное, что осталось». Значит система называет это
-- ходом человека, и сделать его должно быть можно не только из одного
-- пролистанного уведомления.

do $$
declare
  v_before integer;
  v_after  integer;
  v_id     uuid;
begin
  select count(*) into v_before from bot_pending_reviews(t.id('owner'));
  perform t.assert(v_before > 0,
    'у владельца есть закрытая сделка без его оценки');

  -- Ставим оценку — сделка обязана уйти из списка. Иначе бот предлагал
  -- бы оценить то, что уже оценено, и человек решил бы, что не сохранилось.
  select id into v_id from bot_pending_reviews(t.id('owner')) limit 1;

  -- Кого оцениваем, берём из самой сделки: подпись функции требует явного
  -- получателя, и подставлять сюда что попало нельзя.
  perform bot_submit_review(
    t.id('owner'), v_id,
    (select case when b.owner_id = t.id('owner') then b.renter_id else b.owner_id end
       from bookings b where b.id = v_id),
    5, null);

  select count(*) into v_after from bot_pending_reviews(t.id('owner'));
  perform t.assert(v_after = v_before - 1,
    'оценённая сделка ушла из списка');
end $$;

-- Чужие сделки в список не попадают: граница проходит по запросу, а не
-- по аккуратности того, кто пишет бота.
do $$
declare v_alien integer;
begin
  select count(*) into v_alien
    from bot_pending_reviews(t.id('owner')) p
    join bookings b on b.id = p.id
   where b.owner_id <> t.id('owner') and b.renter_id <> t.id('owner');

  perform t.assert(v_alien = 0, 'в списке только свои сделки');
end $$;

-- Без привязки к Telegram список не отдаётся — тот же пропуск, что у
-- остальных обёрток.
do $$
declare v_err text;
begin
  begin
    perform * from bot_pending_reviews(t.id('stranger'));
    v_err := 'без ошибки';
  exception when others then v_err := sqlerrm;
  end;
  perform t.assert(v_err like '%не привязан к Telegram%',
    'без привязки список не отдаётся');
end $$;


-- ── Претензия по порче из чата ────────────────────────────────
--
-- Единственная обёртка бота, которую стенд не трогал вовсе, — и та, где
-- на кону деньги: заявление о порче удерживает депозит. Пробел нашёлся
-- сверкой списка обёрток со списком того, что упоминается в тестах.

do $$
declare
  v_id uuid := 'dddddddd-0000-4000-8000-000000000001';
  v_d  disputes%rowtype;
  v_b  bookings%rowtype;
begin
  -- Своя бронь на свободных датах: сценарий не должен зависеть от чужих.
  perform t.as(t.id('renter'), format(
    'insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date) '
    || 'values (%L, %L, %L, %L, current_date + 70, current_date + 71)',
    v_id, t.id('item'), t.id('renter'), t.id('owner')));

  perform bot_booking_confirm(t.id('owner'), v_id);
  perform bot_booking_picked_up(t.id('renter'), v_id);
  perform bot_booking_returned(t.id('owner'), v_id);

  perform bot_open_damage_dispute(
    t.id('owner'), v_id, 2000,
    array['https://example.test/bot-after.jpg'], 'Скол на корпусе');

  select * into v_d from disputes where booking_id = v_id;
  select * into v_b from bookings where id = v_id;

  perform t.assert(v_d.id is not null, 'претензия из чата создана');
  perform t.assert(v_d.claim_amount = 2000, 'сумма ущерба записана как заявлена');
  perform t.assert(v_d.opened_by = t.id('owner'),
    'заявитель взят из контекста, а не из аргумента');

  -- 2 000 ₸ ниже порога авторешения в 15 000, поэтому спор закрывается сам
  -- и той же функцией закрывает сделку. Первая версия этого теста ждала
  -- статус disputed — стенд поймал догадку: до ручного разбора дело здесь
  -- не доходит вовсе, и это правило, а не мелочь.
  perform t.assert(v_d.resolution_status = 'auto_resolved',
    'спор ниже порога решён без модератора');
  perform t.assert(v_d.payout_amount > 0,
    'компенсация посчитана, а не оставлена нулём');
  perform t.assert(v_b.status = 'completed',
    'сделка закрыта тем же шлюзом — владельцу нечего нажимать');
  perform t.assert(v_b.deposit_status = 'claimed',
    'депозит удержан — за это и отвечает претензия');
end $$;

-- Без фото претензию не принимают и из чата: правило живёт в
-- open_damage_dispute, обёртка его не знает и знать не должна.
do $$
declare
  v_id  uuid := 'dddddddd-0000-4000-8000-000000000002';
  v_err text;
begin
  perform t.as(t.id('renter'), format(
    'insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date) '
    || 'values (%L, %L, %L, %L, current_date + 80, current_date + 81)',
    v_id, t.id('item'), t.id('renter'), t.id('owner')));

  perform bot_booking_confirm(t.id('owner'), v_id);
  perform bot_booking_picked_up(t.id('renter'), v_id);
  perform bot_booking_returned(t.id('owner'), v_id);

  begin
    perform bot_open_damage_dispute(t.id('owner'), v_id, 2000, array[]::text[], 'Без фото');
    v_err := 'без ошибки';
  exception when others then v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%NO_EVIDENCE%',
    'без фото претензию не приняли — отказ пришёл текстом самой функции');

  -- Арендатор не заявляет о порче своей же аренды.
  begin
    perform bot_open_damage_dispute(
      t.id('renter'), v_id, 2000,
      array['https://example.test/x.jpg'], 'Само сломалось');
    v_err := 'без ошибки';
  exception when others then v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%FORBIDDEN%',
    'заявить о порче может только владелец — и через чат тоже');
end $$;


-- ── Приложение зовёт те же функции напрямую ───────────────────
--
-- Пробел нашёлся сверкой: item_set_status и item_set_price выданы
-- вошедшему, то есть приложение зовёт их само, минуя обёртки бота. А
-- стенд трогал только путь через бота — то есть проверял, что правило
-- работает для чата, и молчал про экран.
--
-- Разница не косметическая: у обёртки контекст выставляет она сама, а
-- здесь auth.uid() приходит из сессии. Проверка владельца одна на оба
-- пути — assert_item_owner, — и убедиться в этом надо с обеих сторон.

do $$
declare v_price integer;
begin
  perform t.as(t.id('owner'), format('select item_set_status(%L, ''hidden'')', t.id('item')));
  perform t.assert(
    (select status = 'hidden' from items where id = t.id('item')),
    'владелец снял вещь с публикации из приложения');

  perform t.as(t.id('owner'), format('select item_set_status(%L, ''active'')', t.id('item')));

  select daily_price into v_price from items where id = t.id('item');
  perform t.as(t.id('owner'), format('select item_set_price(%L, %s)', t.id('item'), v_price + 100));
  perform t.assert(
    (select daily_price = v_price + 100 from items where id = t.id('item')),
    'владелец изменил цену из приложения');

  perform t.as(t.id('owner'), format('select item_set_price(%L, %s)', t.id('item'), v_price));
end $$;

-- Чужое объявление недоступно и отсюда. Это та же проверка, что и для
-- бота, и в том и смысл: функция одна.
select t.expect_fail(t.id('renter'), format(
  'select item_set_status(%L, ''hidden'')', t.id('item')),
  'принадлежит другому участнику');

select t.expect_fail(t.id('renter'), format(
  'select item_set_price(%L, 100)', t.id('item')),
  'принадлежит другому участнику');

-- Анониму — тем более: у него нет auth.uid(), и функция обязана сказать
-- «нужно войти», а не молча ничего не сделать.
select t.anon_fails(format(
  'select item_set_status(%L, ''hidden'')', t.id('item')),
  'нужно войти');


-- ── Профиль в чате ────────────────────────────────────────────
--
-- Рейтинг и число сделок — первое, что спрашивает владелец, решая,
-- продолжать ли сдавать. Проверяем и содержимое, и границу: телефон
-- сюда не попадает по построению, и это стоит закрепить тестом.

do $$
declare
  v_name   text;
  v_deals  integer;
  v_verif  boolean;
  v_active integer;
begin
  select full_name, deals, verified, items_active
    into v_name, v_deals, v_verif, v_active
    from bot_profile(t.id('owner'));

  perform t.assert(v_name is not null, 'профиль владельца пришёл в чат');
  perform t.assert(v_verif, 'номер подтверждён — так и написано');
  perform t.assert(v_deals >= 1, 'сделки посчитаны обеими ролями');
  perform t.assert(v_active >= 0, 'объявления посчитаны');
end $$;

-- Телефона в ответе нет и быть не может: границу держит тип возврата,
-- а не аккуратность того, кто пишет запрос в боте.
do $$
declare v_cols integer;
begin
  select count(*) into v_cols
    from information_schema.columns
   where table_name = 'bot_profile' and column_name in ('phone', 'blocked_at');

  perform t.assert(v_cols = 0,
    'телефон и блокировка в профиль для чата не попадают');
end $$;

-- Без привязки к Telegram профиля нет: тот же пропуск, что у остальных
-- обёрток.
do $$
declare v_err text;
begin
  begin
    perform * from bot_profile(t.id('stranger'));
    v_err := 'без ошибки';
  exception when others then v_err := sqlerrm;
  end;

  perform t.assert(v_err like '%не привязан к Telegram%',
    'без привязки профиль не отдаётся');
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
