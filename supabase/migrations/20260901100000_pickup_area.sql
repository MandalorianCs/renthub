-- Где забирать вещь.
--
-- Лендинг обещает «инструмент рядом», а в каталоге не было ничего о том,
-- насколько рядом: ни района, ни ориентира. Для аренды перфоратора это не
-- деталь — вещь надо забрать и вернуть, и «через дорогу» против «через весь
-- город» меняет решение сильнее, чем двести тенге в цене.
--
-- Поле свободное, а не справочник районов. Списка микрорайонов Кокшетау у
-- нас нет, а выдуманный справочник заставил бы владельца выбирать между
-- пунктами, которые не описывают его двор. «Возле вокзала» и «мкр.
-- Васильковский» одинаково полезны арендатору, и оба он поймёт.
--
-- Необязательное: у части владельцев вещь лежит там, где ориентира нет, и
-- требовать его значило бы не пустить их в витрину из-за формальности.
-- Пустое поле экран покажет честно, а не выдумает «Кокшетау».

alter table items add column pickup_area text
  check (pickup_area is null or length(trim(pickup_area)) between 2 and 80);

comment on column items.pickup_area is
  'Район или ориентир, где забирать вещь. Свободный текст: справочника '
  'районов у пилота нет, а выдуманный не описал бы реальные дворы.';

-- ── Публикация: параметр добавляется дропом, а не заменой ─────
--
-- `create or replace` с другим числом параметров не заменяет функцию, а
-- создаёт ВТОРУЮ рядом: сигнатура — часть имени. Старая осталась бы жить
-- вместе со своими грантами, и какая из них вызовется, зависело бы от того,
-- сколько аргументов передал клиент. Поэтому дроп, потом create, потом
-- гранты заново — дроп снимает их вместе с функцией.

drop function if exists create_item(text, text, integer, integer, text[], text);

create function create_item(
  p_category   text,
  p_title      text,
  p_daily_price integer,
  p_deposit_amount integer,
  p_photos     text[],
  p_description text default null,
  p_pickup_area text default null
)
returns items
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item items%rowtype;
begin
  if auth.uid() is null then
    raise exception 'RENTHUB_FORBIDDEN: нужно войти' using errcode = '42501';
  end if;

  if p_photos is null or array_length(p_photos, 1) is null then
    raise exception 'RENTHUB_BAD_INPUT: нужно хотя бы одно фото вещи'
      using errcode = '22023';
  end if;

  insert into items (owner_id, category, title, description,
                     daily_price, deposit_amount, condition_photos, pickup_area)
  values (auth.uid(), p_category, trim(p_title),
          nullif(trim(coalesce(p_description, '')), ''),
          p_daily_price, p_deposit_amount, p_photos,
          nullif(trim(coalesce(p_pickup_area, '')), ''))
  returning * into v_item;

  return v_item;
end;
$$;

comment on function create_item(text, text, integer, integer, text[], text, text) is
  'Публикация объявления. Владельца берёт из auth.uid(), город — из дефолта '
  'таблицы: оба раньше приходили от клиента и могли разойтись с базой.';

revoke execute on function create_item(text, text, integer, integer, text[], text, text) from anon;
grant execute on function create_item(text, text, integer, integer, text[], text, text) to authenticated;

-- ── Обёртка бота — по той же причине дропом ──────────────────

drop function if exists bot_create_item(uuid, text, text, integer, integer, text[], text);

create function bot_create_item(
  p_actor      uuid,
  p_category   text,
  p_title      text,
  p_daily_price integer,
  p_deposit_amount integer,
  p_photos     text[],
  p_description text default null,
  p_pickup_area text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_item items%rowtype;
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);

  v_item := create_item(p_category, p_title, p_daily_price, p_deposit_amount,
                        p_photos, p_description, p_pickup_area);
  return v_item.id;
end;
$$;

revoke all on function bot_create_item(uuid, text, text, integer, integer, text[], text, text) from public;
revoke execute on function bot_create_item(uuid, text, text, integer, integer, text[], text, text)
  from anon, authenticated;
