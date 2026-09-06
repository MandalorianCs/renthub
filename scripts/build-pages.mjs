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
import { readEnvFile } from './env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

// ── Три оформления по трём адресам ────────────────────────────
//
// Приложение одно, тема — переменная (см. src/theme.ts). Собирается оно
// трижды: /app остаётся тем, что было, /app2 и /app3 — варианты, которые
// можно открыть рядом и сравнить.
//
// Сравнивать по памяти нельзя: «вчера было теснее» — это не наблюдение,
// а ощущение. Два адреса в соседних вкладках отвечают на вопрос за
// секунду, и отвечают одинаково для всех, кто спорит.
//
// Цена — сборка идёт втрое дольше. Она того стоит ровно до того дня,
// когда вариант выберут: тогда лишние два адреса убираются одной
// правкой этого списка.
const VARIANTS = [
  { dir: 'app', theme: 'warm', label: 'исходное оформление' },
  { dir: 'app2', theme: 'calm', label: 'больше воздуха, мягче тени' },
  { dir: 'app3', theme: 'sharp', label: 'плотнее, контрастнее, без теней' },
];

rmSync(DOCS, { recursive: true, force: true });
mkdirSync(DOCS, { recursive: true });

for (const variant of VARIANTS) {
  console.log(`\nСобираю ${variant.dir} — ${variant.label}…`);

  // --clear обязателен, а не «на всякий случай».
  //
  // Metro вшивает EXPO_PUBLIC_-переменные в момент преобразования модуля
  // и кэширует результат. Правка .env кэш не сбрасывает: сборка проходит
  // успешно, имя бандла не меняется, а внутри остаётся старое значение.
  // Поймано на смене EXPO_PUBLIC_AUTH_MODE с invite на sms — публикация
  // молча уехала бы со старым экраном входа.
  //
  // Здесь он обязателен вдвойне: три сборки подряд отличаются ровно
  // одной переменной, и без сброса вторая и третья вышли бы копиями
  // первой — с другим адресом и тем же оформлением.
  execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear'], {
    cwd: ROOT,
    stdio: 'inherit',
    shell: process.platform === 'win32',
    env: {
      ...process.env,
      EXPO_PUBLIC_THEME: variant.theme,
      // baseUrl вшивается в бандл: он определяет, откуда приложение
      // грузит свои же файлы. Для /app2 он обязан отличаться, иначе
      // вторая версия будет тянуть бандл первой и покажет её оформление.
      EXPO_BASE_URL: `/renthub/${variant.dir}`,
    },
  });

  if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
    console.error(`✗ expo export не создал dist/index.html для ${variant.dir}`);
    process.exit(1);
  }

  mkdirSync(join(DOCS, variant.dir), { recursive: true });
  cpSync(join(ROOT, 'dist'), join(DOCS, variant.dir), { recursive: true });
}
// ── Лендинг: витрина берётся из базы ──────────────────────────
//
// В разметке лендинга полка заполняется скриптом, которому нужны адрес
// проекта и публичный ключ. Подставляются они здесь, а не лежат в
// index.html, по той же причине, по которой их не пишут в исходники
// приложения: значения приходят из .env и меняются вместе с проектом.
//
// Ключ публичный по назначению — тот же, что уже лежит в бандле
// приложения в этой же папке docs. Доступ ограничивает не он, а политики
// базы: анонимный запрос видит ровно то, что видит человек в открытом
// каталоге. Секретный ключ здесь появиться не может — он читается другой
// функцией и в сборку не попадает.
//
// Нет .env — лендинг всё равно собирается: в разметке лежит запасная
// полка с настоящими ценами и честным «Пока нет отзывов». Витрина не
// исчезнет, просто перестанет обновляться сама.
const publicUrl = readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const publicKey = readEnvFile('EXPO_PUBLIC_SUPABASE_ANON_KEY');
const pilotCity = readEnvFile('EXPO_PUBLIC_PILOT_CITY');

let landing = readFileSync(join(ROOT, 'landing', 'index.html'), 'utf8');

if (publicUrl && publicKey) {
  const conf = JSON.stringify({ url: publicUrl, key: publicKey, city: pilotCity ?? 'Кокшетау' });
  landing = landing.replace('</head>', `  <script>window.RENTHUB_PUBLIC=${conf};</script>
  </head>`);
} else {
  console.log('  ! Нет EXPO_PUBLIC_SUPABASE_* — витрина лендинга останется запасной');
}

writeFileSync(join(DOCS, 'index.html'), landing);

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

// Та же дека файлом — /pitch/RentHUB-pitch.pdf.
//
// На защите ссылка означает чужой вайфай и чужой браузер, а файл
// открывается без интернета и пересылается целиком. Печатает его
// npm run pitch:pdf из этой же страницы: второй копии деки в проекте
// нет и не будет — числа сверяет npm run check:pitch, и сверяет он
// разметку landing/pitch.html.
//
// Если файла нет, сборка не падает: PDF производный, и его отсутствие
// не повод не публиковать сайт. Молча пропустить тоже нельзя — скажем
// об этом строкой, иначе судьи получат ссылку на 404.
// Презентация выкладывается рядом с раздаткой по той же причине, по
// которой вообще существует: организатор просит именно PPTX, и просит
// обычно за час до защиты. Оба файла собираются одной командой из одних
// снимков — npm run pitch:deck.
for (const [file, command] of [
  ['RentHUB-pitch.pdf', 'npm run pitch:pdf'],
  ['RentHUB-pitch.pptx', 'npm run pitch:pptx'],
]) {
  const src = join(ROOT, 'landing', file);
  if (existsSync(src)) {
    cpSync(src, join(DOCS, 'pitch', file));
  } else {
    console.log(`  ! ${file} не найден — соберите: ${command}`);
  }
}

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

