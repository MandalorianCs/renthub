-- ─────────────────────────────────────────────────────────────
-- Сводка для модератора: живёт ли пилот
--
-- Экран модерации до сих пор показывал только споры, а их в здоровом
-- пилоте нет неделями. Модератор открывал вкладку, видел «разбирать
-- нечего» и не понимал главного: приходят ли вообще люди, выкладывают ли
-- вещи, случаются ли сделки. Пустой экран отвечал на вопрос, которого не
-- задавали.
--
-- Почему функция, а не политики на чтение. Считать участников и сделки
-- модератору нужно, а читать чужие строки целиком — нет: там телефоны,
-- суммы и личности сторон. Функция возвращает только числа и короткие
-- строки событий, и вернуть больше, чем описано ниже, физически не может.
-- Тот же приём, что у item_busy_dates() и my_profile().
-- ─────────────────────────────────────────────────────────────

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
  -- Право проверяется внутри, а не политикой снаружи: security definer
  -- выполняется от владельца и политики на нём не действуют. Без этой
  -- строки сводка была бы доступна любому вошедшему.
  if not exists (select 1 from users where id = auth.uid() and is_moderator) then
    raise exception 'RENTHUB_FORBIDDEN: сводка доступна только модератору'
      using errcode = '42501';
  end if;

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

comment on function moderation_overview() is
  'Числа и лента событий для вкладки «Модерация». Только для модератора, '
  'проверка внутри функции. Личных данных не возвращает.';

revoke all on function moderation_overview() from public;
revoke execute on function moderation_overview() from anon;
grant execute on function moderation_overview() to authenticated;
