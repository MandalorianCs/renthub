import { brandSpellings } from './tools';
import { PILOT_CITY, supabase } from './supabase';
import type {
  Booking,
  BookingContact,
  BookingWithItem,
  BusyRange,
  Category,
  PublicProfile,
  ReviewWithAuthor,
  Dispute,
  DisputeForReview,
  Item,
  ItemWithOwner,
  JoinRequest,
  ModerationOverview,
  ModerationPerson,
  Notification,
  Payout,
  Review,
  MySupportMessage,
  SupportMessage,
  User,
} from './types';

/**
 * Единственное место, где приложение обращается к базе.
 * Экраны не пишут запросы сами — иначе фильтр по городу или по статусу
 * рано или поздно разъедется между каталогом и поиском.
 */

// ── Справочники ───────────────────────────────────────────────

export async function fetchCategories(): Promise<Category[]> {
  const { data, error } = await supabase
    .from('categories')
    .select('*')
    .order('sort_order');
  if (error) throw error;
  return data ?? [];
}

// ── Каталог ───────────────────────────────────────────────────

/** Порядок выдачи каталога. Значения совпадают с подписями в интерфейсе. */
export type CatalogSort = 'new' | 'price_asc' | 'price_desc';

export async function fetchCatalog(params: {
  category?: string | null;
  search?: string;
  sort?: CatalogSort;
  maxPrice?: number | null;
  onlyIds?: string[] | null;
}): Promise<ItemWithOwner[]> {
  let query = supabase
    .from('items')
    .select('*, owner:users!items_owner_id_fkey(id, full_name, rating, ratings_count)')
    .eq('status', 'active')
    .eq('city', PILOT_CITY)
    .limit(60);

  // Сортировка делается базой, а не в памяти клиента: иначе limit(60)
  // отрежет не самые дешёвые, а самые новые, и «сначала дешёвые» соврёт.
  const sort = params.sort ?? 'new';
  if (sort === 'price_asc') query = query.order('daily_price', { ascending: true });
  else if (sort === 'price_desc') query = query.order('daily_price', { ascending: false });
  else query = query.order('created_at', { ascending: false });

  if (params.maxPrice && params.maxPrice > 0) query = query.lte('daily_price', params.maxPrice);
  if (params.onlyIds) {
    // Пустой список избранного не должен превращаться в «показать всё».
    if (params.onlyIds.length === 0) return [];
    query = query.in('id', params.onlyIds);
  }
  if (params.category) query = query.eq('category', params.category);
  if (params.search?.trim()) {
    // Ищем по названию, описанию и ориентиру: «бур на 12» человек напишет
    // в комплектации, а не в заголовке, а «Васильковский» — это запрос не
    // про инструмент вовсе, а про то, куда за ним ехать. Поле есть в
    // карточке, и не находить по нему то, что там написано, — обман.
    //
    // Запятая и скобки в or() — служебные символы PostgREST, поэтому
    // их из запроса вырезаем: иначе поиск «дрель, буры» развалит фильтр
    // на два условия и вернёт мусор.
    const q = params.search.trim().replace(/[,()]/g, ' ');

    // Марку ищем во всех её написаниях. Подсказки при публикации кладут в
    // название латиницу — «Перфоратор Bosch», — а ищут её кириллицей:
    // «бош». Без перевода собственная подсказка ухудшала бы находимость
    // вещи, которую с её помощью и опубликовали.
    const terms = [q, ...brandSpellings(q).map((t) => t.replace(/[,()]/g, ' '))];

    query = query.or(
      terms
        .map(
          (t) =>
            `title.ilike.%${t}%,description.ilike.%${t}%,pickup_area.ilike.%${t}%`,
        )
        .join(','),
    );
  }

  // ilike вместо полнотекстового поиска: на пилоте объявлений сотни,
  // а не миллионы — индекс окупится позже, сложность сейчас лишняя.

  const { data, error } = await query;
  if (error) throw error;
  return (data ?? []) as unknown as ItemWithOwner[];
}

