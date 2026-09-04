-- Аноним с публикуемым ключом мог двигать чужую сделку целиком.
--
-- Измерено 04.09.2026 на стенде, ролью anon без единого токена — то есть
-- тем ключом, что вшит в веб-сборку, лежит в APK и открыто записан в
-- pages.yml. Каждая функция вызывалась из статуса, в котором она разрешена,
-- иначе меряется не защита, а совпадение:
--
--   из pending    booking_cancel          ПРОШЛО → cancelled
--   из confirmed  booking_mark_picked_up  ПРОШЛО → active
--   из active     booking_mark_returned   ПРОШЛО → returned
--   из returned   booking_complete        ПРОШЛО → completed
--   из returned   open_damage_dispute     ПРОШЛО → претензия подана
--
-- booking_confirm упёрлась в уникальный индекс payouts — то есть проверку
-- владельца прошла тоже и дошла до начисления.
--
-- Дороже прочего две. booking_complete отпускает депозит и выплаты, минуя
-- осмотр владельца. open_damage_dispute подаёт претензию от его имени, и
-- ущерб ниже порога закрывается автоматически — деньги двигаются.
--
-- ── Причина ──────────────────────────────────────────────────
--
-- Проверка написана как `v_b.owner_id <> auth.uid()`. У анонима auth.uid()
-- пуст, а `uuid <> null` в SQL даёт не «истина», а NULL — и `if` не
-- срабатывает вовсе. Пропускает не ошибка в условии, а трёхзначная логика:
-- условие выглядит верным и читается верным.
--
-- Это родня находки 03.09, где assert_moderator() считала пустой auth.uid()
-- признаком своего вызова. Там чинили одну функцию; здесь тот же корень
-- дал восемь, и сверку по всем `<> auth.uid()` тогда не сделали.
--
-- ── Что сделано ──────────────────────────────────────────────
--
-- Одна проверка на всех — assert_signed_in(). Тела функций ниже не
-- переписаны руками, а извлечены из последних миграций, где они определены,
-- и отличаются от прежних ровно одной вставленной строкой.
--
-- Стенд сторожит это правилом, а не списком: каждая функция, доступная
-- анониму и меняющая данные, обязана ответить «нужно войти».

create or replace function assert_signed_in()
returns void
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'RENTHUB_FORBIDDEN: нужно войти' using errcode = '42501';
  end if;
end;
$$;

comment on function assert_signed_in() is
  'Единственная проверка «вошёл ли вызывающий» для функций, которые сравнивают '
  'auth.uid() с владельцем строки. Без неё сравнение uuid с NULL даёт NULL, '
  'и проверка владельца молча пропускает анонима.';

revoke all on function assert_signed_in() from public;
revoke all on function assert_signed_in() from anon, authenticated;

-- ── booking_confirm ───────────────────────────────
-- Тело перенесено из 20260816120100_trust_score.sql без изменений, кроме проверки.

