-- Анониму оставлено ровно то, чем он пользуется.
--
-- ── Что показал линтер ───────────────────────────────────────
--
-- Встроенная проверка Supabase (`anon_security_definer_function_executable`)
-- насчитала двадцать семь функций, которые роль `anon` может позвать через
-- `/rest/v1/rpc/…`. Дыры среди них нет: 03.09 и 04.09 закрыты все пути, где
-- посторонний менял чужое, и стенд с тех пор требует от каждой такой функции
-- ответа «нужно войти».
--
-- Но защита держалась на ОДНОМ рубеже — на теле функции. Право позвать
-- оставалось, и каждая новая проверка внутри становилась единственной
-- преградой. Проект уже писал об этом после 03.09: «Отзыв — второй рубеж и
-- он же лучший ответ: посторонний получает permission denied на входе, не
-- доходя до тела».
--
-- ── Что анониму нужно на самом деле ──────────────────────────
--
-- Измерено по коду, а не по памяти: приложение зовёт напрямую тринадцать
-- RPC (`grep rpc\(` в src/lib/api.ts), и до входа из них доступны две.
--
--   item_busy_dates   календарь занятости на карточке вещи. Без него
--                     потенциальный арендатор выбирает даты вслепую и
--                     упирается в bookings_no_overlap после нажатия.
--   user_deals_count  «сдавал N раз» на карточке владельца — то, по чему
--                     решают, отдать ли незнакомцу вещь за 90 000 ₸.
--
-- Обе читающие (`stable`), обе возвращают ровно то, что описано в
-- `returns`: телефонов и чужих строк там нет по построению.
--
-- Всё остальное закрывается. Три группы, и у каждой своя причина:

-- ── 1. Триггерные функции ─────────────────────────────────────
--
-- Их вызывает Postgres при записи в таблицу, и права роли к этому не
-- имеют отношения: триггер выполняется от владельца. Прямой вызов через
-- REST бессмысленен — вне триггера у них нет NEW, — но он ВОЗМОЖЕН, а
-- значит попадает в отчёт линтера и в чужие сканеры.

revoke all on function bookings_before_insert()    from public, anon, authenticated;
revoke all on function bookings_after_insert()     from public, anon, authenticated;
revoke all on function items_before_write()        from public, anon, authenticated;
revoke all on function reviews_before_insert()     from public, anon, authenticated;
revoke all on function reviews_recalc_rating()     from public, anon, authenticated;
-- rls_auto_enable() в этом списке нет намеренно: линтер называет и её, но
-- функция принадлежит платформе, а не нам — в миграциях её не создавали, и
-- на чистом стенде её попросту не существует. Трогать чужое ради красивого
-- отчёта — способ уронить деплой на пустом месте.
revoke all on function handle_new_auth_user()      from public, anon, authenticated;
revoke all on function sync_phone_verification()   from public, anon, authenticated;
revoke all on function link_join_request()         from public, anon, authenticated;

-- ── 2. Вспомогательные проверки ───────────────────────────────
--
-- assert_* и has_open_disputes зовут другие функции, уже работающие от
-- владельца. Снаружи их не зовёт ни приложение, ни бот — проверено
-- сверкой с src/lib/api.ts и bot/bot.py.
--
-- Отдельно про assert_moderator(): именно её пустой auth.uid() открывал
-- 03.09 все функции модератора разом. Корень починен, но право звать её
-- напрямую не нужно никому и никогда.

revoke all on function assert_item_owner(uuid)          from public, anon, authenticated;
revoke all on function assert_verified(uuid, text)      from public, anon, authenticated;
revoke all on function assert_moderator()               from public, anon, authenticated;
revoke all on function has_open_disputes(uuid)          from public, anon, authenticated;

-- ── 3. Действия вошедшего ─────────────────────────────────────
--
-- Здесь право у `authenticated` остаётся: это и есть их работа. У `anon`
-- отбирается — он всё равно получал отказ в теле, но теперь не дойдёт до
-- него. Разница видна ровно в одном случае, зато важном: новая проверка
-- внутри функции больше не будет единственной преградой.

