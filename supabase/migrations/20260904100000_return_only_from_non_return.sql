-- «Вещь вернули» во время разбора порчи откатывала сделку назад.
--
-- Статус disputed означает два очень разных положения:
--
--   1. автоспор о невозврате — вещь ещё у арендатора, и владелец обязан
--      суметь отметить возврат, когда её привезут. Ради этого disputed и
--      был добавлен в booking_mark_returned;
--   2. претензия по порче на ручном разборе — вещь давно вернулась,
--      её осматривает модератор.
--
-- Проверка была одна на оба, и во втором случае владелец мог нажать
-- «Вещь вернули» повторно. Измерено на стенде 04.09.2026:
--
--   до:    status=disputed, окно претензии до 12:16, спор damage=manual_review
--   после: status=returned, окно претензии до 11:16, спор damage=manual_review
--
-- То есть сделка уходила из disputed посреди разбора, а окно претензии
-- пересчитывалось от текущего момента. Денег это не теряет — settle_booking
-- держит сделку через has_open_disputes(), а второй спор о порче не даёт
-- завести уникальный индекс, — но обе стороны видят статус «возвращено,
-- ждёт проверки» ровно тогда, когда идёт разбор.
--
-- ── Почему правило в базе, а не в кнопке ─────────────────────
--
-- Кнопку убрать надо тоже, и она убирается. Но правило, живущее только в
-- компоненте, обходит бот, а обёртка bot_booking_returned зовёт эту же
-- функцию. Здесь оно одно на оба входа — как и всё остальное в этом файле.

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

comment on function booking_mark_returned(uuid) is
  'Владелец принял вещь. Из статуса disputed — только при открытом споре о '
  'невозврате: разбор порчи идёт по вещи, которая уже вернулась.';
