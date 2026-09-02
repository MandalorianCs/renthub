-- Цену можно поменять из чата, и правило владения остаётся одно.
--
-- Цена — то, что владелец правит чаще всего: сосед сдаёт дешевле, сезон
-- кончился, вещь простаивает. Ради одной цифры открывать приложение и
-- проходить форму публикации целиком — это ровно та цена, из-за которой
-- цифру не меняют вовсе.
--
-- ── Почему сначала выносится проверка владельца ───────────────
--
-- После item_set_status() правило «менять объявление может только его
-- владелец» жило уже в двух местах: политика items_update_own для
-- приложения и явная проверка внутри функции для бота (RLS к запросам
-- security definer не применяется). Добавить сюда третью копию значило бы
-- завести привычку: каждая новая операция — ещё одно место, где правило
-- можно записать по-другому.
--
-- Поэтому проверка становится отдельной функцией, а операции — тонкими.
-- Политика остаётся вторым рубежом для всего, что ходит в таблицу напрямую.

create or replace function assert_item_owner(p_item_id uuid)
returns void
language plpgsql
stable
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

  if v_owner <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: объявление принадлежит другому участнику'
      using errcode = '42501';
  end if;
end;
$$;

comment on function assert_item_owner(uuid) is
  'Единственная проверка владельца объявления для функций security definer. '
  'RLS к их запросам не применяется, поэтому проверка обязана быть явной — '
  'и обязана быть одна.';

-- ── Публикация и пауза: теперь через общую проверку ───────────
--
-- Тело повторено целиком: create or replace иначе не умеет. Изменились три
-- строки — вместо собственной проверки вызов assert_item_owner().

create or replace function item_set_status(
  p_item_id uuid,
  p_status  item_status
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_item_owner(p_item_id);

  -- Ограничение модератора здесь не проверяется намеренно: его сторожит
  -- триггер items_verify_owner, и он сработает на любой записи в items.
  update items set status = p_status where id = p_item_id;
end;
$$;

-- ── Цена ──────────────────────────────────────────────────────

create or replace function item_set_price(
  p_item_id uuid,
  p_price   integer
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_item_owner(p_item_id);

  -- Ограничение таблицы (daily_price > 0) сработало бы и само, но его текст
  -- английский и говорит про имя constraint. Человеку в чате нужен ответ,
  -- а не диагноз базы.
  if p_price is null or p_price <= 0 then
    raise exception 'RENTHUB_BAD_INPUT: цена за сутки должна быть больше нуля'
      using errcode = '22023';
  end if;

  -- Верхняя граница не для базы, а для опечатки: лишний ноль в цене
  -- превращает объявление в невидимое, и владелец узнаёт об этом через
  -- неделю тишины.
  if p_price > 1000000 then
    raise exception 'RENTHUB_BAD_INPUT: цена за сутки больше миллиона — проверьте, нет ли лишнего нуля'
      using errcode = '22023';
  end if;

  -- Уже оформленные брони не дешевеют и не дорожают: в bookings лежит
  -- daily_price_snapshot, снятый в момент заявки. Новая цена действует со
  -- следующей брони, и это правило таблицы, а не забота этой функции.
  update items set daily_price = p_price where id = p_item_id;
end;
$$;

comment on function item_set_price(uuid, integer) is
  'Смена цены за сутки. На уже оформленные брони не влияет: там лежит '
  'daily_price_snapshot, снятый в момент заявки.';

revoke all on function item_set_price(uuid, integer) from public;
grant execute on function item_set_price(uuid, integer) to authenticated;

-- ── Тот же вход из Telegram ───────────────────────────────────

create or replace function bot_set_item_price(
  p_actor   uuid,
  p_item_id uuid,
  p_price   integer
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
  perform item_set_price(p_item_id, p_price);
end;
$$;

revoke all on function bot_set_item_price(uuid, uuid, integer) from public;
revoke all on function bot_set_item_price(uuid, uuid, integer) from authenticated;

comment on function bot_set_item_price(uuid, uuid, integer) is
  'Смена цены из Telegram. Правило одно на оба входа — item_set_price(); '
  'обёртка только называет действующее лицо.';
