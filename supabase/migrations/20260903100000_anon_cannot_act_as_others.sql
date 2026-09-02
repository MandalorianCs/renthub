-- Посторонний с публичным ключом мог действовать от чужого имени.
--
-- Измерено на стенде 03.09.2026 ролью anon — то есть тем самым
-- публикуемым ключом, который вшит в веб-сборку, лежит в APK и открыто
-- записан в .github/workflows/pages.yml. Ни токена, ни аккаунта не нужно.
--
--   bot_set_item_price      цена чужого объявления: было 5000, стало 1
--   bot_set_item_status     чужое объявление: было active, стало hidden
--   bot_my_items            чужие вещи, включая снятые с публикации
--   bot_profile             чужой профиль в том виде, в каком его видит чат
--   bot_pending_reviews     чужие незакрытые оценки
--   submit_support_message  обращение от чужого имени: было 3, стало 4
--   join_requests_open      телефон заявителя: +7701…
--   support_open            чужая переписка с поддержкой: 2 обращения
--   notify_user             уведомление любому участнику с любым текстом
--   settle_booking          закрытие чужой сделки
--   moderator_restore_item  дошло до тела функции
--   resolve_dispute_manually дошло до тела функции
--
-- Дороже прочего первые две и последняя. Цену за сутки хватало опустить
-- до рубля, чтобы забронировать чужой перфоратор за ничто: в bookings
-- уезжает daily_price_snapshot, снятый в момент заявки. Снятие с
-- публикации тише и злее — владелец неделю ждёт заявок и решает, что
-- платформа не работает. А notify_user превращает бота в канал доставки
-- чужого текста: сообщение приходит в Telegram подписанным платформой.
--
-- ── Две разные причины, по которым это открылось ──────────────
--
-- ПЕРВАЯ. `revoke all on function ... from public` НЕ отбирает право у
-- anon. Supabase выдаёт этой роли собственный грант — `alter default
-- privileges in schema public grant all on functions to anon,
-- authenticated, service_role`, — а отзыв у PUBLIC чужих именных грантов
-- не трогает. Роль надо называть поимённо.
--
-- Миграции до 01.09 это знали и писали `revoke execute ... from anon,
-- authenticated`. Начиная с 20260901170000 семь миграций подряд написали
-- `revoke all ... from authenticated` — строкой, которая выглядит строже,
-- а закрывает меньше.
--
-- ВТОРАЯ, и она важнее. assert_moderator() пропускала любой вызов, у
-- которого auth.uid() пуст:
--
--     if auth.uid() is null then return; end if;
--
-- Комментарий объяснял: «вызов без сессии — это сервисный ключ или
-- планировщик». Предположение неверное. У anon auth.uid() тоже пуст, и
-- вся защита функций модератора держалась на том, что грант забыли выдать
-- — а его никто не забыл, его выдаёт платформа по умолчанию.
--
-- Поэтому отзывов ниже недостаточно: следующая функция модератора
-- повторит ту же историю. Чинится корень.
--
-- ── Как отличить сервисный ключ от постороннего ───────────────
--
-- Замерено на стенде, изнутри security definer:
--
--   аноним        role=anon           uid=<null>
--   вошедший      role=authenticated  uid=<есть>
--   сервисный ключ role=service_role  uid=<null>
--   планировщик   role=none           uid=<null>
--
-- current_setting('role') переживает вход в security definer: SECURITY
-- DEFINER меняет current_user, но не GUC `role`, который выставляет
-- PostgREST своим `set local role`. Значит различить можно, и различать
-- надо именно роль, а не пустоту auth.uid().

-- ── Корень: проверка модератора перестаёт верить пустому uid ──

create or replace function assert_moderator()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    -- Пустой auth.uid() сам по себе ничего не доказывает: он пуст и у
    -- сервисного ключа, и у постороннего с публикуемым ключом. Раньше
    -- здесь стоял безусловный return, и на нём держались все функции
    -- модератора разом.
    --
    -- Роль различает их надёжно. Сессионные роли PostgREST — anon и
    -- authenticated; всё остальное (service_role, планировщик, прямое
    -- подключение) приходит из-под контролируемого ключа.
    if coalesce(current_setting('role', true), '') in ('anon', 'authenticated') then
      raise exception 'RENTHUB_FORBIDDEN: это действие доступно только модератору'
        using errcode = '42501';
    end if;
    return;
  end if;

  if not exists (select 1 from users where id = auth.uid() and is_moderator) then
    raise exception 'RENTHUB_FORBIDDEN: это действие доступно только модератору'
      using errcode = '42501';
  end if;
end;
$$;

comment on function assert_moderator() is
  'Право разбирать споры. Пустой auth.uid() пропускается только не-сессионным '
  'ролям: у anon он тоже пуст, и безусловный пропуск открывал все функции '
  'модератора любому с публикуемым ключом. Измерено на стенде 03.09.2026.';

-- ── Обёртки бота: право вызвать = право быть другим ───────────
--
-- У них нет и не может быть внутренней проверки вызывающего: тот, за кого
-- действуют, приходит аргументом, а bot_actor_ok(p_actor) проверяет
-- ЖЕРТВУ — что у неё привязан Telegram. Идентификаторы участников открыты
-- анониму намеренно: владелец виден на карточке объявления. Значит
-- единственное, что отделяет чужую цену от постороннего, — грант.
--
-- Список полный, включая те шесть, что закрыты правильно с самого начала:
-- повторный revoke стоит ноль и избавляет от вопроса «а точно ли все».

