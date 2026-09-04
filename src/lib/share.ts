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
  // Через параметр, а не через путь: /app/item/<id> на GitHub Pages
  // отвечает 404 (файла нет), и мессенджеры на 404 не строят превью.
  // Каталог читает `item` и открывает карточку сам — см. app/(tabs)/index.tsx.
  //
  // Правило обязано совпадать с item_url() в bot/bot.py.
  return `${SITE}/?item=${itemId}`;
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

/**
 * Скопировать короткую строку — номер, код, ссылку.
 *
 * Отдельно от shareItem: там системное окно «поделиться» уместно, а здесь
 * человеку нужно ровно одно — положить номер в буфер, чтобы вставить его в
 * приглашение. Системное окно на этом месте предлагало бы отправить чужой
 * телефон в мессенджер.
 *
 * Возвращает false, если буфера нет: тогда вызывающий не должен показывать
 * «скопировано», иначе он соврёт. Своей зависимости ради этого не заводим —
 * expo-clipboard в проекте нет, а на вебе всё есть.
 */
export async function copyText(text: string): Promise<boolean> {
  const nav = globalThis.navigator as (Navigator & { clipboard?: Clipboard }) | undefined;
  if (!nav?.clipboard?.writeText) return false;

  try {
    await nav.clipboard.writeText(text);
    return true;
  } catch {
    // Запрет доступа к буферу — это не сбой приложения. Скажем «не вышло»
    // молчанием кнопки, а не красной ошибкой на весь экран.
    return false;
  }
}
