import { PILOT_CITY, supabase } from './supabase';
import type {
  Booking,
  BookingWithItem,
  Category,
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

export async function fetchCatalog(params: {
  category?: string | null;
  search?: string;
}): Promise<ItemWithOwner[]> {
  let query = supabase
    .from('items')
    .select('*, owner:users!items_owner_id_fkey(id, full_name, rating, ratings_count)')
    .eq('status', 'active')
    .eq('city', PILOT_CITY)
    .order('created_at', { ascending: false })
    .limit(60);

  if (params.category) query = query.eq('category', params.category);
  if (params.search?.trim()) {
    // ilike вместо полнотекстового поиска: на пилоте объявлений сотни,
    // а не миллионы — индекс окупится позже, сложность сейчас лишняя.
    query = query.ilike('title', `%${params.search.trim()}%`);
  }

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

export async function setItemStatus(id: string, status: 'active' | 'hidden') {
  const { error } = await supabase.from('items').update({ status }).eq('id', id);
  if (error) throw error;
}

// ── Календарь занятости ───────────────────────────────────────

/**
 * Владелец видит те же сырые данные, что и платформа — не сводку
 * постфактум. Это и есть ответ на «а вдруг вы сдали мою вещь на 5 дней,
 * а говорите про 30».
 */
export async function fetchItemCalendar(itemId: string): Promise<Booking[]> {
  const { data, error } = await supabase
    .from('bookings')
    .select('*')
    .eq('item_id', itemId)
    .in('status', ['pending', 'confirmed', 'active'])
    .order('start_date');
  if (error) throw error;
  return data ?? [];
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