create or replace function booking_confirm(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  perform assert_signed_in();

  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.owner_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: подтверждать бронь может только владелец';
  end if;

  if v_b.status <> 'pending' then
    raise exception 'RENTHUB_BAD_STATE: бронь уже в статусе %', v_b.status;
  end if;

  update bookings set status = 'confirmed' where id = p_booking_id returning * into v_b;

  perform schedule_payouts(v_b.id);

  perform notify_user(v_b.renter_id, v_b.id, 'booking_confirmed',
    'Бронь подтверждена', 'Владелец подтвердил аренду. Депозит заблокирован.');

  return v_b;
end;
$$;

-- ── booking_mark_picked_up ────────────────────────
-- Тело перенесено из 20260816120100_trust_score.sql без изменений, кроме проверки.

create or replace function booking_mark_picked_up(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  perform assert_signed_in();

  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.renter_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: подтвердить получение может только арендатор';
  end if;

  if v_b.status <> 'confirmed' then
    raise exception 'RENTHUB_BAD_STATE: ожидался статус confirmed, получен %', v_b.status;
  end if;

  update bookings
     set status = 'active', picked_up_at = now()
   where id = p_booking_id
  returning * into v_b;

  perform notify_user(v_b.owner_id, v_b.id, 'item_picked_up',
    'Вещь забрали', 'Арендатор подтвердил получение. Вернуть до ' || v_b.end_date || '.');

  return v_b;
end;
$$;

-- ── booking_mark_returned ─────────────────────────
-- Тело перенесено из 20260904100000_return_only_from_non_return.sql без изменений, кроме проверки.

create or replace function booking_mark_returned(p_booking_id uuid)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  perform assert_signed_in();

  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.owner_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: принять вещь может только владелец';
  end if;

  if v_b.status not in ('active', 'disputed') then
    raise exception 'RENTHUB_BAD_STATE: вещь не находится в аренде (статус %)', v_b.status;
  end if;

  -- Из disputed возврат отмечается только тогда, когда вещь действительно
  -- не вернули: открыт спор о невозврате. Разбор порчи идёт по вещи,
  -- которая уже у владельца, и «принять её обратно» второй раз нечего.
  if v_b.status = 'disputed'
     and not exists (
       select 1 from disputes
        where booking_id = p_booking_id
          and type = 'non_return'
          and resolution_status = 'manual_review'
     )
  then
    raise exception
      'RENTHUB_BAD_STATE: вещь уже возвращена, идёт разбор претензии — дождитесь решения модератора'
      using errcode = '42501';
  end if;

  update bookings
     set status               = 'returned',
         returned_at          = now(),
         damage_claim_ends_at = now() + (setting('damage_claim_window_hours') || ' hours')::interval
   where id = p_booking_id
  returning * into v_b;

  -- Если вещь вернули после автоспора о невозврате — спор закрываем,
  -- депозит возвращается в held до истечения окна на претензию по порче.
  update disputes
     set resolution_status = 'resolved',
         resolution_note   = 'Вещь возвращена после открытия спора',
         resolved_at       = now()
   where booking_id = p_booking_id
     and type = 'non_return'
     and resolution_status = 'manual_review';

  -- Депозит возвращается в held только если по сделке ничего не удержано.
  -- Безусловный held стирал бы уже присуждённую компенсацию за порчу.
  update bookings set deposit_status = 'held'
   where id = p_booking_id
     and not exists (
       select 1 from disputes
        where booking_id = p_booking_id and payout_amount > 0
     );

  perform notify_user(v_b.renter_id, v_b.id, 'item_returned',
    'Вещь принята', 'Владелец подтвердил возврат. Депозит разблокируется после проверки состояния.');

  return v_b;
end;
$$;

-- ── booking_cancel ────────────────────────────────
-- Тело перенесено из 20260901130000_cancel_confirmed.sql без изменений, кроме проверки.

create or replace function booking_cancel(p_booking_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b        bookings%rowtype;
  v_by_owner boolean;
  v_other    uuid;
begin
  perform assert_signed_in();

  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.id is null then
    raise exception 'RENTHUB_NOT_FOUND: бронь не найдена' using errcode = '42501';
  end if;

  if auth.uid() not in (v_b.renter_id, v_b.owner_id) then
    raise exception 'RENTHUB_FORBIDDEN: отменить бронь может только её сторона'
      using errcode = '42501';
  end if;

  v_by_owner := auth.uid() = v_b.owner_id;

  -- Заявку отменяет тот, кто её подал. Владельцу для отказа хватает того,
  -- что он её просто не подтвердит: «отклонил» и «не ответил» — разные
  -- сообщения, и второе честнее, пока он ничего не обещал.
  if v_b.status = 'pending' and v_by_owner then
    raise exception 'RENTHUB_FORBIDDEN: неподтверждённую заявку отменяет арендатор'
      using errcode = '42501';
  end if;

  if v_b.status not in ('pending', 'confirmed') then
    raise exception 'RENTHUB_BAD_STATE: отменить можно до передачи вещи (статус %)', v_b.status
      using errcode = '42501';
  end if;

  update bookings set status = 'cancelled' where id = p_booking_id;

  v_other := case when v_by_owner then v_b.renter_id else v_b.owner_id end;

  -- Вторая сторона узнаёт всегда и узнаёт, КТО отменил. Пропавшая из
  -- списка бронь без объяснения читается как сбой платформы, а не как
  -- решение человека.
  perform notify_user(
    v_other, v_b.id, 'booking_cancelled', 'Бронь отменена',
    case
      when v_b.status = 'pending' then
        'Арендатор отменил неподтверждённую заявку. Даты снова свободны.'
      when v_by_owner then
        'Владелец отменил подтверждённую бронь. Деньги не списывались, даты снова свободны.'
      else
        'Арендатор отменил подтверждённую бронь. Даты снова свободны.'
    end);
end;
$$;

-- ── open_damage_dispute ───────────────────────────
-- Тело перенесено из 20260816120100_trust_score.sql без изменений, кроме проверки.

create or replace function open_damage_dispute(
  p_booking_id   uuid,
  p_claim_amount integer,
  p_photos       text[],
  p_description  text default null
) returns disputes
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b         bookings%rowtype;
  v_item      items%rowtype;
  v_threshold integer := setting('dispute_auto_threshold')::integer;
  v_dispute   disputes%rowtype;
  v_payout    integer;
begin
  perform assert_signed_in();

  select * into v_b from bookings where id = p_booking_id for update;

  if v_b.owner_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN: заявить о порче может только владелец';
  end if;

  if v_b.status <> 'returned' then
    raise exception 'RENTHUB_BAD_STATE: претензия по порче подаётся после возврата вещи';
  end if;

  if v_b.damage_claim_ends_at is not null and now() > v_b.damage_claim_ends_at then
    raise exception 'RENTHUB_CLAIM_WINDOW_CLOSED: окно для претензии истекло %', v_b.damage_claim_ends_at;
  end if;

  if coalesce(array_length(p_photos, 1), 0) = 0 then
    raise exception 'RENTHUB_NO_EVIDENCE: нужны фото «после» для сверки с фото «до»';
  end if;

  select * into v_item from items where id = v_b.item_id;

  insert into disputes (booking_id, opened_by, type, description, evidence_photos, claim_amount)
  values (p_booking_id, auth.uid(), 'damage', p_description, p_photos, p_claim_amount)
  returning * into v_dispute;

  update bookings set status = 'disputed', deposit_status = 'claimed' where id = p_booking_id;

  if p_claim_amount <= v_threshold then
    -- Ниже порога — решаем автоматически, без ручной модерации.
    v_payout := decide_dispute_payout(p_claim_amount, v_b.deposit_snapshot);

    update disputes
       set resolution_status = 'auto_resolved',
           payout_amount     = v_payout,
           resolution_note   = 'Автоматически: сумма ниже порога ' || v_threshold || ' ₸',
           resolved_at       = now()
     where id = v_dispute.id
    returning * into v_dispute;

    perform notify_user(v_b.renter_id, v_b.id, 'dispute_auto_resolved',
      'Претензия по состоянию вещи',
      'Из депозита удержано ' || v_payout || ' ₸.',
      jsonb_build_object('payout_amount', v_payout,
                         'evidence_before', to_jsonb(v_item.condition_photos),
                         'evidence_after', to_jsonb(p_photos)));

    perform notify_user(v_b.owner_id, v_b.id, 'dispute_auto_resolved',
      'Компенсация начислена', 'Вам будет выплачено ' || v_payout || ' ₸ из депозита.');

    -- Спор решён без человека — держать сделку больше нечем, закрываем
    -- тем же шлюзом, что и обычную. Владельцу ничего нажимать не нужно.
    perform settle_booking(p_booking_id);
  else
    perform notify_user(v_b.renter_id, v_b.id, 'dispute_manual_review',
      'Открыт спор по состоянию вещи', 'Сумма выше порога, решение примет модератор.');
    perform notify_user(v_b.owner_id, v_b.id, 'dispute_manual_review',
      'Спор передан на модерацию', 'Сумма выше порога авторазрешения.');
  end if;

  return v_dispute;
end;
$$;

-- ── submit_review ─────────────────────────────────
-- Тело перенесено из 20260828100000_bot_acts_as_user.sql без изменений, кроме проверки.

create or replace function submit_review(
  p_booking_id uuid,
  p_to_user    uuid,
  p_rating     integer,
  p_comment    text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform assert_signed_in();

  -- Автор — всегда вызывающий. Раньше это держала политика
  -- reviews_insert_own через `with check (from_user_id = auth.uid())`;
  -- теперь автор не приходит аргументом вовсе, и подставить чужого нельзя
  -- даже по ошибке. Остальное — что отзыв только после закрытой сделки и
  -- только от стороны — проверяет триггер reviews_validate.
  insert into reviews (booking_id, from_user_id, to_user_id, rating, comment)
  values (p_booking_id, auth.uid(), p_to_user, p_rating,
          nullif(trim(coalesce(p_comment, '')), ''));
end;
$$;

-- ── support_submit ────────────────────────────────
-- Тело перенесено из 20260903110000_support_from_app.sql без изменений, кроме проверки.

create or replace function support_submit(p_text text)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user uuid := auth.uid();
begin
  perform assert_signed_in();

  -- Аноним отсекается здесь, а не внешним ключом. Ошибка внешнего ключа
  -- пришла бы английской строкой про support_messages_user_id_fkey —
  -- человек прочитал бы её как поломку, хотя ему просто надо войти.
  if v_user is null then
    raise exception 'RENTHUB_FORBIDDEN: нужно войти, чтобы написать организатору'
      using errcode = '42501';
  end if;

  -- Верификации и блокировки здесь намеренно нет. Человек, застрявший на
  -- подтверждении номера, и человек, которого заблокировали по ошибке, —
  -- ровно те, кому написать нужнее всего. Закрыть им эту дверь значит
  -- оставить их без единственного способа возразить.
  perform support_add(v_user, p_text);
end;
$$;

-- ── booking_complete ──────────────────────────────
-- Тело перенесено из 20260816120100_trust_score.sql без изменений, кроме проверки.

create or replace function booking_complete(p_booking_id uuid, p_force boolean default false)
returns bookings
language plpgsql
security definer
set search_path = public
as $$
declare
  v_b bookings%rowtype;
begin
  -- coalesce обязателен, и это не перестраховка: первая версия этой
  -- заплатки написала «if not p_force», и вызов с p_force => null прошёл
  -- мимо проверки — та же трёхзначная логика, которая и породила всю
  -- находку. Поймал стенд, через один прогон после того, как правило
  -- было написано.
  if not coalesce(p_force, false) then
    perform assert_signed_in();
  end if;

  select * into v_b from bookings where id = p_booking_id;

  if not p_force and v_b.owner_id <> auth.uid() then
    raise exception 'RENTHUB_FORBIDDEN';
  end if;

  if v_b.status not in ('returned', 'disputed') then
    raise exception 'RENTHUB_BAD_STATE: закрыть можно только возвращённую сделку (статус %)', v_b.status;
  end if;

  if has_open_disputes(p_booking_id) then
    raise exception 'RENTHUB_OPEN_DISPUTE: по сделке есть неразрешённый спор';
  end if;

  perform settle_booking(p_booking_id);

  select * into v_b from bookings where id = p_booking_id;
  return v_b;
end;
$$;
