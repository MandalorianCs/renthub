#!/usr/bin/env node
// Кому написать, чтобы он привязал Telegram — и что именно написать.
//
//   npm run nudge
//
// Зачем. На 04.09.2026 привязку сделал один живой участник из пяти.
// Остальные четверо не получают ни подтверждения брони, ни напоминания о
// возврате, ни ответа организатора: всё это лежит в приложении и ждёт, пока
// человек зайдёт сам. Он не заходит — потому и не знает, что его ждут.
//
// Разорвать круг изнутри продукта нельзя: чтобы дотянуться до человека,
// нужен канал, которого как раз и нет. Зато он есть у организатора — те же
// номера, по которым людей приглашали. Это единственная дверь, и открывается
// она руками.
//
// Поэтому скрипт не рассылает, а готовит: кому писать, в каком порядке и
// каким текстом. Порядок — по тому, сколько человек уже пропустил: у кого
// висят непрочитанные события, тому есть что терять прямо сейчас, и разговор
// с ним получается про его дело, а не про нашу метрику.

import { createClient } from '@supabase/supabase-js';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';
import { isServiceAccount } from './phone.mjs';

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();
const bot = readEnvFile('EXPO_PUBLIC_TELEGRAM_BOT') ?? 'renthub_kokshetau_bot';

if (!secret) {
  console.error(missingSecretMessage('npm run nudge'));
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const { data: users, error } = await admin
  .from('users')
  .select('id, phone, full_name, telegram_id')
  .not('verified_at', 'is', null);

if (error) {
  console.error(`\n✗ База не ответила: ${error.message}\n`);
  process.exit(1);
}

const people = users.filter((u) => !isServiceAccount(u.phone));
const missing = people.filter((u) => !u.telegram_id);

if (missing.length === 0) {
  console.log(`\n✓ Все ${people.length} участников привязали Telegram. Писать некому.\n`);
  process.exit(0);
}

// Что человек уже пропустил. Непрочитанное — то, чего он не видел даже в
// приложении; недоставленное — то, что бот не смог отдать, потому что
// отдавать некуда. Второе и есть цена непривязки, выраженная в событиях.
const { data: notes } = await admin
  .from('notifications')
  .select('user_id, title, read_at, sent_at, created_at')
  .in('user_id', missing.map((u) => u.id))
  .order('created_at', { ascending: false });

const byUser = new Map();
for (const n of notes ?? []) {
  const bucket = byUser.get(n.user_id) ?? { unread: 0, undelivered: 0, last: null };
  if (!n.read_at) bucket.unread += 1;
  if (!n.sent_at) bucket.undelivered += 1;
  if (!bucket.last) bucket.last = n.title;
  byUser.set(n.user_id, bucket);
}

const ranked = missing
  .map((u) => ({ ...u, ...(byUser.get(u.id) ?? { unread: 0, undelivered: 0, last: null }) }))
  .sort((a, b) => b.unread - a.unread || b.undelivered - a.undelivered);

console.log(`\nБез Telegram: ${missing.length} из ${people.length} участников\n`);

for (const u of ranked) {
  const name = (u.full_name ?? '').split(' ')[0];
  const hello = name ? `${name}, это RentHUB.` : 'Здравствуйте, это RentHUB.';

  console.log('─'.repeat(64));
  console.log(`${u.full_name ?? 'без имени'}  ${u.phone}`);
  console.log(
    u.unread || u.undelivered
      ? `  пропущено: ${u.unread} непрочитанных, ${u.undelivered} не доставлено${u.last ? ` · последнее: «${u.last}»` : ''}`
      : '  событий пока не было',
  );
  console.log('');

  // Два текста целиком, а не общий с подстановкой.
  //
  // Сначала подставлялась одна фраза, и у того, кого ещё ничего не ждёт,
  // выходило: «как только появится бронь — уведомление придёт туда — они
  // приходят в приложение, и увидеть их можно, только зайдя туда самому».
  // Организатор скопировал бы это не читая: текст ему обещан готовым.
  //
  // Разница не в вежливости, а в честности. Человеку, у которого висят
  // события, разговор про его дело: тебя ждут, и ты об этом не знаешь.
  // Тому, у кого пусто, обещать пропущенное нельзя — он откроет и увидит
  // тишину, а в следующий раз не откроет.
  const lines = u.unread
    ? [
        hello,
        '',
        `Вас ждёт ${u.unread} ${plural(u.unread, 'непрочитанное уведомление', 'непрочитанных уведомления', 'непрочитанных уведомлений')}` +
          ` — ${plural(u.unread, 'оно лежит', 'они лежат', 'они лежат')} в приложении, и`,
        'увидеть их можно, только зайдя туда самому. Чтобы приходили сразу,',
        'откройте бота и нажмите «Поделиться номером»:',
      ]
    : [
        hello,
        '',
        'Пока у вас всё тихо. Но когда появится бронь, подтверждение придёт',
        'в приложение — и вы увидите его, только если зайдёте сами. Чтобы',
        'приходило в Telegram, откройте бота и нажмите «Поделиться номером»:',
      ];

  for (const line of lines) console.log(line ? `  ${line}` : '');
  console.log('');
  console.log(`  https://t.me/${bot}`);
  console.log('');
  console.log('  Одно нажатие и один раз. Ваш номер Telegram передаст сам,');
  console.log('  вводить и подтверждать ничего не нужно.');
  console.log('');
}

console.log('─'.repeat(64));
console.log('\nОтправьте каждому его текст тем же способом, каким приглашали.');
console.log('Проверить, что подействовало: npm run health, строка «Telegram привязан».\n');

/** Склонение — то же правило, что на экранах: «1 уведомлений» читается как сбой. */
function plural(n, one, few, many) {
  const two = n % 100;
  const last = n % 10;
  if (two >= 11 && two <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
