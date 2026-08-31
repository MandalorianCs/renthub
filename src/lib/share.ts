import { Platform, Share } from 'react-native';


/**
 * Ссылка на объявление.
 *
 * Пилот распространяется сарафаном: владелец показывает вещь соседу, сосед
 * пересылает ссылку знакомому. Без готовой ссылки этот путь ломается —
 * человек диктует название и надеется, что найдут поиском.
 *
 * Адрес собирается из публикации, а не из текущего окружения: ссылка,
 * отправленная из локальной сборки, должна вести на живой сайт, а не на
 * localhost собеседника.
 */
const SITE = 'https://mandaloriancs.github.io/renthub/app';

export function itemUrl(itemId: string): string {
  return `${SITE}/item/${itemId}`;
}

/**
 * Поделиться объявлением.
 *
 * Три платформы — три механизма, и это не выбор, а данность:
 *   • телефон — системное окно «Поделиться» из React Native;
 *   • браузер с поддержкой — то же окно средствами самого браузера;
 *   • браузер без поддержки (десктоп) — копирование в буфер.
 *
 * Возвращает, что произошло, чтобы экран сказал это словами: «скопировано»
 * без подтверждения выглядит как несработавшая кнопка.
 */
export async function shareItem(itemId: string, title: string): Promise<'shared' | 'copied'> {
  const url = itemUrl(itemId);
  const message = `${title} — в аренду на RentHUB\n${url}`;

  if (Platform.OS !== 'web') {
    await Share.share({ message, url });
    return 'shared';
  }

  const nav = globalThis.navigator as
    | (Navigator & { share?: (data: { title: string; text: string; url: string }) => Promise<void> })
    | undefined;

  if (nav?.share) {
    try {
      await nav.share({ title, text: message, url });
      return 'shared';
    } catch {
      // Отмена в системном окне приходит исключением. Это не ошибка —
      // человек передумал, и падать здесь незачем: копируем и говорим об этом.
    }
  }

  await nav?.clipboard?.writeText(url);
  return 'copied';
}
