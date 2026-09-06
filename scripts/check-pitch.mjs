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

import { createClient } from '@supabase/supabase-js';
import { existsSync, readFileSync } from 'node:fs';
// Отпечаток считает тот же код, что его записывает: две реализации
// «одинаковости» разошлись бы первыми.
import { deckFingerprint } from './deck.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { readEnvFile, readSecret } from './env.mjs';

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
    // exitCode, а не exit(): при живом соединении supabase-js обрыв процесса
    // даёт на Windows код 127 вместо заданного — см. scripts/exit.mjs.
    process.exitCode = 2;
    throw new Error(`образец не найден: ${what}`);
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
// Страховой сбор теперь назван и у жюри — там, где объясняем, из чего
// складывается доход. Сверяется с базой той же строкой, что и всё
// остальное: цифра, названная судье, обязана совпадать с той, что
// начисляется человеку.
ok(
  'страховой сбор назван у жюри',
  find(pitch, /(\d+)[\s\u00a0]₸ сверху, если арендатор/, 'страховой сбор в деке'),
  insuranceDb,
  ' ₸',
);
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

// ── Калькулятор дохода на лендинге ────────────────────────────
//
// Владелец приходит на лендинг с одним вопросом — «сколько я заработаю»,
// — и калькулятор отвечает на него числами. Это четвёртое место, где
// живёт та же модель: цена за сутки, срок аренды и комиссия.
//
// Сверяется трижды, потому что расходиться оно может по-разному:
//
//   • комиссия в скрипте лендинга — против настройки в базе. Разойдись
//     она, и владелец увидит на лендинге один доход, а в приложении
//     другой, причём лендинг он читает первым;
//   • цена за сутки и срок по умолчанию — против чека деки. Судья и
//     владелец должны считать от одной цены перфоратора, иначе «10 500 ₸
//     за трое суток» в деке и калькулятор на сайте описывают разные вещи;
//   • напечатанные в разметке результаты — против той же формулы. Их
//     пересчитывает скрипт при загрузке, но если он не выполнится, на
//     экране останутся именно они: числа, которые никто не проверял.
const calcCommission = digits(landing.match(/var COMMISSION = 0\.(\d+);/)[1]);
const calcPrice = find(landing, /id="calc-price"[^>]*value="(\d+)"/, 'цена в калькуляторе');
const calcTimes = find(landing, /id="calc-times"[^>]*value="(\d+)"/, 'аренд в месяц');
const calcDays = find(landing, /id="calc-days"[^>]*value="(\d+)"/, 'суток за аренду');
const calcOwner = find(landing, /id="calc-owner">([\d\s ]+)[\s ]₸/, 'доход в месяц');
const calcFee = find(landing, /id="calc-fee">([\d\s ]+)[\s ]₸/, 'комиссия в месяц');
const calcYear = find(landing, /id="calc-year">([\d\s ]+)[\s ]₸/, 'доход за год');

const calcGross = calcPrice * calcDays * calcTimes;

console.log('\n── Калькулятор дохода ──');
ok('комиссия в калькуляторе = базе', calcCommission, commissionDb, '%');
ok('цена за сутки = цене перфоратора в деке', calcPrice, perDay, ' ₸');
ok('срок аренды = сроку в чеке деки', calcDays, 3, ' сут.');
ok('напечатанный доход = формуле', Math.round(calcGross * (1 - commissionDb / 100)), calcOwner, ' ₸');
ok('напечатанная комиссия = формуле', Math.round((calcGross * commissionDb) / 100), calcFee, ' ₸');
ok('напечатанный год = доход × 12', calcOwner * 12, calcYear, ' ₸');

