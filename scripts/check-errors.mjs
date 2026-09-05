#!/usr/bin/env node
// Каждое ограничение базы должно быть объяснено по-русски.
//
//   npm run check:errors
//
// Зачем. Бот и приложение держат таблицы переводов: имя ограничения → фраза
// человеку. Без перевода Postgres присылает своё:
//
//   new row for relation "bookings" violates check constraint "bookings_check1"
//
// Это не сообщение об ошибке, это улика. Человек не понимает ни что сделал
// не так, ни что делать дальше.
//
// 05.09.2026 сверка нашла одиннадцать таких. Среди них `bookings_check1` —
// «renter_id <> owner_id», то есть попытка снять собственную вещь. Каталог
// показывает и свои объявления, кнопка на них живая, и обычное любопытство
// упиралось в латиницу.
//
// Правило простое: ограничение либо переведено в обоих клиентах, либо
// названо в списке исключений ниже — с причиной. Третьего не дано, и это
// заставляет принять решение, а не забыть.

import { createClient } from '@supabase/supabase-js';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Ограничения, до которых человек не дотягивается вводом.
 *
 * Это не «пока не перевели», а «переводить нечего»: нарушить их можно
 * только ошибкой в коде, и тогда сырая строка Postgres — правильный ответ,
 * потому что читать её будет разработчик.
 */
const NOT_FOR_HUMANS = {
  // bookings_no_overlap переведено в обоих клиентах и потому здесь не
  // нужно. Оно EXCLUDE, и до миграции 20260905030000 функция его не
  // возвращала вовсе — проверка нашла дефект в том, что её обслуживает.
  disputes_payout_amount_check: 'сумму выплаты считает decide_dispute_payout, человек её не вводит',
  payouts_amount_check: 'строку payouts создаёт триггер, человек к ней не прикасается',
  reviews_check: 'from_user_id <> to_user_id — отзыв себе невозможен через UI, кнопки нет',
  join_requests_phone_check: 'номер приходит от Telegram подтверждённым, руками его не вводят',
  payouts_booking_id_kind_period_start_key:
    'строку выплаты создаёт триггер, повтор возможен только ошибкой в коде',
};

const secret = readSecret();
if (!secret) {
  console.error(missingSecretMessage('npm run check:errors'));
  process.exit(1);
}

