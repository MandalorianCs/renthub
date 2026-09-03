#!/usr/bin/env node
// Сверка чисел питча с числами продукта.
//
//   npm run check:pitch
//
// Зачем. Под схемой расчёта на слайде «Рынок» написано: «Каждая стрелка —
// одно умножение. Любую цифру можно пересчитать на месте». Это обещание
// судье, и его надо держать — а держится оно ровно до первой правки, после
// которой никто не пересчитал.
//
// 03.09.2026 нашлись две цифры, которые его уже не держали:
//
//   ≈ 87 000 ₸  «цена проблемы» — из соседних чисел выходит 79 500
//   ≈ 62 млн ₸  верхняя граница по стране — той же арифметикой выходит 49
//
// Обе были правдоподобны и обе не сходились. Заметить это чтением нельзя:
// числа стоят на разных слайдах, а перемножать их приходит только тот, кто
// собирается спорить.
//
// Скрипт не хранит третью копию цифр. Он вынимает их из самих страниц и из
// кода — и проверяет отношения между ними. Разойдётся код с декой, или дека
// сама с собой, — падение придёт здесь, а не на защите.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const pitch = readFileSync(join(ROOT, 'landing', 'pitch.html'), 'utf8');
const landing = readFileSync(join(ROOT, 'landing', 'index.html'), 'utf8');
const pricing = readFileSync(join(ROOT, 'src', 'lib', 'pricing.ts'), 'utf8');
const bot = readFileSync(join(ROOT, 'bot', 'bot.py'), 'utf8');
const schema = readFileSync(
  join(ROOT, 'supabase', 'migrations', '20260816120000_schema.sql'),
  'utf8',
);

// Числа на страницах разделены неразрывными пробелами: иначе «10 500 ₸»
// переносится по строке между числом и знаком валюты. Для сравнения их надо
// убрать — вместе с обычными пробелами внутри разрядов.
const digits = (s) => Number(String(s).replace(/[\s ]/g, '').replace(',', '.'));

let failed = 0;

function ok(what, got, want, unit = '') {
  // Допуск 0,5%: на страницах числа округлены («≈28 млн» против 28,35),
  // и требовать точного совпадения значило бы падать на честном округлении.
  const good = Math.abs(got - want) <= Math.max(1, Math.abs(want) * 0.005);
  if (!good) failed++;
  const mark = good ? '  ok  ' : '  ✗   ';
  console.log(
    `${mark}${what.padEnd(46)} ждали ${String(want).padStart(10)}${unit}` +
      (good ? '' : `   получили ${got}${unit}`),
  );
}

/** Вынуть число по образцу; падать сразу, если образец больше не находится. */
function find(text, re, what) {
  const m = text.match(re);
  if (!m) {
    console.error(`\n✗ Не нашёл на странице: ${what}`);
    console.error('  Текст правили, а сверка осталась старой — почините образец в этом файле.');
    process.exit(2);
  }
  return digits(m[1]);
}

console.log('\nЧисла деки против чисел продукта\n');

// ── Комиссия и сбор: код против деки и лендинга ───────────────
//
// Самая дорогая пара для расхождения: владелец увидит на экране одно, а
// начислено ему будет другое, и спорить он придёт с тем числом, которое
// видел. README отдельно разбирает, почему эти две настройки нельзя менять
// одной строкой в базе.
const commissionCode = digits(pricing.match(/COMMISSION_PCT = (\d+)/)[1]);
const insuranceCode = digits(pricing.match(/INSURANCE_FEE = (\d+)/)[1]);
const commissionDb = digits(schema.match(/'commission_pct',\s*(\d+)/)[1]);
const insuranceDb = digits(schema.match(/'insurance_fee',\s*(\d+)/)[1]);
const commissionBot = Math.round((1 - Number(bot.match(/price \* (0\.\d+)/)[1])) * 100);

console.log('── Комиссия и страховой сбор ──');
ok('комиссия: база против src/lib/pricing.ts', commissionCode, commissionDb, '%');
ok('комиссия: бот против того же', commissionBot, commissionDb, '%');
ok('сбор: база против src/lib/pricing.ts', insuranceCode, insuranceDb, ' ₸');
// Образец нарочно длинный. Короткий — /× (\d+)%/ — ловил «× 3%», первый
// множитель цепочки: в схеме таких подписей четыре, и «первая похожая»
// здесь означает «не та».
ok(
  'комиссия названа на слайде «Рынок»',
  find(pitch, /Комиссия (\d+)% — параметр платформы/, 'подпись комиссии под схемой'),
  commissionDb,
  '%',
);
ok(
  'сбор назван на клиентском сайте',
  find(landing, /(\d+)[\s ]₸, если включите защиту/, 'страховой сбор на лендинге'),
  insuranceDb,
  ' ₸',
);

