-- Телефон в профиле хранится в одном формате — с плюсом.
--
-- GoTrue хранит номер без плюса: 77758663588. Триггер переносил его в
-- public.users как есть, а всё остальное — приглашения, поиск, интерфейс —
-- работает с +77758663588. Поиск по одному формату молча не находил
-- существующего пользователя, и выглядело это как «человека нет в базе»
-- сразу после того, как его туда добавили.
--
-- Формат выбран E.164 (с плюсом), потому что именно он однозначен: 8 705…
-- и +7 705… — один номер, и без ведущего плюса «77758663588» невозможно
-- отличить от локальной записи с восьмёркой без разбора длины и кода.

-- ── Существующие профили ──────────────────────────────────────
-- Трогаем только те, где лежат одни цифры. В колонке может оказаться email
-- или uuid: триггер использует их как запасной вариант, когда телефона нет,
-- и приписывать плюс к почте было бы порчей данных.

update users
   set phone = '+' || phone
 where phone ~ '^[0-9]{6,15}$';

-- ── Регистрация ───────────────────────────────────────────────

create or replace function handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.users (id, phone, full_name, verified_at)
  values (
    new.id,
    case
      when coalesce(new.phone, '') <> '' then '+' || ltrim(new.phone, '+')
      else coalesce(new.email, new.id::text)
    end,
    new.raw_user_meta_data ->> 'full_name',
    new.phone_confirmed_at
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

-- ── Подтверждение номера ──────────────────────────────────────

create or replace function sync_phone_verification()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.users
     set verified_at = new.phone_confirmed_at,
         phone       = case
                         when coalesce(new.phone, '') <> '' then '+' || ltrim(new.phone, '+')
                         else phone
                       end
   where id = new.id
     and (verified_at is distinct from new.phone_confirmed_at
          or phone is distinct from '+' || ltrim(coalesce(new.phone, ''), '+'));

  return new;
end;
$$;

comment on column users.phone is
  'Номер в формате E.164 с ведущим плюсом. GoTrue хранит его без плюса — '
  'триггеры приводят к единому виду, иначе поиск по номеру не находит '
  'пользователя, который в базе есть.';
