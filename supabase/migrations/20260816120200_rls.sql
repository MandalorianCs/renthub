-- RentHUB — Row Level Security.
--
-- Клиентское приложение работает с базой напрямую по anon-ключу, который
-- лежит в собранном APK и в JS веб-версии — то есть публично. Единственное,
-- что отделяет чужие данные от пользователя, это политики ниже.
--
-- Принцип: читать — через политики, менять состояние сделки — только через
-- RPC из 0002. Поэтому у bookings/disputes/payouts нет update-политик:
-- статусы двигаются функциями, которые проверяют, кто и откуда их зовёт.

alter table users         enable row level security;
alter table categories    enable row level security;
alter table items         enable row level security;
alter table bookings      enable row level security;
alter table reviews       enable row level security;
alter table disputes      enable row level security;
alter table payouts       enable row level security;
alter table notifications enable row level security;
alter table app_settings  enable row level security;

-- ── Справочники: читают все авторизованные ────────────────────

create policy categories_read on categories
  for select to authenticated using (true);

create policy app_settings_read on app_settings
  for select to authenticated using (true);

-- ── Профили ───────────────────────────────────────────────────
-- Профиль виден всем: рейтинг владельца — часть карточки объявления,
-- без него арендатор не может принять решение.

create policy users_read on users
  for select to authenticated using (true);

create policy users_update_own on users
  for update to authenticated
  using (id = auth.uid())
  with check (id = auth.uid());

-- ── Объявления ────────────────────────────────────────────────

create policy items_read on items
  for select to authenticated
  using (status = 'active' or owner_id = auth.uid());

create policy items_insert_own on items
  for insert to authenticated
  with check (owner_id = auth.uid());

create policy items_update_own on items
  for update to authenticated
  using (owner_id = auth.uid())
  with check (owner_id = auth.uid());

create policy items_delete_own on items
  for delete to authenticated
  using (owner_id = auth.uid());

-- ── Бронирования ──────────────────────────────────────────────
-- Видят только две стороны сделки. Создаёт арендатор; дальнейшие
-- переходы статусов — через booking_confirm / _mark_picked_up /
-- _mark_returned / _complete.

create policy bookings_read_participants on bookings
  for select to authenticated
  using (renter_id = auth.uid() or owner_id = auth.uid());

create policy bookings_insert_as_renter on bookings
  for insert to authenticated
  with check (renter_id = auth.uid());

-- Отменить свою неподтверждённую заявку арендатор может сам.
create policy bookings_cancel_pending on bookings
  for update to authenticated
  using (renter_id = auth.uid() and status = 'pending')
  with check (renter_id = auth.uid() and status = 'cancelled');

-- ── Отзывы ────────────────────────────────────────────────────
-- Читают все: рейтинг без возможности прочитать отзывы — это цифра
-- без объяснения, ей не верят.

create policy reviews_read on reviews
  for select to authenticated using (true);

create policy reviews_insert_own on reviews
  for insert to authenticated
  with check (from_user_id = auth.uid());

-- ── Споры ─────────────────────────────────────────────────────
-- Создаются только через open_damage_dispute / process_overdue_bookings.

create policy disputes_read_participants on disputes
  for select to authenticated
  using (
    exists (
      select 1 from bookings b
       where b.id = disputes.booking_id
         and (b.renter_id = auth.uid() or b.owner_id = auth.uid())
    )
  );

-- ── Выплаты ───────────────────────────────────────────────────
-- Владелец видит свои начисления как выписку по счёту: это ровно
-- те же сырые данные, что у платформы, а не сводка постфактум.

create policy payouts_read_own on payouts
  for select to authenticated
  using (owner_id = auth.uid());

-- ── Уведомления ───────────────────────────────────────────────

create policy notifications_read_own on notifications
  for select to authenticated
  using (user_id = auth.uid());

create policy notifications_mark_read on notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- ── Storage: фото объявлений и доказательства по спорам ───────

insert into storage.buckets (id, name, public)
values ('item-photos', 'item-photos', true)
on conflict (id) do nothing;

create policy item_photos_read on storage.objects
  for select using (bucket_id = 'item-photos');

-- Каждый пишет только в свою папку: <user_id>/<filename>
create policy item_photos_write on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'item-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

create policy item_photos_delete on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'item-photos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );
