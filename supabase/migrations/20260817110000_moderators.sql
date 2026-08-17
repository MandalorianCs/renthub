-- Модераторы и закрытие дыры в разрешении споров.
--
-- resolve_dispute_manually() не проверяла вызывающего вообще. Функция
-- security definer, то есть обходит RLS, а PostgREST открывает публичные
-- функции всем авторизованным. Значит любой вошедший мог разрешить любой
-- спор — включая спор против себя, поставив выплату в ноль.
--
-- Комментарий в коде утверждал, что функция «вызывается сервисным ключом,
-- не из клиентского приложения». Но это описание намерения, а не защита:
-- ключ у клиента другой, а функция открыта обоим.

alter table users add column is_moderator boolean not null default false;

comment on column users.is_moderator is
  'Право разрешать споры выше порога авторешения. Назначается только через '
  'сервисный ключ (scripts/moderator.mjs) — из приложения выдать его нельзя.';

-- Роль нельзя выдать себе самому. Политика users_update_own разрешает
-- менять свою строку целиком, и без этого триггера любой пользователь
-- поставил бы себе is_moderator = true одним запросом.
--
-- Условие на auth.uid(): у сервисного ключа сессии нет, поэтому скрипт
-- назначения роль менять может, а любой вошедший — нет.
create or replace function users_role_guard()
returns trigger
language plpgsql
as $$
begin
  if new.is_moderator is distinct from old.is_moderator and auth.uid() is not null then
    raise exception 'RENTHUB_FORBIDDEN: роль модератора выдаётся только сервисным ключом'
      using errcode = '42501';
  end if;
  return new;
end;
$$;

create trigger users_protect_moderator_role
  before update on users
  for each row execute function users_role_guard();

-- ── Проверка права ────────────────────────────────────────────

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
    raise exception 'RENTHUB_FORBIDDEN: разрешать споры может только модератор'
      using errcode = '42501';
  end if;
end;
$$;

-- ── Разрешение спора — теперь с проверкой ─────────────────────

create or replace function resolve_dispute_manually(
  p_dispute_id    uuid,
  p_payout_amount integer,
  p_note          text default null,
  p_finalize      boolean default true
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_d disputes%rowtype;
  v_b bookings%rowtype;
begin
  perform assert_moderator();

  select * into v_d from disputes where id = p_dispute_id for update;

  if v_d.id is null then
    raise exception 'RENTHUB_DISPUTE_NOT_FOUND';
  end if;

  select * into v_b from bookings where id = v_d.booking_id for update;

  if p_payout_amount > v_b.deposit_snapshot then
    raise exception 'RENTHUB_OVER_DEPOSIT: нельзя выплатить больше депозита (% ₸)', v_b.deposit_snapshot;
  end if;

  if p_payout_amount < 0 then
    raise exception 'RENTHUB_BAD_AMOUNT: выплата не может быть отрицательной';
  end if;

  update disputes
     set resolution_status = 'resolved',
         payout_amount     = p_payout_amount,
         resolution_note   = p_note,
         resolved_at       = now()
   where id = p_dispute_id
  returning * into v_d;

  if p_finalize then
    perform settle_booking(v_d.booking_id);
  end if;

  return v_d;
end;
$$;

-- ── Модератор должен видеть то, что разбирает ─────────────────

create policy disputes_read_moderator on disputes
  for select to authenticated
  using (exists (select 1 from users u where u.id = auth.uid() and u.is_moderator));

create policy bookings_read_moderator on bookings
  for select to authenticated
  using (exists (select 1 from users u where u.id = auth.uid() and u.is_moderator));
