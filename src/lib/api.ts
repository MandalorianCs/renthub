import { PILOT_CITY, supabase } from './supabase';
import type {
  Booking,
  BookingWithItem,
  BusyRange,
  Category,
  PublicProfile,
  ReviewWithAuthor,
  Dispute,
  Item,
  ItemWithOwner,
  Notification,
  Payout,
  Review,
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
    // Ищем и по названию, и по описанию: «бур на 12» человек напишет
    // в комплектации, а не в заголовке, и по названию такое не найдётся.
    //
    // Запятая и скобки в or() — служебные символы PostgREST, поэтому
    // их из запроса вырезаем: иначе поиск «дрель, буры» развалит фильтр
    // на два условия и вернёт мусор.
    const q = params.search.trim().replace(/[,()]/g, ' ');
    query = query.or(`title.ilike.%${q}%,description.ilike.%${q}%`);
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

export async function createItem(input: {
  ownerId: string;
  category: string;
  title: string;
  description: string;
  dailyPrice: number;
  depositAmount: number;
  photos: string[];
}): Promise<Item> {
  const { data, error } = await supabase
    .from('items')
    .insert({
      owner_id: input.ownerId,
      category: input.category,
      title: input.title,
      description: input.description,
      daily_price: input.dailyPrice,
      deposit_amount: input.depositAmount,
      condition_photos: input.photos,
      city: PILOT_CITY,
    })
    .select()
    .single();
  if (error) throw error;
  return data;
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
    })
    .eq('id', id);
  if (error) throw error;
}

export async function setItemStatus(id: string, status: 'active' | 'hidden') {
  const { error } = await supabase.from('items').update({ status }).eq('id', id);
  if (error) throw error;
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

export async function cancelBooking(id: string) {
  const { error } = await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', id);
  if (error) throw error;
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

export async function submitReview(input: {
  bookingId: string;
  fromUserId: string;
  toUserId: string;
  rating: number;
  comment?: string;
}) {
  const { error } = await supabase.from('reviews').insert({
    booking_id: input.bookingId,
    from_user_id: input.fromUserId,
    to_user_id: input.toUserId,
    rating: input.rating,
    comment: input.comment ?? null,
  });
  if (error) throw error;
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

export async function fetchProfile(userId: string): Promise<User | null> {
  const { data, error } = await supabase.from('users').select('*').eq('id', userId).maybeSingle();
  if (error) throw error;
  return data;
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
export async function uploadPhoto(userId: string, uri: string): Promise<string> {
  const response = await fetch(uri);
  const blob = await response.arrayBuffer();
  const ext = uri.split('.').pop()?.split('?')[0] ?? 'jpg';
  const path = `${userId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  const { error } = await supabase.storage.from('item-photos').upload(path, blob, {
    contentType: `image/${ext === 'jpg' ? 'jpeg' : ext}`,
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
