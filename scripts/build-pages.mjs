#!/usr/bin/env node
// Сборка публичной версии для GitHub Pages.
//
//   npm run build:pages
//
// Раскладка:
//   docs/index.html   — лендинг, он же корень сайта
//   docs/app/         — само приложение (Expo web)
//   docs/.nojekyll    — см. ниже, без него приложение не запустится
//
// Почему docs, а не dist: Pages умеет отдавать сайт из папки docs ветки
// main, и это единственный вариант без отдельной ветки gh-pages и
// дополнительной механики публикации.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

console.log('Собираю веб-версию приложения…');

// --clear обязателен, а не «на всякий случай».
//
// Metro вшивает EXPO_PUBLIC_-переменные в момент преобразования модуля и
// кэширует результат. Правка .env кэш не сбрасывает: сборка проходит
// успешно, имя бандла не меняется, а внутри остаётся старое значение.
// Поймано на смене EXPO_PUBLIC_AUTH_MODE с invite на sms — публикация
// молча уехала бы со старым экраном входа.
//
// Цена — лишняя минута на пересборку. Она дешевле часа поисков причины,
// по которой «переменную поменяли, а ничего не изменилось».
execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ expo export не создал dist/index.html');
  process.exit(1);
}

rmSync(DOCS, { recursive: true, force: true });
mkdirSync(join(DOCS, 'app'), { recursive: true });

cpSync(join(ROOT, 'dist'), join(DOCS, 'app'), { recursive: true });
cpSync(join(ROOT, 'landing', 'index.html'), join(DOCS, 'index.html'));

// Страницы схем публикуются отдельными адресами. На питче ссылку открыть
// быстрее, чем искать картинку в переписке, а сами страницы самодостаточны:
// весь SVG внутри, внешних файлов нет.
cpSync(join(ROOT, 'landing', 'diagrams'), join(DOCS, 'diagrams'), { recursive: true });

// Картинки лендинга: пока там только фавикон, но папка нужна целиком —
// логотип и картинка для карточки ссылки лягут туда же.
cpSync(join(ROOT, 'landing', 'assets'), join(DOCS, 'assets'), { recursive: true });

// Питч — отдельная страница, а не замена лендинга: лендинг написан для
// владельцев инструмента, питч — для жюри и инвесторов. Один текст не
// обслуживает обе аудитории, а адрес /pitch/ удобно диктовать голосом.
mkdirSync(join(DOCS, 'pitch'), { recursive: true });
cpSync(join(ROOT, 'landing', 'pitch.html'), join(DOCS, 'pitch', 'index.html'));

// robots.txt и sitemap.xml.
//
// Приложение из индекса исключено намеренно: это одностраничное приложение
// на клиентской маршрутизации, поисковик увидит там пустой каркас и решит,
// что сайт пустой. Индексировать нужно то, что читается без JavaScript, —
// лендинг, питч и схемы.
const SITE = 'https://mandaloriancs.github.io/renthub/';
const pages = ['', 'pitch/', 'diagrams/deal-loop.html', 'diagrams/money-flow.html'];
const today = new Date().toISOString().slice(0, 10);

writeFileSync(
  join(DOCS, 'robots.txt'),
  ['User-agent: *', 'Allow: /', 'Disallow: /renthub/app/', '', `Sitemap: ${SITE}sitemap.xml`, ''].join('\n'),
);

writeFileSync(
  join(DOCS, 'sitemap.xml'),
  [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    ...pages.map((p) => `  <url><loc>${SITE}${p}</loc><lastmod>${today}</lastmod></url>`),
    '</urlset>',
    '',
  ].join('\n'),
);

// GitHub Pages прогоняет сайт через Jekyll, а тот игнорирует папки,
// начинающиеся с подчёркивания. Expo кладёт бандл в _expo/static/… —
// без этого файла сайт откроется, а весь JavaScript вернёт 404, и
// симптом будет выглядеть как «белый экран, локально всё работает».
writeFileSync(join(DOCS, '.nojekyll'), '');

// ── Карточка ссылки для мессенджеров ──────────────────────────
//
// Expo отдаёт голый index.html: <title>RentHUB</title> и ничего больше.
// Значит любая ссылка на приложение — из бота, из «поделиться», на
// конкретное объявление — приходит в чат безымянным адресом: ни названия,
// ни описания, ни картинки.
//
// Для витрины, которая растёт пересылкой ссылок, это прямая потеря: сосед
// отправил ссылку на перфоратор, а получатель видит строку из букв и цифр.
// Лендинг такие теги имеет давно, приложение — нет.
//
// Теги вставляются здесь, а не в шаблон Expo: шаблон перегенерируется
// экспортом при каждой сборке, и правка в нём не переживёт следующую.
//
// Описание общее, без конкретной вещи: статический хостинг не умеет
// отдавать разные теги на разные адреса, а угадывать название объявления
// на клиенте поздно — превью собирается до выполнения JavaScript.

