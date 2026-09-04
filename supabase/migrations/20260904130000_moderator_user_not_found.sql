-- Модератор, назвавший удалённого участника, видел ошибку внешнего ключа.
--
-- Тот же класс, что в 20260904120000, только на другом конце экрана.
-- Измерено 04.09.2026 от имени модератора, с идентификатором, которого нет:
--
--   set_user_blocked   insert or update on table "notifications" violates
--                      foreign key constraint ...
--   moderator_notify   то же
--
-- Восемь функций из десяти на том же наборе отвечают своим текстом
-- («объявление не найдено», «заявка не найдена или уже закрыта») — образец
-- в проекте есть, до этих двух он не дошёл.
--
-- Когда это случается: экран модерации держит список людей, загруженный
-- минуту назад. Участника удалили, модератор нажимает «Заблокировать» — и
-- читает английский текст с именами таблиц вместо «участник не найден».
--
-- ── Почему проверка стоит после assert_moderator() ───────────
--
-- Порядок здесь имеет значение: сначала «есть ли право», потом «есть ли
-- объект». Обратный порядок превратил бы функцию в способ узнать, заведён
-- ли участник с таким идентификатором, — для того, у кого прав нет.
--
-- Тела извлечены из последних миграций, где функции определены, и
-- отличаются ровно вставленной проверкой.

-- ── set_user_blocked ──────────────────────────────
-- Тело перенесено из 20260902090000_system_write_scope.sql без изменений, кроме проверки.

create or replace function set_user_blocked(
  p_user_id uuid,
  p_blocked boolean,
  p_reason  text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_hidden integer := 0;
begin
  perform assert_moderator();

  if not exists (select 1 from users where id = p_user_id) then
    raise exception 'RENTHUB_NOT_FOUND: участник не найден' using errcode = '42501';
  end if;

  if p_user_id = auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: нельзя заблокировать самого себя'
      using errcode = '42501';
  end if;

  if p_blocked and exists (select 1 from users where id = p_user_id and is_moderator) then
    raise exception 'RENTHUB_FORBIDDEN: модератора нельзя заблокировать из приложения'
      using errcode = '42501';
  end if;

  -- Объявления снимаются ПЕРВЫМИ — до отметки о блокировке. Иначе триггер
  -- items_verify_owner увидит уже заблокированного владельца и не даст
  -- тронуть его же строки.
  if p_blocked then
    with hidden as (
      update items
         set status = 'hidden'
       where owner_id = p_user_id and status = 'active'
      returning 1
    )
    select count(*) into v_hidden from hidden;
  end if;

  perform set_config('renthub.system_write', 'on', true);

  update users
     set blocked_at = case when p_blocked then now() else null end,
         blocked_reason = case when p_blocked then p_reason else null end
   where id = p_user_id;

  perform set_config('renthub.system_write', '', true);

  insert into notifications (user_id, type, title, body)
  values (
    p_user_id,
    case when p_blocked then 'blocked' else 'unblocked' end,
    case when p_blocked then 'Доступ ограничен' else 'Доступ восстановлен' end,
    case
      when p_blocked then
        coalesce(p_reason, 'Решение модератора RentHUB. Ответить можно организатору пилота.')
        || case
             when v_hidden > 0
               then ' Ваши объявления сняты с публикации: ' || v_hidden || '.'
             else ''
           end
      else 'Вы снова можете сдавать и арендовать.'
           || case
                when exists (
                  select 1 from items
                   where owner_id = p_user_id and status = 'hidden'
                )
                  then ' Объявления остались скрытыми — верните в витрину те, что ещё актуальны.'
                else ''
              end
    end
  );
end;
$$;

-- ── moderator_notify ──────────────────────────────
-- Тело перенесено из 20260825100000_moderation_actions.sql без изменений, кроме проверки.

create or replace function moderator_notify(
  p_user_id uuid,
  p_title   text,
  p_body    text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_moderator();

  if not exists (select 1 from users where id = p_user_id) then
    raise exception 'RENTHUB_NOT_FOUND: участник не найден' using errcode = '42501';
  end if;

  if length(trim(coalesce(p_title, ''))) < 3 then
    raise exception 'RENTHUB_BAD_INPUT: у сообщения должен быть заголовок'
      using errcode = '22023';
  end if;

  insert into notifications (user_id, type, title, body)
  values (p_user_id, 'moderator_message', trim(p_title), nullif(trim(coalesce(p_body, '')), ''));
end;
$$;
