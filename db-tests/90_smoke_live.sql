-- Проверка живого проекта Supabase: всё ли встало после миграций.
--
-- Вставить целиком в SQL Editor и выполнить. Запрос только читает системные
-- каталоги — данные не трогает, запускать можно сколько угодно раз.
--
-- Отдельно проверяются два места, которых локальный стенд показать не может:
-- триггеры на auth.users (владелец таблицы — supabase_auth_admin) и политики
-- на storage.objects (владелец — supabase_storage_admin). Если что-то пошло
-- не так при выполнении миграций, скорее всего не хватило прав именно там.
--
-- Числа здесь не выдуманы: они сняты с локального стенда, где та же схема
-- разворачивается из тех же миграций (`node db-tests/run.mjs --keep`, затем
-- `docker exec -i renthub-test-db psql -U postgres`). Если добавляете
-- миграцию — обновите и ожидаемые числа, иначе проверка начнёт врать в
-- сторону «всё плохо», а такую быстро перестают запускать.

with checks as (

  select 1 as ord, 'Таблицы' as раздел, 'создано 10 таблиц' as проверка,
         count(*)::text as факт, (count(*) = 10) as ок
    from pg_tables
   where schemaname = 'public'
     and tablename in ('users','items','bookings','payouts','reviews',
                       'disputes','notifications','app_settings','categories',
                       'favorites')

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

  -- ── Функции ───────────────────────────────────────────────

  union all
  select 6, 'Функции', 'переходы статусов, шлюз закрытия, отмена и отзыв',
         count(*)::text, count(*) = 10
    from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('booking_confirm','booking_mark_picked_up','booking_mark_returned',
                     'booking_complete','settle_booking','has_open_disputes',
                     'open_damage_dispute','process_overdue_bookings',
                     'booking_cancel','submit_review')

  union all
  select 7, 'Функции', 'resolve_dispute_manually принимает p_finalize',
         coalesce(max(pronargs)::text, 'НЕТ'), max(pronargs) = 4
    from pg_proc
   where pronamespace = 'public'::regnamespace and proname = 'resolve_dispute_manually'

  union all
  select 8, 'Функции', 'инструменты модератора',
         count(*)::text, count(*) = 7
    from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('assert_moderator','resolve_dispute_manually','set_user_blocked',
                     'moderator_hide_item','moderator_notify','moderation_overview',
                     'moderation_people')

  union all
  select 9, 'Функции', 'обёртки бота (bot_*)',
         count(*)::text, count(*) = 9
    from pg_proc
   where pronamespace = 'public'::regnamespace and proname like 'bot\_%'

  union all
  select 10, 'Функции', 'витрина без входа: занятость, счётчик сделок, свой профиль',
         count(*)::text, count(*) = 3
    from pg_proc
   where pronamespace = 'public'::regnamespace
     and proname in ('item_busy_dates','user_deals_count','my_profile')

  -- ── Колонки, добавленные поздними миграциями ──────────────

  union all
  select 11, 'Колонки', 'users: telegram_id, blocked_at, blocked_reason, is_moderator',
         count(*)::text, count(*) = 4
    from information_schema.columns
   where table_schema = 'public' and table_name = 'users'
     and column_name in ('telegram_id','blocked_at','blocked_reason','is_moderator')

  -- ── RLS ───────────────────────────────────────────────────

  union all
  select 12, 'RLS', 'RLS включена на всех 10 таблицах',
         count(*)::text, count(*) = 10
    from pg_class c join pg_namespace n on n.oid = c.relnamespace
   where n.nspname = 'public' and c.relrowsecurity
     and c.relname in ('users','items','bookings','payouts','reviews',
                       'disputes','notifications','app_settings','categories',
                       'favorites')

  -- Ноль — это правильно. Политику bookings_cancel_pending убрала миграция
  -- 20260831110000: её `with check` смотрел только renter_id и status,
  -- поэтому арендатор мог тем же UPDATE переписать суммы своей брони.
  -- Теперь все переходы идут через функции, и прямого пути в таблицу нет.
  union all
  select 13, 'RLS', 'у bookings нет ни одной UPDATE-политики (переходы только через RPC)',
         count(*)::text, count(*) = 0
    from pg_policies
   where schemaname = 'public' and tablename = 'bookings' and cmd = 'UPDATE'

  union all
  select 14, 'RLS', 'политик всего',
         count(*)::text, count(*) >= 24
    from pg_policies where schemaname = 'public'

  -- Телефон закрыт грантом на колонки, а не политикой: RLS фильтрует строки,
  -- а не поля. Анониму открыты ровно пять колонок витрины.
  union all
  select 15, 'Приватность', 'anon видит 5 колонок users (телефона среди них нет)',
         count(*)::text, count(*) = 5
    from information_schema.column_privileges
   where table_schema = 'public' and table_name = 'users'
     and grantee = 'anon' and privilege_type = 'SELECT'

  -- Через has_column_privilege, а не через column_privileges: последний
  -- отдаёт ВСЕ привилегии колонки — INSERT, UPDATE, REFERENCES, — и запрос
  -- без фильтра по SELECT объявляет телефон открытым, хотя читать его
  -- анониму нельзя. Поймано при написании этой проверки.
  union all
  select 16, 'Приватность', 'телефон анониму на чтение закрыт',
         case when has_column_privilege('anon', 'public.users', 'phone', 'SELECT')
              then 'ОТКРЫТ' else 'закрыт' end,
         not has_column_privilege('anon', 'public.users', 'phone', 'SELECT')

  -- Табличные INSERT/UPDATE у anon есть — это дефолт Supabase «Automatically
  -- expose new tables», и убрать его нельзя, не сломав остальное. Записать
  -- аноним всё равно не может: политик на запись для него нет, и держится
  -- это на RLS. Проверка сторожит именно её — появится политика, и запись
  -- откроется молча.
  union all
  select 17, 'Приватность', 'у anon нет ни одной политики на запись',
         count(*)::text, count(*) = 0
    from pg_policies
   where schemaname = 'public'
     and cmd in ('INSERT','UPDATE','DELETE')
     and 'anon' = any (roles)

  -- ── Ниже то, что локальный стенд проверить не в состоянии ──

  union all
  select 18, 'auth.users', 'триггер on_auth_user_created создан',
         count(*)::text, count(*) = 1
    from pg_trigger
   where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_created'

  union all
  select 19, 'auth.users', 'триггер on_auth_user_phone_confirmed создан',
         count(*)::text, count(*) = 1
    from pg_trigger
   where tgrelid = 'auth.users'::regclass and tgname = 'on_auth_user_phone_confirmed'

  union all
  select 20, 'Storage', 'бакет item-photos существует',
         coalesce(max(id), 'НЕТ'), count(*) = 1
    from storage.buckets where id = 'item-photos'

  union all
  select 21, 'Storage', 'политик на storage.objects',
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
