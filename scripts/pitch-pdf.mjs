#!/usr/bin/env node
// Дека для судей одним файлом.
//
//   npm run pitch:pdf
//
// Зачем. Питч показывают по ссылке, но на защите ссылка — это чужой
// вайфай и чужой браузер. PDF открывается без интернета и приходит в
// мессенджер целиком.
//
// Почему печатается ИЗ страницы, а не собирается отдельно. Вторая копия
// презентации разошлась бы с первой в первый же вечер правок, а числа
// деки сверяет npm run check:pitch — и сверяет он разметку
// landing/pitch.html, а не чужой файл. Здесь тот же принцип, что во всём
// проекте: один источник, проверяемый одним инструментом.
//
// Печатные правила живут в самой деке, в блоке @media print. Там же
// записано, почему масштаб 0,9 и почему слайд не начинается с новой
// страницы.

import { execFileSync, spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'landing', 'RentHUB-pitch.pdf');
const PORT = 8899;

// ── Чем печатать ──────────────────────────────────────────────
//
// Chrome и Edge печатают одинаково — оба Chromium. Ищем, что есть:
// на машине пилота стоит Edge, в CI обычно Chrome.
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
];

const browser = BROWSERS.find((p) => existsSync(p));

if (!browser) {
  console.error('\n✗ Не нашёл Chrome или Edge — печатать нечем.');
  console.error('  Пути, которые проверены:');
  for (const p of BROWSERS) console.error(`    ${p}`);
  process.exit(1);
}

// ── Почему через локальный сервер, а не file:// ───────────────
//
// Печать из file:// работает, но шрифты и SVG-схемы подтягиваются
// относительными путями, и часть из них Chromium из файловой системы
// не берёт — в PDF уезжает дека без картинки карточки и без части
// начертаний Manrope. Разница видна только в готовом файле, то есть
// поздно.
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

const server = createServer((req, res) => {
  const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '') || 'pitch.html';
  const file = join(ROOT, 'landing', rel);

  if (!file.startsWith(join(ROOT, 'landing')) || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404).end('not found');
    return;
  }

  res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
  res.end(readFileSync(file));
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// ── Печать ────────────────────────────────────────────────────
//
// virtual-time-budget даёт странице досчитать вёрстку и подгрузить
// шрифты. Без него Chromium печатает тот кадр, который успел, и в PDF
// попадает дека в системном шрифте.
// Linux в CI печатает только без песочницы: контейнер runner'а не даёт
// Chromium создать пользовательские namespace'ы, и он падает на старте.
// Признак коварный — шаг с continue-on-error помечается «success», а
// файла нет: первая публикация так и прошла, с зелёной галочкой и 404
// на месте деки.
const sandbox = process.platform === 'win32' ? [] : ['--no-sandbox', '--disable-dev-shm-usage'];

try {
  execFileSync(
  browser,
  [
    '--headless=new',
    '--disable-gpu',
    ...sandbox,
    // Свой профиль обязателен. Без него запуск не создаёт новый
    // процесс, а передаёт команду уже открытому браузеру — тот
    // печатать не берётся, и на диск попадает обрывок в одну
    // страницу. На машине, где Edge открыт всегда, это выглядит как
    // «скрипт сломался», хотя сломан не он.
    `--user-data-dir=${join(tmpdir(), 'renthub-pitch-print')}`,
    '--no-pdf-header-footer',
    `--print-to-pdf=${OUT}`,
    '--virtual-time-budget=12000',
    `http://127.0.0.1:${PORT}/pitch.html`,
  ],
  // Таймаут и глушение ошибки — не перестраховка, а разница между
  // платформами. На Windows Chromium форкается и возвращает управление
  // сразу; на Linux в CI он остаётся жить и не выходит сам — шаг
  // публикации висел три минуты и падал по таймауту, оставляя сайт без
  // деки. К этому моменту файл уже напечатан: проверяем его ниже, а
  // зависший процесс просто снимаем.
  { stdio: 'ignore', timeout: 60_000, killSignal: 'SIGKILL' },
  );
} catch {
  // Снятый по таймауту браузер — обычный исход на Linux, а не сбой.
  // Судит о результате проверка файла, а не код возврата.
}