// ── Приложение ставится на телефон ───────────────────────────
//
// Экспорт Expo манифест не создаёт (проверено на собранной папке), а без
// него браузер не предложит «Установить». Значения берутся из app.json,
// раздел web: второй копии настроек не появляется.
const appConfig = JSON.parse(readFileSync(join(ROOT, 'app.json'), 'utf8')).expo.web ?? {};

const manifest = {
  name: appConfig.name ?? 'RentHUB',
  short_name: appConfig.shortName ?? 'RentHUB',
  description: appConfig.description ?? '',
  lang: appConfig.lang ?? 'ru',
  start_url: appConfig.startUrl ?? `${SITE}app/`,
  scope: appConfig.scope ?? `${SITE}app/`,
  display: appConfig.display ?? 'standalone',
  orientation: appConfig.orientation ?? 'portrait',
  theme_color: appConfig.themeColor ?? '#AE5030',
  background_color: appConfig.backgroundColor ?? '#FAF7F2',
  icons: [
    {
      src: '../assets/app-icon-192.png',
      sizes: '192x192',
      type: 'image/png',
      // maskable: Android обрезает иконку под форму системы, и знак
      // нарисован с запасом по краям именно под это.
      purpose: 'any maskable',
    },
    { src: '../assets/app-icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
  ],
};

writeFileSync(
  join(DOCS, 'app', 'manifest.webmanifest'),
  `${JSON.stringify(manifest, null, 2)}\n`,
);

// Служебный скрипт: установка и открытие без сети.
//
// Страницы — из сети, и только при её отсутствии из кеша: иначе судья
// увидит вчерашнюю версию и решит, что мы ничего не поправили. Статика —
// из кеша: имена файлов содержат хеш сборки, старое не подменит новое.
const serviceWorker = `// Собран автоматически: scripts/build-pages.mjs
const CACHE = 'renthub-${BUILD_REF}';

self.addEventListener('install', (event) => {
  // Не ждём закрытия вкладок: обновление должно доезжать сразу.
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Страница: сначала сеть, кеш — запасной путь на случай метро и лифта.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
          return response;
        })
        .catch(() => caches.match(request).then((hit) => hit || caches.match('${SITE}app/'))),
    );
    return;
  }

  // Статика: имена с хешем, поэтому кеш безопасен и быстр.
  event.respondWith(
    caches.match(request).then((hit) => {
      if (hit) return hit;
      return fetch(request).then((response) => {
        if (response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      });
    }),
  );
});
`;

writeFileSync(join(DOCS, 'app', 'sw.js'), serviceWorker);

// Теги в index.html приложения: манифест, цвет панели, иконка для iOS и
// регистрация служебного скрипта.
{
  const appIndex = join(DOCS, 'app', 'index.html');
  const html = readFileSync(appIndex, 'utf8');

  const tags = [
    '<link rel="manifest" href="manifest.webmanifest" />',
    `<meta name="theme-color" content="${manifest.theme_color}" />`,
    '<link rel="apple-touch-icon" href="../assets/apple-touch-icon.png" />',
    '<meta name="apple-mobile-web-app-capable" content="yes" />',
    '<meta name="apple-mobile-web-app-title" content="RentHUB" />',
    '<script>',
    "  if ('serviceWorker' in navigator) {",
    "    window.addEventListener('load', function () {",
    "      navigator.serviceWorker.register('sw.js').catch(function () {",
    '        // Регистрация может не пройти в приватном окне или при',
    '        // запрете хранилища. Это не повод ронять приложение: без',
    '        // служебного скрипта оно работает как обычный сайт.',
    '      });',
    '    });',
    '  }',
    '</script>',
  ].join('\n    ');

  if (!html.includes('rel="manifest"')) {
    writeFileSync(appIndex, html.replace('</head>', `  ${tags}\n  </head>`));
  }
}


const BUILD_META = `
    <meta name="renthub-build" content="${BUILD_REF}" />`;

/**
 * Заблаговременное соединение с базой.
 *
 * Приложение открывается и сразу идёт за объявлениями и их фотографиями —
 * оба запроса к одному домену Supabase. Пока браузер только начинает
 * рукопожатие, витрина пустая: Lighthouse на живом сайте оценил эту паузу
 * в 300 мс, а на мобильном интернете она заметно больше.
 *
 * Адрес читается из .env — того же, из которого он попадает в бандл. Нет
 * его — подсказка просто не появится, сборка от этого не страдает.
 */
function supabaseHints() {
  const url = readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
  if (!url) return '';

  return `<link rel="preconnect" href="${url}" crossorigin />
    <link rel="dns-prefetch" href="${url}" />`;
}

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
    <meta name="twitter:image" content="${SITE}assets/og.png" />
    ${supabaseHints()}`;

// Теги вставляются во ВСЕ три оформления, а не только в основное.
// Ссылку на вариант тоже пересылают — «посмотри, как стало», — и без
// карточки она приходит в чат голым адресом.
const appHtmlPath = join(DOCS, 'app', 'index.html');

for (const variant of VARIANTS) {
  const htmlPath = join(DOCS, variant.dir, 'index.html');
  const html = readFileSync(htmlPath, 'utf8');

  if (html.includes('og:title')) {
    // Экспорт когда-нибудь начнёт добавлять теги сам — тогда две карточки
    // подряд собьют превью, и лучше узнать об этом сразу.
    console.warn(`\u26a0 В index.html ${variant.dir} уже есть og:title — теги не добавлены`);
  } else {
    writeFileSync(htmlPath, html.replace('</head>', `${APP_META}\n  </head>`));
  }
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