const admin = createClient(
  process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL'),
  secret,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

const { data, error } = await admin.rpc('constraint_names');

if (error) {
  console.error(`\n✗ База не ответила: ${error.message}`);
  console.error('  Функция constraint_names() появляется миграцией 20260905020000.\n');
  process.exit(1);
}

const names = (data ?? []).map((r) => (typeof r === 'string' ? r : r.constraint_names));

// Тексты клиентов читаются целиком: перевод может лежать и в таблице, и в
// регулярке, и в комментарии рядом. Нам важно одно — упомянуто ли имя.
const botText = readFileSync(join(ROOT, 'bot', 'bot.py'), 'utf8');
const appText = readFileSync(join(ROOT, 'src', 'lib', 'supabase.ts'), 'utf8');

const rows = names.map((name) => ({
  name,
  bot: botText.includes(name),
  app: appText.includes(name),
  waived: Object.hasOwn(NOT_FOR_HUMANS, name),
}));

const bad = rows.filter((r) => !r.waived && (!r.bot || !r.app));
const stale = Object.keys(NOT_FOR_HUMANS).filter((n) => !names.includes(n));

console.log(`\nОграничения базы против переводов (${rows.length})\n`);

for (const r of rows) {
  const mark = r.waived ? ' ' : r.bot && r.app ? '✓' : '✗';
  const where = r.waived
    ? `не для человека: ${NOT_FOR_HUMANS[r.name]}`
    : `${r.bot ? 'бот' : '—'} / ${r.app ? 'приложение' : '—'}`;
  console.log(`  ${mark} ${r.name.padEnd(34)} ${where}`);
}

// ── Отказы, брошенные голым кодом ─────────────────────────────
//
// Ограничения таблиц — половина того, что видит человек. Вторая половина
// это наши собственные отказы, и у них правило записано в bot/README.md
// словами: «Пишете новый отказ в базе — дайте ему русский хвост»
// (`RENTHUB_КОД: текст для человека`). Тогда переводить нечего, обе двери
// показывают его как есть.
//
// Семь мест это правило не выполняют — бросают `raise exception
// 'RENTHUB_FORBIDDEN'` без хвоста. Пока для них есть запасные фразы в
// обеих картах, человек видит их по-русски. Но правило держится на том,
// что кто-то помнит про обе карты, а помнить про две вещи сразу — это и
// есть определение того, что однажды забудут: 03.09.2026 в приложении
// было двенадцать переводов, в боте пять, и разошлись они молча.
//
// Проверка простая: каждый код, брошенный без хвоста, обязан найтись в
// карте приложения И в карте бота. Новый отказ без перевода уронит
// npm run check, а не дойдёт до человека словом «FORBIDDEN».
const migrations = readdirSync(join(ROOT, 'supabase', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .map((f) => readFileSync(join(ROOT, 'supabase', 'migrations', f), 'utf8'))
  .join('\n');

const bareCodes = [
  ...new Set(
    [...migrations.matchAll(/raise exception '(RENTHUB_[A-Z_]+)'/g)].map((m) => m[1]),
  ),
].sort();

// Карта приложения хранит коды без приставки — она отрезана регуляркой
// в humanizeError. Карта бота хранит целиком. Сверяем каждую по-своему,
// а не приводим одну к другой: приставка в двух местах живёт по-разному
// намеренно, и подгонка спрятала бы это различие.
const bareBad = bareCodes.filter((code) => {
  const short = code.replace('RENTHUB_', '');
  const inApp = new RegExp(`\\b${short}: '`).test(appText);
  const inBot = appText && botText.includes(`"${code}"`);
  return !inApp || !inBot;
});

console.log(`\nОтказы без русского хвоста (${bareCodes.length})\n`);

for (const code of bareCodes) {
  const short = code.replace('RENTHUB_', '');
  const inApp = new RegExp(`\\b${short}: '`).test(appText);
  const inBot = botText.includes(`"${code}"`);
  const where = [inBot ? 'бот' : '— бот', inApp ? 'приложение' : '— приложение'].join(' / ');
  console.log(`  ${inApp && inBot ? '✓' : '✗'} ${code.padEnd(30)} ${where}`);
}

if (stale.length) {
  console.log(`\n! В списке исключений есть то, чего в базе больше нет: ${stale.join(', ')}`);
  console.log('  Ограничение убрали — уберите и запись, иначе список начнёт врать.');
}

if (bad.length === 0 && stale.length === 0 && bareBad.length === 0) {
  console.log('\n✓ Каждое ограничение объяснено по-русски или объявлено внутренним.\n');
  // exitCode, а не exit(): см. scripts/exit.mjs — обрыв процесса при живом
  // соединении supabase-js даёт на Windows код 127 вместо нуля, и цепочка
  // `npm run check` считает успешную проверку провалом.
  process.exitCode = 0;
} else {

  if (bad.length) {
    console.log(`\n✗ Без перевода: ${bad.length}\n`);
    for (const r of bad) {
      console.log(`  ${r.name}`);
      if (!r.bot) console.log('    бот покажет сырую строку Postgres');
      if (!r.app) console.log('    приложение покажет сырую строку Postgres');
    }
    console.log('\n  Добавьте фразу в CONSTRAINT_MESSAGES (bot/bot.py) и в humanizeError');
    console.log('  (src/lib/supabase.ts) — либо внесите имя в NOT_FOR_HUMANS здесь,');
    console.log('  объяснив, почему человек до него не дотягивается.\n');
  }

  if (bareBad.length) {
    console.log(`\n✗ Отказ без русского хвоста и без запасной фразы: ${bareBad.length}\n`);
    for (const code of bareBad) console.log(`  ${code}`);
    console.log('\n  Либо допишите хвост в самой миграции — `RENTHUB_КОД: текст`,');
    console.log('  тогда переводить нечего, — либо добавьте фразу в BARE_CODE_MESSAGES');
    console.log('  (bot/bot.py) и в fallbacks humanizeError (src/lib/supabase.ts).\n');
  }

  process.exitCode = 1;
}
