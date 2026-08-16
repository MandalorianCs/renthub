-- RentHUB — базовая схема (MVP без реальных платежей)
-- Все суммы хранятся в тенге, целыми числами (в ₸ нет копеек в обиходе).
-- Денежный поток эмулируется статусами: реальные деньги не двигаются.

create extension if not exists pgcrypto;
create extension if not exists btree_gist;

-- ─────────────────────────────────────────────────────────────
-- Перечисления
-- ─────────────────────────────────────────────────────────────

create type item_status as enum ('active', 'hidden');

-- pending → confirmed → active → returned → completed
--                                        ↘ disputed
create type booking_status as enum (
  'pending',    -- арендатор запросил, владелец ещё не подтвердил
  'confirmed',  -- владелец подтвердил, вещь ещё не передана
  'active',     -- вещь у арендатора
  'returned',   -- вещь вернули, идёт окно на претензию по порче
  'completed',  -- сделка закрыта, депозит отпущен
  'disputed',   -- открыт спор
  'cancelled'
);

create type deposit_status as enum ('held', 'released', 'claimed');
create type dispute_type as enum ('damage', 'non_return');
create type dispute_resolution as enum ('auto_resolved', 'manual_review', 'resolved');
create type payout_status as enum ('scheduled', 'released');

-- Выплата за аренду и компенсация ущерба — разные деньги: с аренды берётся
-- комиссия, с компенсации нет. Владелец должен видеть их отдельными строками,
-- иначе «начислено 15 000» невозможно объяснить, не открывая спор.
create type payout_kind as enum ('rent', 'damage_compensation');

-- ─────────────────────────────────────────────────────────────
-- Настройки платформы
-- Бизнес-правила вынесены в таблицу, а не зашиты в код: менять
-- порог авторазрешения споров можно без деплоя приложения и бота.
-- ─────────────────────────────────────────────────────────────

create table app_settings (
  key   text primary key,
  value numeric not null,
  note  text
);

insert into app_settings (key, value, note) values
  ('commission_pct',            20,    'Комиссия платформы, % от суммы аренды'),
  ('insurance_fee',             150,   'Страховой сбор, ₸ — фиксированный, если арендатор выбрал защиту'),
  ('grace_period_hours',        12,    'Сколько часов после end_date ждём возврат до автоспора (6–12 по ТЗ)'),
  ('damage_claim_window_hours', 48,    'Окно, в течение которого владелец может заявить о порче (24–48 по ТЗ)'),
  ('dispute_auto_threshold',    15000, 'Порог, ₸: споры дешевле решаются автоматически, дороже — на ручной модерации');

create or replace function setting(p_key text)
returns numeric
language sql
stable
as $$
  select value from app_settings where key = p_key;
$$;

-- ─────────────────────────────────────────────────────────────
-- Пользователи
-- Профиль отдельно от auth.users: там телефон и служебные поля Supabase,
-- здесь — доменные (рейтинг, верификация, роль).
-- ─────────────────────────────────────────────────────────────

create table users (
  id            uuid primary key references auth.users (id) on delete cascade,
  phone         text unique not null,
  full_name     text,
  -- Пока подтверждение телефона. ID-верификация — заглушка на будущее,
  -- поэтому одно поле, а не два: важен факт «проверен», а не способ.
  verified_at   timestamptz,
  rating        numeric(3, 2),
  ratings_count integer not null default 0,
  -- Не enum: человек бывает и владельцем, и арендатором одновременно.
  role_hint     text not null default 'both',
  -- Пассивный режим: владелец не хочет вручную отслеживать статусы.
  -- Включён по умолчанию — это большинство (см. сегментацию владельцев).
  passive_mode  boolean not null default true,
  created_at    timestamptz not null default now()
);

create index users_verified_idx on users (verified_at) where verified_at is not null;

-- ─────────────────────────────────────────────────────────────
-- Категории — стартуем узко: только стройтехника и инструмент
-- ─────────────────────────────────────────────────────────────

create table categories (
  slug       text primary key,
  title_ru   text not null,
  sort_order integer not null default 0
);

insert into categories (slug, title_ru, sort_order) values
  ('rotary_hammers', 'Перфораторы и отбойники', 10),
  ('grinders',       'Шлифмашины и УШМ',        20),
  ('concrete',       'Бетономешалки и вибраторы', 30),
  ('scaffolding',    'Леса, вышки, стремянки',  40),
  ('drills',         'Дрели и шуруповёрты',     50),
  ('saws',           'Пилы и резаки',           60),
  ('measuring',      'Измерительный инструмент', 70),
  ('other_tools',    'Прочий инструмент',       80);

-- ─────────────────────────────────────────────────────────────
-- Объявления
-- ─────────────────────────────────────────────────────────────

