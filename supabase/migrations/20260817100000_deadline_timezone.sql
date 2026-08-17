-- Дедлайн возврата считается в часовом поясе пилота, а не сервера.
--
-- Было: (new.end_date + 1)::timestamptz
--
-- Приведение даты к моменту времени берёт часовой пояс сессии, а у Supabase
-- это UTC. Казахстан с 2024 года целиком в UTC+5, поэтому «конец последних
-- суток аренды» вычислялся как полночь по UTC — то есть 05:00 по Кокшетау.
-- С запасом в 12 часов дедлайн приходился на 17:00 вместо 12:00.
--
-- Арендатор получал пять лишних часов, а владелец видел в приложении время,
-- не совпадающее с обещанным правилом. Ошибка не падает и не логируется:
-- она тихо меняет условие, за которым стоит удержание депозита.
--
-- Пояс задан явно строкой, а не взят из настроек сессии: сессии бывают
-- разные — PostgREST, pg_cron, psql администратора, — и правило, зависящее
-- от того, кто именно выполняет запрос, воспроизводить невозможно.

create or replace function bookings_before_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item  items%rowtype;
  v_price record;
  v_days  integer;
begin
  select * into v_item from items where id = new.item_id;

  if v_item.id is null then
    raise exception 'RENTHUB_ITEM_NOT_FOUND';
  end if;

  if v_item.status <> 'active' then
    raise exception 'RENTHUB_ITEM_HIDDEN: объявление снято с публикации';
  end if;

  perform assert_verified(new.renter_id, 'Бронирование');

  if v_item.owner_id = new.renter_id then
    raise exception 'RENTHUB_SELF_BOOKING: нельзя забронировать собственную вещь';
  end if;

  if new.start_date < current_date then
    raise exception 'RENTHUB_PAST_DATE: аренда не может начинаться в прошлом';
  end if;

  -- Оба дня включительно: аренда «с 1 по 1 число» — это один день.
  v_days := (new.end_date - new.start_date) + 1;

  select * into v_price
  from calc_booking_price(v_item.daily_price, v_days, coalesce(new.insurance_selected, false));

  new.owner_id             := v_item.owner_id;
  new.days                 := v_days;
  new.status               := 'pending';
  new.deposit_status       := 'held';
  new.daily_price_snapshot := v_item.daily_price;
  new.deposit_snapshot     := v_item.deposit_amount;
  new.rent_total           := v_price.rent_total;
  new.platform_fee         := v_price.platform_fee;
  new.insurance_fee        := v_price.insurance_fee;
  new.renter_total         := v_price.renter_total;
  new.owner_payout_total   := v_price.owner_payout_total;

  -- Полночь по местному времени в конце последних суток аренды плюс запас.
  new.grace_period_ends_at :=
    ((new.end_date + 1)::timestamp at time zone 'Asia/Almaty')
    + (setting('grace_period_hours') || ' hours')::interval;

  return new;
end;
$$;

comment on function bookings_before_insert() is
  'Готовит бронь: подставляет владельца, считает дни и суммы, ставит дедлайн '
  'возврата в поясе Asia/Almaty — сервер живёт в UTC, и без явного пояса '
  'дедлайн уезжал на пять часов.';
