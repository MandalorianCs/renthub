-- Человеку есть кому написать, когда что-то пошло не так.
--
-- Пробел нашёлся простым вопросом: что будет, если участник напишет боту
-- «не могу вернуть вещь, что делать». Ответ — ничего. Обработчика на
-- произвольный текст в боте не было вовсе, и сообщение уходило в пустоту.
--
-- Это худший из возможных исходов и прямое нарушение того, чем проект
-- живёт: молчание в ответ читается как поломка. Человек в затруднении
-- решает, что платформа мертва, и уходит — вместе со своей сделкой и
-- депозитом, который на ней висит.
--
-- Канала поддержки не было и в приложении. Телефон организатора в подвале
-- — не решение: это чужой личный контакт, и обращения попадают туда, где
-- их некому считать.
--
-- Здесь обращение кладётся в базу, а ответ уходит обратно тем же ботом
-- через существующий moderator_notify(). Петля замыкается: человек написал
-- — модератор увидел — модератор ответил — ответ пришёл в тот же чат.

create table support_messages (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  text       text not null,
  -- Отметка «разобрано» ставится модератором вручную. Автоматически по
  -- факту ответа — нельзя: ответ может быть уточняющим вопросом, и
  -- закрывать обращение после него значит терять разговор на середине.
  handled_at timestamptz,
  created_at timestamptz not null default now(),

  constraint support_messages_text_check check (length(btrim(text)) between 2 and 2000)
);

create index support_messages_open_idx on support_messages (created_at desc)
  where handled_at is null;

comment on table support_messages is
  'Обращения участников из Telegram. Ответ уходит обратно ботом через '
  'moderator_notify() — отдельного канала связи заводить не нужно.';

alter table support_messages enable row level security;

-- Читает только модератор: чужие обращения — это чужие проблемы, и
-- открывать их вошедшему не за чем.
create policy support_read_moderator on support_messages
  for select to authenticated
  using (exists (select 1 from users u where u.id = auth.uid() and u.is_moderator));

-- Своё обращение человек видит: иначе «я писал» превращается в спор без
-- доказательств.
create policy support_read_own on support_messages
  for select to authenticated
  using (user_id = auth.uid());

-- ── Приём обращения ───────────────────────────────────────────

create or replace function submit_support_message(p_actor uuid, p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_open integer;
begin
  perform bot_actor_ok(p_actor);

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

comment on function submit_support_message(uuid, text) is
  'Обращение участника из Telegram. Предел в три открытых на человека — '
  'чтобы очередь модерации не превращалась в переписку с одним.';

revoke all on function submit_support_message(uuid, text) from public;
revoke all on function submit_support_message(uuid, text) from authenticated;

-- ── Очередь для модератора ────────────────────────────────────

create or replace function support_open()
returns table (
  id         uuid,
  user_id    uuid,
  full_name  text,
  telegram   boolean,
  text       text,
  created_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform assert_moderator();

  return query
    select m.id, m.user_id, u.full_name, u.telegram_id is not null, m.text, m.created_at
      from support_messages m
      join users u on u.id = m.user_id
     where m.handled_at is null
     order by m.created_at;
end;
$$;

revoke all on function support_open() from public;
grant execute on function support_open() to authenticated;

create or replace function support_close(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_moderator();

  update support_messages set handled_at = now()
   where id = p_id and handled_at is null;

  if not found then
    raise exception 'RENTHUB_NOT_FOUND: обращение не найдено или уже закрыто'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function support_close(uuid) from public;
grant execute on function support_close(uuid) to authenticated;
