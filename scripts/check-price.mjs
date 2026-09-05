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
import { calcPrice } from '../src/lib/pricing.ts';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';

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

if (failed === 0) {
  console.log(
    `\n✓ Обе реализации расчёта сходятся на ${CASES.length} наборах.` +
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
