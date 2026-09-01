-- Решение модератора нельзя отменить нажатием владельца.
--
-- Дыра в перегруженном значении. У item_status два состояния, active и
-- hidden, и hidden означает сразу две разные вещи:
--
--   • владелец поставил объявление на паузу — уехал, инструмент занят;
--   • модератор снял объявление с публикации — опасная вещь, обман, жалобы.
--
-- Состояния неразличимы, значит неразличимы и права на выход из них.
-- Политика items_update_own разрешает владельцу менять свою строку целиком,
-- и в приложении это один значок глаза в «Моих вещах»: модератор снял —
-- владелец вернул, и так по кругу. Модератор об этом даже не узнает.
--
-- Здесь появляется отдельная отметка. Не новое значение enum: миграции
-- Supabase идут в транзакции, а значение, добавленное через
-- `alter type ... add value`, в этой же транзакции использовать нельзя —
-- пришлось бы делить на две миграции. Отдельная колонка обходит ловушку и
-- вдобавок помнит, КОГДА и ПОЧЕМУ, а этого enum не умеет вовсе.

alter table items add column moderated_at     timestamptz;
alter table items add column moderated_reason text;

comment on column items.moderated_at is
  'Снято модератором. Пока отметка стоит, владелец не может вернуть '
  'объявление в каталог; снимает её только moderator_restore_item().';

comment on column items.moderated_reason is
  'Причина, показанная владельцу. Дублирует текст уведомления намеренно: '
  'уведомление можно пролистать, а карточка объявления остаётся.';

-- Индекс под очередь модерации: снятых объявлений мало, и частичный
-- индекс не платит за остальные строки.
create index items_moderated_idx on items (moderated_at desc)
  where moderated_at is not null;

-- ── Сторож ────────────────────────────────────────────────────
--
-- Проверка встраивается в существующий триггер items_verify_owner, а не
-- вешается вторым: assert_verified() уже стоит перед каждой записью в
-- items и из приложения, и из бота, и это единственная точка, которую
-- нельзя обойти. Второй триггер добавил бы ещё одно место, где правило
-- живёт, — ровно ту болезнь, которую эта миграция лечит.
--
-- Два условия, на которых сторож молчит, повторяют разбор из
-- 20260901150000_lock_profile_fields.sql:
--
--   auth.uid() is null      — сервисный ключ и миграции: у них нет сессии,
--                             и запрещать им нечего;
--   renthub.system_write    — функция модератора, которая как раз и ставит
--                             отметку; без флага она запретила бы сама себе.
--
-- pg_trigger_depth() здесь не нужен: в items никто не пишет из триггеров.

create or replace function items_before_write()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_verified(new.owner_id, 'Создание объявления');
  new.updated_at := now();

  if tg_op = 'UPDATE'
     and auth.uid() is not null
     and coalesce(current_setting('renthub.system_write', true), '') <> 'on'
  then
    -- Саму отметку владелец не трогает. Без этой строки защита была бы
    -- декоративной: обойти запрет «вернуть в каталог» можно было бы,
    -- обнулив moderated_at тем же update — политика разрешает менять
    -- строку целиком, а не отдельные поля.
    if new.moderated_at is distinct from old.moderated_at
       or new.moderated_reason is distinct from old.moderated_reason
    then
      raise exception
        'RENTHUB_FORBIDDEN: отметку модератора снимает только модератор'
        using errcode = '42501';
    end if;

    -- Пока отметка стоит, в каталог нельзя. Всё остальное можно: править
    -- описание, цену, фото — именно этим владелец и приводит объявление в
    -- порядок, чтобы модератор снял ограничение. Запрет на правку
    -- превратил бы снятие в тупик.
    if old.moderated_at is not null and new.status = 'active' then
      raise exception
        'RENTHUB_MODERATED: объявление снято модератором — вернуть его в '
        'каталог может только модератор'
        using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

-- ── Модератор ставит отметку ──────────────────────────────────
--
-- Тело повторено целиком: create or replace иначе не умеет. Изменились
-- две строки — set_config и добавленные поля в update.

