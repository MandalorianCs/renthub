-- Владелец видит свой рейтинг, не открывая приложение.
--
-- Это первое, что спрашивает человек, решая, продолжать ли сдавать: сколько
-- сделок он довёл и как его оценили. До сих пор ответ жил только на экране
-- профиля, а бот — единственное место, куда владелец в пассивном режиме
-- вообще заходит: туда ему приходят уведомления.
--
-- Через функцию, а не выборкой сервисным ключом. Ключ читает users целиком,
-- вместе с телефонами и отметками блокировки, и «взять только нужное»
-- держалось бы на внимательности того, кто пишет запрос в боте. Тип
-- возврата — это и есть граница: лишнего отсюда не вынести, даже если
-- захотеть. Тем же приёмом сделаны item_busy_dates() и booking_contact().

create or replace function bot_profile(p_actor uuid)
returns table (
  full_name     text,
  rating        numeric,
  ratings_count integer,
  deals         integer,
  verified      boolean,
  passive_mode  boolean,
  items_active  integer,
  items_hidden  integer
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);

  return query
    select u.full_name,
           u.rating,
           u.ratings_count,
           user_deals_count(u.id),
           u.verified_at is not null,
           u.passive_mode,
           (select count(*)::int from items i
             where i.owner_id = u.id and i.status = 'active'),
           -- Снятые модератором считаются вместе со скрытыми владельцем:
           -- в чате разделять их незачем, причина видна в /вещи.
           (select count(*)::int from items i
             where i.owner_id = u.id and i.status = 'hidden')
      from users u
     where u.id = p_actor;
end;
$$;

comment on function bot_profile(uuid) is
  'Профиль участника для чата: имя, рейтинг, сделки, статус номера и счёт '
  'объявлений. Граница проходит по типу возврата — телефон и отметки '
  'блокировки сюда не попадают по построению.';

revoke all on function bot_profile(uuid) from public;
revoke all on function bot_profile(uuid) from authenticated;
