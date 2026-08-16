-- Избранное.
--
-- Аренда отличается от покупки тем, что к вещи возвращаются: перфоратор
-- нужен раз в полгода, и во второй раз человек хочет взять тот же — у
-- владельца, с которым уже всё прошло гладко. Список избранного делает
-- этот повтор возможным, а для платформы это дешёвый повторный заказ
-- вместо нового привлечения.

create table favorites (
  user_id    uuid not null references users (id) on delete cascade,
  item_id    uuid not null references items (id) on delete cascade,
  created_at timestamptz not null default now(),

  -- Составной ключ вместо суррогатного id: «добавить в избранное дважды»
  -- не имеет смысла, и база должна делать это невозможным, а не приложение.
  primary key (user_id, item_id)
);

create index favorites_user_idx on favorites (user_id, created_at desc);

alter table favorites enable row level security;

-- Своё избранное — целиком своё: и читать, и менять. Чужое не видно вообще,
-- поэтому счётчика «сколько людей добавили» здесь намеренно нет: он потребовал
-- бы открыть чужие строки на чтение.
create policy favorites_own on favorites
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
