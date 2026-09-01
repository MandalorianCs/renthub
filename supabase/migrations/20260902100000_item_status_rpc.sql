-- Снять вещь с публикации можно из чата, и правило при этом одно.
--
-- Зачем это в боте. Инструмент ломается не тогда, когда владелец сидит с
-- телефоном в приложении. Он ломается на объекте, и до сих пор в этот
-- момент сделать было нечего: пауза жила только в «Моих вещах». Бронь тем
-- временем оформляет кто-то ещё, и разбирать это придётся отменой уже
-- подтверждённой сделки.
--
-- Почему не прямой update в обёртке bot_*. Обёртки работают через
-- security definer, а это значит RLS к ним не применяется: у сервисного
-- ключа и так полный доступ. Приложение же меняет статус обычным update, и
-- владельца там проверяет политика items_update_own. Скопируй этот update
-- в обёртку — и правило владения молча исчезнет: политика к нему больше не
-- относится, а второй проверки нет.
--
-- Поэтому правило переезжает в функцию, которую зовут оба входа. Так уже
-- сделан create_item, и по той же причине. Политика остаётся на месте
-- вторым рубежом: она защищает всё, что ходит в таблицу напрямую.

create or replace function item_set_status(
  p_item_id uuid,
  p_status  item_status
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
begin
  if auth.uid() is null then
    raise exception 'RENTHUB_FORBIDDEN: нужно войти' using errcode = '42501';
  end if;

  select owner_id into v_owner from items where id = p_item_id;

  if v_owner is null then
    raise exception 'RENTHUB_NOT_FOUND: объявление не найдено' using errcode = '42501';
  end if;

  -- Проверка явная, а не через RLS: функция security definer, и политика к
  -- её запросам не применяется. Без этой строки любой вошедший снимал бы с
  -- публикации чужие объявления, передав чужой id аргументом.
  if v_owner <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: объявление принадлежит другому участнику'
      using errcode = '42501';
  end if;

  -- Ограничение модератора здесь не проверяется намеренно. Его сторожит
  -- триггер items_verify_owner, и он сработает на любой записи в items —
  -- из приложения, из бота, из этой функции. Повтори проверку тут, и
  -- правило снова жило бы в двух местах: ровно то, от чего уходим.
  update items set status = p_status where id = p_item_id;
end;
$$;

comment on function item_set_status(uuid, item_status) is
  'Публикация и пауза объявления. Владельца проверяет сама: security '
  'definer обходит RLS, и политика items_update_own к её запросам не '
  'применяется. Ограничение модератора ловит триггер items_verify_owner.';

revoke all on function item_set_status(uuid, item_status) from public;
grant execute on function item_set_status(uuid, item_status) to authenticated;

-- ── Тот же вход из Telegram ───────────────────────────────────
--
-- Обёртка не знает ни про владельца, ни про модератора, и знать не должна:
-- она выставляет, от чьего имени говорит бот, и зовёт ту же функцию.

create or replace function bot_set_item_status(
  p_actor   uuid,
  p_item_id uuid,
  p_status  item_status
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
  perform item_set_status(p_item_id, p_status);
end;
$$;

-- Право на вызов вошедшему не выдаётся: с ним любой передал бы чужой uuid
-- первым аргументом и действовал от чужого имени. Обёртки живут только для
-- сервисного ключа.
revoke all on function bot_set_item_status(uuid, uuid, item_status) from public;
revoke all on function bot_set_item_status(uuid, uuid, item_status) from authenticated;

comment on function bot_set_item_status(uuid, uuid, item_status) is
  'Пауза и публикация объявления из Telegram. Правило одно на оба входа — '
  'item_set_status(); обёртка только называет действующее лицо.';

-- ── Список своих вещей для бота ───────────────────────────────
--
-- Боту нужен не тот же запрос, что приложению. Приложение показывает
-- карточки с фото и занятостью; чату хватает названия, цены и состояния —
-- и обязательно того, снято ли объявление модератором. Без последнего
-- кнопка «вернуть в каталог» отвечала бы отказом, а человек в чате не
-- увидел бы причины: карточки, где написано «исправьте», у него нет.

create or replace function bot_my_items(p_actor uuid)
returns table (
  id            uuid,
  title         text,
  daily_price   integer,
  status        item_status,
  moderated     boolean,
  moderated_why text
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
           i.moderated_reason
      from items i
     where i.owner_id = p_actor
     order by i.created_at desc;
end;
$$;

revoke all on function bot_my_items(uuid) from public;
revoke all on function bot_my_items(uuid) from authenticated;

comment on function bot_my_items(uuid) is
  'Вещи участника для чата: название, цена, состояние и отметка модератора. '
  'Возвращаемый тип и есть граница — телефоны и чужие объявления сюда не '
  'попадают по построению.';
