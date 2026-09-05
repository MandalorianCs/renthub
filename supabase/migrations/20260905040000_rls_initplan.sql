-- auth.uid() в политике вычисляется для каждой строки.
--
-- Нашёл аудит Supabase (`get_advisors`, тип performance): девятнадцать
-- политик помечены `auth_rls_initplan`. Postgres не знает, что auth.uid()
-- одинакова для всех строк запроса, и честно зовёт её на каждой.
--
-- Лечится одним приёмом, который рекомендует сама Supabase: обернуть вызов
-- в подзапрос. `(select auth.uid())` планировщик выполняет один раз и
-- подставляет результат как константу — InitPlan, отсюда и название
-- предупреждения.
--
-- Насколько это важно сегодня. Незаметно: в каталоге восемь объявлений, и
-- разницы между восемью вызовами и одним нет никакой. Важно станет на
-- тысяче — а тысяча появится не в тот день, когда об этом вспомнят.
-- Правка стоит одной строки на политику и не меняет ни условий, ни ролей.
--
-- alter policy, а не drop/create: меняется только выражение. Пересоздание
-- потребовало бы повторить роли и команду, а это ровно то место, где
-- ошибаются молча — политика с `for all` вместо `for select` выглядит
-- работающей и открывает лишнее.

-- ── users ────────────────────────────────────────────────────
alter policy users_update_own on users
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- ── items ────────────────────────────────────────────────────
alter policy items_read on items
  using (status = 'active'::item_status or owner_id = (select auth.uid()));

alter policy items_insert_own on items
  with check (owner_id = (select auth.uid()));

alter policy items_update_own on items
  using (owner_id = (select auth.uid()))
  with check (owner_id = (select auth.uid()));

alter policy items_delete_own on items
  using (owner_id = (select auth.uid()));

alter policy items_read_moderator on items
  using (exists (select 1 from users u where u.id = (select auth.uid()) and u.is_moderator));

-- ── bookings ─────────────────────────────────────────────────
alter policy bookings_read_participants on bookings
  using (renter_id = (select auth.uid()) or owner_id = (select auth.uid()));

alter policy bookings_insert_as_renter on bookings
  with check (renter_id = (select auth.uid()));

alter policy bookings_read_moderator on bookings
  using (exists (select 1 from users u where u.id = (select auth.uid()) and u.is_moderator));

-- ── disputes ─────────────────────────────────────────────────
alter policy disputes_read_participants on disputes
  using (
    exists (
      select 1 from bookings b
      where b.id = disputes.booking_id
        and (b.renter_id = (select auth.uid()) or b.owner_id = (select auth.uid()))
    )
  );

alter policy disputes_read_moderator on disputes
  using (exists (select 1 from users u where u.id = (select auth.uid()) and u.is_moderator));

-- ── reviews ──────────────────────────────────────────────────
alter policy reviews_insert_own on reviews
  with check (from_user_id = (select auth.uid()));

-- ── notifications ────────────────────────────────────────────
alter policy notifications_read_own on notifications
  using (user_id = (select auth.uid()));

alter policy notifications_mark_read on notifications
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ── favorites ────────────────────────────────────────────────
alter policy favorites_own on favorites
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- ── payouts ──────────────────────────────────────────────────
alter policy payouts_read_own on payouts
  using (owner_id = (select auth.uid()));

-- ── support_messages ─────────────────────────────────────────
alter policy support_read_own on support_messages
  using (user_id = (select auth.uid()));

alter policy support_read_moderator on support_messages
  using (exists (select 1 from users u where u.id = (select auth.uid()) and u.is_moderator));

-- ── join_requests ────────────────────────────────────────────
alter policy join_requests_read_moderator on join_requests
  using (exists (select 1 from users u where u.id = (select auth.uid()) and u.is_moderator));
