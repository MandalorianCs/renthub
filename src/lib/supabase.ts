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

export const PILOT_CITY = process.env.EXPO_PUBLIC_PILOT_CITY ?? 'kokshetau';

/**
 * Ссылка на бота.
 *
 * Значение вынесено в переменную по той же причине, что и город: имя бота
 * встречается и в приложении, и на лендинге, и разойтись они не должны.
 * Запасное значение стоит здесь, а не в .env, чтобы сборка без переменной
 * вела на живого бота, а не в никуда.
 */
export const TELEGRAM_BOT = process.env.EXPO_PUBLIC_TELEGRAM_BOT ?? 'renthub_kokshetau_bot';
export const TELEGRAM_BOT_URL = `https://t.me/${TELEGRAM_BOT}`;

/**
 * Куда возвращает ссылка из письма.
 *
 * Указывать это обязательно, хотя одного указания и мало. Измерено
 * 04.09.2026 через `admin.generateLink`, который отдаёт ту самую ссылку,
 * не отправляя письма:
 *
 *   без redirectTo            → redirect_to = http://localhost:3000
 *   с redirectTo на витрину   → redirect_to = http://localhost:3000
 *
 * Первая строка — это Site URL проекта, оставшийся по умолчанию. Вторая
 * говорит больше: запрошенный адрес **подменён**, потому что его нет в
 * списке Redirect URLs. GoTrue не отказывает, а молча берёт Site URL — и
 * человек уезжает на localhost:3000, которого у него нет.
 *
 * Поэтому порядок такой: здесь мы просим правильный адрес, а разрешить
 * его должен организатор в панели — README, «Что настроить в панели
 * Supabase». `npm run health` проверяет это той же командой и говорит,
 * куда ссылка ведёт на самом деле.
 *
 * На вебе берём адрес текущей вкладки: тогда локальная разработка
 * возвращает на localhost, а публикация — на Pages, без второй
 * переменной, которая однажды разойдётся с первой.
 */
export const EMAIL_RETURN_URL =
  Platform.OS === 'web' && typeof window !== 'undefined'
    ? window.location.origin + window.location.pathname
    : 'https://mandaloriancs.github.io/renthub/app/';

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
    [/items_photos_count/, 'Нужно от одного до шести фото вещи'],
    [/items_pickup_area_check/, 'Ориентир: от 2 до 80 символов, или оставьте пустым'],
    [/daily_price_check/, 'Цена должна быть больше нуля'],
    // Ограничению дано имя в миграции, а не оставлено Postgres:
    // автоимя зависит от порядка колонок, а эта строка на него
    // ссылается. Путь сюда один — прямой update из формы правки
    // объявления; публикация и «изменить цену» отвечают раньше и
    // по-русски.
    [/items_daily_price_max/, 'Цена за сутки больше миллиона — проверьте, нет ли лишнего нуля'],
    [/Failed to fetch|NetworkError|Load failed/i, 'Нет связи с сервером — проверьте интернет'],
    // Хук входа отвечает по-русски и подробно — три разных объяснения на три
    // разных положения, — но человеку они не доходят: GoTrue не пропускает
    // тело ответа и подставляет своё «Unexpected status code returned from
    // hook: 404».
    //
    // Измерено на живой базе 04.09.2026, и это не редкий случай: из восьми
    // участников семеро ещё не привязали Telegram, то есть почти каждый,
    // кто откроет вкладку «По SMS», получит именно 409.
    //
    // Тексты ниже повторяют то, что написано в самой функции
    // (supabase/functions/telegram-otp/index.ts) — там же лежит и разбор,
    // почему сообщение теряется по дороге.
    [
      /hook: 404/,
      'Этот номер не участвует в пилоте. Доступ выдаёт организатор — ' +
        'оставьте заявку через бота, это одно нажатие',
    ],
    [
      /hook: 409/,
      'Telegram ещё не привязан. Откройте бота, нажмите «Поделиться номером» ' +
        'и повторите вход — код придёт туда',
    ],
    [/hook: 5\d\d|Unexpected status code returned from hook/, 'Не удалось отправить код — попробуйте ещё раз'],
    // Отказы почтового входа. Приходят по-английски прямо от GoTrue, и
    // до 04.09.2026 показывались как есть — «For security purposes, you
    // can only request this after 59 seconds» на экране входа.
    //
    // Минута — это защита от перебора на один адрес, а не поломка, и
    // сказать об этом надо так, чтобы человек подождал, а не решил, что
    // сломалось.
    [
      /over_email_send_rate_limit|only request this after/,
      'Письмо уже отправлено. Повторить можно через минуту — так устроена защита от перебора',
    ],
    // Адрес не привязан к аккаунту. Заводить под него второй аккаунт
    // нельзя (см. README, «Вход по почте»), поэтому вход отказывает.
    [
      /otp_disabled|Signups not allowed for otp/,
      'Эта почта не привязана к аккаунту. Привязать её можно в профиле — войдя по приглашению или через Telegram',
    ],
    [/email rate limit exceeded/, 'Почта временно не отправляется — попробуйте позже или войдите иначе'],
    // Ошибки хранилища приходят по-английски и звучат как сбой платформы,
    // хотя означают всего лишь «этот файл не подошёл».
    [/exceeded the maximum allowed size|Payload too large/i, 'Фото слишком большое — снимите поменьше или сожмите'],
    [/Invalid key|invalid_key/i, 'Не удалось сохранить фото — попробуйте другой файл'],
    [/mime type .* is not supported/i, 'Такой формат фото не поддерживается — нужен JPG, PNG или WebP'],
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
    // Пропало то, на что ссылались. Чаще всего — гонка: человек держал
    // открытой карточку или ссылку, а вещь тем временем удалили.
    // Измерено 03.09.2026 на стенде: бронирование удалённого объявления
    // отвечало ровно строкой RENTHUB_ITEM_NOT_FOUND, и она доходила до
    // экрана как есть.
    ITEM_NOT_FOUND: 'Объявление больше не существует — вернитесь в каталог',
    BOOKING_NOT_FOUND: 'Сделка не найдена — обновите список',
    DISPUTE_NOT_FOUND: 'Спор не найден — возможно, его уже разобрали',
  };

  if (fallbacks[code]) return fallbacks[code];

  // Незнакомый код показывать нельзя. RENTHUB_* — это имя, понятное
  // разработчику, и человек читает его как поломку, причём без подсказки,
  // что делать. Отказ, у которого нет русского хвоста и нет строки выше, —
  // это недосмотр в базе, и до его исправления лучше честное «не
  // получилось», чем заглавные латинские буквы.
  //
  // Возвращать raw было соблазнительно: «вдруг там что-то полезное». За
  // двоеточием ничего нет по определению — иначе сработала бы ветка tail
  // десятью строками выше.
  //
  // Код при этом не теряется, а уходит в консоль — так же, как в боте:
  // тот, кто добавит следующий отказ без русского хвоста, увидит какой
  // именно, а не будет искать его по описанию «вылезло что-то непонятное».
  console.warn(`humanizeError: отказ без русского текста — RENTHUB_${code}`);
  return 'Не получилось выполнить действие — обновите экран и попробуйте снова';
}
