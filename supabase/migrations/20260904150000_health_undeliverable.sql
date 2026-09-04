-- «Не доставлено» и «доставлять некуда» — разные вещи.
--
-- Первый же прогон `npm run health` показал два уведомления в очереди
-- возрастом двое суток и поднял тревогу «бот не запущен». Бот был запущен.
--
-- Измерено: оба адресованы участнику без `telegram_id`. Бот пропускает
-- такие намеренно и отметку не ставит — человек может привязать Telegram
-- позже, и тогда всё, что накопилось, придёт одной пачкой. То есть
-- поведение верное, а метрика неверная: она считала недоставляемое
-- недоставленным.
--
-- Цена ошибки не в цифре. Тревога, которая горит всегда и «так и должно
-- быть», перестаёт читаться — и однажды скрывает настоящую поломку. HANDOFF
-- разбирает ровно этот случай с красным workflow в Actions, который никто
-- уже не открывает.
--
-- Поэтому очередь разделена. Первое число — работа бота, по нему и тревога.
-- Второе — не поломка, а факт про человека: он получает ответы только в
-- ленте приложения, и организатору стоит это знать, отвечая ему.

create or replace function platform_health()
returns table (
  part    text,
  state   text,
  alarm   boolean
)
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_jobs      integer := 0;
  v_waiting   integer;
  v_oldest    interval;
  v_nowhere   integer;
begin
  -- Планировщик.
  if to_regclass('cron.job') is not null then
    execute $q$
      select count(*) from cron.job where command like '%process_overdue_bookings%'
    $q$ into v_jobs;

    part  := 'планировщик';
    state := case
               when v_jobs > 0 then format('задача есть (%s)', v_jobs)
               else 'pg_cron включён, но задачи нет'
             end;
    alarm := v_jobs = 0;
  else
    part  := 'планировщик';
    state := 'pg_cron не включён — просрочки не разбираются';
    alarm := true;
  end if;
  return next;

  -- Ждут доставки: получатель привязал Telegram, значит доставить есть куда.
  select count(*), max(now() - n.created_at)
    into v_waiting, v_oldest
    from notifications n
    join users u on u.id = n.user_id
   where n.sent_at is null and u.telegram_id is not null;

  part  := 'доставка уведомлений';
  state := case
             when v_waiting = 0 then 'очередь пуста'
             else format('%s ждут, самому старому %s',
                         v_waiting, date_trunc('minute', v_oldest))
           end;
  -- Тревога по возрасту, а не по числу: очередь наполняется и при живом
  -- боте — между записью и следующим опросом проходит до пятнадцати секунд.
  -- Десять минут означают, что опроса нет.
  alarm := coalesce(v_oldest > interval '10 minutes', false);
  return next;

  -- Доставлять некуда: Telegram не привязан. Не поломка — человек видит
  -- эти уведомления в ленте приложения, `sent_at` означает только «ушло в
  -- чат». Но организатору, который ему отвечает, стоит знать, что ответ в
  -- Telegram не придёт.
  select count(*)
    into v_nowhere
    from notifications n
    join users u on u.id = n.user_id
   where n.sent_at is null and u.telegram_id is null;

  if v_nowhere > 0 then
    part  := 'без Telegram';
    state := format('%s уведомлений некуда доставить — человек увидит их только в приложении',
                    v_nowhere);
    alarm := false;
    return next;
  end if;
end;
$$;

comment on function platform_health() is
  'Живо ли то, что обещано словами: планировщик просрочек и доставка '
  'уведомлений. Очередь разделена: «ждут доставки» — работа бота, '
  '«доставлять некуда» — человек без Telegram, и это не поломка.';

revoke all on function platform_health() from public;
revoke all on function platform_health() from anon, authenticated;