// ── Единица экономики ─────────────────────────────────────────
const perDay = find(pitch, /трое суток по ([\d\s ]+)[\s ]₸/, 'цена за сутки');
const total = find(pitch, /<strong>([\d\s ]+)[\s ]₸<\/strong>\s*—\s*трое суток/, 'чек');
const fee = find(pitch, /<strong>([\d\s ]+)[\s ]₸<\/strong> с сделки/, 'комиссия с сделки');
const price = find(pitch, /перфоратор за ([\d\s ]+)[\s ]₸ работает/, 'цена перфоратора');
const problem = find(pitch, /<div class="v">([\d\s ]+)[\s ]₸<\/div>/, 'цена проблемы');

console.log('\n── Единица экономики ──');
ok('цена за сутки × 3 = чек', perDay * 3, total, ' ₸');
ok('чек × комиссия = сбор платформы', Math.round((total * commissionDb) / 100), fee, ' ₸');
ok('покупка − аренда = цена проблемы', price - total, problem, ' ₸');

// ── Рынок ─────────────────────────────────────────────────────
const people = find(pitch, /≈([\d\s ]+) жителей/, 'жители Кокшетау');
const households = find(pitch, /≈([\d\s ]+) домохозяйств\./, 'домохозяйства Кокшетау');
const share = find(pitch, /(\d+)% домохозяйств арендуют/, 'доля пилота');
const renters = find(pitch, />([\d\s ]+)<\/text>\s*<text[^>]*>арендуют/, 'арендаторы');
const deals = find(pitch, />([\d\s ]+)<\/text>\s*<text[^>]*>сделок в год/, 'сделки');
const turnover = find(pitch, />([\d,]+)<\/text>\s*<text[^>]*>млн ₸<\/text>/, 'оборот');
const revenue = find(pitch, />([\d,]+)<\/text>\s*<text[^>]*>млн ₸ выручки/, 'выручка');

console.log('\n── Рынок: Кокшетау ──');
ok('домохозяйства × доля = арендаторы', Math.round((households * share) / 100), renters);
ok('арендаторы × 2 аренды = сделки', renters * 2, deals);
ok('сделки × чек = оборот', (deals * total) / 1e6, turnover, ' млн ₸');
ok('оборот × комиссия = выручка', (turnover * commissionDb) / 100, revenue, ' млн ₸');

// ── Верхняя граница по стране ─────────────────────────────────
//
// Проверяется той же плотностью домохозяйств, что названа для Кокшетау.
// Именно здесь и разошлось: 62 млн получались только при 2,64 человека на
// домохозяйство — доле, которая нигде не названа.
const kzPeople = find(pitch, /(\d+)[\s ]млн ÷/, 'жители Казахстана') * 1e6;
const perHouse = find(pitch, /÷ ([\d,]+) человека на домохозяйство/, 'плотность');
const kzHouse = find(pitch, /<strong>([\d,]+)[\s ]млн домохозяйств<\/strong>/, 'домохозяйства КЗ');
const kzShare = find(pitch, /при ([\d,]+)% проникновения/, 'доля по стране');
const kzRevenue = find(pitch, /≈([\d,]+)[\s ]млн[\s ]₸<\/strong> выручки/, 'выручка КЗ');

console.log('\n── Рынок: верхняя граница по стране ──');
ok('жители ÷ домохозяйства = плотность', people / households, perHouse);
ok('жители КЗ ÷ плотность = домохозяйства', kzPeople / perHouse / 1e6, kzHouse, ' млн');
ok(
  'домохозяйства × доля × 2 × чек × комиссия',
  (kzHouse * 1e6 * (kzShare / 100) * 2 * total * (commissionDb / 100)) / 1e6,
  kzRevenue,
  ' млн ₸',
);

// План на 2028 ссылается на эту же границу и обязан с ней совпадать: план,
// выходящий за границу посчитанного рынка, обесценивает оба слайда — так и
// написано на самом слайде.
ok(
  'план на 2028 = верхняя граница рынка',
  find(pitch, /выручка ≈([\d,]+)[\s ]млн[\s ]₸ — верхняя граница/, 'план 2028'),
  kzRevenue,
  ' млн ₸',
);

// ── Стенд ─────────────────────────────────────────────────────
//
// Число проверок на слайде «Результаты инкубации» — единственная цифра
// деки, которая растёт сама. Списанная однажды, она занижает: 03.09 там
// стояло 130 против 345 фактических.
const claimed = find(pitch, /<div class="stat-v">(\d+)<\/div>/, 'число проверок стенда');
console.log('\n── Стенд ──');
console.log(`  ??  на слайде заявлено ${claimed} проверок`);
console.log('      сверить: npm run test:db, посчитать строки «ok» в выводе');

console.log(
  failed === 0
    ? '\n✓ Числа деки сходятся между собой и с кодом.\n'
    : `\n✗ Расхождений: ${failed}. Судья, который перемножит, найдёт их раньше нас.\n`,
);

process.exit(failed === 0 ? 0 : 1);
