-- Верхнюю границу цены знал один путь записи из трёх.
--
-- 02.09.2026 в item_set_price() появилась проверка «больше миллиона —
-- проверьте, нет ли лишнего нуля», и причина у неё записана там же: цена с
-- лишним нулём превращает объявление в невидимое, а владелец узнаёт об этом
-- через неделю тишины и решает, что платформа не работает.
--
-- Причина верна для любого способа поставить цену. Проверка стояла в одном.
-- Измерено на стенде 03.09.2026, ролью владельца:
--
--   insert into items (... daily_price 30000000 ...)   → прошло
--   update items set daily_price = 99000000            → прошло
--   item_set_price(id, 30000000)                       → RENTHUB_BAD_INPUT
--
-- То есть создать можно было то, что нельзя установить, и починить свою же
-- опечатку правкой цены — тоже нельзя: функция отказывала на том самом
-- числе, которое уже лежало в строке.
--
-- Три пути ведут в items.daily_price:
--
--   create_item()          публикация из приложения и из бота
--   update items           форма правки объявления (политика items_update_own)
--   item_set_price()       «Изменить цену» в приложении и в чате
--
-- ── Почему проверка становится функцией ──────────────────────
--
-- Тем же приёмом, что assert_item_owner() 02.09: правило, которое понадобилось
-- второму месту, выносится, а не копируется. Скопированное правило расходится
-- на первой же правке порога — и разойдётся молча, потому что оба места
-- выглядят верными.
--
-- ── И почему сверх функции нужно ограничение таблицы ─────────
--
-- Форма правки объявления пишет в items напрямую: у items, в отличие от
-- bookings, UPDATE-политика для владельца есть и нужна — он правит описание,
-- фото и ориентир. Функция такой путь не сторожит. Ограничение сторожит любую
-- запись, включая ту, о которой мы забудем.
--
-- Тексты у ограничений английские и говорят про имя constraint, поэтому
-- работают оба рубежа: функция отвечает человеку по-русски там, где вызов идёт
-- через неё, а ограничение ловит остальное — его имя переведено в
-- humanizeError и в CONSTRAINT_MESSAGES бота.

-- ── Порог одним числом ────────────────────────────────────────
--
-- В app_settings он не кладётся намеренно. Настройки оттуда участвуют в
-- расчёте денег, и README отдельно разбирает, какие из них нельзя менять
-- одной строкой. Здесь другое: это не параметр бизнес-модели, а ловушка для
-- опечатки, и её значение не должно выглядеть как то, что кто-то станет
-- крутить. Самая дорогая позиция витрины — строительные леса — стоит 5 000 ₸
-- в сутки; миллион не граница рынка, а граница правдоподобия.

create or replace function assert_item_price(p_price integer)
returns void
language plpgsql
immutable
as $$
begin
  if p_price is null or p_price <= 0 then
    raise exception 'RENTHUB_BAD_INPUT: цена за сутки должна быть больше нуля'
      using errcode = '22023';
  end if;

  if p_price > 1000000 then
    raise exception 'RENTHUB_BAD_INPUT: цена за сутки больше миллиона — проверьте, нет ли лишнего нуля'
      using errcode = '22023';
  end if;
end;
$$;

comment on function assert_item_price(integer) is
  'Единственная проверка цены за сутки для функций, которые её пишут. '
  'Нижняя граница дублирует ограничение таблицы ради русского текста, '
  'верхняя ловит лишний ноль: объявление с ним не бронируют, а владелец '
  'узнаёт об этом тишиной.';

revoke all on function assert_item_price(integer) from public;
revoke all on function assert_item_price(integer) from anon, authenticated;

-- ── Смена цены: та же проверка, вынесенная наружу ─────────────
--
-- Тело повторено целиком: create or replace иначе не умеет. Изменились две
-- проверки — вместо них вызов.

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
  perform assert_item_price(p_price);

  -- Уже оформленные брони не дешевеют и не дорожают: в bookings лежит
  -- daily_price_snapshot, снятый в момент заявки. Новая цена действует со
  -- следующей брони, и это правило таблицы, а не забота этой функции.
  update items set daily_price = p_price where id = p_item_id;
end;
$$;

-- ── Публикация: та же проверка, которой здесь не было ─────────

create or replace function create_item(
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

  -- Цена проверяется до вставки, а не ограничением после: отказ ограничения
  -- приходит по-английски и называет имя constraint, а на этом шаге человек
  -- уже прошёл форму или шесть шагов диалога в чате.
  perform assert_item_price(p_daily_price);

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

-- ── Третий путь: прямая запись в таблицу ─────────────────────
--
-- Имя ограничения задано явно, а не оставлено Postgres: его переводит
-- humanizeError в приложении и CONSTRAINT_MESSAGES в боте, и автоимя,
-- зависящее от порядка колонок, для этого не годится.

alter table items add constraint items_daily_price_max
  check (daily_price <= 1000000);

comment on constraint items_daily_price_max on items is
  'Лишний ноль в цене. Не граница рынка, а граница правдоподобия: '
  'объявление с такой ценой никто не забронирует, а владелец узнает об '
  'этом только тишиной. Сторожит путь, которого не видит assert_item_price() '
  '— прямой update из формы правки объявления.';
