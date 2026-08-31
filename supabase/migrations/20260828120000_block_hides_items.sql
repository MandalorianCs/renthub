-- ─────────────────────────────────────────────────────────────
-- Блокировка снимает объявления с публикации
--
-- Пробел, который видно только в сценарии: модератор блокирует человека за
-- чужие фото или за невозврат, тот больше не может выложить новое — а
-- старые объявления остаются в каталоге, и их продолжают бронировать.
-- Получается наказание, которого нет: витрина работает как прежде, а на
-- другом конце сделки человек, которому платформа уже не доверяет.
--
-- Решение простое: блокировка прячет активные объявления, разблокировка их
-- НЕ возвращает. Возврат — решение владельца, а не автоматики: за время
-- блокировки вещь могла быть продана, сломана или сдана иначе. Молча
-- вернуть её в витрину значит выставить на аренду то, чего, возможно, уже
-- нет. Отсюда и текст уведомления: объявления сняты, вернуть можно самому.
--
-- Существующие брони не трогаются. Заблокировать — не значит отменить
-- обязательства: вещь на руках у арендатора, депозит удержан, сделку надо
-- довести до конца. Иначе блокировка стала бы способом сорвать возврат.
-- ─────────────────────────────────────────────────────────────

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

  if p_user_id = auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: нельзя заблокировать самого себя'
      using errcode = '42501';
  end if;

  if p_blocked and exists (select 1 from users where id = p_user_id and is_moderator) then
    raise exception 'RENTHUB_FORBIDDEN: модератора нельзя заблокировать из приложения'
      using errcode = '42501';
  end if;

  update users
     set blocked_at = case when p_blocked then now() else null end,
         blocked_reason = case when p_blocked then p_reason else null end
   where id = p_user_id;

  if p_blocked then
    with hidden as (
      update items
         set status = 'hidden'
       where owner_id = p_user_id and status = 'active'
      returning 1
    )
    select count(*) into v_hidden from hidden;
  end if;

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
      else 'Вы снова можете сдавать и арендовать. Объявления остались скрытыми — '
           || 'верните в витрину те, что ещё актуальны.'
    end
  );
end;
$$;

comment on function set_user_blocked(uuid, boolean, text) is
  'Блокировка участника модератором: закрывает сдачу и аренду и снимает его '
  'активные объявления с публикации. Разблокировка объявления не возвращает — '
  'это решение владельца. Существующие брони не трогаются.';
