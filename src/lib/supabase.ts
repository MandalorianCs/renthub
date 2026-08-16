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
