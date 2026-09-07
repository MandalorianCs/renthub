#!/usr/bin/env node
// Контраст цветов приложения.
//
//   npm run check:contrast
//
// Зачем. 06.09.2026 замер лендинга показал пару «янтарный на янтарной
// подложке» с контрастом 2,81 при норме 4,5 — вдвое ниже. Это плашки
// «Простаивает», «Ожидание», «Срок подходит»: надписи, которые читают с
// телефона во дворе и на проекторе в светлом зале, то есть в худших
// условиях из возможных.
//
// Нашлось это случайно, инструментом для сайта. У приложения такого
// инструмента нет: Lighthouse умеет мерить страницу, а не палитру, и
// экраны, до которых он не дошёл (сделка, спор, профиль), никем не
// проверены.
//
// Что проверяем. Пары «цвет текста на своём фоне» из src/theme.ts —
// именно так они и стоят в интерфейсе. Норма WCAG AA: 4,5 для обычного
// текста, 3,0 для крупного (18pt и больше или полужирный от 14pt).
//
// Цвета читаются разбором файла, а не импортом: src/theme.ts тянет
// react-native, которого в Node нет.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const source = readFileSync(join(ROOT, 'src', 'theme.ts'), 'utf8');

// Цвета лежат как `имя: '#RRGGBB'`. Разбор нестрогий намеренно: если
// формат изменится, проверка скажет «не нашёл цвета», а не промолчит.
const colors = Object.fromEntries(
  [...source.matchAll(/^\s{2}(\w+):\s*'(#[0-9A-Fa-f]{6})'/gm)].map((m) => [m[1], m[2]]),
);

if (Object.keys(colors).length < 8) {
  console.error(`\n✗ В src/theme.ts найдено ${Object.keys(colors).length} цветов — образец сломан.\n`);
  process.exit(1);
}

/** Относительная яркость по WCAG. */
function luminance(hex) {
  const channels = [1, 3, 5].map((i) => {
    const value = parseInt(hex.slice(i, i + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

function ratio(fg, bg) {
  const a = luminance(fg);
  const b = luminance(bg);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

// Пары, которые реально встречаются на экранах. Список ведётся руками:
// перебирать все сочетания бессмысленно — половина из них в интерфейсе не
// существует, и проверка утонула бы в выдуманных претензиях.
const PAIRS = [
  { fg: 'text', bg: 'bg', what: 'основной текст на фоне' },
  { fg: 'text', bg: 'surface', what: 'основной текст на карточке' },
  { fg: 'textMuted', bg: 'bg', what: 'подписи на фоне' },
  { fg: 'textMuted', bg: 'surface', what: 'подписи на карточке' },
  { fg: 'accentInk', bg: 'accentSoft', what: 'акцентный текст на своей подложке' },
  { fg: 'accentInk', bg: 'bg', what: 'акцентный текст на фоне' },
  // Сам accent проверяется как заливка, а не как текст: им красят кнопки,
  // точки и иконки. Для крупного полужирного на нём норма 3,0.
  { fg: 'onFill', bg: 'accent', what: 'текст на кнопке действия', large: true },
  { fg: 'green', bg: 'greenSoft', what: 'подтверждено на своей подложке' },
  { fg: 'warn', bg: 'warnSoft', what: 'ожидание на своей подложке' },
  { fg: 'danger', bg: 'dangerSoft', what: 'спор на своей подложке' },
  { fg: 'onFill', bg: 'green', what: 'текст на зелёной плашке', large: true },
  { fg: 'onFill', bg: 'danger', what: 'текст на красной плашке', large: true },
];

console.log('\n── Контраст в приложении ──');

let failed = 0;
let checked = 0;

for (const pair of PAIRS) {
  const fg = colors[pair.fg];
  const bg = colors[pair.bg];

  if (!fg || !bg) {
    console.log(`  ??  нет цвета: ${!fg ? pair.fg : pair.bg} — образец устарел`);
    failed++;
    continue;
  }

  // 3,0 для крупного текста — это заголовки и надписи на кнопках, которые
  // набраны полужирным от 14pt. Для мелких подписей действует 4,5.
  const need = pair.large ? 3 : 4.5;
  const value = ratio(fg, bg);
  checked++;

  if (value < need) {
    console.log(`  ??  ${pair.what}: ${value.toFixed(2)} : 1 при норме ${need} (${fg} на ${bg})`);
    failed++;
  } else {
    console.log(`  ok  ${pair.what}: ${value.toFixed(2)} : 1`);
  }
}

if (failed === 0) {
  console.log(`\n✓ Все ${checked} пар читаются — в том числе на солнце и с проектора.\n`);
  process.exit(0);
}

console.log('\n  Что делать: затемнить цвет текста или осветлить подложку.');
console.log('  Фирменный тон при этом остаётся — меняется только светлота;');
console.log('  так уже сделано с янтарным (#B8860B → #8C6508).\n');
process.exit(1);
