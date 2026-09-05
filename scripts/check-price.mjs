#!/usr/bin/env node
// Две реализации одного расчёта дают одно и то же.
//
//   npm run check:price
//
// Зачем. Стоимость сделки считается дважды: `calc_booking_price()` в
// Postgres и `calcPrice()` в src/lib/pricing.ts. Дубль сознательный и
// описан в самом файле — экран бронирования обязан показать сумму до
// того, как бронь создана, а сходить за ней в базу не может: карточка
// объявления открыта анониму, а таблицу настроек читает только вошедший.
//
// Авторитет при этом за базой: клиент ничего не отправляет, суммы
// проставляет триггер. Отсюда и цена расхождения — человек видит на
// экране одно, а начислено ему другое, и спорить он придёт с тем числом,
// которое видел. Заметить это можно только по жалобе: обе стороны
// работают, обе выдают правдоподобные цифры.
//
// Сверка честная: обе формулы выполняются на одних входах. Никакой
// третьей копии расчёта здесь нет — TypeScript Node исполняет напрямую,
// SQL-функция вызывается через RPC.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calcPrice } from '../src/lib/pricing.ts';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (...parts) => readFileSync(join(ROOT, ...parts), 'utf8');

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!secret) {
  console.error(missingSecretMessage('npm run check:price'));
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Случаи подобраны не «для красоты», а по местам, где две реализации
// расходятся чаще всего:
//
//   • округление комиссии — дробная часть при делении на 100;
//   • страховой сбор, который входит в сумму арендатора и не входит в
//     выплату владельцу;
//   • границы: рубль за сутки и цена под самым потолком.
//
// Депозит здесь не участвует в арифметике — он блокируется отдельно, —
// но передаётся, чтобы обе стороны получили одинаковый вход.
const CASES = [
  { dailyPrice: 3500, days: 3, insurance: true, deposit: 20000 },
  { dailyPrice: 3500, days: 3, insurance: false, deposit: 20000 },
  { dailyPrice: 333, days: 1, insurance: false, deposit: 0 },
  { dailyPrice: 1, days: 1, insurance: false, deposit: 0 },
  { dailyPrice: 1, days: 1, insurance: true, deposit: 0 },
  { dailyPrice: 7, days: 3, insurance: false, deposit: 100 },
  { dailyPrice: 12500, days: 2, insurance: true, deposit: 50000 },
  { dailyPrice: 999999, days: 30, insurance: true, deposit: 999999 },
  { dailyPrice: 4000, days: 14, insurance: false, deposit: 10000 },
];

console.log('\nРасчёт стоимости: приложение против базы\n');

let failed = 0;

for (const c of CASES) {
  const mine = calcPrice(c);

  const { data, error } = await admin.rpc('calc_booking_price', {
    p_daily_price: c.dailyPrice,
    p_days: c.days,
    p_insurance: c.insurance,
  });

  if (error) {
    console.error(`✗ База не посчитала ${c.dailyPrice}×${c.days}: ${error.message}`);
    failed += 1;
    continue;
  }

  const theirs = data[0];

  // Сравниваем по одному полю, а не объекты целиком: имена в двух
  // реализациях разные (rentTotal против rent_total), и «объекты не
  // равны» не сказало бы, какое именно число разошлось.
  const fields = [
    ['аренда', mine.rentTotal, theirs.rent_total],
    ['комиссия', mine.platformFee, theirs.platform_fee],
    ['страховка', mine.insuranceFee, theirs.insurance_fee],
    ['платит арендатор', mine.renterTotal, theirs.renter_total],
    ['получит владелец', mine.ownerPayoutTotal, theirs.owner_payout_total],
  ];

  const bad = fields.filter(([, a, b]) => a !== b);
  const label = `${c.dailyPrice} ₸ × ${c.days} дн.${c.insurance ? ' + защита' : ''}`;

  if (bad.length === 0) {
    console.log(`  ok  ${label.padEnd(32)} ${theirs.renter_total} ₸ / владельцу ${theirs.owner_payout_total} ₸`);
  } else {
    failed += 1;
    console.log(`  ✗   ${label}`);
    for (const [name, a, b] of bad) {
      console.log(`      ${name}: приложение ${a}, база ${b}`);
    }
  }
}

// ── Потолок цены: четыре копии одного числа ───────────────────
//
// 1 000 000 ₸ за сутки — не параметр бизнес-модели, а ловушка для
// опечатки: цена с лишним нулём не делает объявление дорогим, она делает
// его невидимым, и владелец узнаёт об этом не отказом, а неделей тишины.
//
// Именно поэтому числа нет в app_settings — и именно поэтому оно
// записано четырежды: два рубежа (проверка в assert_item_price и
// ограничение items_daily_price_max) и две вежливости (форма публикации
// и шаг цены в чате, которые говорят об этом до отправки).
//
// README про это пишет прямо: «Меняете число — меняете все четыре:
// разойдутся, и форма примет то, что база отвергнет». Проверял это
// только тот, кто помнил.
//
// Сверяем текстом, а не запуском: чтобы измерить рубежи в базе, нужно
// живое объявление и его владелец, а число видно в самой миграции — там,
// где оно и обязано совпадать.
const ceilings = [
  ['форма публикации', read('src', 'lib', 'pricing.ts'), /MAX_DAILY_PRICE = ([\d_]+)/],
  ['шаг цены в чате', read('bot', 'bot.py'), /MAX_DAILY_PRICE = ([\d_]+)/],
  ['assert_item_price', read('supabase', 'migrations', '20260903120000_price_ceiling.sql'), /if p_price > (\d+) then/],
  ['items_daily_price_max', read('supabase', 'migrations', '20260903120000_price_ceiling.sql'), /check \(daily_price <= (\d+)\)/],
];

console.log('\nПотолок цены за сутки\n');

const seen = new Set();

for (const [where, text, pattern] of ceilings) {
  const match = text.match(pattern);
  if (!match) {
    failed += 1;
    console.log(`  ✗   ${where.padEnd(24)} число не найдено — образец сломан`);
    continue;
  }
  const value = Number(match[1].replace(/_/g, ''));
  seen.add(value);
  console.log(`  ok  ${where.padEnd(24)} ${value.toLocaleString('ru-RU')} ₸`);
}

if (seen.size > 1) {
  failed += 1;
  console.log(`\n  ✗ Потолки разошлись: ${[...seen].join(', ')}`);
  console.log('    Форма примет то, что база отвергнет, — после собранных фото.');
}

// ── Порог автоспора: числом в базе, словами на экранах ────────
//
// 15 000 ₸ лежит в app_settings.dispute_auto_threshold, и база считает по
// нему. Но человеку это число называют словами в двух местах приложения:
// на экране сделки, под полем суммы ущерба («до 15 000 ₸ решается
// автоматически»), и на экране модерации («здесь появляются споры выше
// 15 000 ₸»).
//
// README честно предупреждает, что смена значения в базе меняет не всё:
// эти две подписи придётся править руками. До сих пор их не сверял никто
// — check:pitch смотрит лендинг и деку, потому что там цифру видит судья.
//
// Цена расхождения тише, чем у денег, но того же рода: человек с ущербом
// в 14 000 читает «решится автоматически», ждёт — и попадает в очередь
// модерации, где ждать некому. Или наоборот, идёт к модератору с тем, что
// база уже закрыла сама.
const { data: settings } = await admin
  .from('app_settings')
  .select('value')
  .eq('key', 'dispute_auto_threshold')
  .maybeSingle();

const threshold = Number(settings?.value);

console.log('\nПорог автоспора\n');

if (!threshold) {
  failed += 1;
  console.log('  ✗   dispute_auto_threshold не прочитан из базы — сверять не с чем');
} else {
  const labels = [
    ['экран сделки', read('app', 'booking', '[id].tsx'), /До ([\d\s\u00a0]+)[\s\u00a0]₸ решается автоматически/],
    ['экран модерации', read('app', '(tabs)', 'moderation.tsx'), /ущербом выше ([\d\s\u00a0]+)[\s\u00a0]₸/],
  ];

  console.log(`  ok  ${'в базе'.padEnd(24)} ${threshold.toLocaleString('ru-RU')} ₸`);

  for (const [where, text, pattern] of labels) {
    const match = text.match(pattern);
    if (!match) {
      failed += 1;
      console.log(`  ✗   ${where.padEnd(24)} подпись не найдена — образец сломан`);
      continue;
    }
    const said = Number(match[1].replace(/[\s\u00a0]/g, ''));
    if (said === threshold) {
      console.log(`  ok  ${where.padEnd(24)} ${said.toLocaleString('ru-RU')} ₸`);
    } else {
      failed += 1;
      console.log(`  ✗   ${where.padEnd(24)} обещает ${said.toLocaleString('ru-RU')} ₸ при ${threshold.toLocaleString('ru-RU')} ₸ в базе`);
    }
  }
}

// ── Сроки: числом в базе, обещанием на лендинге ───────────────
//
// grace_period_hours и damage_claim_window_hours — два срока, по которым
// работает планировщик: сколько ждать опоздавшего до автоспора и сколько
// живёт окно на претензию. Оба лежат в app_settings, и README называет
// их «безопасными»: клиент их не считает, только называет словами.
//
// «Только называет словами» и есть повод сверять. Лендинг обещает
// «даётся 12 часов» и «окно на претензию — 48 часов» — это обещание
// человеку, который по нему планирует: вернуть вещь вечером или утром,
// подать претензию сегодня или завтра. Смена настройки в базе оставит
// текст прежним, и обещание станет ложью молча.
const { data: rows } = await admin
  .from('app_settings')
  .select('key, value')
  .in('key', ['grace_period_hours', 'damage_claim_window_hours']);

const hours = Object.fromEntries((rows ?? []).map((r) => [r.key, Number(r.value)]));
const landing = read('landing', 'index.html');

console.log('\nСроки на лендинге против базы\n');

const promises = [
  ['опоздание, «даётся N часов»', /даётся (\d+) часов на опоздание/, 'grace_period_hours'],
  ['опоздание, второй раз', /аренды даётся (\d+) часов/, 'grace_period_hours'],
  ['окно претензии', /окно на претензию — (\d+) часов/, 'damage_claim_window_hours'],
  ['окно претензии, второй раз', /за (\d+) часов\. Вас дёргают/, 'damage_claim_window_hours'],
];

for (const [where, pattern, key] of promises) {
  const expected = hours[key];
  const match = landing.match(pattern);

  if (!expected) {
    failed += 1;
    console.log(`  ✗   ${where.padEnd(28)} ${key} не прочитан из базы`);
    continue;
  }
  if (!match) {
    failed += 1;
    console.log(`  ✗   ${where.padEnd(28)} обещание не найдено — образец сломан`);
    continue;
  }

  const said = Number(match[1]);
  if (said === expected) {
    console.log(`  ok  ${where.padEnd(28)} ${said} ч`);
  } else {
    failed += 1;
    console.log(`  ✗   ${where.padEnd(28)} обещает ${said} ч при ${expected} ч в базе`);
  }
}

if (failed === 0) {
  console.log(
    `
✓ Расчёт сходится на ${CASES.length} наборах, потолок цены одинаков ` +
      `во всех ${ceilings.length} местах.` +
      `
  Порог автоспора и сроки на лендинге совпадают с настройками базы.` +
      '\n  Человек увидит на экране ровно то, что начислит база.\n',
  );
  process.exitCode = 0;
} else {
  console.log(`\n✗ Расходятся: ${failed}.`);
  console.log('  Человек увидит на экране одно, а начислено будет другое —');
  console.log('  и спорить он придёт с тем числом, которое видел.');
  console.log('  Авторитет за базой: правьте src/lib/pricing.ts.\n');
  process.exitCode = 1;
}