-- Обе строки на каждую функцию, и это не перестраховка. Право у anon
-- приходит двумя путями: именным грантом от Supabase (`alter default
-- privileges ... to anon`) и грантом роли PUBLIC, который Postgres даёт
-- каждой новой функции сам. Отзыв у anon не трогает второй.
--
-- Правило записано в README с 03.09.2026 — и я наступил на него первой же
-- версией этой миграции: `revoke ... from anon` прошёл без ошибки, а
-- стенд показал, что booking_* и create_item по-прежнему доступны
-- анониму. Через PUBLIC.
--
-- Порядок обязателен: сначала отобрать у всех, потом вернуть тому, кому
-- нужно. Иначе `revoke all from public` заодно отнимет право у
-- authenticated, полученное тем же путём, и приложение перестанет
-- работать — молча, до первой попытки забронировать.

revoke all on function booking_confirm(uuid)                    from public, anon;
revoke all on function booking_cancel(uuid)                     from public, anon;
revoke all on function booking_mark_picked_up(uuid)             from public, anon;
revoke all on function booking_mark_returned(uuid)              from public, anon;
revoke all on function booking_complete(uuid, boolean)          from public, anon;
revoke all on function open_damage_dispute(uuid, integer, text[], text) from public, anon;
revoke all on function submit_review(uuid, uuid, integer, text) from public, anon;
revoke all on function support_submit(text)                     from public, anon;
revoke all on function item_set_price(uuid, integer)            from public, anon;
revoke all on function item_set_status(uuid, item_status)       from public, anon;
revoke all on function create_item(text, text, integer, integer, text[], text, text) from public, anon;

grant execute on function booking_confirm(uuid)                    to authenticated;
grant execute on function booking_cancel(uuid)                     to authenticated;
grant execute on function booking_mark_picked_up(uuid)             to authenticated;
grant execute on function booking_mark_returned(uuid)              to authenticated;
grant execute on function booking_complete(uuid, boolean)          to authenticated;
grant execute on function open_damage_dispute(uuid, integer, text[], text) to authenticated;
grant execute on function submit_review(uuid, uuid, integer, text) to authenticated;
grant execute on function support_submit(text)                     to authenticated;
grant execute on function item_set_price(uuid, integer)            to authenticated;
grant execute on function item_set_status(uuid, item_status)       to authenticated;
grant execute on function create_item(text, text, integer, integer, text[], text, text) to authenticated;

-- calc_booking_price() отдельно: он ничего не меняет и никому не вредит,
-- но и не нужен снаружи. Приложение считает ту же сумму в
-- src/lib/pricing.ts — именно потому, что до создания брони сходить в
-- базу не может. Сверку двух реализаций делает npm run check:price
-- сервисным ключом.
revoke all on function calc_booking_price(integer, integer, boolean) from public, anon;

-- Ещё две, найденные стендом, а не глазами: линтер их не назвал, потому
-- что они не security definer, а список «что осталось» их показал.
--
--   setting()               читает строку app_settings. Секрета в
--                           комиссии нет — она на лендинге, — но и повода
--                           звать её снаружи тоже нет.
--   decide_dispute_payout() чистый расчёт выплаты по правилам спора.
--                           Immutable, ничего не читает и не меняет, но
--                           это внутренняя механика разбора, а не витрина.
revoke all on function setting(text) from public, anon, authenticated;
revoke all on function decide_dispute_payout(integer, integer) from public, anon, authenticated;

comment on function item_busy_dates(uuid) is
  'Занятые интервалы объявления для календаря. Одна из двух функций, '
  'намеренно оставленных роли anon: без неё арендатор выбирает даты '
  'вслепую. Возвращаемый тип и есть граница — сторон сделки и сумм там нет.';

comment on function user_deals_count(uuid) is
  'Сколько сделок человек завершил. Вторая функция, намеренно оставленная '
  'роли anon: по этому числу решают, отдать ли незнакомцу вещь за 90 000 ₸, '
  'и видеть его нужно до входа.';
