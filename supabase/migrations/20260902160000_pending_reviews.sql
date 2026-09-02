-- Оценить вторую сторону можно не только из одного уведомления.
--
-- Пробел нашёлся сверкой таблицы «чей ход» с кнопками бота. Для закрытой
-- сделки shared/next-move.json говорит обеим сторонам: «Оцените вторую
-- сторону — это единственное, что осталось». То есть система прямо
-- называет это ходом человека.
--
-- А сделать этот ход в чате можно было ровно один раз: звёзды приходят с
-- уведомлением о закрытии. Пролистал, отвлёкся, вернулся через день — и
-- всё: /сделки показывает только живые сделки, а закрытая туда не попадает
-- по построению («что сейчас», а не история).
--
-- Отзывы — не украшение: рейтинг владельца и есть то, ради чего незнакомец
-- соглашается отдать вещь за 90 000 ₸. Терять их из-за пролистанного
-- сообщения дорого.
--
-- Отдельной функцией, потому что условие «нет моего отзыва» PostgREST
-- фильтром не выразить: это отрицание существования строки в другой
-- таблице. Тип возврата заодно держит границу — телефон второй стороны
-- сюда не попадает, для него есть booking_contact().

create or replace function bot_pending_reviews(p_actor uuid)
returns table (
  id           uuid,
  title        text,
  other_name   text,
  completed_at timestamptz
)
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  perform bot_actor_ok(p_actor);

  return query
    select b.id,
           i.title,
           u.full_name,
           b.completed_at
      from bookings b
      join items i on i.id = b.item_id
      join users u
        on u.id = case when b.owner_id = p_actor then b.renter_id else b.owner_id end
     where b.status = 'completed'
       and (b.owner_id = p_actor or b.renter_id = p_actor)
       and not exists (
         select 1 from reviews r
          where r.booking_id = b.id and r.from_user_id = p_actor
       )
     order by b.completed_at desc nulls last
     -- Пять последних, а не все: /сделки отвечает на вопрос «что от меня
     -- осталось», а не заменяет историю. Список из тридцати закрытых сделок
     -- утопил бы живые, ради которых команду и открывают.
     limit 5;
end;
$$;

comment on function bot_pending_reviews(uuid) is
  'Закрытые сделки, где участник ещё не поставил оценку. Нужна потому, что '
  'условие «нет моего отзыва» — отрицание существования строки в другой '
  'таблице, и фильтром PostgREST не выражается.';

revoke all on function bot_pending_reviews(uuid) from public;
revoke all on function bot_pending_reviews(uuid) from authenticated;
