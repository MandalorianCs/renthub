// Send SMS Hook: код входа уходит в Telegram вместо SMS.
//
// Supabase сам генерирует код, сам его проверяет и сам держит счётчик
// попыток — хук отвечает только за доставку. Это важно: собственная
// реализация кодов означала бы своё хранилище, свои сроки жизни, свою
// защиту от перебора, и всё это пришлось бы поддерживать рядом с готовым.
//
// Приложение при этом не меняется вовсе. На экране входа остаётся тот же
// signInWithOtp({ phone }), а вкладка «По SMS» включается сменой
// EXPO_PUBLIC_AUTH_MODE=sms.
//
// Побочное свойство, которое стоит осознать: пилот остаётся закрытым сам
// собой. Код уходит только тому, у кого в профиле есть telegram_id, а он
// появляется лишь после «Поделиться номером» у заведённого участника.
// Посторонний с чужим номером получит понятный отказ, а не молчание.

import { Webhook } from 'https://esm.sh/standardwebhooks@1.0.0';

const HOOK_SECRET = Deno.env.get('SEND_SMS_HOOK_SECRET') ?? '';
const BOT_TOKEN = Deno.env.get('TELEGRAM_BOT_TOKEN') ?? '';

// Имена переменных у Supabase менялись вместе с форматом ключей: сначала
// SERVICE_ROLE, потом SECRET. Берём то, что есть, — иначе функция падала бы
// после смены ключей проекта, а причина выглядела бы как «сломался вход».
const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SERVICE_KEY =
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? Deno.env.get('SB_SECRET_KEY') ?? '';

/**
 * Ответ на отказ.
 *
 * ВАЖНО: до человека этот текст сейчас НЕ доходит. Измерено на живом
 * проекте 04.09.2026 — `signInWithOtp` возвращает «Unexpected status code
 * returned from hook: 404», то есть GoTrue не разбирает тело, а сообщает
 * о неожиданном коде ответа.
 *
 *   номер не участника      → hook: 404
 *   участник без Telegram   → hook: 409
 *
 * Второе не редкость: на 05.09 из пяти живых участников четверо ещё не
 * привязали Telegram, то есть почти каждый, кто откроет вкладку «По SMS».
 *
 * Тексты продублированы в `humanizeError` (`src/lib/supabase.ts`): человек
 * видит русское объяснение, но приходит оно от клиента, а не отсюда.
 *
 * **Гипотеза проверена 05.09.2026 и оказалась неверной.** Предполагалось,
 * что хук должен отвечать HTTP 200 с ошибкой в теле. Документация Supabase
 * («Auth Hooks», раздел Error handling) говорит другое — таблицу кодов:
 *
 *   200, 202, 204   принимается, идём дальше
 *   400, 403        ПРЕВРАЩАЮТСЯ В 500 Internal Server Error
 *   429, 503        считаются временными, до трёх повторов
 *
 * Всё остальное — включая наши 404 и 409 — в таблице отсутствует, отсюда и
 * «Unexpected status code returned from hook: 409» в логах 04.09.
 *
 * Вывод неприятный: текст ошибки от хука до человека НЕ ДОХОДИТ НИКОГДА.
 * Формат тела у нас как раз правильный (`{error:{http_code,message}}` — так
 * в документации), но GoTrue при любом не-200 отдаёт своё сообщение, а наше
 * выбрасывает. Возвращать 200 нельзя тем более: тогда Auth решит, что код
 * отправлен, и человек будет ждать сообщение, которого нет.
 *
 * Поэтому русские тексты живут в `humanizeError` (`src/lib/supabase.ts`) и
 * приходят от клиента — это не временное решение, как считалось, а
 * единственно возможное. Коды ниже оставлены осмысленными ради логов: по
 * ним видно, что именно случилось, даже если человек этого не увидит.
 */
function fail(message: string, code = 400) {
  return new Response(JSON.stringify({ error: { http_code: code, message } }), {
    status: code,
    headers: { 'Content-Type': 'application/json' },
  });
}

/**
 * Номер к тому же виду, в котором он лежит в базе.
 *
 * GoTrue отдаёт номер без плюса («77011234567»), а в users он хранится в
 * E.164 («+77011234567») — это выровняла миграция 20260818100000. Без
 * приведения поиск не найдёт никого, и все получат «Telegram не привязан».
 */
function toE164(raw: string): string {
  const digits = raw.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  return `+${digits}`;
}

async function findChat(phone: string): Promise<{ chat: number | null; found: boolean }> {
  const url =
    `${SUPABASE_URL}/rest/v1/users` +
    `?phone=eq.${encodeURIComponent(phone)}&select=telegram_id&limit=1`;

  const response = await fetch(url, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });

  if (!response.ok) {
    throw new Error(`база ответила ${response.status}: ${await response.text()}`);
  }

  const rows = (await response.json()) as Array<{ telegram_id: number | null }>;
  if (rows.length === 0) return { chat: null, found: false };
  return { chat: rows[0].telegram_id, found: true };
}

async function sendCode(chatId: number, code: string): Promise<void> {
  const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      // Код моноширинным — по нему удобно нажать и скопировать целиком.
      // Срок жизни называем словами: «истечёт» без числа рождает вопрос.
      //
      // Число обязано совпадать с sms_otp_exp в настройках проекта. До
      // 05.09.2026 здесь стоял «час», а настройка давала 60 секунд: человек
      // читал «час», откладывал телефон и возвращался к мёртвому коду. Обе
      // стороны по отдельности безупречны, врёт их сочетание — поэтому
      // сверка живёт в `npm run auth`, а правда о сроке — в shared/auth.json.
      text: `<b>Код входа в RentHUB</b>\n\n<code>${code}</code>\n\nДействует 10 минут. Если вход не начинали вы — просто не вводите его и никому не пересылайте.`,
      parse_mode: 'HTML',
    }),
  });

  const result = (await response.json()) as { ok: boolean; description?: string };
  if (!result.ok) throw new Error(`Telegram отказал: ${result.description ?? 'без причины'}`);
}

Deno.serve(async (req) => {
  const payload = await req.text();

  try {
    if (!HOOK_SECRET) return fail('Не задан SEND_SMS_HOOK_SECRET у функции', 500);
    if (!BOT_TOKEN) return fail('Не задан TELEGRAM_BOT_TOKEN у функции', 500);

    // Подпись проверяется до всего остального: без неё эндпоинт стал бы
    // способом рассылать любому участнику сообщения от имени RentHUB.
    const webhook = new Webhook(HOOK_SECRET.replace('v1,whsec_', ''));
    const { user, sms } = webhook.verify(payload, Object.fromEntries(req.headers)) as {
      user: { phone: string };
      sms: { otp: string };
    };

    const phone = toE164(user.phone ?? '');
    const { chat, found } = await findChat(phone);

    if (!found) {
      return fail(
        'Номер не найден среди участников пилота. Пилот идёт по приглашениям — ' +
          'напишите организатору.',
        404,
      );
    }

    if (!chat) {
      return fail(
        'Telegram не привязан. Откройте бота RentHUB, нажмите «Поделиться номером» ' +
          'и повторите вход — код придёт туда.',
        409,
      );
    }

    await sendCode(chat, sms.otp);

    return new Response(JSON.stringify({}), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    // Текст уходит человеку на экран входа, поэтому без стека и без
    // внутренностей: «не удалось отправить код» полезнее, чем трассировка.
    console.error('telegram-otp:', error);
    return fail('Не удалось отправить код в Telegram. Попробуйте ещё раз.', 500);
  }
});
