-- ПРАВИЛА 6-7: претензия по порче, порог 15 000 ₸, авторешение vs модерация.

\echo ''
\echo '=== Сценарий 4: порча вещи ==='

-- Вторая вещь с маленьким депозитом: нужна, чтобы проверить, что выплата
-- обрезается размером депозита, а не суммой претензии.
select t.as(t.id('owner'), $sql$
  insert into items (id, owner_id, category, title, daily_price, deposit_amount,
                     condition_photos)
  values (t.id('item_cheap'), t.id('owner'), 'measuring',
          'Лазерный уровень', 1000, 3000,
          array['https://example.test/level-before.jpg'])
$sql$);

-- ── Претензия ниже порога: решается без модератора ────────────

select t.as(t.id('renter'), format($sql$
  insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, %L, current_date, current_date + 1, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('booking4'), t.id('item_cheap'), t.id('renter'), t.id('renter')));

select t.as(t.id('owner'),  format('select booking_confirm(%L)', t.id('booking4')));
select t.as(t.id('renter'), format('select booking_mark_picked_up(%L)', t.id('booking4')));
select t.as(t.id('owner'),  format('select booking_mark_returned(%L)', t.id('booking4')));

-- Без фото «после» сверять не с чем — база обязана отказать.
select t.expect_fail(t.id('owner'), format($sql$
  select open_damage_dispute(%L, 2000, array[]::text[], 'Скол на корпусе')
$sql$, t.id('booking4')), 'RENTHUB_NO_EVIDENCE');

-- Заявлять о порче может только владелец.
select t.expect_fail(t.id('renter'), format($sql$
  select open_damage_dispute(%L, 2000, array['https://example.test/after.jpg'], 'Само сломалось')
$sql$, t.id('booking4')), 'RENTHUB_FORBIDDEN');

-- Ущерб 10 000 ₸ — ниже порога 15 000, но ВЫШЕ депозита 3 000.
select t.as(t.id('owner'), format($sql$
  select open_damage_dispute(%L, 10000,
    array['https://example.test/level-after.jpg'], 'Разбит объектив')
$sql$, t.id('booking4')));

do $$
declare
  d disputes%rowtype;
  b bookings%rowtype;
begin
  select * into d from disputes where booking_id = t.id('booking4') and type = 'damage';
  select * into b from bookings where id = t.id('booking4');

  perform t.assert(d.resolution_status = 'auto_resolved',
    'ПРАВИЛО 7: сумма ниже порога — решено без модератора');
  perform t.assert(d.payout_amount = 3000,
    'выплата обрезана размером депозита: заявлено 10000, депозит 3000');
  perform t.assert(d.opened_by = t.id('owner'), 'автор претензии — владелец');
  perform t.assert(array_length(d.evidence_photos, 1) = 1, 'фото «после» сохранены');
  perform t.assert(b.deposit_status = 'claimed', 'депозит удержан');

  -- Держать сделку больше нечем: спор решён без человека, значит она
  -- закрывается тем же шлюзом, что и обычная.
  perform t.assert(b.status = 'completed',
    'сделка закрылась сразу после авторешения, владельцу нажимать нечего');

  perform t.assert(
    (select count(*) from payouts where booking_id = b.id and status = 'released') = 2,
    'обе выплаты отпущены: аренда и компенсация');

  perform t.assert(
    (select amount = 1600 from payouts where booking_id = b.id and kind = 'rent'),
    'аренда 1000 × 2 минус 20% комиссии = 1600 ₸');

  perform t.assert(
    (select amount = 3000 from payouts
      where booking_id = b.id and kind = 'damage_compensation'),
    'компенсация отдельной строкой, комиссия с неё не берётся');

  perform t.assert(
    (select body like '%1600%' and body like '%3000%' from notifications
      where booking_id = b.id and user_id = t.id('owner') and type = 'payout_released'),
    'в уведомлении владельцу обе суммы названы отдельно');

  perform t.assert(
    (select title = 'Депозит возвращён частично' from notifications
      where booking_id = b.id and user_id = t.id('renter') and type = 'deposit_released'),
    'арендатору сказано, что депозит вернулся не полностью');
