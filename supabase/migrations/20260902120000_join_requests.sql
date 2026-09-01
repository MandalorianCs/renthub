-- Человеку, у которого нет приглашения, есть куда нажать.
--
-- Дыра нашлась, когда на лендинг добавили точки входа под рекламу. Реклама
-- приводит незнакомого человека, он открывает витрину — она открыта всем,
-- — выбирает вещь, жмёт «Забронировать» и упирается в экран входа, где
-- пути «у меня нет приглашения» нет вовсе. Второй тупик рядом: бот на
-- незнакомый номер отвечает «напишите организатору», не говоря кому и как.
--
-- То есть до сих пор все кнопки вели в стену. Чинить это телефоном
-- организатора в подвале сайта — значит выложить чужой личный контакт и
-- получать заявки туда, где их некому считать.
--
-- Заявка кладётся в базу. Номер к этому моменту уже подтверждён самим
-- Telegram — тем же способом, что и у участников: кнопка «Поделиться
-- номером», а не набранный руками текст. Организатор видит список в
-- модерации и заводит аккаунт обычным scripts/invite.mjs.

create table join_requests (
  id                uuid primary key default gen_random_uuid(),
  phone             text not null,
  full_name         text,
  telegram_id       bigint,
  telegram_username text,
  -- Что человек написал о себе сам. Не обязательное: заставлять писать
  -- сочинение ради заявки — это и есть способ не получить ни одной.
  note              text,
  handled_at        timestamptz,
  created_at        timestamptz not null default now(),

  constraint join_requests_phone_check check (phone ~ '^\+7[0-9]{10}$'),
  constraint join_requests_note_check  check (note is null or length(note) between 2 and 300)
);

-- Один номер — одна открытая заявка. Без этого человек, нажавший кнопку
-- трижды, превращается в три строки, и список модерации становится
-- списком нетерпеливых, а не списком людей.
create unique index join_requests_open_idx on join_requests (phone)
  where handled_at is null;

create index join_requests_queue_idx on join_requests (created_at desc)
  where handled_at is null;

comment on table join_requests is
  'Заявки на участие в пилоте от людей без приглашения. Номер подтверждает '
  'Telegram кнопкой «Поделиться номером» — не введённый текст.';

alter table join_requests enable row level security;

-- Читает только модератор. Список заявок — это список чужих телефонов, и
-- открывать его вошедшему не за чем.
create policy join_requests_read_moderator on join_requests
  for select to authenticated
  using (exists (select 1 from users u where u.id = auth.uid() and u.is_moderator));

-- ── Приём заявки ──────────────────────────────────────────────
--
-- Через функцию, а не прямой insert сервисным ключом: правило «уже
-- участник — не заявка» должно жить в одном месте, иначе бот проверял бы
-- его сам и разошёлся бы с базой при первой же правке.

create or replace function submit_join_request(
  p_phone             text,
  p_full_name         text default null,
  p_telegram_id       bigint default null,
  p_telegram_username text default null,
  p_note              text default null
)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  v_phone text := regexp_replace(coalesce(p_phone, ''), '[^0-9+]', '', 'g');
  v_open  uuid;
begin
  if v_phone !~ '^\+7[0-9]{10}$' then
    raise exception 'RENTHUB_BAD_INPUT: номер должен быть в формате +7XXXXXXXXXX'
      using errcode = '22023';
  end if;

  -- Участнику заявка не нужна, и сказать об этом надо прямо: «заявка
  -- принята» человеку, у которого уже есть аккаунт, — это отправить его
  -- ждать того, что у него уже есть.
  if exists (select 1 from users where phone = v_phone) then
    return 'already_member';
  end if;

  select id into v_open from join_requests
   where phone = v_phone and handled_at is null;

  if v_open is not null then
    -- Повтор не создаёт вторую строку, но дописывает то, что человек
    -- добавил со второго раза: имя или пояснение.
    update join_requests
       set full_name         = coalesce(nullif(trim(p_full_name), ''), full_name),
           telegram_id       = coalesce(p_telegram_id, telegram_id),
           telegram_username = coalesce(nullif(trim(p_telegram_username), ''), telegram_username),
           note              = coalesce(nullif(trim(p_note), ''), note)
     where id = v_open;
    return 'already_waiting';
  end if;

  insert into join_requests (phone, full_name, telegram_id, telegram_username, note)
  values (v_phone,
          nullif(trim(p_full_name), ''),
          p_telegram_id,
          nullif(trim(p_telegram_username), ''),
          nullif(trim(p_note), ''));

  return 'accepted';
end;
$$;

comment on function submit_join_request(text, text, bigint, text, text) is
  'Заявка на участие. Возвращает accepted, already_waiting или '
  'already_member — три разных ответа, потому что человеку в чате нужно '
  'сказать три разные вещи.';

-- Вошедшему не нужна: у него уже есть аккаунт. Право остаётся у сервисного
-- ключа, которым ходит бот.
revoke all on function submit_join_request(text, text, bigint, text, text) from public;
revoke all on function submit_join_request(text, text, bigint, text, text) from authenticated;

-- ── Очередь для модератора ────────────────────────────────────

create or replace function join_requests_open()
returns table (
  id                uuid,
  phone             text,
  full_name         text,
  telegram_username text,
  note              text,
  created_at        timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform assert_moderator();

  return query
    select r.id, r.phone, r.full_name, r.telegram_username, r.note, r.created_at
      from join_requests r
     where r.handled_at is null
     order by r.created_at;
end;
$$;

revoke all on function join_requests_open() from public;
grant execute on function join_requests_open() to authenticated;

-- Закрыть заявку. Отдельным действием, а не автоматически при создании
-- аккаунта: приглашение выдаётся скриптом с сервисным ключом, и связывать
-- две несвязанные вещи ради экономии одного нажатия — это способ получить
-- очередь, которая расходится с реальностью.

create or replace function join_request_close(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_moderator();

  update join_requests set handled_at = now()
   where id = p_id and handled_at is null;

  if not found then
    raise exception 'RENTHUB_NOT_FOUND: заявка не найдена или уже закрыта'
      using errcode = '42501';
  end if;
end;
$$;

revoke all on function join_request_close(uuid) from public;
grant execute on function join_request_close(uuid) to authenticated;
