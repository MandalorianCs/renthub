-- Решение о блокировке принимается по сигналам, а не по ощущению.
--
-- В списке участников модератор видел: имя, телефон, дату прихода, сколько
-- объявлений и аренд, подтверждён ли номер. Всё это отвечает на вопрос «кто
-- это», и ни одно — на вопрос «что с ним не так».
--
-- А кнопка рядом закрывает человеку сдачу и аренду. Нажимать её, глядя на
-- «4 объявления · 2 аренды», — это решать по ощущению.
--
-- Добавляются два сигнала, ради которых блокировка обычно и случается:
--
--   рейтинг      — как его оценили те, кто с ним уже имел дело;
--   споры        — сколько раз доходило до разбора, и сколько из них
--                  решил человек, а не автоматика.
--
-- Споры считаются по обеим ролям. Владелец, на вещи которого постоянно
-- открывают споры, и арендатор, которому постоянно предъявляют, — разные
-- истории, но обе стоят того, чтобы посмотреть до нажатия.
--
-- drop, а не create or replace: добавляются колонки в returns table, то
-- есть меняется тип результата. Заменить тело create or replace умеет, тип
-- — нет, и падает посреди деплоя. Дроп снимает гранты, поэтому они выданы
-- заново ниже.

drop function if exists moderation_people();

create function moderation_people()
returns table (
  id uuid,
  full_name text,
  phone text,
  verified boolean,
  telegram boolean,
  is_moderator boolean,
  blocked boolean,
  blocked_reason text,
  items integer,
  bookings integer,
  rating numeric,
  ratings_count integer,
  disputes integer,
  disputes_manual integer,
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
    u.blocked_at is not null,
    u.blocked_reason,
    (select count(*)::int from items i where i.owner_id = u.id),
    (select count(*)::int from bookings b where b.renter_id = u.id),
    u.rating,
    u.ratings_count,
    (select count(*)::int
       from disputes d
       join bookings b on b.id = d.booking_id
      where b.owner_id = u.id or b.renter_id = u.id),
    -- Отдельно те, что дошли до человека: спор ниже порога закрывается сам
    -- и о поведении говорит мало, а разбор модератором означает, что
    -- договориться не вышло.
    (select count(*)::int
       from disputes d
       join bookings b on b.id = d.booking_id
      where (b.owner_id = u.id or b.renter_id = u.id)
        and d.resolution_status <> 'auto_resolved'),
    u.created_at
  from users u
  order by u.blocked_at desc nulls last, u.created_at desc
  limit 200;
end;
$$;

comment on function moderation_people() is
  'Поимённый список участников для вкладки «Модерация»: кто, когда пришёл, '
  'подтвердил ли номер, привязал ли Telegram, сколько объявлений и аренд, '
  'как его оценили и сколько раз доходило до спора. Телефон включён '
  'намеренно — оператор пилота обзванивает участников сам.';

revoke all on function moderation_people() from public;
revoke execute on function moderation_people() from anon;
grant execute on function moderation_people() to authenticated;
