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
  status: ItemStatus;
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
