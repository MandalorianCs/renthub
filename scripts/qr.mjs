#!/usr/bin/env node
// QR-коды для деки и лендинга.
//
//   npm run qr
//
// Зачем. На защите у судьи в руках телефон, а на экране — ссылка,
// которую он должен перепечатать. Никто не перепечатывает. QR решает это
// за секунду: навёл камеру — открыл продукт, пока докладчик ещё говорит.
//
// Почему в разметку, а не картинкой. Код рисуется в SVG и вставляется в
// страницу прямо тегом: он не грузится отдельным файлом, не пропадает
// при пересылке PDF и не мылится на проекторе — вектор.
//
// Что делает скрипт. Находит в разметке контейнеры <div data-qr="адрес">,
// рисует для каждого код и кладёт SVG внутрь. Адрес живёт в разметке
// рядом с подписью, поэтому второй копии ссылок в проекте не появляется.
//
// Библиотека: soldair/node-qrcode (MIT) — она же qrcode в npm. Тянется
// через npx в момент запуска: в приложении и на сайте она не нужна,
// нужен только результат её работы.

import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PAGES = [
  join(ROOT, 'landing', 'pitch.html'),
  join(ROOT, 'landing', 'index.html'),
];

// Цвета кода: чернильный на кремовом, как вся дека. Чистый чёрный на
// белом рядом с мягкими тонами выглядит вставкой из другого документа, а
// контраста 12 : 1 камере хватает с запасом.
const DARK = '#1A1917';
const LIGHT = '#FAF7F2';

/**
 * SVG кода для одного адреса.
 *
 * Уровень коррекции M, а не H: код на слайде показывают целиком и не
 * пачкают, а лишняя избыточность делает ячейки мельче — камере с задних
 * рядов их труднее поймать.
 */
function draw(url) {
  // Пишем во временный файл: у qrcode вывод SVG идёт только туда, в stdout
  // он рисует код псевдографикой для терминала.
  const tmp = join(tmpdir(), `renthub-qr-${Date.now()}.svg`);

  execSync(`npx --yes qrcode -t svg -e M -o "${tmp}" "${url}"`, {
    stdio: ['ignore', 'ignore', 'ignore'],
    timeout: 120_000,
  });

  const svg = readFileSync(tmp, 'utf8');
  rmSync(tmp, { force: true });

  return svg
    // Декларация и DOCTYPE нужны отдельному файлу, а не куску страницы.
    .replace(/<\?xml[^>]*\?>/, '')
    .replace(/<!DOCTYPE[^>]*>/, '')
    .replace(/#ffffff/gi, LIGHT)
    .replace(/#000000/gi, DARK)
    // Размер задаёт вёрстка: у кода квадратный viewBox, и он растянется
    // ровно на отведённое место.
    .replace(/<svg /, '<svg width="100%" height="100%" aria-hidden="true" ')
    .trim();
}


let total = 0;

for (const page of PAGES) {
  const before = readFileSync(page, 'utf8');
  let after = before;

  // Контейнер: <div class="qr" data-qr="https://…"></div>
  const holders = [...before.matchAll(/<div([^>]*?)data-qr="([^"]+)"([^>]*)>([\s\S]*?)<\/div>/g)];

  for (const [whole, pre, url, post] of holders) {
    const svg = draw(url);
    after = after.replace(whole, `<div${pre}data-qr="${url}"${post}>${svg}</div>`);
    total += 1;
    console.log(`  нарисован код: ${url}`);
  }

  if (after !== before) writeFileSync(page, after, 'utf8');
}

if (!total) {
  console.log('\n  Контейнеров <div data-qr="…"> в разметке нет — рисовать нечего.\n');
  process.exit(0);
}

console.log(`\n✓ Кодов в разметке: ${total}`);
console.log('  Дека изменилась — пересоберите файлы: npm run pitch:deck\n');
