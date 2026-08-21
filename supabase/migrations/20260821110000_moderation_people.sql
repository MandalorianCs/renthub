-- ─────────────────────────────────────────────────────────────
-- Поимённый список участников для модератора
--
-- Сводка отвечает «сколько», этот список — «кто и что сделал». Оператору
-- пилота нужно второе: шесть строк с именами полезнее любых процентов,
-- когда надо понять, кто выложил вещь, а кто зарегистрировался и пропал.
--
-- Телефон здесь есть — и это осознанное исключение из правила, по которому
-- он не покидает базу. Причина: пилот идёт по личным приглашениям, оператор
-- сам заводил этих людей и звонит им, когда сделка встала. Исключение
-- ограничено с двух сторон: право модератора выдаётся только сервисным
-- ключом, и список живёт в отдельной функции, а не в общей сводке — там
-- телефонов по-прежнему нет, и стенд это проверяет.
--
-- Если решение переиграется, менять придётся одну строку: убрать phone из
-- returns table. Остальное — политики, гранты, экран — не тронется.
-- ─────────────────────────────────────────────────────────────

create or replace function moderation_people()
returns table (
  id uuid,
  full_name text,
  phone text,
  verified boolean,
  telegram boolean,
  is_moderator boolean,
  items integer,
  bookings integer,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from users u where u.id = auth.uid() and u.is_moderator) then
    raise exception 'RENTHUB_FORBIDDEN: список участников доступен только модератору'
      using errcode = '42501';
  end if;

  return query
  select
    u.id,
    u.full_name,
    u.phone,
    u.verified_at is not null,
    u.telegram_id is not null,
    u.is_moderator,
    (select count(*)::int from items i where i.owner_id = u.id),
    (select count(*)::int from bookings b where b.renter_id = u.id),
    u.created_at
  from users u
  order by u.created_at desc
  limit 200;
end;
$$;

comment on function moderation_people() is
  'Поимённый список участников для вкладки «Модерация»: кто, когда пришёл, '
  'подтвердил ли номер, привязал ли Telegram, сколько объявлений и аренд. '
  'Телефон включён намеренно — оператор пилота обзванивает участников сам.';

revoke all on function moderation_people() from public;
revoke execute on function moderation_people() from anon;
grant execute on function moderation_people() to authenticated;
