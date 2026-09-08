#!/usr/bin/env node
// Ни одна зона нажатия не меньше пальца.
//
//   npm run check:tap
//
// ── Что проверяется ──────────────────────────────────────────
//
// WCAG 2.5.5 (Target Size, AAA) требует 44×44. У нас причина конкретнее
// нормы: инструмент берут и возвращают на улице — зимой в перчатках,
// летом грязными руками, второй рукой придерживая перфоратор. Промах по
// кнопке в 32 точки здесь не мелкое неудобство, а причина закрыть
// вкладку.
//
// 08.09.2026 мельче нормы было почти всё, чего человек касается первым:
// категории каталога 38, «Фильтры» 32, выбор срока 32, вкладки входа 41,
// сердечко 30, «Поделиться» 28×31.
//
// ── Почему hitSlop не считается ──────────────────────────────
//
// Половина этих кнопок была «прикрыта» hitSlop, и это иллюзия: он
// расширяет зону только в нативной сборке, react-native-web его
// игнорирует. Пилот раздаётся ссылкой, то есть живёт как раз в вебе.
// Поэтому меряем коробку — ровно то, во что попадает палец.
//
// ── Почему браузером, а не разбором стилей ───────────────────
//
// Высота кнопки в React Native складывается из отступов, размера шрифта,
// межстрочного расстояния и родительского flex. Посчитать её по исходнику
// значит написать второй движок раскладки и ошибиться в нём. Браузер уже
// посчитал — надо только спросить.
//
// Управляем им по DevTools Protocol напрямую: в Node 22 есть свой
// WebSocket, и целой библиотеки ради трёх команд не нужно.
//
// Смотрим на живой сайт — как npm run check:public. Это то, что открывает
// судья, а не то, что лежит в рабочей копии.

import { execFile, spawn } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SITE = 'https://mandaloriancs.github.io/renthub/app/';
const MIN = 44;

// Экраны, открытые без входа: только их и может посмотреть посторонний,
// и только на них зона нажатия видна проверке без секретов.
const SCREENS = [
  ['витрина', SITE],
  ['разбор сделки', `${SITE}?how=1`],
  ['вход', `${SITE}sign-in`],
];

const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium-browser',
  '/usr/bin/chromium',
];

function findBrowser() {
  for (const path of BROWSERS) if (existsSync(path)) return path;
  return null;
}

/** Замер живёт строкой: выполняется он в чужом процессе, в самой странице. */
const PROBE = `(() => {
  const MIN = ${MIN};
  const els = document.querySelectorAll('[role="button"],[role="link"],[tabindex],button,a');
  const seen = new Set();
  const small = [];
  let counted = 0;

  for (const el of els) {
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) continue;   // скрытое не нажимают

    const label = (el.innerText || el.getAttribute('aria-label') || '(без имени)')
      .trim().replace(/\\s+/g, ' ').slice(0, 34);
    const key = label + Math.round(r.width) + 'x' + Math.round(r.height);
    if (seen.has(key)) continue;           // повторы карточек не считаем дважды
    seen.add(key);
    counted++;

    if (r.width < MIN || r.height < MIN) {
      small.push(label + ' — ' + Math.round(r.width) + '×' + Math.round(r.height));
    }
  }
  return JSON.stringify({ counted, small });
})()`;

/** Одна страница: запустить браузер, дождаться отрисовки, спросить размеры. */
async function measure(browser, url) {
  const profile = mkdtempSync(join(tmpdir(), 'renthub-tap-'));
  const port = 9500 + Math.floor(Math.random() * 400);

  const child = spawn(browser, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profile}`,
    // Телефонный размер: на нём кнопки самые тесные, и пилот открывают
    // именно с телефона.
    '--window-size=390,844',
    url,
  ], { stdio: ['ignore', 'ignore', 'ignore'] });

  try {
    const target = await waitForTarget(port);
    const value = await evaluate(target, PROBE);
    return JSON.parse(value);
  } finally {
    child.kill();
    try { rmSync(profile, { recursive: true, force: true }); } catch { /* профиль временный */ }
  }
}

/** Дождаться, пока браузер поднимет отладочный порт и отрисует страницу. */
async function waitForTarget(port) {
  for (let attempt = 0; attempt < 60; attempt++) {
    await new Promise((r) => setTimeout(r, 500));
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      // Приложение рисуется скриптом: страница «загружена» задолго до
      // того, как на ней появятся кнопки. Ждём ещё, а готовность
      // проверяем по самим кнопкам.
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* порт ещё не открыт */ }
  }
  throw new Error('браузер не поднял отладочный порт');
}

/** Выполнить выражение в странице и вернуть результат. */
function send(socket, id, method, params) {
  return new Promise((resolve, reject) => {
    const onMessage = (event) => {
      const msg = JSON.parse(event.data);
      if (msg.id !== id) return;
      socket.removeEventListener('message', onMessage);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    };
    socket.addEventListener('message', onMessage);
    socket.send(JSON.stringify({ id, method, params }));
    setTimeout(() => reject(new Error(`${method}: ответа нет`)), 30_000);
  });
}

async function evaluate(wsUrl, expression) {
  const socket = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('не подключился к браузеру')), { once: true });
  });

  try {
    // Ждём, пока приложение нарисует хоть что-то нажимаемое: без этого
    // проверка мерила бы пустую страницу и радовалась нулю нарушений.
    for (let attempt = 0; attempt < 40; attempt++) {
      const probe = await send(socket, 1000 + attempt, 'Runtime.evaluate', {
        expression: 'document.querySelectorAll(\'[role="button"],[role="link"]\').length',
        returnByValue: true,
      });
      if ((probe.result?.value ?? 0) > 2) break;
      await new Promise((r) => setTimeout(r, 500));
    }

    const result = await send(socket, 1, 'Runtime.evaluate', { expression, returnByValue: true });
    return result.result.value;
  } finally {
    socket.close();
  }
}

// ── Прогон ────────────────────────────────────────────────────

console.log('\n── Зоны нажатия ──');

const browser = findBrowser();

if (!browser) {
  // Молчать нельзя: «браузера нет» и «всё в порядке» — разные ответы.
  console.log('  ✗   не нашёл Chrome или Edge — мерить нечем');
  console.log('      проверка не состоялась, это не «нарушений нет»\n');
  process.exit(1);
}

let failed = 0;

for (const [name, url] of SCREENS) {
  let out;
  try {
    out = await measure(browser, url);
  } catch (error) {
    console.log(`  ✗   ${name.padEnd(16)} не измерен — ${error.message}`);
    failed++;
    continue;
  }

  if (out.small.length === 0) {
    console.log(`  ok  ${name.padEnd(16)} ${out.counted} нажимаемых, все от ${MIN}`);
    continue;
  }

  failed++;
  console.log(`  ✗   ${name.padEnd(16)} мельче ${MIN}: ${out.small.length}`);
  for (const line of out.small) console.log(`        ${line}`);
}

if (failed === 0) {
  console.log(`\n✓ Палец попадает везде: ни одной зоны меньше ${MIN}×${MIN}.\n`);
  process.exit(0);
}

console.log(`\n✗ Экранов с промахом: ${failed}.`);
console.log('  Размер задаётся коробкой — minHeight/minWidth из TAP в src/theme.ts.');
console.log('  hitSlop не считается: в вебе он не работает, а пилот живёт в вебе.\n');
process.exit(1);