revoke execute on function bot_actor_ok(uuid)                            from anon, authenticated;
revoke execute on function bot_booking_confirm(uuid, uuid)               from anon, authenticated;
revoke execute on function bot_booking_picked_up(uuid, uuid)             from anon, authenticated;
revoke execute on function bot_booking_returned(uuid, uuid)              from anon, authenticated;
revoke execute on function bot_booking_complete(uuid, uuid)              from anon, authenticated;
revoke execute on function bot_cancel_booking(uuid, uuid)                from anon, authenticated;
revoke execute on function bot_booking_contact(uuid, uuid)               from anon, authenticated;
revoke execute on function bot_my_items(uuid)                            from anon, authenticated;
revoke execute on function bot_profile(uuid)                             from anon, authenticated;
revoke execute on function bot_pending_reviews(uuid)                     from anon, authenticated;
revoke execute on function bot_set_item_price(uuid, uuid, integer)       from anon, authenticated;
revoke execute on function bot_set_item_status(uuid, uuid, item_status)  from anon, authenticated;
revoke execute on function bot_submit_review(uuid, uuid, uuid, integer, text)
  from anon, authenticated;
revoke execute on function bot_open_damage_dispute(uuid, uuid, integer, text[], text)
  from anon, authenticated;
revoke execute on function bot_create_item(uuid, text, text, integer, integer, text[], text, text)
  from anon, authenticated;
revoke execute on function submit_support_message(uuid, text)            from anon, authenticated;
revoke execute on function submit_join_request(text, text, bigint, text, text)
  from anon, authenticated;

comment on function bot_actor_ok(uuid) is
  'Проверяет, что у человека привязан Telegram. Проверяет того, ЗА КОГО '
  'действуют, а не того, кто зовёт: вызывающего здесь опознать нечем. '
  'Поэтому право вызвать любую функцию с p_actor равно праву действовать '
  'от чужого имени, и обе сессионные роли обязаны быть от них отрезаны.';

-- ── Функции модератора: анониму их видеть незачем ─────────────
--
-- Корень уже починен, и одного его хватило бы. Отзыв — второй рубеж и
-- он же лучший ответ: посторонний получает «permission denied» на входе,
-- не доходя до тела, где лежат чужие телефоны.
--
-- authenticated здесь остаётся: модератор разбирает споры из приложения,
-- обычному участнику откажет assert_moderator().

revoke execute on function join_requests_open()                          from anon;
revoke execute on function join_request_close(uuid)                      from anon;
revoke execute on function support_open()                                from anon;
revoke execute on function support_close(uuid)                           from anon;
revoke execute on function moderator_restore_item(uuid, text)            from anon;

-- resolve_dispute_manually с 17.08 не была отозвана даже у PUBLIC, а
-- PUBLIC — это каждая роль: Postgres выдаёт execute на новую функцию
-- всем по умолчанию. Отзыв только у anon её бы не закрыл, право пришло бы
-- обратно через PUBLIC. Обе строки обязательны, и старые миграции пишут
-- их парой именно поэтому.
revoke all on function resolve_dispute_manually(uuid, integer, text, boolean) from public;
revoke execute on function resolve_dispute_manually(uuid, integer, text, boolean) from anon;
grant execute on function resolve_dispute_manually(uuid, integer, text, boolean) to authenticated;

-- ── Внутренняя механика: её не зовут ни из приложения, ни из чата ──
--
-- Эти четыре вызываются только другими функциями — а те security definer
-- и работают от владельца, — да планировщиком pg_cron. Ни клиент, ни бот
-- к ним не обращаются: проверено сверкой с src/lib/api.ts и bot/bot.py.
--
-- Своей проверки вызывающего у них нет по построению: notify_user пишет
-- уведомление кому скажут, settle_booking закрывает сделку, которую
-- назовут. Пока право было у anon, обе они были открытым входом.

-- И здесь тоже обе строки. Ни у одной из четырёх не было отзыва даже у
-- PUBLIC: они писались первыми, когда правило «отзывать явно» ещё не
-- сложилось, и с 16.08 были доступны всем.

revoke all on function notify_user(uuid, uuid, text, text, text, jsonb) from public;
revoke all on function settle_booking(uuid)                             from public;
revoke all on function schedule_payouts(uuid)                           from public;
revoke all on function process_overdue_bookings()                       from public;

revoke execute on function notify_user(uuid, uuid, text, text, text, jsonb)
  from anon, authenticated;
revoke execute on function settle_booking(uuid)          from anon, authenticated;
revoke execute on function schedule_payouts(uuid)        from anon, authenticated;
revoke execute on function process_overdue_bookings()    from anon, authenticated;

comment on function notify_user(uuid, uuid, text, text, text, jsonb) is
  'Уведомление участнику. Вызывающего не проверяет и проверить не может — '
  'зовут её только другие security definer функции. Сессионным ролям '
  'закрыта: с правом на неё бот превращается в канал доставки чужого текста.';
