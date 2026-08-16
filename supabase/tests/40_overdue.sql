-- ПРАВИЛО 5: просрочка → grace period → автоспор → закрытие по таймеру.
--
-- Ждать 12 часов в тесте нельзя, поэтому сделка проходит петлю честно,
-- а потом сдвигаются назад только дедлайны. Так проверяется настоящая
-- логика process_overdue_bookings, а не подставленная строка в нужном статусе.

\echo ''
\echo '=== Сценарий 3: невозврат и работа планировщика ==='

select t.as(t.id('renter'), format($sql$
  insert into bookings (id, item_id, renter_id, owner_id, start_date, end_date,
                        days, daily_price_snapshot, deposit_snapshot,
                        rent_total, platform_fee, insurance_fee,
                        renter_total, owner_payout_total)
  values (%L, %L, %L, %L, current_date, current_date, 1, 0, 0, 0, 0, 0, 0, 0)
$sql$, t.id('booking3'), t.id('item'), t.id('renter'), t.id('renter')));

select t.as(t.id('owner'),  format('select booking_confirm(%L)', t.id('booking3')));
select t.as(t.id('renter'), format('select booking_mark_picked_up(%L)', t.id('booking3')));

-- ── Напоминание в день возврата ───────────────────────────────

select process_overdue_bookings();

do $$
begin
  perform t.assert(
    (select count(*) from notifications
      where booking_id = t.id('booking3') and type = 'return_due_today') = 2,
    'в день возврата напоминание уходит обеим сторонам');
end $$;

select process_overdue_bookings();

do $$
begin
  perform t.assert(
    (select count(*) from notifications
      where booking_id = t.id('booking3') and type = 'return_due_today') = 2,
    'повторный запуск планировщика не дублирует напоминание');
end $$;

-- ── Grace period истёк, вещь не вернули ───────────────────────

update bookings set grace_period_ends_at = now() - interval '1 minute'
 where id = t.id('booking3');

do $$
declare
  v_moved integer;
begin
  select process_overdue_bookings() into v_moved;
  perform t.assert(v_moved = 1, 'планировщик сообщил об одной просроченной сделке');
end $$;

do $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = t.id('booking3');

  perform t.assert(b.status = 'disputed', 'сделка переведена в спор');
  perform t.assert(b.deposit_status = 'claimed', 'депозит удержан');

  perform t.assert(
    (select count(*) from disputes
      where booking_id = b.id and type = 'non_return'
        and opened_by is null and resolution_status = 'manual_review') = 1,
    'автоспор о невозврате открыт системой, без инициатора');

  perform t.assert(
    (select claim_amount = 20000 from disputes
      where booking_id = b.id and type = 'non_return'),
    'сумма претензии равна депозиту из брони');

  perform t.assert(
    (select count(*) from notifications
      where booking_id = b.id and type = 'dispute_non_return') = 2,
    'обе стороны узнали о споре');
end $$;

select process_overdue_bookings();

do $$
begin
  perform t.assert(
    (select count(*) from disputes
      where booking_id = t.id('booking3') and type = 'non_return') = 1,
    'повторный запуск не плодит вторую претензию по той же сделке');
end $$;

-- ── Вещь всё-таки вернули ─────────────────────────────────────

select t.as(t.id('owner'), format('select booking_mark_returned(%L)', t.id('booking3')));

do $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = t.id('booking3');

  perform t.assert(b.status = 'returned', 'после возврата сделка вышла из спора');
  perform t.assert(b.deposit_status = 'held',
    'депозит вернулся в held до конца окна претензии по порче');

  perform t.assert(
    (select resolution_status = 'resolved' from disputes
      where booking_id = b.id and type = 'non_return'),
    'спор о невозврате закрыт автоматически');
end $$;

-- ── Окно претензии истекло без спора → закрытие без владельца ──
-- Это и есть пассивный режим: владелец ничего не нажимал, а деньги
-- начислились и уведомление пришло.

update bookings set damage_claim_ends_at = now() - interval '1 minute'
 where id = t.id('booking3');

select process_overdue_bookings();

do $$
declare
  b bookings%rowtype;
begin
  select * into b from bookings where id = t.id('booking3');

  perform t.assert(b.status = 'completed',
    'сделка закрылась сама по истечении окна претензии');
  perform t.assert(b.deposit_status = 'released', 'депозит отпущен');

  perform t.assert(
    (select count(*) from payouts
      where booking_id = b.id and status = 'released') = 1,
    'начисление владельцу отпущено без его участия');

  perform t.assert(
    (select count(*) from notifications
      where booking_id = b.id and user_id = t.id('owner')
        and type = 'payout_released') = 1,
    'владелец получил готовый итог: «деньги начислены»');
end $$;

\echo '--- сценарий 3 пройден ---'
