-- Контакт второй стороны — и в Telegram тоже.
--
-- booking_contact() появилась для приложения, и на этом расхождение уже
-- началось бы: человек, который ведёт сделку из чата, видел бы у себя
-- меньше, чем тот же человек в приложении. Бот для того и сделан, чтобы
-- не заставлять открывать приложение ради одного действия.
--
-- Обёртка та же, что у остальных bot_*: выставляет auth.uid() и зовёт ту
-- же функцию. Правило «контакт только сторонам и только после
-- подтверждения» остаётся в одном месте — в booking_contact(), — и бот
-- его не знает.

create or replace function bot_booking_contact(p_actor uuid, p_booking_id uuid)
returns table (
  user_id           uuid,
  full_name         text,
  phone             text,
  telegram_username text
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);
  perform set_config('request.jwt.claims',
    json_build_object('sub', p_actor, 'role', 'authenticated')::text, true);
  return query select * from booking_contact(p_booking_id);
end;
$$;

comment on function bot_booking_contact(uuid, uuid) is
  'Контакт второй стороны для бота. Проверок не дублирует — выставляет '
  'auth.uid() и зовёт booking_contact(). Только для сервисного ключа.';

revoke all on function bot_booking_contact(uuid, uuid) from public;
revoke execute on function bot_booking_contact(uuid, uuid) from anon, authenticated;
