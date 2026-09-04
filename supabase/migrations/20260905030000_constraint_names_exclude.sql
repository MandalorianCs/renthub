-- constraint_names() пропускала EXCLUDE-ограничения.
--
-- Первая версия брала contype in ('c', 'u') — check и unique. Проверка
-- `npm run check:errors` тут же это и показала: в списке исключений лежал
-- `bookings_no_overlap`, а функция его не вернула, и скрипт честно сказал
-- «в исключениях есть то, чего в базе нет».
--
-- А это самое частое ограничение из всех: пересечение дат брони. Человек
-- упирается в него, когда выбирает занятые числа, — то есть в обычном
-- сценарии, а не в краю.
--
-- Проверка нашла дефект в том, что её же и обслуживает. Так и должно быть:
-- список, который спрашивают у базы, врёт ровно там, где неверен вопрос.

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
    -- c — check, u — unique, x — exclude. Все три человек нарушает вводом:
    -- неверным значением, повтором и пересечением соответственно.
    and c.contype in ('c', 'u', 'x')
  order by c.conname;
$$;

revoke all on function constraint_names() from public;
revoke all on function constraint_names() from anon, authenticated;