end $$;

-- Сделка закрыта — значит стороны могут оценить друг друга. До исправления
-- это было невозможно: отзыв требует completed, а сделка висела в disputed.
select t.as(t.id('renter'), format($sql$
  insert into reviews (booking_id, from_user_id, to_user_id, rating, comment)
  values (%L, %L, %L, 3, 'Претензию считаю завышенной, но вопрос закрыт.')
$sql$, t.id('booking4'), t.id('renter'), t.id('owner')));

do $$
begin
  perform t.assert(
    (select ratings_count = 2 from users where id = t.id('owner')),
    'после сделки со спором отзыв всё равно можно оставить');

  perform t.assert(
    (select count(*) from notifications
      where booking_id = t.id('booking4') and type = 'dispute_auto_resolved') = 2,
    'обе стороны уведомлены о решении спора');

  perform t.assert(
    (select payload -> 'evidence_before' is not null and payload -> 'evidence_after' is not null
       from notifications
      where booking_id = t.id('booking4') and type = 'dispute_auto_resolved'
        and user_id = t.id('renter')),
    'арендатору отправлены обе пачки фото — «до» и «после»');
end $$;

-- ── Претензия выше порога: уходит модератору ──────────────────

select t.as(t.id('renter'), format($sql$
  insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, %L, current_date + 11, current_date + 12, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('booking5'), t.id('item'), t.id('renter'), t.id('renter')));

select t.as(t.id('owner'),  format('select booking_confirm(%L)', t.id('booking5')));
select t.as(t.id('renter'), format('select booking_mark_picked_up(%L)', t.id('booking5')));
select t.as(t.id('owner'),  format('select booking_mark_returned(%L)', t.id('booking5')));

select t.as(t.id('owner'), format($sql$
  select open_damage_dispute(%L, 18000,
    array['https://example.test/hammer-after.jpg'], 'Сгорел двигатель')
$sql$, t.id('booking5')));

do $$
declare
  d disputes%rowtype;
begin
  select * into d from disputes where booking_id = t.id('booking5') and type = 'damage';

  perform t.assert(d.resolution_status = 'manual_review',
    'ПРАВИЛО 7: сумма выше порога — на ручную модерацию');
  perform t.assert(d.payout_amount = 0, 'до решения модератора не выплачено ничего');
  perform t.assert(d.resolved_at is null, 'спор не закрыт');

  perform t.assert(
    (select count(*) from notifications
      where booking_id = t.id('booking5') and type = 'dispute_manual_review') = 2,
    'обе стороны знают, что решение примет человек');
end $$;

-- Пока спор ждёт человека, сделку закрыть нельзя — это верно и так и остаётся.
-- Причина отказа теперь называется прямо: «есть неразрешённый спор»,
-- а не «неподходящий статус».
select t.expect_fail(t.id('owner'),
  format('select booking_complete(%L)', t.id('booking5')), 'RENTHUB_OPEN_DISPUTE');

do $$
begin
  perform t.assert(
    (select count(*) from payouts
      where booking_id = t.id('booking5') and status = 'scheduled') = 1,
    'пока спор открыт, деньги владельцу не отпущены');
end $$;

-- Модератор решает. Больше депозита выплатить нельзя ни при каких условиях.
do $$
declare
  v_dispute uuid;
