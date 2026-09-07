#!/usr/bin/env node
// Что видит человек, пришедший по ссылке.
//
//   npm run check:public
//
// Зачем. У нас есть проверки кода, схемы, чисел деки и здоровья базы — и
// ни одной, которая смотрит на продукт снаружи, без ключей и без входа.
// А судья приходит именно так: открывает адрес с телефона и видит либо
// витрину, либо пустой экран.
//
// Отличие от соседних проверок:
//   npm run health       смотрит базу изнутри, с секретным ключом;
//   npm run check:links  обходит ссылки сайта и ищет 404;
//   npm run check:public отвечает на вопрос «работает ли то, что обещано
//                        судьям» — каталог отдаёт вещи, дека скачивается,
//                        приложение ставится на телефон.
//
// Ключей не требует: всё, что здесь проверяется, доступно любому.

const SITE = 'https://mandaloriancs.github.io/renthub/';

// Публичный адрес и ключ берём из собранного приложения — там же, где их
// берёт браузер. Читать .env незачем: проверка смотрит на то, что уехало
// в продакшн, а не на то, что лежит локально.
async function publicConfig() {
  const html = await (await fetch(`${SITE}app/`)).text();
  const entry = html.match(/src="([^"]*entry-[^"]+\.js)"/)?.[1];
  if (!entry) return null;

  const bundle = await (await fetch(new URL(entry, `${SITE}app/`).href)).text();
  const url = bundle.match(/https:\/\/[a-z0-9]+\.supabase\.co/)?.[0];
  const key = bundle.match(/(sb_publishable_[A-Za-z0-9_-]+)/)?.[1]
    ?? bundle.match(/(eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,})/)?.[1];

  return url && key ? { url, key } : null;
}

const checks = [];
let failed = 0;

function say(ok, what, detail = '') {
  checks.push(ok);
  if (!ok) failed++;
  console.log(`  ${ok ? 'ok ' : '?? '} ${what}${detail ? ` — ${detail}` : ''}`);
}

async function status(path) {
  try {
    const response = await fetch(`${SITE}${path}`, { redirect: 'follow' });
    return response;
  } catch (error) {
    return { ok: false, status: 0, error };
  }
}

console.log('\n── Продукт снаружи ──');

// ── Страницы ──────────────────────────────────────────────────
for (const [path, what] of [
  ['', 'лендинг открывается'],
  ['app/', 'приложение открывается'],
  ['pitch/', 'дека открывается страницей'],
]) {
  const response = await status(path);
  say(response.ok, what, response.ok ? '' : `ответ ${response.status}`);
}

// ── Файлы, которые скачивают судьи ───────────────────────────
for (const [path, what] of [
  ['pitch/RentHUB-pitch.pdf', 'раздатка скачивается'],
  ['pitch/RentHUB-pitch.pptx', 'презентация скачивается'],
]) {
  const response = await status(path);
  const size = Number(response.headers?.get?.('content-length') ?? 0);
  // Пустой или обрезанный файл отдаётся с тем же кодом 200, что и целый:
  // размер здесь и есть проверка.
  say(response.ok && size > 500_000, what, size ? `${Math.round(size / 1024)} КБ` : 'размер неизвестен');
}

// ── Приложение ставится на телефон ───────────────────────────
{
  const manifest = await status('app/manifest.webmanifest');
  const worker = await status('app/sw.js');
  say(manifest.ok && worker.ok, 'приложение ставится на телефон',
    manifest.ok && worker.ok ? 'манифест и служебный скрипт на месте' : 'чего-то нет');
}

// ── Каталог отдаёт вещи анониму ──────────────────────────────
//
// Главное обещание слайда «Результаты»: каталог открыт без регистрации.
// Проверяем тем же путём, что и браузер — публичным ключом из бандла.
{
  const config = await publicConfig();

  if (!config) {
    say(false, 'каталог отдаёт объявления', 'не нашёл адрес базы в собранном приложении');
  } else {
    try {
      const response = await fetch(
        `${config.url}/rest/v1/items?select=id,title,daily_price&status=eq.active&limit=5`,
        { headers: { apikey: config.key, authorization: `Bearer ${config.key}` } },
      );
      const items = await response.json();
      const alive = Array.isArray(items) && items.length > 0;
      say(alive, 'каталог отдаёт объявления анониму',
        alive ? `${items.length} шт., первое «${items[0].title}»` : JSON.stringify(items).slice(0, 80));
    } catch (error) {
      say(false, 'каталог отдаёт объявления анониму', error.message);
    }
  }
}

// ── Бот на месте ─────────────────────────────────────────────
{
  try {
    const response = await fetch('https://t.me/renthub_kokshetau_bot');
    const html = await response.text();
    say(response.ok && html.includes('renthub_kokshetau_bot'), 'бот существует в Telegram');
  } catch (error) {
    say(false, 'бот существует в Telegram', error.message);
  }
}

if (failed === 0) {
  console.log(`\n✓ Всё, что обещано судьям, работает (${checks.length} проверок).\n`);
  process.exit(0);
}

console.log(`\n✗ Не работает: ${failed} из ${checks.length}.`);
console.log('  Это то, что увидит судья, открыв ссылку. Чинить до защиты.\n');
process.exit(1);