// ── Тайминг: три минуты, расписанные до секунды ───────────────
//
// Регламент Терриконовой долины («Шаблон ИНК») даёт на выступление 180
// секунд и делит их по разделам: заставка 5, клиент 10, проблема 10,
// решение 30, рынок 20, конкуренты 20, «до инкубации» с результатами 40,
// экспортные контракты 15, план 15, команда 10, визитка 5.
//
// Это не пожелание. На защите жюри слушает по таймеру, и лишние двадцать
// секунд отнимаются не у слабого слайда, а у последнего — того, где
// инвестиционный запрос и контакты.
//
// Проверка появилась после того, как я сам выбил деку из регламента:
// слайд «Юнит-экономика», добавленный 06.09.2026, стоил ровно двадцать
// секунд сверх ста восьмидесяти. Он остался, но помечен резервом — это
// ответ на вопрос после выступления, а не часть речи.
//
// Считаются только слайды с явным «· N секунд». Слайды с пометкой
// «часть из 40» — это блок «до инкубации + результаты», расписанный
// регламентом одной строкой; он учитывается один раз, отдельным
// слагаемым.
const TIMING_TOTAL = 180;
const BLOCK_7_8 = 40;

const seconds = [...pitch.matchAll(/<span>· (\d+) секунд/g)].map((m) => Number(m[1]));
const shared = (pitch.match(/часть из (\d+) секунд/g) ?? []).length;

const spoken = seconds.reduce((a, b) => a + b, 0) + BLOCK_7_8;

console.log('\n── Тайминг выступления ──');

ok('слайдов с общим блоком «часть из 40»', shared, 2);
ok('сумма секунд = регламенту ИНК', spoken, TIMING_TOTAL, ' сек');

// ── Дека файлом: не отстал ли PDF ─────────────────────────────
//
// PDF лежит в репозитории, а не собирается при публикации: печать в CI
// не давалась — Chromium на runner'е то висел до таймаута, то молча не
// создавал файл, и сайт трижды выходил с 404 на месте деки под зелёной
// галочкой. Локально она печатается за двенадцать секунд.
//
// Цена решения известна: файл в репозитории устаревает молча. Поэтому
// его свежесть проверяется здесь — рядом с числами, которые он показывает
// судьям. Отстал по времени от pitch.html — значит показывает не то, что
// проверил этот же скрипт строкой выше.
const pdfPath = join(ROOT, 'landing', 'RentHUB-pitch.pdf');
const pptxPath = join(ROOT, 'landing', 'RentHUB-pitch.pptx');
const slides = (pitch.match(/<section/g) ?? []).length;

console.log('\n── Дека файлом ──');

// Оба файла собираются из одних снимков (npm run pitch:deck), поэтому и
// проверяются одинаково: отпечаток исходника рядом с файлом отвечает на
// вопрос «этот файл сделан из ЭТОЙ версии деки».
const deckNow = deckFingerprint(ROOT);