begin
  select id into v_dispute from disputes where booking_id = t.id('booking5') and type = 'damage';

  begin
    perform resolve_dispute_manually(v_dispute, 999999, 'Попытка выплатить больше депозита');
    raise exception 'ПРОВАЛ: модератору позволили выплатить больше депозита';
  exception
    when others then
      if sqlerrm not like '%RENTHUB_OVER_DEPOSIT%' then raise; end if;
  end;

  -- p_finalize => false: модератор фиксирует решение, но сделку пока
  -- не закрывает — «а вдруг всплывёт ещё что-то».
  perform resolve_dispute_manually(
    v_dispute, 12000, 'Экспертиза подтвердила ущерб частично', false);

  perform t.assert(
    (select resolution_status = 'resolved' and payout_amount = 12000
       from disputes where id = v_dispute),
    'модератор закрыл спор на 12000 ₸');

  perform t.assert(
    (select status = 'disputed' from bookings where id = t.id('booking5')),
    'при p_finalize => false сделка осталась открытой — пауза перед финализацией');

  perform t.assert(
    (select count(*) from payouts
      where booking_id = t.id('booking5') and status = 'scheduled') = 1,
    'в паузе деньги ещё не отпущены');
end $$;

-- ── Подметание планировщиком ──────────────────────────────────
--
-- Сделка, оставленная модератором в паузе, не зависает навсегда: следующий
-- проход планировщика закрывает её вместе со всеми остальными созревшими.
-- Это и есть «закрыть для всех разом» — никого не нужно дёргать поштучно.

\echo ''
\echo '--- планировщик закрывает всё созревшее одним проходом ---'

do $$
declare
  v_closed integer;
begin
  select process_overdue_bookings() into v_closed;

  perform t.assert(v_closed = 1,
    'планировщик закрыл одну созревшую сделку (сделка с авторешением закрылась раньше сама)');
end $$;

do $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = t.id('booking5');

  perform t.assert(b.status = 'completed', 'сделка после решения модератора закрыта');
  perform t.assert(b.deposit_status = 'claimed',
    'депозит помечен как частично удержанный: 12000 из 20000');

  perform t.assert(
    (select amount = 8000 from payouts where booking_id = b.id and kind = 'rent'),
    'аренда 5000 × 2 минус 20% = 8000 ₸');

  perform t.assert(
    (select amount = 12000 from payouts
      where booking_id = b.id and kind = 'damage_compensation'),
    'компенсация по решению модератора — отдельной строкой');

  perform t.assert(
    (select count(*) from payouts where booking_id = b.id and status = 'scheduled') = 0,
    'после закрытия ничего не осталось в ожидании');
end $$;

-- Повторный проход ничего не ломает: шлюз идемпотентен.
do $$
begin
  perform t.assert(process_overdue_bookings() = 0,
    'повторный проход планировщика не закрывает уже закрытое');

  perform t.assert(
    (select count(*) from payouts where kind = 'damage_compensation') = 2,
    'компенсации не задвоились');
end $$;

\echo '--- сценарий 4 пройден ---'

-- ── Кто может разрешать споры ─────────────────────────────────
--
-- До миграции с модераторами resolve_dispute_manually не проверяла
-- вызывающего вообще: функция security definer, PostgREST открывает её
-- всем авторизованным. Арендатор мог закрыть спор против себя с выплатой
-- ноль. Проверки ниже фиксируют, что этого больше нельзя.

\echo ''
\echo '--- право разрешать споры ---'

-- Готовим спор выше порога: он остаётся на ручном разборе.
select t.as(t.id('renter'), format($sql$
  insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, %L, current_date + 40, current_date + 41, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('booking6'), t.id('item'), t.id('renter'), t.id('renter')));

select t.as(t.id('owner'),  format('select booking_confirm(%L)', t.id('booking6')));
select t.as(t.id('renter'), format('select booking_mark_picked_up(%L)', t.id('booking6')));
select t.as(t.id('owner'),  format('select booking_mark_returned(%L)', t.id('booking6')));
select t.as(t.id('owner'), format($sql$
  select open_damage_dispute(%L, 18000, array['https://example.test/x.jpg'], 'Разбор')
$sql$, t.id('booking6')));