export async function fetchItem(id: string): Promise<ItemWithOwner | null> {
  const { data, error } = await supabase
    .from('items')
    .select('*, owner:users!items_owner_id_fkey(id, full_name, rating, ratings_count)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as ItemWithOwner) ?? null;
}

export async function fetchMyItems(userId: string): Promise<Item[]> {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Публикация объявления.
 *
 * Через RPC, а не insert: тот же вход использует бот, а под сервисным
 * ключом RLS не применяется — значит правилу место в функции, иначе оно
 * жило бы в двух местах.
 *
 * Владелец и город больше не передаются. Первого функция берёт из
 * auth.uid(), второй ставит база своим дефолтом. Город, приходивший от
 * клиента, был единственным способом сломать витрину: разойдись
 * EXPO_PUBLIC_PILOT_CITY с дефолтом items.city — и объявления создавались
 * бы в одном городе, а искались в другом.
 */
export async function createItem(input: {
  category: string;
  title: string;
  description: string;
  dailyPrice: number;
  depositAmount: number;
  photos: string[];
  pickupArea: string;
}): Promise<Item> {
  return rpc<Item>('create_item', {
    p_category: input.category,
    p_title: input.title,
    p_daily_price: input.dailyPrice,
    p_deposit_amount: input.depositAmount,
    p_photos: input.photos,
    p_description: input.description,
    p_pickup_area: input.pickupArea,
  });
}

/**
 * Правка объявления. Цену менять можно — уже созданные брони это не
 * затронет: там лежит снимок цены на момент бронирования, и триггер
 * считает по нему, а не по текущей.
 */
export async function updateItem(
  id: string,
  input: {
    category: string;
    title: string;
    description: string;
    dailyPrice: number;
    depositAmount: number;
    photos: string[];
    pickupArea: string;
  },
): Promise<void> {
  const { error } = await supabase
    .from('items')
    .update({
      category: input.category,
      title: input.title,
      description: input.description,
      daily_price: input.dailyPrice,
      deposit_amount: input.depositAmount,
      condition_photos: input.photos,
      // Пустая строка -> null, а не '': ограничение таблицы запрещает
      // пробельный ориентир, и пустое поле формы иначе ломало бы сохранение.
      pickup_area: input.pickupArea.trim() || null,
    })
    .eq('id', id);
  if (error) throw error;
}

/**
 * Обращения участников, на которые ещё не ответили.
 *
 * Отвечает модератор той же кнопкой «Написать участнику», что и раньше:
 * moderator_notify() кладёт сообщение в notifications, а бот доставляет его
 * в тот же чат, откуда обращение и пришло. Отдельного канала связи заводить
 * не нужно — петля замыкается существующими частями.
 */
export async function fetchSupportMessages(): Promise<SupportMessage[]> {
  const rows = await rpc<SupportMessage[]>('support_open', {});
  return rows ?? [];
}

/**
 * Отметить обращение разобранным.
 *
 * Отдельным действием, а не автоматически по факту ответа: ответ может быть
 * уточняющим вопросом, и закрывать обращение после него значит терять
 * разговор на середине.
 */
export async function closeSupportMessage(id: string) {
  await rpc('support_close', { p_id: id });
}

/**
 * Написать организатору из приложения.
 *
 * Через RPC, а не вставкой в таблицу: правило приёма — длина текста и
 * предел в три открытых обращения — общее с ботом и живёт в support_add().
 * Права на прямую запись у участника нет и не будет: предел, который можно
 * обойти вставкой, не предел.
 *
 * Автор берётся из auth.uid() внутри функции, а не приходит аргументом.
 * Разница не косметическая: у ботовской двери автор именно аргумент, и
 * ровно поэтому её нельзя открывать сессионным ролям.
 */
export async function submitSupport(text: string) {
  await rpc('support_submit', { p_text: text });
}

/**
 * Свои обращения — что написал и разобрано ли.
 *
 * Показывать их обязательно: иначе «я вам писал» превращается в спор без
 * доказательств, а человек, не увидевший своего сообщения, пишет его ещё
 * раз и упирается в предел, которого не понимает.
 *
 * Выборкой, а не функцией: политика support_read_own уже пускает человека
 * к своим строкам и только к ним. Фильтр по user_id тут не защита, а
 * подсказка планировщику — защита в политике.
 */
export async function fetchMySupport(userId: string): Promise<MySupportMessage[]> {
  const { data, error } = await supabase
    .from('support_messages')
    .select('id, text, handled_at, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Очередь заявок на участие.
 *
 * Через функцию, а не выборкой: список заявок — это список чужих
 * телефонов, и право на него проверяется в одном месте, а не политикой на
 * таблицу и грантом порознь.
 */
export async function fetchJoinRequests(): Promise<JoinRequest[]> {
  const rows = await rpc<JoinRequest[]>('join_requests_open', {});
  return rows ?? [];
}

export async function closeJoinRequest(id: string) {
  await rpc('join_request_close', { p_id: id });
}

/**
 * Объявления, снятые модератором.
 *
 * Обычным запросом, а не функцией: политика items_read_moderator уже
 * открывает модератору все объявления, и заводить ради выборки
 * security definer значило бы городить второе выражение того же права.
 */
export async function fetchHeldItems(): Promise<ItemWithOwner[]> {
  const { data, error } = await supabase
    .from('items')
    .select('*, owner:users!items_owner_id_fkey(id, full_name, rating, ratings_count)')
    .not('moderated_at', 'is', null)
    .order('moderated_at', { ascending: false });
  if (error) throw error;
  return (data as unknown as ItemWithOwner[]) ?? [];
}

/**
 * Снять ограничение модератора.
 *
 * Объявление остаётся скрытым: «теперь можно» и «публикую» — разные
 * решения, и второе принимает владелец. Публикация чужой вещи от лица
 * модератора была бы действием за человека.
 */
export async function moderatorRestoreItem(itemId: string, note?: string) {
  await rpc('moderator_restore_item', { p_item_id: itemId, p_note: note ?? null });
}

/**
 * Пауза и публикация объявления.
 *
 * Через RPC, а не update: тот же вход есть у бота, а под сервисным ключом
 * RLS не применяется — значит правило владения должно жить в функции,
 * иначе для чата его пришлось бы написать второй раз. Политика
 * items_update_own остаётся вторым рубежом для всего, что ходит в таблицу
 * напрямую.
 */
export async function setItemStatus(id: string, status: 'active' | 'hidden') {
  await rpc('item_set_status', { p_item_id: id, p_status: status });
}

// ── Публичный профиль владельца ───────────────────────────────

/**
 * Всё, что нужно, чтобы решиться отдать незнакомцу вещь за 90 000 ₸:
 * кто он, как его оценили другие и что ещё он сдаёт.
 *
 * Телефон сюда не входит и войти не может: анониму он закрыт грантом
 * на колонки, а авторизованному не нужен до подтверждения брони.
 */
export async function fetchPublicProfile(userId: string): Promise<PublicProfile | null> {
  const { data, error } = await supabase
    .from('users')
    .select('id, full_name, rating, ratings_count, created_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as PublicProfile) ?? null;
}

/**
 * Сколько сделок человек довёл до конца.
 *
 * Через RPC по той же причине, что и календарь занятости: политика
 * bookings_read_participants показывает бронь только её сторонам, и прямой
 * `count(*)` вернул бы постороннему ноль — не «сделок нет», а «вам не
 * видно». Функция отдаёт одно число, без сторон, сумм и дат.
 *
 * Счётчик сильнее счётчика отзывов: отзыв оставляют не после каждой сделки,
 * и человек с двадцатью закрытыми арендами выглядел как человек с тремя.
 */
export async function fetchDealsCount(userId: string): Promise<number> {
  const { data, error } = await supabase.rpc('user_deals_count', { p_user_id: userId });
  if (error) throw error;
  return (data as number | null) ?? 0;
}

export async function fetchOwnerItems(ownerId: string): Promise<Item[]> {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('owner_id', ownerId)
    .eq('status', 'active')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Ещё вещи в той же категории.
 *
 * Карточка объявления была тупиком: либо бронировать, либо назад. А выбор
 * между «этим перфоратором» и «никаким» — не выбор; человек уходит искать
 * заново, и половина уходит совсем.
 *
 * Своё объявление исключается по id, а не фильтрацией на клиенте: иначе
 * при limit=4 одно из мест всегда занимал бы предмет, который человек уже
 * открыл.
 */
/**
 * Как связаться со второй стороной сделки.
 *
 * Телефон закрыт грантом на колонки даже вошедшему — витрина не место для
 * чужих номеров. Но вещь передают из рук в руки, и у сторон подтверждённой
 * брони задача другая: без контакта им остаётся угадывать, когда встретиться.
 *
 * Функция отдаёт контакт того, с кем у вызывающего общая бронь, и только
 * после подтверждения: до него владелец ещё ничего не обещал, а заявка не
 * должна работать способом собирать телефоны.
 */
export async function fetchBookingContact(bookingId: string): Promise<BookingContact | null> {
  const rows = await rpc<BookingContact[]>('booking_contact', { p_booking_id: bookingId });
  return rows?.[0] ?? null;
}

export async function fetchSimilarItems(
  category: string,
  excludeId: string,
  limit = 6,
): Promise<Item[]> {
  const { data, error } = await supabase
    .from('items')
    .select('*')
    .eq('category', category)
    .eq('status', 'active')
    .eq('city', PILOT_CITY)
    .neq('id', excludeId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}

export async function fetchReviewsAbout(userId: string): Promise<ReviewWithAuthor[]> {
  const { data, error } = await supabase
    .from('reviews')
    .select('*, author:users!reviews_from_user_id_fkey(id, full_name)')
    .eq('to_user_id', userId)
    .order('created_at', { ascending: false })
    .limit(30);
  if (error) throw error;
  return (data ?? []) as unknown as ReviewWithAuthor[];
}

// ── Избранное ─────────────────────────────────────────────────

/**
 * Аренда — про возвраты: перфоратор нужен раз в полгода, и во второй раз
 * человек хочет того же владельца, с которым уже всё прошло гладко.
 * Политика favorites_own закрывает чужие строки целиком, поэтому счётчика
 * «сколько людей добавили» здесь нет и быть не может.
 */
export async function fetchFavoriteIds(userId: string): Promise<string[]> {
  const { data, error } = await supabase
    .from('favorites')
    .select('item_id')
    .eq('user_id', userId);
  if (error) throw error;
  return (data ?? []).map((r) => r.item_id as string);
}

export async function toggleFavorite(userId: string, itemId: string, on: boolean) {
  if (on) {
    const { error } = await supabase.from('favorites').insert({ user_id: userId, item_id: itemId });
    if (error) throw error;
  } else {
    const { error } = await supabase
      .from('favorites')
      .delete()
      .eq('user_id', userId)
      .eq('item_id', itemId);
    if (error) throw error;
  }
}

// ── Календарь занятости ───────────────────────────────────────

/**
 * Занятые даты объявления.
 *
 * Идёт через RPC, а не через `from('bookings')`: политика RLS показывает
 * бронь только её сторонам, поэтому прямой запрос возвращал потенциальному
 * арендатору пустой список — то есть календарь был пуст ровно для того,
 * кому он нужен. Функция отдаёт только границы интервалов, без сторон
 * сделки и сумм.
 */
export async function fetchItemCalendar(itemId: string): Promise<BusyRange[]> {
  const { data, error } = await supabase.rpc('item_busy_dates', { p_item_id: itemId });
  if (error) throw error;
  return (data ?? []) as BusyRange[];
}

// ── Бронирования ──────────────────────────────────────────────

export async function createBooking(input: {
  itemId: string;
  renterId: string;
  startDate: string;
  endDate: string;
  insurance: boolean;
}): Promise<Booking> {
  // Суммы намеренно не передаём: их проставит триггер bookings_prepare
  // из цены объявления. Клиент не может назначить себе свою цену.
  const { data, error } = await supabase
    .from('bookings')
    .insert({
      item_id: input.itemId,
      renter_id: input.renterId,
      start_date: input.startDate,
      end_date: input.endDate,
      insurance_selected: input.insurance,
      // Заглушки под NOT NULL — триггер перезапишет их до вставки.
      owner_id: input.renterId,
      days: 1,
      daily_price_snapshot: 0,
      deposit_snapshot: 0,
      rent_total: 0,
      platform_fee: 0,
      insurance_fee: 0,
      renter_total: 0,
      owner_payout_total: 0,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
}

export async function fetchMyBookings(userId: string): Promise<BookingWithItem[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*, item:items(id, title, condition_photos, category)')
    .eq('renter_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as BookingWithItem[];
}

export async function fetchBooking(id: string): Promise<BookingWithItem | null> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*, item:items(id, title, condition_photos, category)')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  return (data as unknown as BookingWithItem) ?? null;
}

export async function fetchBookingReviews(bookingId: string): Promise<Review[]> {
  const { data, error } = await supabase.from('reviews').select('*').eq('booking_id', bookingId);
  if (error) throw error;
  return data ?? [];
}

export async function fetchOwnerBookings(userId: string): Promise<BookingWithItem[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*, item:items(id, title, condition_photos, category)')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as BookingWithItem[];
}

// Переходы статусов идут через RPC: каждая функция сама проверяет,
// кто её зовёт и из какого состояния. Прямой update из клиента закрыт RLS.
export const confirmBooking = (id: string) => rpc<Booking>('booking_confirm', { p_booking_id: id });
export const markPickedUp = (id: string) => rpc<Booking>('booking_mark_picked_up', { p_booking_id: id });
export const markReturned = (id: string) => rpc<Booking>('booking_mark_returned', { p_booking_id: id });
export const completeBooking = (id: string) => rpc<Booking>('booking_complete', { p_booking_id: id });

/**
 * Отмена неподтверждённой заявки.
 *
 * Через RPC, а не прямым UPDATE. Политика bookings_cancel_pending проверяла
 * в `with check` только renter_id и статус, поэтому тем же запросом можно
 * было переписать и суммы своей брони. Функция меняет один столбец, а ещё
 * отвечает отказом вместо молчаливого нуля изменённых строк — политика
 * фильтрует строки, и «ничего не подошло» выглядело как успех.
 */
export async function cancelBooking(id: string) {
  return rpc<void>('booking_cancel', { p_booking_id: id });
}

// ── Споры ─────────────────────────────────────────────────────

export function openDamageDispute(input: {
  bookingId: string;
  claimAmount: number;
  photos: string[];
  description?: string;
}) {
  return rpc<Dispute>('open_damage_dispute', {
    p_booking_id: input.bookingId,
    p_claim_amount: input.claimAmount,
    p_photos: input.photos,
    p_description: input.description ?? null,
  });
}

export async function fetchDisputes(bookingId: string): Promise<Dispute[]> {
  const { data, error } = await supabase
    .from('disputes')
    .select('*')
    .eq('booking_id', bookingId)
    .order('created_at');
  if (error) throw error;
  return data ?? [];
}

// ── Модерация споров ──────────────────────────────────────────

/**
 * Споры, ждущие человека. Видны только модератору — политики
 * disputes_read_moderator и bookings_read_moderator, добавленные вместе
 * с ролью. Обычный пользователь получит здесь пустой список, а не отказ:
 * RLS фильтрует строки, а не запрещает запрос.
 */
export async function fetchDisputesForReview(): Promise<DisputeForReview[]> {
  const { data, error } = await supabase
    .from('disputes')
    .select(
      '*, booking:bookings(id, start_date, end_date, deposit_snapshot, renter_id, owner_id, item:items(id, title, condition_photos))',
    )
    .eq('resolution_status', 'manual_review')
    .order('created_at');
  if (error) throw error;
  return (data ?? []) as unknown as DisputeForReview[];
}

/**
 * Сводка по платформе. Считается запросами с head: true — база возвращает
 * только число, не строки: на пилоте разница невелика, но список сделок
 * ради счётчика тянуть незачем.
 *
 * Числа приходят уже отфильтрованными политиками: модератор видит все
 * сделки и споры, обычный пользователь получил бы здесь свои — то есть
 * экран не соврёт даже если открыть его без права.
 */
/**
 * Сводка модератора.
 *
 * Раньше здесь было четыре запроса вида `select('*', { count: 'exact' })`.
 * После закрытия личных колонок (миграция 20260819100000) такой запрос к
 * users стал отказом: «звёздочка» разворачивается во все колонки, включая
 * телефон и telegram_id. Числа пропали с экрана целиком — считать их
 * клиенту больше нечем.
 *
 * Теперь считает база: moderation_overview() проверяет право модератора
 * внутри себя и возвращает только числа и короткие строки событий. Заодно
 * это один запрос вместо четырёх и данных больше — разрез по статусам и
 * лента последних событий.
 */
/**
 * Действия модератора.
 *
 * Все три — функции Postgres с проверкой права внутри. Клиент не решает,
 * можно ли: он спрашивает, а отказ приходит из базы. Поэтому те же действия
 * будут доступны будущему боту без дублирования правил.
 */
export async function setUserBlocked(userId: string, blocked: boolean, reason?: string) {
  const { error } = await supabase.rpc('set_user_blocked', {
    p_user_id: userId,
    p_blocked: blocked,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

export async function moderatorHideItem(itemId: string, reason?: string) {
  const { error } = await supabase.rpc('moderator_hide_item', {
    p_item_id: itemId,
    p_reason: reason ?? null,
  });
  if (error) throw error;
}

export async function moderatorNotify(userId: string, title: string, body: string) {
  const { error } = await supabase.rpc('moderator_notify', {
    p_user_id: userId,
    p_title: title,
    p_body: body,
  });
  if (error) throw error;
}

/** Поимённый список участников. Отказывает всем, кроме модератора. */
export async function fetchModerationPeople(): Promise<ModerationPerson[]> {
  const { data, error } = await supabase.rpc('moderation_people');
  if (error) throw error;
  return (data ?? []) as ModerationPerson[];
}

export async function fetchModerationOverview(): Promise<ModerationOverview> {
  const { data, error } = await supabase.rpc('moderation_overview');
  if (error) throw error;
  return data as ModerationOverview;
}

export function resolveDispute(input: { disputeId: string; amount: number; note?: string }) {
  return rpc<Dispute>('resolve_dispute_manually', {
    p_dispute_id: input.disputeId,
    p_payout_amount: input.amount,
    p_note: input.note ?? null,
  });
}

// ── Выплаты, отзывы, уведомления ──────────────────────────────

export async function fetchPayouts(userId: string): Promise<Payout[]> {
  const { data, error } = await supabase
    .from('payouts')
    .select('*')
    .eq('owner_id', userId)
    .order('period_start', { ascending: false });
  if (error) throw error;
  return data ?? [];
}

/**
 * Отзыв о второй стороне.
 *
 * Автор не передаётся: функция берёт его из auth.uid(). Раньше он приходил
 * полем from_user_id, а совпадение с вошедшим держала политика — теперь
 * подставить чужого нельзя даже по ошибке. Тот же вход использует бот.
 */
export async function submitReview(input: {
  bookingId: string;
  toUserId: string;
  rating: number;
  comment?: string;
}) {
  return rpc<void>('submit_review', {
    p_booking_id: input.bookingId,
    p_to_user: input.toUserId,
    p_rating: input.rating,
    p_comment: input.comment ?? null,
  });
}

export async function fetchNotifications(userId: string): Promise<Notification[]> {
  const { data, error } = await supabase
    .from('notifications')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) throw error;
  return (data ?? []) as unknown as Notification[];
}

export async function markNotificationsRead(userId: string) {
  const { error } = await supabase
    .from('notifications')
    .update({ read_at: new Date().toISOString() })
    .eq('user_id', userId)
    .is('read_at', null);
  if (error) throw error;
}

// ── Профиль ───────────────────────────────────────────────────

/**
 * Свой профиль — через функцию, а не запросом к таблице.
 *
 * Телефон и telegram_id закрыты грантом на колонки (миграция
 * 20260819100000): читать их из приложения можно только так. Функция
 * возвращает строго строку вызывающего — идентификатор берётся из
 * auth.uid(), а не из аргумента, поэтому подставить чужой нельзя.
 *
 * userId остаётся в сигнатуре: он не нужен запросу, но нужен вызывающим —
 * там, где профиля ещё нет, вызывать функцию незачем.
 */
export async function fetchProfile(userId: string): Promise<User | null> {
  if (!userId) return null;
  const { data, error } = await supabase.rpc('my_profile');
  if (error) throw error;
  return (data as User | null) ?? null;
}

export async function updateProfile(userId: string, patch: Partial<Pick<User, 'full_name' | 'passive_mode' | 'role_hint'>>) {
  const { error } = await supabase.from('users').update(patch).eq('id', userId);
  if (error) throw error;
}

// ── Загрузка фото ─────────────────────────────────────────────

/**
 * Путь строится как `<user_id>/<файл>` — ровно это проверяет
 * storage-политика item_photos_write: писать можно только в свою папку.
 */
/** Тип файла → расширение. Список закрытый: в хранилище незачем принимать всё. */
const PHOTO_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'image/heif': 'heif',
};

/**
 * Тип и расширение снимка.
 *
 * Спрашиваем сам файл, а не его адрес. Причина: на телефоне выбор фото
 * отдаёт `file:///…/IMG_0042.jpg`, где расширение есть, а в браузере —
 * `blob:http://localhost:8081/d0a1bcc3-…`, где нет ни точки, ни расширения.
 * Прежний код брал «всё после последней точки», получал на вебе весь адрес
 * целиком и собирал из него путь в хранилище: с двоеточием и слешами внутри.
 * Такой ключ отвергают и Storage, и политика item_photos_write, которая ждёт
 * ровно две части пути — папку владельца и имя файла. Симптом был тихий:
 * фото просто не загружались.
 */
function photoKind(uri: string, headerType: string | null): { ext: string; contentType: string } {
  const declared = (headerType ?? '').split(';')[0].trim().toLowerCase();
  if (PHOTO_EXT[declared]) return { ext: PHOTO_EXT[declared], contentType: declared };

  // Заголовка нет (так бывает с file:// на телефоне) — пробуем адрес, но
  // принимаем только то, что похоже на расширение, а не любой хвост.
  const tail = uri.split('?')[0].split('#')[0].split('.').pop() ?? '';
  const ext = /^[a-z0-9]{2,5}$/i.test(tail) ? tail.toLowerCase() : 'jpg';
  const known = Object.entries(PHOTO_EXT).find(([, e]) => e === ext);
  return { ext: known ? known[1] : 'jpg', contentType: known ? known[0] : 'image/jpeg' };
}

export async function uploadPhoto(userId: string, uri: string): Promise<string> {
  const response = await fetch(uri);
  const bytes = await response.arrayBuffer();
  const { ext, contentType } = photoKind(uri, response.headers.get('content-type'));
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage.from('item-photos').upload(path, bytes, {
    contentType,
    upsert: false,
  });
  if (error) throw error;

  return supabase.storage.from('item-photos').getPublicUrl(path).data.publicUrl;
}

// ── Вспомогательное ───────────────────────────────────────────

async function rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw error;
  return data as T;
}
