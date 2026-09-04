-- «2 уведомлений» в сводке состояния.
--
-- Правило склонения записано в DESIGN.md для экранов, и здесь оно тоже
-- уместно по той же причине, по которой его дали выводу стенда: сводку
-- читает организатор, и «1 уведомлений» выглядит как сбой подсчёта, а не
-- как одно уведомление.
--
-- Функция целиком повторена: create or replace иначе не умеет. Изменилась
-- одна строка формата.

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
    state := format('%s %s некуда доставить — человек увидит их только в приложении',
                    v_nowhere,
                    case
                      when v_nowhere % 100 between 11 and 14 then 'уведомлений'
                      when v_nowhere % 10 = 1 then 'уведомление'
                      when v_nowhere % 10 between 2 and 4 then 'уведомления'
                      else 'уведомлений'
                    end);
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
