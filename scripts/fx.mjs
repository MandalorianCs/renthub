#!/usr/bin/env node
// Курс тенге к доллару в деке.
//
//   npm run fx        обновить курс и пересчитать эквиваленты
//
// Зачем. Жюри и потенциальные инвесторы считают рынок в долларах, а вся
// наша арифметика — в тенге: чек 10 500 ₸, выручка пилота 5,6 млн ₸,
// верхняя граница 49 млн ₸. Человек, который слышит «сорок девять
// миллионов», делит их в уме на курс, который помнит примерно, — и
// получает не то, что мы имели в виду.
//
// Поэтому крупные суммы деки несут эквивалент рядом: «≈ $108 тыс.».
// Считает его этот скрипт, а не рука: посчитанное рукой устаревает молча.
//
// Откуда курс. @fawazahmed0/currency-api — открытый список курсов из
// каталога public-apis (github.com/public-apis/public-apis): без ключа,
// без лимитов, раздаётся с jsDelivr. Мы берём оттуда одно число раз в
// несколько недель, поэтому ни ключ, ни договор здесь не нужны.
//
// Почему при сборке, а не в браузере. Лендинг и дека не должны зависеть
// от чужой доступности: упавший CDN не имеет права стереть цифру со
// слайда. Курс приезжает сюда один раз, ложится в shared/fx.json и
// уезжает в разметку числом.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STORE = join(ROOT, 'shared', 'fx.json');

// Файлы, где живут суммы с эквивалентом.
const PAGES = [
  join(ROOT, 'landing', 'pitch.html'),
  join(ROOT, 'landing', 'index.html'),
];

const SOURCE =
  'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies/usd.json';

/**
 * Читаемая сумма в долларах.
 *
 * Точность здесь вредна: «$107 462» на слайде читается как измерение,
 * хотя это пересчёт допущения по плавающему курсу. Округляем до тысяч и
 * миллионов — так число честно показывает свой порядок.
 */
function usd(tenge, rate) {
  const value = tenge / rate;

  if (value >= 1_000_000) {
    return `≈ $${(value / 1_000_000).toFixed(1).replace('.', ',')} млн`;
  }
  if (value >= 1000) {
    return `≈ $${Math.round(value / 1000)} тыс.`;
  }
  return `≈ $${Math.round(value)}`;
}

async function fetchRate() {
  const response = await fetch(SOURCE, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`ответ ${response.status}`);

  const data = await response.json();
  const rate = data?.usd?.kzt;

  if (!rate || !Number.isFinite(rate)) throw new Error('в ответе нет курса usd→kzt');

  return { rate, date: data.date ?? new Date().toISOString().slice(0, 10) };
}

let fresh;

try {
  fresh = await fetchRate();
  console.log(`\nКурс получен: 1 $ = ${fresh.rate.toFixed(2)} ₸ на ${fresh.date}`);
} catch (error) {
  // Нет сети — не повод стирать эквиваленты: старый курс честнее пустоты,
  // а проверка деки скажет, если он совсем протух.
  console.error(`\n✗ Курс не получен: ${error.message}`);
  console.error('  Разметка оставлена как есть.\n');
  process.exit(1);
}

writeFileSync(
  STORE,
  `${JSON.stringify(
    {
      комментарий: [
        'Курс доллара к тенге для эквивалентов в деке и на лендинге.',
        '',
        'Обновляется командой npm run fx из открытого списка курсов',
        '@fawazahmed0/currency-api (каталог public-apis). Здесь он лежит',
        'числом, чтобы страницы не зависели от чужой доступности: упавший',
        'CDN не должен стирать цифру со слайда.',
        '',
        'Свежесть сверяет npm run check:pitch — курс старше 90 дней',
        'превращает «≈ $108 тыс.» в неправду.',
      ],
      usd_kzt: Number(fresh.rate.toFixed(4)),
      date: fresh.date,
      source: SOURCE,
    },
    null,
    2,
  )}\n`,
  'utf8',
);

// ── Пересчёт разметки ─────────────────────────────────────────
//
// Эквивалент живёт в <span data-usd="49000000"></span>: в атрибуте —
// сумма в тенге, внутри — то, что видит человек. Так число на слайде
// всегда выведено из суммы, которая рядом, а не написано отдельно.

let touched = 0;

for (const page of PAGES) {
  const before = readFileSync(page, 'utf8');
  const after = before.replace(
    /(<span[^>]*data-usd="(\d+)"[^>]*>)([^<]*)(<\/span>)/g,
    (whole, open, tenge, old, close) => {
      const next = usd(Number(tenge), fresh.rate);
      if (next !== old) touched += 1;
      return `${open}${next}${close}`;
    },
  );

  if (after !== before) writeFileSync(page, after, 'utf8');
}

console.log(`  Пересчитано мест в разметке: ${touched}`);
console.log('  Курс записан в shared/fx.json\n');

if (touched) {
  console.log('  Дека изменилась — пересоберите файлы: npm run pitch:deck\n');
}
