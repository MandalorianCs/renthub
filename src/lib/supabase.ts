import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient } from '@supabase/supabase-js';
import { Platform } from 'react-native';
import 'react-native-url-polyfill/auto';

const url = process.env.EXPO_PUBLIC_SUPABASE_URL;
const anonKey = process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;

if (!url || !anonKey) {
  throw new Error(
    'Не заданы EXPO_PUBLIC_SUPABASE_URL / EXPO_PUBLIC_SUPABASE_ANON_KEY. ' +
      'Скопируйте .env.example в .env и подставьте значения из Supabase.',
  );
}

export const supabase = createClient(url, anonKey, {
  auth: {
    // На вебе сессию хранит сам браузер (localStorage). На телефоне
    // своего хранилища нет — подсовываем AsyncStorage, иначе пользователь
    // будет логиниться заново при каждом запуске.
    storage: Platform.OS === 'web' ? undefined : AsyncStorage,
    autoRefreshToken: true,
    persistSession: true,
    // detectSessionInUrl нужен только вебу, где токен прилетает в hash.
    detectSessionInUrl: Platform.OS === 'web',
  },
});

export const PILOT_CITY = process.env.EXPO_PUBLIC_PILOT_CITY ?? 'almaty';

/**
 * Ошибки бизнес-правил приходят из Postgres как `RENTHUB_CODE: текст`.
 * Показываем пользователю человеческую часть, а не сырой SQL-стейт.
 */
export function humanizeError(error: unknown): string {
  const raw =
    typeof error === 'object' && error !== null && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error);

  // Не все отказы приходят как RENTHUB_*. Часть запретов — это ограничения
  // самого Postgres, и их текст английский и технический. Показывать его
  // пользователю нельзя: «conflicting key value violates exclusion constraint»
  // ничего ему не говорит, хотя означает всего лишь «даты уже заняты».
  const constraints: Array<[RegExp, string]> = [
    [/bookings_no_overlap/, 'Эти даты уже заняты — выберите другие'],
    [/reviews_booking_id_from_user_id_key/, 'Вы уже оставили отзыв по этой сделке'],
    [/disputes_booking_id_type_key/, 'Претензия по этой сделке уже подана'],
    [/bookings_check|end_date/, 'Проверьте даты: конец не может быть раньше начала'],
    [/items_title_check/, 'Название слишком короткое'],
    [/daily_price_check/, 'Цена должна быть больше нуля'],
    [/Failed to fetch|NetworkError|Load failed/i, 'Нет связи с сервером — проверьте интернет'],
  ];

  for (const [pattern, text] of constraints) {
    if (pattern.test(raw)) return text;
  }

  const match = raw.match(/RENTHUB_([A-Z_]+):?\s*(.*)/);
  if (!match) return raw;

  const [, code, tail] = match;
  if (tail) return tail;

  const fallbacks: Record<string, string> = {
    NOT_VERIFIED: 'Сначала подтвердите номер телефона',
    FORBIDDEN: 'Это действие доступно другой стороне сделки',
    BAD_STATE: 'Сделка находится в другом статусе — обновите экран',
    ITEM_HIDDEN: 'Объявление снято с публикации',
    SELF_BOOKING: 'Нельзя забронировать собственную вещь',
    NO_EVIDENCE: 'Приложите фото состояния вещи',
    CLAIM_WINDOW_CLOSED: 'Срок подачи претензии истёк',
    OPEN_DISPUTE: 'По сделке есть неразрешённый спор',
  };

  return fallbacks[code] ?? raw;
}
