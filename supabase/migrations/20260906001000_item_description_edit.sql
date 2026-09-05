-- Описание вещи правится из чата — и там же впервые появляется.
--
-- ── Чего не хватало ──────────────────────────────────────────
--
-- В диалоге /сдать шага описания нет вовсе: раздел, название, цена,
-- депозит, ориентир, фото. Значит объявление, опубликованное из чата,
-- всегда выходит без описания — и дописать его владельцу негде, если он
-- живёт в Telegram, а не в приложении.
--
-- Так и вышло с первым живым объявлением платформы: у лобзика нет ни
-- ориентира (закрыто 05.09.2026), ни описания. Арендатор видит название,
-- цену и фото — и решает, писать ли незнакомому человеку, не зная, что
-- именно получит.
--
-- Шаг в публикацию не добавляется намеренно: в диалоге их уже шесть, а
-- седьмой отделяет владельца от витрины ещё одним экраном. Описание —
-- то, что дописывают потом, когда вещь уже висит и её смотрят.
--
-- ── Почему у описания появляется граница ─────────────────────
--
-- До сих пор её не было ни в базе, ни в форме: колонка `text`, поле без
-- maxLength. Пока писали в приложении, это сходило — человек за экраном
-- видит, сколько уже набрал. В чат приходит пересланный откуда угодно
-- текст, и карточка объявления становится нечитаемой.
--
-- 600 символов — это примерно десять строк на телефоне: хватает на
-- комплект, состояние и особенности, и не хватает на историю покупки.
-- Нижняя граница в два символа — та же, что у названия и ориентира:
-- «а» в описании это не описание, а промах по клавише.
--
-- Существующие описания измерены до правки: самое длинное — 82 символа.

alter table items add constraint items_description_check
  check (description is null or length(trim(description)) between 2 and 600);

comment on column items.description is
  'Что в комплекте, состояние, особенности. Необязательное; граница в 600 '
  'символов появилась вместе с правкой из чата, где текст приходит '
  'пересланным и длину его никто не видит.';

-- ── Правка ────────────────────────────────────────────────────

create or replace function item_set_description(
  p_item_id uuid,
  p_text    text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_item_owner(p_item_id);

  -- Пустая строка убирает описание, а не пишет пустоту: поле
  -- необязательное, и путь назад обязан существовать. Та же
  -- нормализация, что у ориентира и в create_item().
  update items
     set description = nullif(trim(coalesce(p_text, '')), '')
   where id = p_item_id;
end;
$$;

comment on function item_set_description(uuid, text) is
  'Смена описания вещи. Пустая строка убирает его. Длину сторожит '
  'ограничение items_description_check — вторая копия границ не заводится.';

revoke all on function item_set_description(uuid, text) from public;
revoke execute on function item_set_description(uuid, text) from anon;
grant execute on function item_set_description(uuid, text) to authenticated;

-- ── Тот же вход из Telegram ───────────────────────────────────

create or replace function bot_set_item_description(
  p_actor   uuid,
  p_item_id uuid,
  p_text    text
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
  perform item_set_description(p_item_id, p_text);
end;
$$;

revoke all on function bot_set_item_description(uuid, uuid, text) from public;
revoke execute on function bot_set_item_description(uuid, uuid, text) from anon, authenticated;

comment on function bot_set_item_description(uuid, uuid, text) is
  'Смена описания из Telegram. Правило одно на оба входа — '
  'item_set_description(); обёртка только называет действующее лицо.';

-- ── Список вещей в чате показывает, есть ли описание ──────────
--
-- Та же причина, что и у ориентира: кнопка «добавить описание» без
-- ответа на «а что у меня сейчас» — это вопрос без контекста. Тип
-- результата меняется, поэтому дроп, а не create or replace, и гранты
-- выписываются заново: дроп снимает их вместе с функцией.
--
-- Возвращается не сам текст, а его наличие: описание бывает в шестьсот
-- символов, и в списке из пяти вещей оно превратило бы строку в
-- простыню. Показать целиком есть где — в самом диалоге правки.

drop function if exists bot_my_items(uuid);

create function bot_my_items(p_actor uuid)
returns table (
  id             uuid,
  title          text,
  daily_price    integer,
  status         item_status,
  moderated      boolean,
  moderated_why  text,
  pickup_area    text,
  has_description boolean
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
           i.pickup_area,
           i.description is not null
      from items i
     where i.owner_id = p_actor
     order by i.created_at desc;
end;
$$;

revoke all on function bot_my_items(uuid) from public;
revoke execute on function bot_my_items(uuid) from anon, authenticated;

comment on function bot_my_items(uuid) is
  'Вещи участника для чата: название, цена, состояние, отметка модератора, '
  'ориентир и признак описания. Возвращаемый тип и есть граница — телефоны '
  'и чужие объявления сюда не попадают по построению.';