create table items (
  id               uuid primary key default gen_random_uuid(),
  owner_id         uuid not null references users (id) on delete cascade,
  category         text not null references categories (slug),
  title            text not null check (length(trim(title)) >= 3),
  description      text,
  daily_price      integer not null check (daily_price > 0),
  deposit_amount   integer not null default 0 check (deposit_amount >= 0),
  -- Фото «до» — база для сверки при споре о порче.
  condition_photos text[] not null default '{}',
  city             text not null default 'almaty',
  status           item_status not null default 'active',
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

create index items_catalog_idx on items (city, category, created_at desc) where status = 'active';
create index items_owner_idx on items (owner_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Бронирования
-- Цены скопированы на момент брони: если владелец изменит daily_price,
-- уже подтверждённая сделка не должна пересчитаться задним числом.
-- ─────────────────────────────────────────────────────────────

create table bookings (
  id                    uuid primary key default gen_random_uuid(),
  item_id               uuid not null references items (id) on delete restrict,
  renter_id             uuid not null references users (id) on delete restrict,
  -- Дублируем владельца: RLS-политики и выплаты обращаются к нему постоянно,
  -- а джойн к items на каждой проверке — лишняя работа.
  owner_id              uuid not null references users (id) on delete restrict,

  start_date            date not null,
  end_date              date not null,
  days                  integer not null check (days > 0),

  status                booking_status not null default 'pending',
  deposit_status        deposit_status not null default 'held',

  -- Снимок расчёта
  daily_price_snapshot  integer not null,
  deposit_snapshot      integer not null,
  insurance_selected    boolean not null default false,
  rent_total            integer not null,  -- daily_price × days
  platform_fee          integer not null,  -- 20% комиссия
  insurance_fee         integer not null,  -- 150 ₸ или 0
  renter_total          integer not null,  -- сколько платит арендатор (без депозита)
  owner_payout_total    integer not null,  -- аренда минус комиссия

  -- Дедлайн возврата: после него открывается автоспор о невозврате
  grace_period_ends_at  timestamptz,
  -- Дедлайн для претензии по порче: считается от факта возврата
  damage_claim_ends_at  timestamptz,

  picked_up_at          timestamptz,
  returned_at           timestamptz,
  completed_at          timestamptz,
  created_at            timestamptz not null default now(),

  check (end_date >= start_date),
  check (renter_id <> owner_id)
);

-- Двойное бронирование невозможно на уровне базы, а не «мы проверим в коде».
-- Занятыми считаем только живые статусы: отменённая или завершённая бронь
-- освобождает даты.
alter table bookings add constraint bookings_no_overlap
  exclude using gist (
    item_id with =,
    daterange(start_date, end_date, '[]') with &&
  ) where (status in ('pending', 'confirmed', 'active'));

create index bookings_renter_idx on bookings (renter_id, created_at desc);
create index bookings_owner_idx on bookings (owner_id, created_at desc);
create index bookings_overdue_idx on bookings (grace_period_ends_at) where status = 'active';

-- ─────────────────────────────────────────────────────────────
-- Выплаты владельцу — начисления по сделке, «выписка по счёту».
--
-- Сейчас: одна выплата за сделку. Транши для длинной аренды (раз в 7 дней)
-- отложены — таблица уже разбита по периодам (period_start/period_end),
-- поэтому включить их потом можно, не меняя схему: достаточно переписать
-- schedule_payouts в 0002.
-- ─────────────────────────────────────────────────────────────

create table payouts (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references bookings (id) on delete cascade,
  owner_id     uuid not null references users (id) on delete restrict,
  period_start date not null,
  period_end   date not null,
  amount       integer not null check (amount >= 0),
  kind         payout_kind not null default 'rent',
  status       payout_status not null default 'scheduled',
  released_at  timestamptz,
  created_at   timestamptz not null default now(),

  -- Компенсация по сделке ровно одна: защита от повторного начисления,
  -- если шлюз закрытия позовут дважды.
  unique (booking_id, kind, period_start)
);

create index payouts_booking_idx on payouts (booking_id, period_start);
create index payouts_owner_idx on payouts (owner_id, status);

-- ─────────────────────────────────────────────────────────────
-- Отзывы — обе стороны оценивают друг друга после completed
-- ─────────────────────────────────────────────────────────────

create table reviews (
  id           uuid primary key default gen_random_uuid(),
  booking_id   uuid not null references bookings (id) on delete cascade,
  from_user_id uuid not null references users (id) on delete cascade,
  to_user_id   uuid not null references users (id) on delete cascade,
  rating       integer not null check (rating between 1 and 5),
  comment      text,
  created_at   timestamptz not null default now(),

  -- Один отзыв на сделку от одного человека
  unique (booking_id, from_user_id),
  check (from_user_id <> to_user_id)
);

create index reviews_to_user_idx on reviews (to_user_id, created_at desc);

-- ─────────────────────────────────────────────────────────────
-- Споры
-- ─────────────────────────────────────────────────────────────

create table disputes (
  id                uuid primary key default gen_random_uuid(),
  booking_id        uuid not null references bookings (id) on delete cascade,
  -- null — спор создан автоматически системой (невозврат)
  opened_by         uuid references users (id) on delete set null,
  type              dispute_type not null,
  description       text,
  -- Фото «после» — сверяются с items.condition_photos
  evidence_photos   text[] not null default '{}',
  claim_amount      integer not null default 0 check (claim_amount >= 0),
  resolution_status dispute_resolution not null default 'manual_review',
  payout_amount     integer not null default 0 check (payout_amount >= 0),
  resolution_note   text,
  resolved_at       timestamptz,
  created_at        timestamptz not null default now(),

  -- По одному спору каждого типа на сделку
  unique (booking_id, type)
);

create index disputes_pending_idx on disputes (resolution_status, created_at)
  where resolution_status = 'manual_review';

-- ─────────────────────────────────────────────────────────────
-- Уведомления
-- Опора пассивного режима: владелец не заходит проверять статусы,
-- система сама сообщает о каждом событии сделки.
-- Та же таблица кормит и Telegram-бота.
-- ─────────────────────────────────────────────────────────────

create table notifications (
  id         uuid primary key default gen_random_uuid(),
  user_id    uuid not null references users (id) on delete cascade,
  booking_id uuid references bookings (id) on delete cascade,
  type       text not null,
  title      text not null,
  body       text,
  payload    jsonb not null default '{}',
  read_at    timestamptz,
  -- Отметка, что бот уже доставил уведомление в Telegram
  sent_at    timestamptz,
  created_at timestamptz not null default now()
);

create index notifications_inbox_idx on notifications (user_id, created_at desc);
create index notifications_undelivered_idx on notifications (created_at) where sent_at is null;
