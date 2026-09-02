-- Кто такой модератор — записано в одном месте.
--
-- Проверка права жила в трёх видах: assert_moderator() и по собственной
-- копии внутри moderation_overview() и moderation_people(). Копии не просто
-- дублировали правило — они вели себя иначе.
--
-- assert_moderator() пропускает вызов без сессии: у сервисного ключа и
-- планировщика auth.uid() пустой, и без этого автоматика не смогла бы
-- закрывать сделки. Копии такой оговорки не имели, поэтому сводку и список
-- участников нельзя было прочитать скриптом — при том что сервисный ключ и
-- так читает users целиком. То есть запрет ничего не защищал, а мешал.
--
-- Разошлись и тексты отказов: «сводка доступна только модератору», «список
-- участников доступен только модератору» — против общего «это действие
-- доступно только модератору». Три формулировки одного правила.
--
-- Тела функций перенесены как есть: заменена одна строка сторожа, всё
-- остальное — посимвольно то, что было. Копировать руками восемьдесят
-- строк ради одной проверки — это способ внести опечатку в работающий
-- расчёт.

create or replace function moderation_overview()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_result jsonb;
begin
  perform assert_moderator();

  select jsonb_build_object(
    'users', (
      select jsonb_build_object(
        'total', count(*),
        'verified', count(*) filter (where verified_at is not null),
        'telegram', count(*) filter (where telegram_id is not null),
        'week', count(*) filter (where created_at > now() - interval '7 days')
      ) from users
    ),
    'items', (
      select jsonb_build_object(
        'active', count(*) filter (where status = 'active'),
        'hidden', count(*) filter (where status = 'hidden'),
        'week', count(*) filter (where created_at > now() - interval '7 days')
      ) from items
    ),
    'bookings', (
      select jsonb_build_object(
        'pending', count(*) filter (where status = 'pending'),
        'confirmed', count(*) filter (where status = 'confirmed'),
        'active', count(*) filter (where status = 'active'),
        'returned', count(*) filter (where status = 'returned'),
        'completed', count(*) filter (where status = 'completed'),
        'cancelled', count(*) filter (where status = 'cancelled'),
        'week', count(*) filter (where created_at > now() - interval '7 days')
      ) from bookings
    ),
    'disputes', (
      select jsonb_build_object(
        'open', count(*) filter (where resolution_status = 'manual_review'),
        'auto', count(*) filter (where resolution_status = 'auto_resolved'),
        'resolved', count(*) filter (where resolution_status = 'resolved')
      ) from disputes
    ),
    -- Лента последних событий. Имена в ней — те же, что и так видны в
    -- каталоге и отзывах; телефонов, сумм и адресов здесь нет.
    'recent', coalesce((
      select jsonb_agg(event order by at desc)
      from (
        (select created_at as at,
                jsonb_build_object('at', created_at, 'kind', 'user',
                  'text', coalesce(full_name, 'Без имени') || ' — регистрация') as event
         from users order by created_at desc limit 10)
        union all
        (select created_at as at,
                jsonb_build_object('at', created_at, 'kind', 'item',
                  'text', 'Объявление: ' || title) as event
         from items order by created_at desc limit 10)
        union all
        (select b.created_at as at,
                jsonb_build_object('at', b.created_at, 'kind', 'booking',
                  'text', 'Бронь: ' || i.title) as event
         from bookings b join items i on i.id = b.item_id
         order by b.created_at desc limit 10)
      ) mixed
      limit 20
    ), '[]'::jsonb)
  ) into v_result;

  return v_result;
end;
$$;

create or replace function moderation_people()
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
  perform assert_moderator();

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