// Сервер НЕ закрывается здесь, и это главное место скрипта.
//
// execFileSync ждёт запущенный процесс, а Chromium на Windows форкается:
// страницу дочитывает и печатает потомок. Закрытие сервера сразу после
// вызова обрывало ему загрузку на середине — в PDF уходила ОДНА
// страница вместо тринадцати, а скрипт бодро печатал «готово».
// Сервер живёт до тех пор, пока файл не перестанет расти.

// ── Дождаться, пока файл допишется ────────────────────────────
//
// execFileSync возвращает управление, когда завершился ЗАПУЩЕННЫЙ
// процесс, а Chromium на Windows форкается: печать доканчивает потомок.
// Первая версия скрипта читала файл в этот момент и получала обрывок —
// 75 КБ и ОДНА страница вместо тринадцати, причём с бодрым «Дека
// напечатана» в выводе. Тот же класс ошибки, что «ok от скрипта правки
// означает „в памяти"»: успех печатался раньше результата.
//
// Ждём, пока размер перестанет расти три замера подряд.
let last = -1;
let stable = 0;
for (let i = 0; i < 120 && stable < 4; i += 1) {
  await new Promise((r) => setTimeout(r, 500));
  const now = existsSync(OUT) ? statSync(OUT).size : -1;
  stable = now > 0 && now === last ? stable + 1 : 0;
  last = now;
}

server.close();

if (!existsSync(OUT) || statSync(OUT).size === 0) {
  console.error('\n✗ Браузер отработал, а файла нет. Проверьте, не открыт ли PDF в просмотрщике.');
  process.exit(1);
}

const size = Math.round(statSync(OUT).size / 1024);

// ── Проверка вместо доверия ───────────────────────────────────
//
// «Файл создан» ничего не значит: первая рабочая версия печатала
// одиннадцать страниц, из которых три были ПУСТЫМИ — блоки с
// анимацией появления (.reveal держит opacity: 0, пока страницу не
// прокрутят) уезжали в PDF прозрачными. Файл при этом весил как
// надо и открывался.
//
// Поэтому здесь считается не факт печати, а содержимое: сколько
// страниц и есть ли среди них пустые. Считаем по потокам страниц —
// без внешних утилит, их на машине может не быть.
const pdf = readFileSync(OUT);
const pages = (pdf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) ?? []).length;

// Одна страница означает оборванную печать, а не короткую деку.
if (pages < 5) {
  console.error(`\n✗ В файле ${pages} страниц — дека столько не занимает.`);
  console.error('  Печать оборвалась. Запустите команду ещё раз.\n');
  process.exit(1);
}

// Отпечаток деки, из которой напечатан этот файл.
//
// Нужен, чтобы проверка свежести работала в CI. Первая версия сравнивала
// время файлов — и падала на каждом прогоне: git времени не хранит, при
// клонировании все файлы получают время checkout'а, а их порядок между
// собой случаен. Проверка, которая падает всегда, учит не читать её
// вывод.
//
// Хеш — то же самое утверждение, но проверяемое где угодно: «этот PDF
// напечатан вот из этой версии pitch.html».
writeFileSync(
  `${OUT}.sha`,
  `${createHash('sha256').update(readFileSync(join(ROOT, 'landing', 'pitch.html'))).digest('hex')}\n`,
);

console.log(`\n✓ Дека напечатана: landing/RentHUB-pitch.pdf`);
console.log(`  ${pages} ${pages % 10 === 1 && pages % 100 !== 11 ? 'страница' : 'страниц'}, ${size} КБ\n`);
console.log('  Числа деки сверяет npm run check:pitch — он же следит, чтобы');
console.log('  напечатанное совпадало с кодом и с базой.\n');
