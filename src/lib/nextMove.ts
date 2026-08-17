import type { Booking } from './types';

/**
 * Чей сейчас ход и что будет дальше.
 *
 * Экран сделки показывал набор кнопок и два бейджа: человек видел, что
 * может нажать, но не понимал, ждут ли чего-то от него, от второй стороны
 * или от системы. Для сделки, где на кону депозит в 20 000 ₸, это главный
 * вопрос — и он должен быть написан словами, а не выведен из статуса.
 *
 * Функция намеренно живёт отдельно от экрана: то же самое понадобится
 * Telegram-боту, который будет писать людям «ваш ход», и логика не должна
 * при этом расходиться с приложением.
 */

export type Move = {
  /** true — действие за тобой, false — ждём вторую сторону или систему. */
  yours: boolean;
  title: string;
  body: string;
  /** Имя иконки Ionicons. */
  icon: 'hand-right-outline' | 'time-outline' | 'checkmark-circle-outline' | 'alert-circle-outline';
};

export function nextMove(booking: Booking, isOwner: boolean): Move {
  const other = isOwner ? 'арендатора' : 'владельца';

  switch (booking.status) {
    case 'pending':
      return isOwner
        ? {
            yours: true,
            title: 'Подтвердите бронь',
            body:
              'Даты уже закрыты от других арендаторов. Пока вы не подтвердите, ' +
              'сделка не начнётся, а человек ждёт.',
            icon: 'hand-right-outline',
          }
        : {
            yours: false,
            title: `Ждём ${other}`,
            body: 'Он подтверждает бронь. Депозит уже заблокирован, деньги не списаны.',
            icon: 'time-outline',
          };

    case 'confirmed':
      return isOwner
        ? {
            yours: false,
            title: `Ждём ${other}`,
            body: 'Передайте вещь и дождитесь, пока он отметит получение в приложении.',
            icon: 'time-outline',
          }
        : {
            yours: true,
            title: 'Отметьте получение',
            body:
              'Когда заберёте вещь — нажмите кнопку. С этого момента пойдёт срок аренды, ' +
              'и владелец увидит, что вещь у вас.',
            icon: 'hand-right-outline',
          };

    case 'active':
      return isOwner
        ? {
            yours: true,
            title: 'Примите вещь после возврата',
            body:
              'Когда получите вещь обратно — отметьте это. Пока не отметите, ' +
              'система будет считать её невозвращённой.',
            icon: 'hand-right-outline',
          }
        : {
            yours: true,
            title: 'Верните вовремя',
            body:
              'После окончания аренды есть небольшой запас времени. Если не вернуть — ' +
              'откроется спор о невозврате, и депозит удержат.',
            icon: 'time-outline',
          };

    case 'returned':
      return isOwner
        ? {
            yours: true,
            title: 'Проверьте состояние вещи',
            body:
              'Всё в порядке — закройте сделку, и деньги начислятся. Есть повреждения — ' +
              'заявите о них с фото. Если ничего не делать, сделка закроется сама.',
            icon: 'hand-right-outline',
          }
        : {
            yours: false,
            title: `Ждём ${other}`,
            body:
              'Он проверяет состояние вещи. Если промолчит — сделка закроется сама, ' +
              'и депозит вернётся.',
            icon: 'time-outline',
          };

    case 'completed':
      return {
        yours: true,
        title: 'Сделка закрыта',
        body: 'Депозит отпущен. Оцените вторую сторону — это единственное, что осталось.',
        icon: 'checkmark-circle-outline',
      };

    case 'disputed':
      return {
        yours: false,
        title: 'Идёт разбор',
        body:
          'Депозит удержан до решения. Мелкие претензии закрываются автоматически, ' +
          'крупные смотрит модератор.',
        icon: 'alert-circle-outline',
      };

    case 'cancelled':
      return {
        yours: false,
        title: 'Заявка отменена',
        body: 'Даты освободились. Деньги и депозит не удерживаются.',
        icon: 'checkmark-circle-outline',
      };
  }
}
