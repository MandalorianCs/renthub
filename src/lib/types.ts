/** Типы повторяют схему из supabase/migrations/20260816120000_schema.sql. */

export type ItemStatus = 'active' | 'hidden';

export type BookingStatus =
  | 'pending'
  | 'confirmed'
  | 'active'
  | 'returned'
  | 'completed'
  | 'disputed'
  | 'cancelled';

export type DepositStatus = 'held' | 'released' | 'claimed';
export type DisputeType = 'damage' | 'non_return';
export type DisputeResolution = 'auto_resolved' | 'manual_review' | 'resolved';
export type PayoutStatus = 'scheduled' | 'released';

/** Аренда и компенсация ущерба — разные деньги: с компенсации комиссия не берётся. */
export type PayoutKind = 'rent' | 'damage_compensation';

export type User = {
  id: string;
  phone: string;
  full_name: string | null;
  verified_at: string | null;
  rating: number | null;
  ratings_count: number;
  role_hint: string;
  passive_mode: boolean;
  /** Право разбирать споры выше порога. Выдаётся только сервисным ключом. */
  is_moderator: boolean;
  /**
   * Чат с ботом. Заполняет бот после «Поделиться номером» — раньше этого
   * момента написать человеку в Telegram нельзя, так устроен сам Telegram.
   */
  telegram_id: number | null;
  telegram_username: string | null;
  created_at: string;
};

/**
 * Сводка для вкладки «Модерация» — то, что возвращает moderation_overview().
 *
 * Считает база, а не клиент: подсчёт на клиенте потребовал бы читать чужие
 * строки, а там телефоны и суммы. Функция отдаёт только числа и короткие
 * строки событий.
 */
export type ModerationOverview = {
  users: { total: number; verified: number; telegram: number; week: number };
  items: { active: number; hidden: number; week: number };
  bookings: {
    pending: number;
    confirmed: number;
    active: number;
    returned: number;
    completed: number;
    cancelled: number;
    week: number;
  };
  disputes: { open: number; auto: number; resolved: number };
  recent: Array<{ at: string; kind: 'user' | 'item' | 'booking'; text: string }>;
};

/**
 * Строка поимённого списка участников — moderation_people().
 *
 * Телефон здесь есть намеренно: пилот идёт по личным приглашениям, и
 * оператор обзванивает людей сам. Право на этот список выдаётся только
 * сервисным ключом, а в общей сводке телефонов нет — стенд проверяет.
 */
export type ModerationPerson = {
  id: string;
  full_name: string | null;
  phone: string;
  verified: boolean;
  telegram: boolean;
  is_moderator: boolean;
  /** Заблокирован модератором: не может создавать объявления и брони. */
  blocked: boolean;
  blocked_reason: string | null;
  items: number;
  bookings: number;
  created_at: string;
};

export type Category = {
  slug: string;
  title_ru: string;
  sort_order: number;
};

export type Item = {
  id: string;
  owner_id: string;
  category: string;
  title: string;
  description: string | null;
  daily_price: number;
  deposit_amount: number;
  condition_photos: string[];
  city: string;
  /** Район или ориентир, где забирать. Необязательный: у части вещей его нет. */
  pickup_area: string | null;
  status: ItemStatus;
  /**
   * Снято модератором. Отличается от status: hidden означало сразу и паузу
   * владельца, и решение модератора, а права на выход из них разные —
   * вернуть в каталог снятое модератором владелец не может.
   */
  moderated_at: string | null;
  moderated_reason: string | null;
  created_at: string;
  updated_at: string;
};

/** Объявление вместе с профилем владельца — то, что нужно карточке каталога. */
export type ItemWithOwner = Item & {
  owner: Pick<User, 'id' | 'full_name' | 'rating' | 'ratings_count'> | null;
};

export type Booking = {
  id: string;
  item_id: string;
  renter_id: string;
  owner_id: string;
  start_date: string;
  end_date: string;
  days: number;
  status: BookingStatus;
  deposit_status: DepositStatus;
  daily_price_snapshot: number;
  deposit_snapshot: number;
  insurance_selected: boolean;
  rent_total: number;
  platform_fee: number;
  insurance_fee: number;
  renter_total: number;
  owner_payout_total: number;
  grace_period_ends_at: string | null;
  damage_claim_ends_at: string | null;
  picked_up_at: string | null;
  returned_at: string | null;
  completed_at: string | null;
  created_at: string;
};

export type BookingWithItem = Booking & {
  item: Pick<Item, 'id' | 'title' | 'condition_photos' | 'category'> | null;
};

export type ReviewWithAuthor = Review & {
  author: { id: string; full_name: string | null } | null;
};

/**
 * Спор со всем, что нужно для решения: суммой депозита, фото «до» из
 * объявления и фото «после» из самой претензии. Без обеих пачек снимков
 * решение принимается вслепую по одной стороне.
 */
export type DisputeForReview = Dispute & {
  booking: {
    id: string;
    start_date: string;
    end_date: string;
    deposit_snapshot: number;
    renter_id: string;
    owner_id: string;
    item: { id: string; title: string; condition_photos: string[] } | null;
  } | null;
};

export type Payout = {
  id: string;
  booking_id: string;
  owner_id: string;
  period_start: string;
  period_end: string;
  amount: number;
  kind: PayoutKind;
  status: PayoutStatus;
  released_at: string | null;
};

/**
 * Занятый интервал объявления. Намеренно беднее Booking: RPC item_busy_dates
 * отдаёт только границы, потому что чужая бронь — не наше дело, а вот занятые
 * даты обязан видеть каждый, кто выбирает срок.
 */
export type BusyRange = {
  start_date: string;
  end_date: string;
};

/**
 * Профиль в том объёме, в каком его видит посторонний. Телефона здесь нет
 * не потому, что забыли: анониму он закрыт грантом на колонки в базе.
 */
export type PublicProfile = {
  id: string;
  full_name: string | null;
  rating: number | null;
  ratings_count: number;
  created_at: string;
};

/** Контакт второй стороны сделки — только после подтверждения брони. */
export type BookingContact = {
  user_id: string;
  full_name: string | null;
  phone: string;
  telegram_username: string | null;
};

export type Review = {
  id: string;
  booking_id: string;
  from_user_id: string;
  to_user_id: string;
  rating: number;
  comment: string | null;
  created_at: string;
};

export type Dispute = {
  id: string;
  booking_id: string;
  opened_by: string | null;
  type: DisputeType;
  description: string | null;
  evidence_photos: string[];
  claim_amount: number;
  resolution_status: DisputeResolution;
  payout_amount: number;
  resolution_note: string | null;
  resolved_at: string | null;
  created_at: string;
};

export type Notification = {
  id: string;
  user_id: string;
  booking_id: string | null;
  type: string;
  title: string;
  body: string | null;
  payload: Record<string, unknown>;
  read_at: string | null;
  created_at: string;
};
