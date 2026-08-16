-- Проверка живого проекта Supabase: всё ли встало после трёх миграций.
--
-- Вставить целиком в SQL Editor и выполнить. Запрос только читает системные
-- каталоги — данные не трогает, запускать можно сколько угодно раз.
--
-- Отдельно проверяются два места, которых локальный стенд показать не может:
-- триггеры на auth.users (владелец таблицы — supabase_auth_admin) и политики
-- на storage.objects (владелец — supabase_storage_admin). Если что-то пошло
-- не так при выполнении миграций, скорее всего не хватило прав именно там.

with checks as (

  select 1 as ord, 'Таблицы' as раздел, 'создано 9 таблиц' as проверка,
         count(*)::text as факт, (count(*) = 9) as ок
    from pg_tables
   where schemaname = 'public'
     and tablename in ('users','items','bookings','payouts','reviews',
                       'disputes','notifications','app_settings','categories')

  union all
  select 2, 'Типы', 'создано 7 перечислений',
         count(*)::text, count(*) = 7
    from pg_type
   where typnamespace = 'public'::regnamespace
     and typname in ('item_status','booking_status','deposit_status',
                     'dispute_type','dispute_resolution','payout_status','payout_kind')

  union all
  select 3, 'Типы', 'payout_kind на месте (компенсации ущерба)',
         coalesce(max(typname), 'НЕТ'), count(*) = 1
    from pg_type
   where typnamespace = 'public'::regnamespace and typname = 'payout_kind'

  union all
  select 4, 'Настройки', 'app_settings заполнена',
         count(*)::text, count(*) = 5
    from app_settings

  union all
  select 5, 'Настройки', 'категорий инструмента',
         count(*)::text, count(*) = 8
    from categories

  union all
  select 6, 'Функции', 'RPC переходов и шлюз закрытия',
         count(*)::text, count(*) = 8
    from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('booking_confirm','booking_mark_picked_up','booking_mark_returned',
                     'booking_complete','settle_booking','has_open_disputes',
                     'open_damage_dispute','process_overdue_bookings')

  union all
  select 7, 'Функции', 'resolve_dispute_manually принимает p_finalize',
         coalesce(max(pronargs)::text, 'НЕТ'), max(pronargs) = 4
    from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'resolve_dispute_manually'

  union all
  select 8, 'RLS', 'RLS включена на всех 9 таблицах',
         count(*)::text, count(*) = 9
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relrowsecurity
     and c.relname in ('users','items','bookings','payouts','reviews',
                       'disputes','notifications','app_settings','categories')

  union all
  select 9, 'RLS', 'у bookings нет своевольного update (только отмена)',
         count(*)::text, count(*) = 1
    from pg_policies
   where schemaname = 'public' and tablename = 'bookings' and cmd = 'UPDATE'

  union all
  select 10, 'RLS', 'политик всего',
         count(*)::text, count(*) >= 15
    from pg_policies where schemaname = 'public'

  -- ── Ниже то, что локальный стенд проверить не в состоянии ──

  union all
  select 11, 'auth.users', 'триггер on_auth_user_created создан',
         count(*)::text, count(*) = 1
    from pg_trigger
   where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created'

  union all
  select 12, 'auth.users', 'триггер on_auth_user_phone_confirmed создан',
         count(*)::text, count(*) = 1
    from pg_trigger
   where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_phone_confirmed'

  union all
  select 13, 'Storage', 'бакет item-photos существует',
         coalesce(max(id), 'НЕТ'), count(*) = 1
    from storage.buckets where id = 'item-photos'

  union all
  select 14, 'Storage', 'политик на storage.objects',
         count(*)::text, count(*) = 3
    from pg_policies
   where schemaname = 'storage' and tablename = 'objects'
     and policyname in ('item_photos_read','item_photos_write','item_photos_delete')
)

select case when ок then '✓' else '✗ ПРОВЕРИТЬ' end as статус,
       раздел, проверка, факт
  from checks
 order by ord;

-- Проверка планировщика — отдельно и ПОСЛЕ включения pg_cron.
-- В запрос выше её нельзя вставить: пока расширение не включено, схемы cron
-- не существует, и Postgres отвергает весь запрос целиком на разборе, ещё
-- до выполнения — «зелёными» не станут даже те проверки, что прошли бы.
--
-- select jobname, schedule, command from cron.job
--  where command like '%process_overdue_bookings%';
