-- База рассказывает, какие у неё ограничения.
--
-- Зачем. И бот, и приложение держат таблицу переводов: имя ограничения →
-- фраза по-русски. Без перевода человек получает то, что прислал Postgres:
-- `new row for relation "bookings" violates check constraint
-- "bookings_check1"`. Это не сообщение об ошибке, это улика.
--
-- 05.09.2026 сверка показала: в базе семнадцать check-ограничений, а
-- переведено шесть. Среди непереведённых было `bookings_check1` —
-- «renter_id <> owner_id», то есть попытка забронировать собственную вещь.
-- Каталог показывает и свои объявления, кнопка на них живая, и обычное
-- любопытство упиралось в латиницу.
--
-- Почему функция, а не список в репозитории. Списку пришлось бы верить:
-- ограничение добавляется одной строкой в миграции, а вспомнить про две
-- таблицы переводов в двух языках — отдельное усилие, и однажды его никто
-- не сделает. Спросить базу дешевле, чем помнить.
--
-- Авто-именованные ограничения — половина списка (`bookings_check1`,
-- `items_daily_price_check`), и в миграциях этих имён нет вовсе: Postgres
-- придумывает их сам. Прочитать их можно только у него.

create or replace function constraint_names()
returns setof text
language sql
stable
security definer
set search_path = public
as $$
  select c.conname::text
  from pg_constraint c
  join pg_namespace n on n.oid = c.connamespace
  where n.nspname = 'public'
    and c.contype in ('c', 'u')   -- check и unique: и то и другое человек нарушает вводом
  order by c.conname;
$$;

comment on function constraint_names() is
  'Имена ограничений схемы public. Читает scripts/check-errors.mjs, чтобы '
  'сверить их с таблицами переводов в боте и приложении: без перевода '
  'человек видит сырую строку Postgres.';

-- Только служебному ключу: список ограничений ничего не открывает, но и
-- участнику он ни к чему, а лишний грант однажды окажется лишним.
revoke all on function constraint_names() from public;
revoke all on function constraint_names() from anon, authenticated;
