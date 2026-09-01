-- Несостоявшаяся встреча больше не блокирует вещь навсегда.
--
-- Пробел, который видно только на живом сценарии. Отменить можно было
-- ТОЛЬКО неподтверждённую бронь, и только арендатору. А планировщик
-- разбирал лишь active — напоминания и автоспоры о невозврате.
--
-- Значит бронь в confirmed, которую никто не забрал, не трогал никто. При
-- этом confirmed входит в bookings_no_overlap: даты заняты. Одна сорванная
-- встреча — и вещь не сдаётся больше никому, а владелец ничего не может
-- сделать. Ни ошибки, ни подсказки: сделка просто висит.
--
-- Две части: руками и автоматом.

-- ── 1. Отменить подтверждённую может любая сторона ────────────
--
-- Причина не в вежливости, а в жизни: вещь сломалась до передачи, человек
-- заболел, встреча не сложилась. Отказывать здесь — значит требовать
-- довести до передачи то, чего не было.
--
-- Граница — момент передачи. После picked_up вещь у арендатора, и путь
-- один: вернуть. Отмена там означала бы «сделки не было», хотя вещь на
-- руках, а суммы и депозит уже посчитаны.

create or replace function booking_cancel(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b        bookings%rowtype;
  v_by_owner boolean;
  v_other    uuid;
begin
  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.id is null then
    raise exception 'RENTHUB_NOT_FOUND: бронь не найдена' using errcode = '42501';
  end if;

  if auth.uid() not in (v_b.renter_id, v_b.owner_id) then
    raise exception 'RENTHUB_FORBIDDEN: отменить бронь может только её сторона'
      using errcode = '42501';
  end if;

  v_by_owner := auth.uid() = v_b.owner_id;

  -- Заявку отменяет тот, кто её подал. Владельцу для отказа хватает того,
  -- что он её просто не подтвердит: «отклонил» и «не ответил» — разные
  -- сообщения, и второе честнее, пока он ничего не обещал.
  if v_b.status = 'pending' and v_by_owner then
    raise exception 'RENTHUB_FORBIDDEN: неподтверждённую заявку отменяет арендатор'
      using errcode = '42501';
  end if;

  if v_b.status not in ('pending', 'confirmed') then
    raise exception 'RENTHUB_BAD_STATE: отменить можно до передачи вещи (статус %)', v_b.status
      using errcode = '42501';
  end if;

  update bookings set status = 'cancelled' where id = p_booking_id;

  v_other := case when v_by_owner then v_b.renter_id else v_b.owner_id end;

  -- Вторая сторона узнаёт всегда и узнаёт, КТО отменил. Пропавшая из
  -- списка бронь без объяснения читается как сбой платформы, а не как
  -- решение человека.
  perform notify_user(
    v_other, v_b.id, 'booking_cancelled', 'Бронь отменена',
    case
      when v_b.status = 'pending' then
        'Арендатор отменил неподтверждённую заявку. Даты снова свободны.'
      when v_by_owner then
        'Владелец отменил подтверждённую бронь. Деньги не списывались, даты снова свободны.'
      else
        'Арендатор отменил подтверждённую бронь. Даты снова свободны.'
    end);
end;
$$;

comment on function booking_cancel(uuid) is
  'Отмена брони до передачи вещи. Неподтверждённую отменяет арендатор, '
  'подтверждённую — любая сторона. После picked_up отмены нет: вещь на '
  'руках, и путь один — вернуть.';

-- ── 2. Планировщик закрывает то, что не забрали ───────────────
--
-- Тело функции повторено целиком: `create or replace` иначе не умеет, а
-- добавить один цикл в существующую нельзя. Всё, кроме нового блока,
-- оставлено как было — включая returns integer и подсчёт v_count, по
-- которому стенд проверяет, сколько сделок закрыл проход.
--
-- Новый случай ждёт до конца брони плюс тот же grace period, что и для
-- возврата: до этого момента передача ещё может состояться с опозданием,
-- и закрывать раньше значило бы отменять живую сделку.

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

  -- Не забрали. Раньше этот случай не разбирал никто, и бронь висела в
  -- confirmed вечно, держа даты занятыми — вещь была сдана в никуда.
  --
  -- Срок тот же, что у невозврата: grace_period_ends_at считается от конца
  -- брони, и до него передача ещё может состояться с опозданием.
  for v_b in
    select * from bookings
     where status = 'confirmed'
       and grace_period_ends_at < now()
     for update
  loop
    update bookings set status = 'cancelled' where id = v_b.id;

    perform notify_user(v_b.owner_id, v_b.id, 'booking_cancelled',
      'Бронь закрыта: вещь не забрали',
      'Срок брони прошёл, а передача не отмечена. Даты снова свободны.');
    perform notify_user(v_b.renter_id, v_b.id, 'booking_cancelled',
      'Бронь закрыта: вещь не забрали',
      'Срок брони прошёл, а получение не отмечено. Деньги не списывались.');

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

comment on function process_overdue_bookings() is
  'Регулярная задача: напоминания, автоспор о невозврате, отмена броней, '
  'которые не забрали, и закрытие созревших сделок. Запускать раз в час.';
