-- Ориентир «где забирать» правится оттуда же, откуда публиковали.
--
-- ── Что случилось ─────────────────────────────────────────────
--
-- 05.09.2026 на витрине появилось первое НЕ демонстрационное объявление:
-- лобзик, живой владелец, публикация из чата. Ориентира у него нет —
-- в диалоге /сдать шаг «где забирать» предлагает кнопку «Пропустить», и
-- она была нажата.
--
-- Само по себе это не ошибка: поле необязательное намеренно (см.
-- 20260901100000_pickup_area.sql), у части владельцев вещь лежит там, где
-- ориентира нет. Ошибка в том, что назад дороги не было. `/вещи` в чате
-- умеет ровно две вещи — пауза и цена, — а правка ориентира считалась
-- частью «правки объявления целиком», которая в диалог не помещается.
--
-- Итог виден на витрине: восемь нарисованных объявлений говорят, где их
-- забирать, а единственное настоящее — нет. Причём его владелец сделал
-- всё, что мог сделать в чате: опубликовал вещь.
--
-- ── Почему это тот же случай, что и цена ──────────────────────
--
-- Аргумент против правки из чата записан в NewPrice: «показать все
-- текущие значения и дать выбрать, какое менять, — это уже экран, а не
-- диалог». Он верен для описания и фото. Для ориентира — нет, ровно по
-- тем же трём признакам, по которым исключение сделали для цены:
--
--   • текущее значение помещается в одну строку;
--   • новое — один ответ, без выбора из списка;
--   • правят его чаще прочего: район, где вещь лежит, меняется вместе с
--     переездом и с тем, кто её сейчас держит.
--
-- Четвёртый признак есть только здесь и он сильнее трёх: без ориентира
-- объявление уже опубликовано и уже показывается людям. Цену пропустить
-- нельзя, фото нельзя, а это — можно, и мы сами предложили кнопку.
--
-- ── Правило владения не удваивается ───────────────────────────
--
-- Функция тонкая: вся проверка — assert_item_owner(), тот же вызов, что
-- у item_set_price() и item_set_status(). Третья копия правила «менять
-- объявление может только его владелец» здесь не появляется.
--
-- Длину сторожит ограничение items_pickup_area_check, заведённое вместе
-- с колонкой, — и перевод для него уже есть в обеих дверях
-- (CONSTRAINT_MESSAGES в боте, humanizeError в приложении). Своей
-- проверки в теле нет намеренно: второй экземпляр границ «2 и 80» стал
-- бы третьим местом, где их правят.

create or replace function item_set_pickup_area(
  p_item_id uuid,
  p_area    text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_item_owner(p_item_id);

  -- Пустая строка означает «убрать ориентир», а не «записать пустоту»:
  -- владелец, поставивший его по ошибке, должен уметь вернуться к тому,
  -- как было. Ограничение таблицы null разрешает, пустую строку — нет,
  -- поэтому nullif обязателен, а не косметика.
  --
  -- Та же нормализация стоит в create_item(): ориентир, записанный
  -- пробелами, ничем не отличается от отсутствующего, и хранить эту
  -- разницу значило бы показывать в каталоге пустую строку под замком.
  update items
     set pickup_area = nullif(trim(coalesce(p_area, '')), '')
   where id = p_item_id;
end;
$$;

comment on function item_set_pickup_area(uuid, text) is
  'Смена ориентира «где забирать». Пустая строка убирает его: поле '
  'необязательное, и путь назад обязан существовать. Длину сторожит '
  'ограничение items_pickup_area_check — вторая копия границ не заводится.';

revoke all on function item_set_pickup_area(uuid, text) from public;
revoke execute on function item_set_pickup_area(uuid, text) from anon;
grant execute on function item_set_pickup_area(uuid, text) to authenticated;

-- ── Тот же вход из Telegram ───────────────────────────────────
--
-- Обёртка называет действующее лицо и зовёт ту же функцию. Право позвать
-- её равно праву действовать от чужого имени — получатель приходит
-- аргументом, — поэтому обе сессионные роли от неё отрезаны. Имя
-- параметра p_actor обязательно: по нему стенд находит такие функции и
-- требует отзыва прав, не заглядывая в список.

create or replace function bot_set_item_pickup(
  p_actor   uuid,
  p_item_id uuid,
  p_area    text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  perform item_set_pickup_area(p_item_id, p_area);
end;
$$;

revoke all on function bot_set_item_pickup(uuid, uuid, text) from public;
revoke execute on function bot_set_item_pickup(uuid, uuid, text) from anon, authenticated;

comment on function bot_set_item_pickup(uuid, uuid, text) is
  'Смена ориентира из Telegram. Правило одно на оба входа — '
  'item_set_pickup_area(); обёртка только называет действующее лицо.';

-- ── Список вещей в чате показывает ориентир ───────────────────
--
-- Кнопка «добавить ориентир» без текущего значения рядом — это вопрос без
-- контекста: владелец не помнит, писал он район или пропустил, и нажмёт
-- наугад. Строка списка обязана отвечать на «а что у меня сейчас», иначе
-- отсутствие ориентира так и останется незаметным — ровно тем, из-за чего
-- эта миграция и появилась.
--
-- Тип результата меняется, поэтому дроп, а не create or replace: у
-- последнего сигнатура — часть имени, и добавленная колонка не заменила бы
-- функцию, а оставила бы старую жить рядом. Дроп снимает и гранты, поэтому
-- отзывы ниже выписаны заново, а не «уже были».

drop function if exists bot_my_items(uuid);

create function bot_my_items(p_actor uuid)
returns table (
  id            uuid,
  title         text,
  daily_price   integer,
  status        item_status,
  moderated     boolean,
  moderated_why text,
  pickup_area   text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);

  return query
    select i.id, i.title, i.daily_price, i.status,
           i.moderated_at is not null,
           i.moderated_reason,
           i.pickup_area
      from items i
     where i.owner_id = p_actor
     order by i.created_at desc;
end;
$$;

revoke all on function bot_my_items(uuid) from public;
revoke execute on function bot_my_items(uuid) from anon, authenticated;

comment on function bot_my_items(uuid) is
  'Вещи участника для чата: название, цена, состояние, отметка модератора '
  'и ориентир. Возвращаемый тип и есть граница — телефоны и чужие '
  'объявления сюда не попадают по построению.';
