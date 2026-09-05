-- Индексы под внешние ключи.
--
-- ── Что нашёл анализатор ─────────────────────────────────────
--
-- Postgres создаёт индекс под PRIMARY KEY и UNIQUE, но НЕ под внешний
-- ключ. Шесть таких нашлось: disputes.opened_by, favorites.item_id,
-- items.category, notifications.booking_id, reviews.from_user_id,
-- support_messages.user_id.
--
-- ── Почему это важно раньше, чем кажется ─────────────────────
--
-- Дело не в чтении, а в удалении. У сделок и вещей стоит `on delete
-- restrict` — правило «нельзя удалить человека и вещь с историей», и
-- держится оно проверкой: перед каждым удалением Postgres ищет
-- ссылающиеся строки. Без индекса это полный проход по таблице.
--
-- Сегодня в базе девять объявлений и ноль броней, и разницы не видно
-- вовсе. Разница появится там же, где появится нагрузка: удаление
-- объявления начнёт сканировать все favorites, отметка уведомления —
-- все notifications. Момент, когда это станет заметно, узнать нельзя
-- заранее, а индексы стоят десятки килобайт.
--
-- ── Чего здесь намеренно нет ─────────────────────────────────
--
-- Анализатор жалуется ещё на четыре «неиспользованных» индекса
-- (users_telegram_idx, users_blocked_idx, users_verified_idx,
-- items_moderated_idx) и предлагает их убрать. Не убираем: они не
-- использованы потому, что данных мало и запросов почти не было, а не
-- потому, что не нужны. Удалить их сейчас — значит принять статистику
-- пилота из пяти человек за приговор.
--
-- И на четыре пары политик SELECT (участник плюс модератор на одной
-- таблице). Слить их в одну означало бы написать «свои строки ИЛИ ты
-- модератор» одним выражением — и потерять то, ради чего они разделены:
-- каждая политика читается отдельно и отвечает на свой вопрос.

create index if not exists disputes_opened_by_idx
  on disputes (opened_by);

create index if not exists favorites_item_idx
  on favorites (item_id);

create index if not exists items_category_idx
  on items (category);

create index if not exists notifications_booking_idx
  on notifications (booking_id);

create index if not exists reviews_from_user_idx
  on reviews (from_user_id);

create index if not exists support_messages_user_idx
  on support_messages (user_id);

comment on index favorites_item_idx is
  'Под внешний ключ favorites.item_id. Нужен не чтению, а удалению: '
  'без него проверка on delete идёт полным проходом по избранному.';
