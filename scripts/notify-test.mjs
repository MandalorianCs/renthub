#!/usr/bin/env node
// Проверка связи с ботом.
//
//   npm run notify:test -- +77011234567
//   npm run notify:test -- +77011234567 "Свой текст"
//
// Кладёт в notifications одну запись — ровно такую же, какие создают
// триггеры при настоящих сделках. Бот заберёт её очередным опросом и
// пришлёт в Telegram.
//
// Зачем отдельная команда. Путь «база → бот → Telegram» состоит из четырёх
// звеньев: запись появилась, бот её увидел, Telegram принял, человек
// получил. Когда владелец жалуется «уведомления не приходят», нужно знать,
// какое звено молчит, — и проверять это на живой сделке дорого: сделку
// придётся создать, провести и закрыть.
//
// Записи помечены type = 'connection_test': их видно в базе и легко убрать,
// не задев настоящие.

import { createClient } from '@supabase/supabase-js';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';

const [rawPhone, ...textParts] = process.argv.slice(2);
const customText = textParts.join(' ').trim();

if (!rawPhone) {
  console.error(`
Кому отправляем проверку?

  npm run notify:test -- +77011234567
`);
  process.exit(1);
}

/** Казахстанские номера: 8 705… и +7 705… — один и тот же номер. */
function normalizePhone(input) {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 11) return `+${digits}`;
  return `+${digits}`;
}

const phone = normalizePhone(rawPhone);
const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!url || url.includes('xxxxxxxxxxxx')) {
  console.error('✗ Не найден адрес проекта. Заполните EXPO_PUBLIC_SUPABASE_URL в .env');
  process.exit(1);
}

if (!secret) {
  console.error(missingSecretMessage('npm run notify:test -- +7701...'));
  process.exit(1);
}

const admin = createClient(url, secret, { auth: { persistSession: false } });

const { data: user, error: findError } = await admin
  .from('users')
  .select('id, full_name, telegram_id')
  .eq('phone', phone)
  .maybeSingle();

if (findError) {
  console.error(`✗ Не удалось найти пользователя: ${findError.message}`);
  process.exit(1);
}

if (!user) {
  console.error(
    `✗ Номер ${phone} не заведён.\n` +
      `  Сначала: npm run invite -- ${phone} "Имя Фамилия"`,
  );
  process.exit(1);
}

// Проверяем привязку до вставки: без telegram_id запись просто ляжет в
// базу и будет ждать вечно, а человек будет ждать сообщения. Молчание
// без объяснения — худший из возможных ответов.
if (!user.telegram_id) {
  console.error(
    `✗ ${user.full_name ?? phone}: Telegram не привязан.\n\n` +
      `  Откройте бота, нажмите «Поделиться номером» — и повторите команду.\n` +
      `  Уведомления при этом не теряются: всё, что накопилось, придёт\n` +
      `  сразу после привязки.\n`,
  );
  process.exit(1);
}

const { error: insertError } = await admin.from('notifications').insert({
  user_id: user.id,
  type: 'connection_test',
  title: 'Проверка связи',
  body:
    customText ||
    'Если вы это читаете — уведомления по сделкам дойдут: подтверждения броней, ' +
      'напоминания о возврате, решения по спорам.',
});

if (insertError) {
  console.error(`✗ Не удалось создать уведомление: ${insertError.message}`);
  process.exit(1);
}

console.log(`
✓ Уведомление создано для ${user.full_name ?? phone}.

  Бот заберёт его очередным опросом — по умолчанию в течение 15 секунд.
  Не пришло за минуту: посмотрите окно бота. Пусто — бот не запущен;
  строка с ошибкой — она и есть ответ.

  Убрать все проверочные записи:
    npm run notify:clear
`);
