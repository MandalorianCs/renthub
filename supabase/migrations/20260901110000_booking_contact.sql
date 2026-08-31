-- Контакт второй стороны — после подтверждения брони.
--
-- Пробел, который видно только в сценарии: бронь подтверждена, вещь надо
-- передать из рук в руки — а связаться не через что. Телефон закрыт
-- грантом на колонки не только анониму, но и любому вошедшему, и это
-- правильно: витрина не место для чужих номеров. Но у сторон СОСТОЯВШЕЙСЯ
-- сделки задача другая, и решать её «напишите в поддержку» на пилоте из
-- одного города — значит не решать.
--
-- Отсюда функция вместо ослабления гранта. Она отдаёт контакт ровно того,
-- с кем у вызывающего общая бронь, и ровно тогда, когда встреча уже
-- нужна. Расширить её нельзя: возвращаемые поля перечислены в returns
-- table, и телефон третьего лица физически не проходит.
--
-- ── Почему не с момента заявки ────────────────────────────────
--
-- Статус pending — это «арендатор попросил», а не «стороны договорились».
-- Владелец ещё ничего не обещал, и отдавать его номер тому, кто нажал
-- кнопку, значит сделать заявку способом собирать телефоны. Отмена
-- закрывает доступ по той же причине: договорённости больше нет.

create or replace function booking_contact(p_booking_id uuid)
returns table (
  user_id           uuid,
  full_name         text,
  phone             text,
  telegram_username text
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
  v_other uuid;
begin
  if auth.uid() is null then
    raise exception 'RENTHUB_FORBIDDEN: нужно войти' using errcode = '42501';
  end if;

  select * into v_b from bookings where id = p_booking_id;

  if v_b.id is null then
    raise exception 'RENTHUB_NOT_FOUND: сделка не найдена' using errcode = '42501';
  end if;

  if auth.uid() not in (v_b.renter_id, v_b.owner_id) then
    raise exception 'RENTHUB_FORBIDDEN: контакт доступен только сторонам сделки'
      using errcode = '42501';
  end if;

  -- Список статусов, а не «не pending»: отменённая и завершённая сделки
  -- попали бы под отрицание, а это разные случаи. Завершённая контакт
  -- сохраняет намеренно — вещь могли забыть вернуть, и связаться нужно
  -- ровно тогда, когда сделка уже закрыта.
  if v_b.status not in ('confirmed', 'active', 'returned', 'completed', 'disputed') then
    raise exception 'RENTHUB_BAD_STATE: контакт открывается после подтверждения брони (статус %)', v_b.status
      using errcode = '42501';
  end if;

  v_other := case when auth.uid() = v_b.owner_id then v_b.renter_id else v_b.owner_id end;

  return query
  select u.id, u.full_name, u.phone, u.telegram_username
    from users u
   where u.id = v_other;
end;
$$;

comment on function booking_contact(uuid) is
  'Телефон и Telegram второй стороны — только участнику сделки и только '
  'после подтверждения брони. Нужна потому, что грант на колонки закрывает '
  'phone даже вошедшим, а вещь передают из рук в руки.';

revoke all on function booking_contact(uuid) from public;
revoke execute on function booking_contact(uuid) from anon;
grant execute on function booking_contact(uuid) to authenticated;