-- ── Назад из разбора хода нет ─────────────────────────────────
--
-- Статус disputed означает два разных положения, и одно из них —
-- «вещь не вернули». Ради него disputed и разрешён в
-- booking_mark_returned. Второе — «вещь вернулась, идёт разбор порчи», и
-- отмечать возврат там нечего: вещь уже у владельца.
--
-- Проверка была одна на оба, и владелец мог нажать «Вещь вернули»
-- повторно. Измерено 04.09.2026: сделка уходила из disputed в returned
-- посреди разбора, а окно претензии пересчитывалось от текущего момента.
-- Денег это не теряло — settle_booking держит сделку через
-- has_open_disputes(), — но обе стороны видели «возвращено, ждёт
-- проверки» ровно тогда, когда решение принимает модератор.

do $$
declare
  v_status text;
  v_ends   timestamptz;
  v_after  timestamptz;
begin
  select status::text, damage_claim_ends_at into v_status, v_ends
    from bookings where id = t.id('booking6');

  perform t.assert(v_status = 'disputed',
    'сделка в разборе — исходное положение для проверки');

  perform t.expect_fail(t.id('owner'),
    format('select booking_mark_returned(%L)', t.id('booking6')),
    'идёт разбор претензии');

  -- Отказ, после которого что-то всё-таки изменилось, — это не отказ.
  -- Окно претензии проверяется отдельно от статуса: сдвигалось именно оно,
  -- и проверка только по статусу прошла бы зелёной на сломанном коде.
  select status::text, damage_claim_ends_at into v_status, v_after
    from bookings where id = t.id('booking6');

  perform t.assert(v_status = 'disputed', 'статус остался disputed');
  perform t.assert(v_after = v_ends, 'окно претензии не сдвинулось');
end $$;

-- И обратная половина: там, где вещь действительно не вернули, отметка
-- по-прежнему проходит. Без неё запрет забрал бы единственный выход из
-- автоспора о невозврате — сценарий 40 проверяет этот путь целиком.

-- Арендатор — сторона спора, но не модератор.
do $$
declare
  v_dispute uuid;
begin
  select id into v_dispute from disputes where booking_id = t.id('booking6') and type = 'damage';

  perform t.expect_fail(t.id('renter'),
    format('select resolve_dispute_manually(%L, 0, ''Сам себе списал'')', v_dispute),
    'RENTHUB_FORBIDDEN');

  perform t.expect_fail(t.id('owner'),
    format('select resolve_dispute_manually(%L, 20000, ''Сам себе начислил'')', v_dispute),
    'RENTHUB_FORBIDDEN');

  perform t.expect_fail(t.id('stranger'),
    format('select resolve_dispute_manually(%L, 5000, ''Мимо проходил'')', v_dispute),
    'RENTHUB_FORBIDDEN');
end $$;

-- Роль нельзя выдать себе самому, хотя свою строку менять разрешено.
select t.expect_fail(t.id('renter'),
  format('update users set is_moderator = true where id = %L', t.id('renter')),
  'RENTHUB_FORBIDDEN');

-- Назначаем модератора так, как это делает скрипт: без jwt-сессии.
update users set is_moderator = true where id = t.id('stranger');

do $$
declare
  v_dispute uuid;
begin
  select id into v_dispute from disputes where booking_id = t.id('booking6') and type = 'damage';

  perform t.assert(
    t.as_value(t.id('stranger'), 'select count(*)::text from disputes')::int >= 1,
    'модератор видит споры, которых не касается');

  perform t.as(t.id('stranger'),
    format('select resolve_dispute_manually(%L, 12000, ''Экспертиза'')', v_dispute));

  perform t.assert(
    (select resolution_status = 'resolved' and payout_amount = 12000
       from disputes where id = v_dispute),
    'модератор разрешил спор');

  perform t.assert(
    (select status = 'completed' from bookings where id = t.id('booking6')),
    'сделка закрылась после решения модератора');
end $$;

update users set is_moderator = false where id = t.id('stranger');
