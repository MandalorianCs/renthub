/**
 * Зеркало SQL-функции calc_booking_price из 0002_trust_score.sql.
 *
 * Зачем дублировать расчёт: экран бронирования должен показать сумму до
 * того, как бронь создана, — иначе пользователь жмёт «забронировать»
 * вслепую. Но авторитет остаётся за базой: цифры, посчитанные здесь,
 * никуда не отправляются, база пересчитывает всё сама из своих настроек.
 * Если правила разойдутся — прав Postgres, а не этот файл.
 */

/**
 * Оба значения — копия строк `commission_pct` и `insurance_fee` из
 * `app_settings`. Копия сознательная: экран показывает сумму до создания
 * брони, и сходить за ней в базу он не может — карточка объявления открыта
 * анониму, а таблицу настроек читает только вошедший.
 *
 * Отсюда правило, которого нет в README снаружи этого файла: **сменить
 * комиссию или страховой сбор одной строкой в базе нельзя.** Поменяются
 * они и здесь, и в `bot/bot.py` (там `0.8` и слова «20%»), и на лендинге —
 * иначе владелец увидит на экране публикации одно, а начислено ему будет
 * другое, и спорить он придёт с тем числом, которое видел.
 *
 * Остальные три настройки — сроки и порог спора — клиент не считает, а
 * только называет словами, и их смена в базе безопаснее. Таблица «что ещё
 * править» — в README, раздел «Настройки».
 */
export const COMMISSION_PCT = 20;
export const INSURANCE_FEE = 150;

/**
 * Потолок цены за сутки — зеркало `assert_item_price()` и ограничения
 * `items_daily_price_max`.
 *
 * Это не параметр бизнес-модели, в отличие от двух чисел выше, и в
 * `app_settings` он не лежит: это ловушка для опечатки. Цена с лишним
 * нулём не делает объявление дорогим — она делает его невидимым, и
 * владелец узнаёт об этом не отказом, а неделей тишины.
 *
 * Копия здесь нужна, чтобы форма сказала об этом до отправки: отказ
 * базы приходит после того, как человек уже собрал фото и описание.
 * Авторитет, как и у остальных чисел файла, за Postgres.
 */
export const MAX_DAILY_PRICE = 1_000_000;

export type PriceBreakdown = {
  days: number;
  rentTotal: number;
  platformFee: number;
  insuranceFee: number;
  /** Сколько платит арендатор за аренду (депозит блокируется отдельно). */
  renterTotal: number;
  /** Сколько получит владелец: аренда минус комиссия платформы. */
  ownerPayoutTotal: number;
  deposit: number;
};

/** Оба дня включительно: аренда «с 1 по 1 число» — это один день. */
export function countDays(startISO: string, endISO: string): number {
  const start = Date.parse(startISO);
  const end = Date.parse(endISO);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

export function calcPrice(params: {
  dailyPrice: number;
  deposit: number;
  days: number;
  insurance: boolean;
}): PriceBreakdown {
  const { dailyPrice, deposit, days, insurance } = params;

  const rentTotal = dailyPrice * days;
  const platformFee = Math.round((rentTotal * COMMISSION_PCT) / 100);
  const insuranceFee = insurance ? INSURANCE_FEE : 0;

  return {
    days,
    rentTotal,
    platformFee,
    insuranceFee,
    renterTotal: rentTotal + insuranceFee,
    ownerPayoutTotal: rentTotal - platformFee,
    deposit,
  };
}

// Периодические выплаты для длинной аренды (транши раз в 7 дней)
// отложены — начисление одно, при закрытии сделки. См. schedule_payouts
// в supabase/migrations/20260816120100_trust_score.sql.
