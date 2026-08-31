-- ─────────────────────────────────────────────────────────────
-- Блокировка падала на собственном же запрете
--
-- Миграция 20260828120000 научила set_user_blocked() снимать объявления с
-- публикации. Порядок в ней был такой: сначала проставить blocked_at в
-- users, потом `update items set status = 'hidden'`.
--
-- Между этими двумя шагами стоит триггер items_verify_owner: он висит на
-- `before insert or update` и зовёт assert_verified(new.owner_id). А
-- assert_verified с миграции 20260825100000 проверяет ещё и blocked_at —
-- и к моменту update-а он уже проставлен. Функция упиралась в собственный
-- запрет и падала с RENTHUB_BLOCKED.
--
-- То есть блокировка не работала ровно тогда, когда она нужна: у человека
-- есть активные объявления. Без объявлений `update` не задевал ни одной
-- строки, триггер не срабатывал, и ветка проходила — поэтому проверка на
-- живой базе ничего не заметила. Стенд поймал это с первого прогона.
--
-- Починка — порядок: сначала снять объявления, пока человек ещё не
-- заблокирован, потом проставить отметку. Порядок здесь не стилистика, а
-- условие работоспособности, и переставлять его обратно нельзя.
--
-- Почему не тронут триггер. Соблазн — научить items_before_write()
-- пропускать переход в 'hidden'. Но тогда заблокированный смог бы сам
-- прятать и возвращать свои объявления: правило «заблокированный не
-- трогает витрину» держится именно на этом триггере. Дешевле переставить
-- две строки в одной функции, чем ослабить проверку, через которую
-- проходит любая запись объявлений.
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

  -- Объявления снимаются ПЕРВЫМИ — до отметки о блокировке. Иначе триггер
  -- items_verify_owner увидит уже заблокированного владельца и не даст
  -- тронуть его же строки. Транзакция одна, так что промежуточное
  -- состояние снаружи не видно.
  if p_blocked then
    with hidden as (
      update items
         set status = 'hidden'
       where owner_id = p_user_id and status = 'active'
      returning 1
    )
    select count(*) into v_hidden from hidden;
  end if;

  update users
     set blocked_at = case when p_blocked then now() else null end,
         blocked_reason = case when p_blocked then p_reason else null end
   where id = p_user_id;

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
      -- Про скрытые объявления говорим только тем, у кого они есть: иначе
      -- человек ищет в профиле то, чего у него не было.
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

comment on function set_user_blocked(uuid, boolean, text) is
  'Блокировка участника модератором: снимает его активные объявления с '
  'публикации и закрывает сдачу и аренду. Объявления снимаются ДО отметки '
  'о блокировке — после неё их не пустит триггер items_verify_owner. '
  'Разблокировка объявления не возвращает: это решение владельца.';