create or replace function moderator_hide_item(
  p_item_id uuid,
  p_reason  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_title text;
begin
  perform assert_moderator();

  select owner_id, title into v_owner, v_title from items where id = p_item_id;
  if v_owner is null then
    raise exception 'RENTHUB_NOT_FOUND: объявление не найдено' using errcode = '42501';
  end if;

  -- Модератор работает в своей сессии, и auth.uid() у него есть. Без флага
  -- сторож выше запретил бы ему ставить отметку — ту самую, ради которой
  -- функцию и зовут.
  perform set_config('renthub.system_write', 'on', true);

  update items
     set status           = 'hidden',
         moderated_at     = now(),
         moderated_reason = p_reason
   where id = p_item_id;

  insert into notifications (user_id, type, title, body)
  values (
    v_owner,
    'item_hidden',
    'Объявление снято с публикации',
    coalesce(p_reason, 'Решение модератора RentHUB.') || ' Объявление: ' || v_title
  );
end;
$$;

comment on function moderator_hide_item(uuid, text) is
  'Снять объявление с публикации решением модератора. Ставит отметку, '
  'которую владелец снять не может; вернуть в каталог — '
  'moderator_restore_item().';

-- ── Модератор снимает отметку ─────────────────────────────────
--
-- Обратный ход нужен не для симметрии. Без него снятие с публикации —
-- приговор без обжалования: владелец исправил описание, добавил фото, а
-- вернуться некуда. Модерация без пути назад превращается в удаление.
--
-- Статус намеренно остаётся hidden. Снятие ограничения и публикация —
-- разные решения и принимают их разные люди: модератор говорит «теперь
-- можно», владелец решает, хочет ли он ещё сдавать эту вещь. Публикация
-- чужой вещи от лица модератора была бы действием за человека.

create or replace function moderator_restore_item(
  p_item_id uuid,
  p_note    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_owner uuid;
  v_title text;
  v_mark  timestamptz;
begin
  perform assert_moderator();

  select owner_id, title, moderated_at
    into v_owner, v_title, v_mark
    from items where id = p_item_id;

  if v_owner is null then
    raise exception 'RENTHUB_NOT_FOUND: объявление не найдено' using errcode = '42501';
  end if;

  -- Молча ничего не делать здесь хуже, чем сказать. Модератор нажал
  -- «снять ограничение» — значит он видит его в списке, и «ничего не
  -- произошло» он прочитает как сбой, а не как «уже снято».
  if v_mark is null then
    raise exception 'RENTHUB_BAD_STATE: на объявлении нет ограничения'
      using errcode = '42501';
  end if;

  perform set_config('renthub.system_write', 'on', true);

  update items
     set moderated_at     = null,
         moderated_reason = null
   where id = p_item_id;

  insert into notifications (user_id, type, title, body)
  values (
    v_owner,
    'item_restored',
    'Ограничение снято',
    coalesce(p_note, 'Модератор снял ограничение.')
      || ' Объявление: ' || v_title
      || '. Вернуть его в каталог можно в «Моих вещах».'
  );
end;
$$;

comment on function moderator_restore_item(uuid, text) is
  'Снять ограничение модератора. Объявление остаётся скрытым: публикует '
  'его владелец, и это его решение, а не модератора.';

revoke all on function moderator_restore_item(uuid, text) from public;
grant execute on function moderator_restore_item(uuid, text) to authenticated;

-- ── Попутно: отказ перестал врать про споры ───────────────────
--
-- Стенд поймал это на новой проверке. Владелец пытался снять ограничение
-- со своего объявления и получил «разрешать споры может только модератор».
-- Про споры он ничего не делал.
--
-- Причина историческая: когда assert_moderator() писали, вызывающий был
-- один — разрешение спора. Сейчас их девять: сводка модерации, список
-- участников, снятие объявления, сообщение участнику, снятие ограничения
-- и другие. Восемь из девяти отвечали текстом про чужое действие.
--
-- Сообщение делается общим, а не параметром: добавить аргумент нельзя без
-- drop function, а каждому вызывающему пришлось бы переписать тело целиком
-- ради одной строки текста. Общая формулировка верна для всех девяти —
-- это лучше, чем точная для одного и ложная для восьми.

create or replace function assert_moderator()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  -- Вызов без сессии — это сервисный ключ или планировщик: у них право есть
  -- по определению, иначе автоматика не смогла бы закрывать сделки.
  if auth.uid() is null then
    return;
  end if;

  if not exists (select 1 from users where id = auth.uid() and is_moderator) then
    raise exception 'RENTHUB_FORBIDDEN: это действие доступно только модератору'
      using errcode = '42501';
  end if;
end;
$$;
