-- Заявка и появившийся аккаунт связываются сами.
--
-- Бот, приняв заявку, обещает: «организатор заведёт аккаунт, и вы получите
-- сообщение сюда же». Держать это обещание было некому — заявка и будущий
-- участник не связаны ничем, кроме номера, а номер никто не сверял.
--
-- Обещание в интерфейсе, которое ничего не выполняет, хуже отсутствия
-- обещания: человек ждёт и решает, что про него забыли.
--
-- Связать их можно ровно по номеру, и это надёжно: в заявке он не набран
-- руками, а пришёл от Telegram кнопкой «Поделиться номером», и бот
-- проверил, что контакт принадлежит отправителю. То есть пара
-- «номер ↔ telegram_id» подтверждена тем же способом, что и при обычной
-- привязке, — просто раньше по времени.
--
-- Что происходит, когда организатор заводит аккаунт скриптом invite.mjs:
--
--   1. привязка Telegram переносится из заявки — человеку не нужно снова
--      жать «Поделиться номером», а бот получает адрес для доставки;
--   2. заявка закрывается — очередь модерации не показывает сделанное;
--   3. человек получает сообщение в тот же чат, где оставлял заявку.

create or replace function link_join_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_req join_requests%rowtype;
begin
  select * into v_req from join_requests
   where phone = new.phone and handled_at is null
   limit 1;

  if v_req.id is null then
    return new;
  end if;

  -- Привязка переносится, только если чат ещё не занят другим аккаунтом:
  -- telegram_id уникален, и слепой перенос уронил бы создание участника
  -- ошибкой базы вместо понятного отказа. Такое бывает, когда человек
  -- оставил заявку с одного номера, а приглашение получил на другой.
  if v_req.telegram_id is not null
     and not exists (select 1 from users where telegram_id = v_req.telegram_id)
  then
    -- Запись идёт из триггера, поэтому users_role_guard пропускает её по
    -- pg_trigger_depth() > 1 — ровно тот случай, ради которого проверка
    -- глубины там и стоит.
    update users
       set telegram_id       = v_req.telegram_id,
           telegram_username = coalesce(v_req.telegram_username, telegram_username)
     where id = new.id;
  end if;

  update join_requests set handled_at = now() where id = v_req.id;

  insert into notifications (user_id, type, title, body)
  values (
    new.id,
    'invite_ready',
    'Аккаунт готов',
    'Заявка одобрена, участник пилота создан. Пароль пришлёт организатор — '
    || 'он же выдал приглашение. Витрина и сделки: '
    || 'https://mandaloriancs.github.io/renthub/app/'
  );

  return new;
end;
$$;

comment on function link_join_request() is
  'Переносит привязку Telegram из заявки в новый аккаунт, закрывает заявку '
  'и сообщает человеку. Связь по номеру надёжна: в заявке он подтверждён '
  'самим Telegram, а не введён руками.';

-- after insert: уведомление ссылается на users.id, и до появления строки
-- вставить его нельзя.
create trigger users_link_join_request
  after insert on users
  for each row execute function link_join_request();
