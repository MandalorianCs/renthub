-- Заглушка платформенных объектов Supabase для локального Postgres.
--
-- Это НЕ часть продакшн-схемы: на реальном проекте всё, что здесь создаётся,
-- уже существует до того, как вы открываете SQL Editor. Файл нужен ровно
-- затем, чтобы миграции 0001–0003 можно было прогнать на голом postgres:16
-- и увидеть настоящие ошибки в своих триггерах, а не в отсутствии auth.uid().
--
-- Что подделываем (и почему это честно):
--   • схема auth + таблица auth.users — колонки те же, что читают наши триггеры
--   • auth.uid() — дословно как у Supabase, читает request.jwt.claims
--   • схема storage + buckets/objects + storage.foldername()
--   • роли anon/authenticated/service_role и default privileges на public
--
-- Чего заглушка НЕ проверяет (проверять придётся на живом проекте):
--   • право postgres создавать триггеры на auth.users (владелец там
--     supabase_auth_admin) и политики на storage.objects
--   • реальную выдачу JWT, PostgREST, rate limits, SMS-провайдера

-- ── Роли ──────────────────────────────────────────────────────
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'anon') then
    create role anon nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'authenticated') then
    create role authenticated nologin noinherit;
  end if;
  if not exists (select 1 from pg_roles where rolname = 'service_role') then
    create role service_role nologin noinherit bypassrls;
  end if;
end $$;

grant usage on schema public to anon, authenticated, service_role;

-- Supabase настраивает это при создании проекта. Без этих строк тесты RLS
-- падают на «permission denied for table», и легко решить, что виноваты
-- политики, хотя виноваты гранты.
alter default privileges in schema public grant all on tables    to anon, authenticated, service_role;
alter default privileges in schema public grant all on functions to anon, authenticated, service_role;
alter default privileges in schema public grant all on sequences to anon, authenticated, service_role;

-- ── Схема auth ────────────────────────────────────────────────

create schema if not exists auth;
grant usage on schema auth to anon, authenticated, service_role;

create table if not exists auth.users (
  id                 uuid primary key default gen_random_uuid(),
  phone              text unique,
  email              text unique,
  phone_confirmed_at timestamptz,
  email_confirmed_at timestamptz,
  raw_user_meta_data jsonb not null default '{}',
  created_at         timestamptz not null default now()
);

-- Дословно как в Supabase: сначала плоская claim, потом весь JSON.
create or replace function auth.uid() returns uuid
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

create or replace function auth.role() returns text
language sql stable
as $$
  select coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

create or replace function auth.jwt() returns jsonb
language sql stable
as $$
  select coalesce(nullif(current_setting('request.jwt.claims', true), ''), '{}')::jsonb
$$;

grant execute on function auth.uid(), auth.role(), auth.jwt() to anon, authenticated, service_role;

-- ── Схема storage ─────────────────────────────────────────────

create schema if not exists storage;
grant usage on schema storage to anon, authenticated, service_role;

create table if not exists storage.buckets (
  id                 text primary key,
  name               text not null,
  owner              uuid,
  public             boolean not null default false,
  file_size_limit    bigint,
  allowed_mime_types text[],
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

create table if not exists storage.objects (
  id           uuid primary key default gen_random_uuid(),
  bucket_id    text references storage.buckets (id),
  name         text,
  owner        uuid,
  metadata     jsonb,
  path_tokens  text[] generated always as (string_to_array(name, '/')) stored,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

alter table storage.objects enable row level security;

-- storage.foldername('uid/file.jpg') = {uid} — ровно это читает политика
-- item_photos_write из 0003.
create or replace function storage.foldername(name text) returns text[]
language plpgsql immutable
as $$
declare
  _parts text[];
begin
  select string_to_array(name, '/') into _parts;
  return _parts[1 : array_length(_parts, 1) - 1];
end
$$;

grant all on storage.buckets, storage.objects to anon, authenticated, service_role;
grant execute on function storage.foldername(text) to anon, authenticated, service_role;
