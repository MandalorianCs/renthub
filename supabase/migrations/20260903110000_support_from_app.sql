-- Написать организатору можно и из приложения, не только из Telegram.
--
-- 02.09.2026 канал поддержки завели, но наполовину. Миграция
-- 20260902190000_support.sql прямо назвала обе дыры — «обработчика на
-- произвольный текст в боте не было вовсе» и «канала поддержки не было и в
-- приложении», — а закрыла первую: submit_support_message() требует
-- привязанного Telegram и отозвана у authenticated. Из приложения написать
-- нельзя.
--
-- Половина хуже, чем кажется, потому что приложение — главный вход. Ссылку
-- на продукт дают на него, витрина открыта в нём, и человек, у которого
-- что-то пошло не так, сидит именно там. Ответ ему уже есть куда положить:
-- moderator_notify() пишет в notifications, а экран уведомлений их
-- показывает. Экран модерации тоже готов — у обращения от человека без
-- Telegram он подписывает «ответ будет ждать в приложении». Не хватало
-- ровно одного звена: двери со стороны человека.
--
-- Правило приёма при этом остаётся одно. Длина текста и предел в три
-- открытых обращения переезжают в support_add(), которую зовут обе двери.
-- Записанное дважды однажды разойдётся: предел, поднятый для бота и
-- забытый для приложения, означал бы, что очередь модерации всё-таки
-- топится — просто из другого окна.

-- ── Общее правило приёма ──────────────────────────────────────
--
-- Приватная: у неё нет проверки, кто просит, — её делает та дверь, что
-- зовёт. Отдать такую наружу значит отдать право писать от чужого имени.

create or replace function support_add(p_actor uuid, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open integer;
begin
  if length(btrim(coalesce(p_text, ''))) < 2 then
    raise exception 'RENTHUB_BAD_INPUT: напишите, что случилось — хотя бы пару слов'
      using errcode = '22023';
  end if;

  -- Три открытых обращения на человека — предел. Не от недоверия: без
  -- предела один расстроенный участник за минуту превращает очередь
  -- модерации в свою переписку, и остальные обращения тонут.
  select count(*) into v_open
    from support_messages
   where user_id = p_actor and handled_at is null;

  if v_open >= 3 then
    raise exception
      'RENTHUB_BAD_STATE: у вас уже три обращения без ответа — дождитесь ответа на них'
      using errcode = '22023';
  end if;

  insert into support_messages (user_id, text)
  values (p_actor, btrim(p_text));
end;
$$;

comment on function support_add(uuid, text) is
  'Общее правило приёма обращения для обеих дверей — приложения и бота. '
  'Кто просит, не проверяет: это дело вызывающей функции. Наружу не выдана.';

revoke all on function support_add(uuid, text) from public;
revoke execute on function support_add(uuid, text) from anon, authenticated;

-- ── Дверь бота ────────────────────────────────────────────────
--
-- Подпись прежняя: бот запускается руками и живёт отдельным процессом.
-- Сменить её здесь значит сломать уже запущенного бота в тот момент, когда
-- миграция доедет до живой базы, — до перезапуска, о котором никто не
-- просил.

create or replace function submit_support_message(p_actor uuid, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform support_add(p_actor, p_text);
end;
$$;

comment on function submit_support_message(uuid, text) is
  'Обращение участника из Telegram. Правило приёма общее с приложением — '
  'support_add(). Только для сервисного ключа.';

revoke all on function submit_support_message(uuid, text) from public;
revoke execute on function submit_support_message(uuid, text) from anon, authenticated;

-- ── Дверь приложения ──────────────────────────────────────────

create or replace function support_submit(p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  -- Аноним отсекается здесь, а не внешним ключом. Ошибка внешнего ключа
  -- пришла бы английской строкой про support_messages_user_id_fkey —
  -- человек прочитал бы её как поломку, хотя ему просто надо войти.
  if v_user is null then
    raise exception 'RENTHUB_FORBIDDEN: нужно войти, чтобы написать организатору'
      using errcode = '42501';
  end if;

  -- Верификации и блокировки здесь намеренно нет. Человек, застрявший на
  -- подтверждении номера, и человек, которого заблокировали по ошибке, —
  -- ровно те, кому написать нужнее всего. Закрыть им эту дверь значит
  -- оставить их без единственного способа возразить.
  perform support_add(v_user, p_text);
end;
$$;

comment on function support_submit(text) is
  'Обращение участника из приложения. Верификацию и блокировку не проверяет: '
  'застрявшему и заблокированному написать нужнее всего.';

revoke all on function support_submit(text) from public;
grant execute on function support_submit(text) to authenticated;