// ── Отпечаток сборки ──────────────────────────────────────────
//
// Из какого коммита собрано то, что лежит на адресе.
//
// Зачем. Публикуют два процесса сразу — наш workflow (сборка из кода) и
// встроенный «pages build and deployment» (папка docs/ из ветки). У обоих
// deploy завершается успехом, и на адресе оказывается тот, кто финишировал
// вторым. Вопрос «доехала ли правка» до сих пор решался гаданием.
//
// Хеш бандла для этого не годится, и это проверено 05.09.2026: локальная
// сборка дала entry-0c9ae25a…, опубликованная — entry-39700533…, при том
// что обе содержали одну и ту же правку. Имя файла зависит от окружения
// сборки, а не только от кода, и как признак свежести оно врёт в обе
// стороны.
//
// Коммит не врёт. `git rev-parse` в CI даёт тот коммит, который собирают.
// Если git недоступен (сборка из архива без .git) — пишем «unknown»: это
// честнее, чем подставить что-нибудь и сверять с этим.
let BUILD_REF = 'unknown';
try {
  BUILD_REF = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();
} catch {
  // Оставляем 'unknown' — см. выше.
}

const BUILD_META = `
    <meta name="renthub-build" content="${BUILD_REF}" />`;

const APP_META = `${BUILD_META}
    <meta name="description" content="Витрина аренды строительного инструмента в Кокшетау: цена за сутки, депозит, календарь занятости." />
    <meta property="og:type" content="website" />
    <meta property="og:site_name" content="RentHUB" />
    <meta property="og:title" content="RentHUB — аренда инструмента у соседей" />
    <meta property="og:description" content="Витрина аренды строительного инструмента в Кокшетау: цена за сутки, депозит, календарь занятости." />
    <meta property="og:url" content="${SITE}app/" />
    <meta property="og:image" content="${SITE}assets/og.png" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="RentHUB — аренда инструмента у соседей" />
    <meta name="twitter:description" content="Витрина аренды строительного инструмента в Кокшетау: цена за сутки, депозит, календарь занятости." />
    <meta name="twitter:image" content="${SITE}assets/og.png" />`;

const appHtmlPath = join(DOCS, 'app', 'index.html');
const appHtml = readFileSync(appHtmlPath, 'utf8');

if (appHtml.includes('og:title')) {
  // Экспорт когда-нибудь начнёт добавлять теги сам — тогда две карточки
  // подряд собьют превью, и лучше узнать об этом сразу.
  console.warn('⚠ В index.html приложения уже есть og:title — теги не добавлены');
} else {
  writeFileSync(appHtmlPath, appHtml.replace('</head>', `${APP_META}\n  </head>`));
}

// Приложение — SPA с маршрутизацией на клиенте. Прямой заход на
// /renthub/app/item/<id> Pages не найдёт как файл и отдаст свою 404 —
// а без этого нельзя отправить ссылку на конкретное объявление, то есть
// отваливается основа маркетплейса.
//
// Файл обязан лежать в КОРНЕ публикации: GitHub Pages ищет 404.html
// только там, вложенные игнорирует. Внутри — index приложения: ассеты
// в нём прописаны абсолютными путями, поэтому он работает с любой глубины,
// а expo-router разберёт адрес из location сам.
//
// Копируется ПОСЛЕ вставки тегов: ссылки на объявления ведут именно сюда,
// и без карточки они остались бы теми же безымянными адресами.
cpSync(appHtmlPath, join(DOCS, '404.html'));

// ── Ссылки на собственные файлы ───────────────────────────────
//
// Страницы называют свои файлы полными адресами: og:image, логотип в
// структурированных данных, канонические ссылки. Опечатка в таком адресе
// не ломает ничего видимого — ломается то, что видит не человек.
//
// 05.09.2026 в landing/index.html поле `logo` для поисковика указывало на
// `/renthub/og-image.png`, а файл лежит в `/renthub/assets/og.png`. Google
// шёл за логотипом организации и получал 404. Заметить это глазами нельзя:
// на странице ничего не меняется.
//
// Проверяем здесь, а не отдельной командой: сборка — единственный момент,
// когда известны и адреса, и то, какие файлы реально получились.
const SITE_PREFIX = 'https://mandaloriancs.github.io/renthub/';
const brokenLinks = [];

for (const page of ['index.html', 'pitch/index.html', 'app/index.html']) {
  const full = join(DOCS, page);
  if (!existsSync(full)) continue;

  const html = readFileSync(full, 'utf8');
  for (const match of html.matchAll(/https:\/\/mandaloriancs\.github\.io\/renthub\/([^"'\s)]*)/g)) {
    const rel = match[1].split('?')[0].split('#')[0];
    // Пустой путь — сам сайт; каталоги отдаёт index.html; адреса приложения
    // разбирает клиентская маршрутизация, файлов под них нет и не должно.
    if (!rel || rel.endsWith('/') || rel.startsWith('app/')) continue;
    if (!existsSync(join(DOCS, rel))) brokenLinks.push(`${page} → ${SITE_PREFIX}${rel}`);
  }
}

if (brokenLinks.length) {
  console.error('\n✗ Страницы ссылаются на файлы, которых в сборке нет:\n');
  for (const link of [...new Set(brokenLinks)]) console.error(`    ${link}`);
  console.error('\n  Это не видно глазами: ломается превью в мессенджере или');
  console.error('  логотип в поиске, а страница выглядит целой.\n');
  process.exit(1);
}

console.log(`
✓ Собрано в docs/ — это локальный предпросмотр.

  Публикацию делает GitHub Actions при пуше в main
  (.github/workflows/pages.yml): сайт всегда собирается из того кода,
  который лежит в main, и забыть пересборку больше нельзя.

  Открыть собранное локально:
    docs/index.html      лендинг
    docs/app/index.html  приложение

Живые адреса:
  лендинг     https://mandaloriancs.github.io/renthub/
  приложение  https://mandaloriancs.github.io/renthub/app/
`);