for (const [label, file, command] of [
  ['PDF', pdfPath, 'npm run pitch:pdf'],
  ['PPTX', pptxPath, 'npm run pitch:pptx'],
]) {
  if (!existsSync(file)) {
    console.log(`  ??  ${label} деки нет — соберите: ${command}`);
    failed++;
    continue;
  }

  const shaPath = `${file}.sha`;
  const builtFrom = existsSync(shaPath) ? readFileSync(shaPath, 'utf8').trim() : null;

  if (builtFrom !== deckNow) {
    console.log(`  ??  ${label} собран из другой версии деки — судьи получат вчерашние числа`);
    console.log(`      собрать заново: ${command}`);
    failed++;
    continue;
  }

  // Число страниц против числа слайдов.
  //
  // Проверка не формальная: 06.09.2026 сборка молча отдавала PDF, где
  // страниц было меньше, чем слайдов, — часть деки просто не доехала до
  // судей, а файл открывался и выглядел целым. Считаем то, что можно
  // сосчитать без внешних утилит: потоки страниц в PDF и файлы слайдов
  // внутри PPTX (это zip, слайды лежат отдельными записями).
  const bytes = readFileSync(file);
  const parts = label === 'PDF'
    ? (bytes.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length
    : (bytes.toString('latin1').match(/ppt\/slides\/slide\d+\.xml(?!\.rels)/g) ?? [])
        .filter((v, i, all) => all.indexOf(v) === i).length;

  if (parts !== slides) {
    console.log(`  ??  в деке ${slides} слайдов, в ${label} — ${parts}`);
    console.log(`      пересобрать: ${command}`);
    failed++;
    continue;
  }

  console.log(`  ok  ${label} свежий, ${parts} слайдов`);

  // Оглавление и ссылки — только у PDF: PPTX ни того, ни другого не несёт.
  //
  // Считаем по сырому файлу, без внешних библиотек. Закладки — записи
  // /Title в дереве оглавления, переходы — аннотации /Link. Точность здесь
  // не нужна: вопрос ровно один — они вообще есть?
  if (label !== 'PDF') continue;

  const raw = bytes.toString('latin1');
  const marks = (raw.match(/\/Type\s*\/Outlines?\b/g) ?? []).length;
  const links = (raw.match(/\/Subtype\s*\/Link\b/g) ?? []).length;
  const deckLinks = (pitch.match(/<a [^>]*href="https?:/g) ?? []).length;

  if (!marks) {
    console.log('  ??  в PDF нет оглавления — судья листает 21 страницу подряд');
    console.log(`      пересобрать: ${command}`);
    failed++;
  } else if (!links && deckLinks) {
    console.log(`  ??  в деке ${deckLinks} ссылок, в PDF — ни одной`);
    console.log('      адреса стали картинкой: их придётся перепечатывать руками');
    console.log(`      пересобрать: ${command}`);
    failed++;
  } else if (!/\/Type\s*\/Font/.test(raw)) {
    // Шрифт в файле — признак текстового слоя. Страницы собраны из
    // снимков, рисовать буквы в них нечем: если шрифта нет, значит слой
    // не лёг, и в раздатке снова не работают ни поиск, ни копирование,
    // ни озвучка. Проверка дешёвая, а пропажу иначе замечает судья.
    console.log('  ??  в PDF нет текстового слоя — поиск по раздатке не работает');
    console.log(`      пересобрать: ${command}`);
    failed++;
  } else {
    console.log(`  ok  оглавление, переходов ${links}, текстовый слой на месте`);
  }
}

// ── Эквиваленты в долларах ────────────────────────────────────
//
// Крупные суммы деки несут рядом пересчёт в доллары: жюри считает рынок
// в них. Пересчёт делает npm run fx по курсу из shared/fx.json — и
// именно поэтому его нужно проверять здесь.
//
// Курс живёт своей жизнью: сегодня 455 ₸ за доллар, через полгода
// другой. Цифра «≈ $108 тыс.», посчитанная однажды и забытая, станет
// такой же неправдой, как выдуманный рейтинг на лендинге, — только
// незаметнее, потому что выглядит вычисленной.
const fxPath = join(ROOT, 'shared', 'fx.json');

console.log('\n── Эквиваленты в долларах ──');

if (!existsSync(fxPath)) {
  console.log('  ??  нет shared/fx.json — обновите курс: npm run fx');
  failed++;
} else {
  const fx = JSON.parse(readFileSync(fxPath, 'utf8'));
  const days = Math.round((Date.now() - Date.parse(fx.date)) / 86_400_000);

  // Девяносто дней — не строгая граница, а срок, за который курс тенге
  // успевает уйти настолько, что округление до тысяч перестаёт спасать.
  if (days > 90) {
    console.log(`  ??  курс от ${fx.date} — ${days} дней назад, обновите: npm run fx`);
    failed++;
  } else {
    console.log(`  ok  курс свежий: 1 $ = ${fx.usd_kzt} ₸ от ${fx.date} (${days} дн. назад)`);
  }

  const marks = [...pitch.matchAll(/data-usd="(\d+)"[^>]*>([^<]*)</g)];

  if (!marks.length) {
    console.log('  ??  в деке нет ни одного эквивалента — а суммы в тенге есть');
    failed++;
  }

  for (const [, tenge, shown] of marks) {
    // Повторяем ту же формулу, что в scripts/fx.mjs: сумма в тенге делится
    // на курс и округляется до тысяч или миллионов.
    const value = Number(tenge) / fx.usd_kzt;
    const want = value >= 1_000_000
      ? `≈ $${(value / 1_000_000).toFixed(1).replace('.', ',')} млн`
      : value >= 1000
        ? `≈ $${Math.round(value / 1000)} тыс.`
        : `≈ $${Math.round(value)}`;

    if (shown.trim() !== want) {
      console.log(`  ??  ${Number(tenge).toLocaleString('ru-RU')} ₸ показаны как «${shown.trim()}», а по курсу это «${want}»`);
      console.log('      пересчитать: npm run fx');
      failed++;
    } else {
      console.log(`  ok  ${Number(tenge).toLocaleString('ru-RU')} ₸ = ${want}`);
    }
  }
}

// ── Юнит-экономика ────────────────────────────────────────────
//
// Слайд не хранит ни одного собственного числа: всё выводится из чека и
// комиссии, названных выше. Проверяем именно это — что выведенное
// совпадает с тем, из чего выводилось.
//
// Смысл проверки прежний: цифра, которую однажды поправили в одном месте
// из двух, выглядит правдоподобно и врёт молча. На слайде про деньги это
// дороже всего — судья считает в уме именно здесь.
const unitFee = find(pitch, /<div class="stat-v">([\d\s ]+)[\s ]₸<\/div>\s*<div class="stat-l">выручка платформы/, 'выручка со сделки');
const arpu = find(pitch, /<div class="stat-v">([\d\s ]+)[\s ]₸<\/div>\s*<div class="stat-l">ARPU/, 'ARPU');
const ltv = find(pitch, /<div class="stat-v">([\d\s ]+)[\s ]₸<\/div>\s*<div class="stat-l">LTV/, 'LTV');
const perYear = find(pitch, /<td>Аренд на человека в год<\/td><td>(\d+)<\/td>/, 'аренд в год');
const lifetime = find(pitch, /<td>Жизнь клиента<\/td><td>(\d+) года<\/td>/, 'жизнь клиента');
const ownerCut = find(pitch, /<td>Владельцу со сделки<\/td><td>([\d\s ]+)[\s ]₸<\/td>/, 'владельцу');
const cacCap = find(pitch, /<td>Потолок CAC<\/td><td>([\d\s ]+)[\s ]₸<\/td>/, 'потолок CAC');

console.log('\n── Юнит-экономика ──');
ok('выручка со сделки та же, что в «Решении»', unitFee, fee, ' ₸');
ok('чек − комиссия = владельцу', total - fee, ownerCut, ' ₸');
ok('сделка × аренд в год = ARPU', unitFee * perYear, arpu, ' ₸');
ok('ARPU × жизнь клиента = LTV', arpu * lifetime, ltv, ' ₸');
// Потолок CAC — не оценка, а следствие: привлечение окупается первой
// сделкой ровно до этой суммы. Совпадать он обязан с выручкой сделки.
ok('потолок CAC = выручка первой сделки', cacCap, unitFee, ' ₸');
// Та же пара аренд в год, что и в расчёте рынка ниже: разойдись они —
// и два слайда одной презентации считали бы разного человека.
ok('аренд в год столько же, сколько в расчёте рынка', perYear, 2);

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
// Между суммой и словом «выручки» теперь стоит эквивалент в долларах:
// образец пропускает необязательный тег между ними.
const kzRevenue = find(pitch, /≈([\d,]+)[\s ]млн[\s ]₸<\/strong>\s*(?:<span[^>]*>[^<]*<\/span>)?\s*выручки/, 'выручка КЗ');

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
// ── Правила Trust Score: слайд против миграции ────────────────
//
// «7 правил Trust Score реализованы как триггеры и политики Postgres» —
// строка в полосе цифр, и до сих пор её никто не сверял. Правило добавят
// восьмым, слайд останется с семёркой, и это заметит ровно тот человек,
// которого мы меньше всего хотим смущать: жюри, считающее по нашей же
// странице.
//
// Считаем не заголовки, а номера: один заголовок покрывает сразу два
// правила («ПРАВИЛО 6-7. Спор о порче и автоматическое разрешение»), и
// счёт по строкам дал бы шесть вместо семи.
const trustSource = readFileSync(
  join(ROOT, 'supabase', 'migrations', '20260816120100_trust_score.sql'),
  'utf8',
);

const ruleNumbers = [...trustSource.matchAll(/^-- ПРАВИЛО (\d+)(?:\s*[-–]\s*(\d+))?/gm)]
  .flatMap((m) => [Number(m[1]), m[2] ? Number(m[2]) : null])
  .filter((n) => n !== null);

const rulesInCode = ruleNumbers.length ? Math.max(...ruleNumbers) : 0;
const rulesOnSlide = find(pitch, /<div class="stat-v">(\d+) правил/, 'число правил Trust Score');

console.log('\n── Trust Score ──');
ok('правил на слайде = в миграции', rulesOnSlide, rulesInCode);

// ── Пороги: тексты против ЖИВОЙ базы ──────────────────────────
//
// Всё выше сверяется с миграцией — то есть с тем, что мы намеревались
// положить в базу. Но обещание человеку держит не намерение, а значение,
// лежащее там сейчас. Настройки в app_settings меняются одной строкой, и
// правило «не трогать схему через SQL Editor» держится на дисциплине.
//
// Три числа названы людям словами и потому проверяются здесь:
//
//   dispute_auto_threshold      «Ущерб до 15 000 ₸ решается автоматически»
//   grace_period_hours          отсрочка перед просрочкой
//   damage_claim_window_hours   окно на претензию по порче
//
// Порог до 05.09.2026 не проверялся ничем, хотя стоит заголовком на
// лендинге и на странице для жюри. Расхождение здесь означает, что мы
// пообещали разбор без людей там, где его не будет.
const secret = process.env.SUPABASE_SECRET_KEY ?? readSecret();

if (secret) {
  const admin = createClient(
    process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL'),
    secret,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { data: live, error: liveError } = await admin
    .from('app_settings')
    .select('key, value');

  if (liveError) {
    console.log('\n── Живые настройки ──');
    console.log(`  ??  базу не спросить: ${liveError.message}`);
  } else {
    const now = Object.fromEntries((live ?? []).map((r) => [r.key, digits(r.value)]));

    console.log('\n── Живые настройки против текстов ──');

    ok('комиссия в базе = коду', now.commission_pct, commissionCode, '%');
    ok('сбор в базе = коду', now.insurance_fee, insuranceCode, ' ₸');

    // Порог ищется в обоих текстах: заголовок один и тот же, и разойтись
    // они могут поодиночке.
    const thresholdPitch = find(
      pitch,
      /Ущерб до ([\d\s\u00a0]+)[\s\u00a0]?₸/,
      'порог авторешения на странице для жюри',
    );
    const thresholdLanding = find(
      landing,
      /Ущерб до ([\d\s\u00a0]+)[\s\u00a0]?₸/,
      'порог авторешения на лендинге',
    );

    ok('порог на лендинге = базе', thresholdLanding, now.dispute_auto_threshold, ' ₸');
    ok('порог у жюри = базе', thresholdPitch, now.dispute_auto_threshold, ' ₸');
  }
}

const claimed = find(pitch, /<div class="stat-v">(\d+)<\/div>/, 'число проверок стенда');

console.log('\n── Стенд ──');

// Раньше здесь стояло «сверить вручную: npm run test:db» — подсказка,
// которую нельзя выполнить без Docker и которую поэтому пролистывали.
// Теперь стенд оставляет результат файлом, и сверка делается сама.
const countPath = join(ROOT, 'shared', 'db-tests.json');

if (!existsSync(countPath)) {
  console.log(`  ??  на слайде заявлено ${claimed} проверок, а замера нет`);
  console.log('      прогнать стенд: npm run test:db (нужен Docker)');
  failed++;
} else {
  const measured = JSON.parse(readFileSync(countPath, 'utf8'));

  if (measured.проверок !== claimed) {
    console.log(`  ??  на слайде ${claimed} проверок, на стенде ${measured.проверок} (замер ${measured.прогон})`);
    console.log('      это единственная цифра деки, которая растёт сама:');
    console.log('      поправьте stat-v в landing/pitch.html и пересоберите деку');
    failed++;
  } else {
    console.log(`  ok  ${claimed} проверок — столько же прошло на стенде ${measured.прогон}`);
  }
}

console.log(
  failed === 0
    ? '\n✓ Числа деки сходятся между собой и с кодом.\n'
    : `\n✗ Расхождений: ${failed}. Судья, который перемножит, найдёт их раньше нас.\n`,
);

// process.exitCode, а не process.exit(): второе обрывает процесс, не
// дав закрыться соединению supabase-js, и на Windows это кончается
// падением libuv с кодом 127 — «команда не найдена». Скрипт печатал бы
// зелёный отчёт и сообщал системе, что упал (см. scripts/exit.mjs).
process.exitCode = failed === 0 ? 0 : 1;
