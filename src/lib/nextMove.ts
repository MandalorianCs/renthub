import table from '../../shared/next-move.json';
import type { Booking } from './types';

/**
 * Чей сейчас ход и что будет дальше.
 *
 * Экран сделки показывал набор кнопок и два бейджа: человек видел, что
 * может нажать, но не понимал, ждут ли чего-то от него, от второй стороны
 * или от системы. Для сделки, где на кону депозит в 20 000 ₸, это главный
 * вопрос — и он должен быть написан словами, а не выведен из статуса.
 *
 * Тексты лежат в shared/next-move.json, а не здесь. Причина записана там
 * же: тот же текст читает Telegram-бот, и расходиться они не должны.
 * Пока таблица была кодом на TypeScript, у бота оставалось два выхода —
 * переписать её по-питоновски или молчать о том, чей ход. Первое
 * расходится на второй правке, второе делает бота бесполезным ровно там,
 * где он нужен.
 *
 * Функция при этом осталась чистой: никакого запроса, только те данные,
 * что уже загружены экраном.
 */

export type Move = {
  /** true — действие за тобой, false — ждём вторую сторону или систему. */
  yours: boolean;
  title: string;
  body: string;
  /** Имя иконки Ionicons. */
  icon: 'hand-right-outline' | 'time-outline' | 'checkmark-circle-outline' | 'alert-circle-outline';
};

type Table = Record<string, { owner: Move; renter: Move }>;

export function nextMove(booking: Booking, isOwner: boolean): Move {
  const row = (table as unknown as Table)[booking.status];
  return isOwner ? row.owner : row.renter;
}
