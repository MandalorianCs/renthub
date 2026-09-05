import type { BookingStatus, DepositStatus } from './types';
import { colors } from '../theme';

export function formatTenge(amount: number): string {
  // Неразрывный пробел перед знаком: toLocaleString уже ставит такой между
  // разрядами, а этот последний оставался обычным — и в узкой колонке
  // «20 000» уезжало на одну строку, а «₸» на следующую. Сумма без валюты
  // читается как другое число.
  return `${amount.toLocaleString('ru-RU')} ₸`;
}

export function formatDate(iso: string): string {
  const d = new Date(iso);

  // Год появляется, только когда он не текущий.
  //
  // Без этого «12 дек.» в истории сделок читается как декабрь этого года,
  // хотя может быть прошлогодним, — и чем старше аккаунт, тем чаще. Даты
  // будущих броней от добавки не страдают: они почти всегда в текущем году
  // и года не получат.
  //
  // Бот делает то же самое в human_date(), но словом целиком: «12 декабря».
  // Различие намеренное — в колонке экрана места меньше, чем в строке чата,
  // — и записано здесь, чтобы следующий читатель не «починил» его до
  // одинаковости.
  const sameYear = d.getFullYear() === new Date().getFullYear();

  return d
    .toLocaleDateString('ru-RU', {
      day: 'numeric',
      month: 'short',
      ...(sameYear ? {} : { year: 'numeric' }),
    })
    // «12 дек. 2025 г.» — два лишних знака в колонке, где место на счету.
    // Год и так стоит числом, слово «г.» ничего к нему не добавляет.
    .replace(' г.', '');
}

export function formatDateRange(startISO: string, endISO: string): string {
  const from = new Date(startISO);
  const to = new Date(endISO);

  // Повторять то, что уже сказано, — значит заставлять перечитывать.
  //
  // «12 дек. 2025 — 15 дек. 2025» несёт ровно столько же, сколько
  // «12 — 15 дек. 2025», но занимает вдвое больше места в карточке, где
  // рядом стоят название, статус и сумма. Аренда почти всегда внутри
  // одного месяца, так что сжатый вид — обычный случай, а не исключение.
  //
  // Три вида, по убыванию частоты:
  //   один месяц      12 — 15 дек.
  //   один год        28 нояб. — 3 дек.
  //   разные годы     28 дек. 2025 — 3 янв. 2026
  const sameYear = from.getFullYear() === to.getFullYear();
  const sameMonth = sameYear && from.getMonth() === to.getMonth();

  if (sameMonth) return `${from.getDate()} — ${formatDate(endISO)}`;
  if (sameYear) return `${formatDay(startISO)} — ${formatDate(endISO)}`;

  // Разные годы: год ставится у обеих дат, даже если правая в текущем.
  // «28 дек. 2025 — 3 янв.» заставляет достраивать год самому, а «3 янв.
  // 2026» не оставляет вопроса — за два лишних знака на редком случае.
  return `${formatDayYear(startISO)} — ${formatDayYear(endISO)}`;
}

/** День, месяц и год — всегда. Для диапазонов через границу года. */
function formatDayYear(iso: string): string {
  return new Date(iso)
    .toLocaleDateString('ru-RU', { day: 'numeric', month: 'short', year: 'numeric' })
    .replace(' г.', '');
}

/**
 * День и месяц без года — левая половина диапазона внутри одного года.
 *
 * Отдельно от formatDate, потому что тот про год решает сам: там это
 * правильно (дата стоит одна), здесь — нет (год скажет правая половина).
 */
function formatDay(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

type StatusStyle = { label: string; fg: string; bg: string };

/**
 * Одна таблица подписей на всё приложение. Статус — единственное, по чему
 * пользователь понимает, где сделка: в MVP денег нет, статус и есть продукт.
 */
export const BOOKING_STATUS: Record<BookingStatus, StatusStyle> = {
  pending: { label: 'Ждёт подтверждения', fg: colors.warn, bg: colors.warnSoft },
  confirmed: { label: 'Подтверждено', fg: colors.green, bg: colors.greenSoft },
  active: { label: 'В аренде', fg: colors.accent, bg: colors.accentSoft },
  returned: { label: 'Возвращено', fg: colors.green, bg: colors.greenSoft },
  completed: { label: 'Завершено', fg: colors.textMuted, bg: colors.border },
  disputed: { label: 'Спор', fg: colors.danger, bg: colors.dangerSoft },
  cancelled: { label: 'Отменено', fg: colors.textMuted, bg: colors.border },
};

export const DEPOSIT_STATUS: Record<DepositStatus, StatusStyle> = {
  held: { label: 'Депозит заблокирован', fg: colors.warn, bg: colors.warnSoft },
  released: { label: 'Депозит возвращён', fg: colors.green, bg: colors.greenSoft },
  claimed: { label: 'Депозит удержан', fg: colors.danger, bg: colors.dangerSoft },
};

/**
 * Оценка с русским разделителем: 4,8 — не 4.8.
 *
 * `toFixed` форматирует по правилам JS, а не локали, и всегда ставит точку.
 * Рядом на том же экране `formatTenge` идёт через `toLocaleString('ru-RU')`
 * и пишет «90 000 ₸» — два числа по разным правилам в одном абзаце читаются
 * как недоделка, тем же способом, что «5 объявление».
 *
 * Не `toLocaleString`: он у оценки съедает незначащий ноль, и «5,0» станет
 * «5», а рядом с «4,8» это выглядит как разный формат, а не как круглая
 * оценка.
 */
export function formatRating(rating: number): string {
  return rating.toFixed(1).replace('.', ',');
}

export function ratingLabel(rating: number | null, count: number): string {
  if (!rating || count === 0) return 'Пока нет отзывов';
  return `${formatRating(rating)} · ${plural(count, 'отзыв', 'отзыва', 'отзывов')}`;
}

/**
 * Склонение существительного после числа: 1 отзыв, 2 отзыва, 5 отзывов.
 *
 * Само правило одно, а лежало оно в трёх файлах — здесь, в каталоге и в
 * профиле владельца. Скопированное правило расходится молча: край «11» или
 * «112» правится в одном месте, а «21 объявлений» остаётся в двух других.
 *
 * Число возвращается вместе со словом намеренно. Разделять их — значит
 * каждый раз писать `${n} ${plural(n, …)}` и однажды забыть число.
 */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return `${n} ${one}`;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return `${n} ${few}`;
  return `${n} ${many}`;
}

/**
 * Дата и время в местном поясе — для сроков, где важен именно час.
 * Дедлайны приходят из базы в UTC, а показывать их надо так, как человек
 * видит на своих часах.
 */
export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString('ru-RU', {
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}
