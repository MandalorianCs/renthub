import type { BookingStatus, DepositStatus } from './types';
import { colors } from '../theme';

export function formatTenge(amount: number): string {
  return `${amount.toLocaleString('ru-RU')} ₸`;
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}

export function formatDateRange(startISO: string, endISO: string): string {
  return `${formatDate(startISO)} — ${formatDate(endISO)}`;
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
