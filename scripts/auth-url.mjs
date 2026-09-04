#!/usr/bin/env node
// Куда ссылка из письма возвращает человека — проверить и починить.
//
//   npm run auth:url            проверить (нужен только секретный ключ)
//   npm run auth:url -- --apply починить (нужен ещё токен аккаунта)
//
// Зачем этот файл существует
// ──────────────────────────
// 04.09.2026 вход по почте не работал так: письмо приходило за секунды, а
// ссылка в нём вела на http://localhost:3000. Это Site URL проекта,
// оставшийся по умолчанию. Хуже того, адрес возврата, который приложение
// просит явно, GoTrue молча подменял тем же localhost — потому что нужного
// адреса нет в списке Redirect URLs. Отказа нет, ошибки нет, есть человек,
// который не вошёл и решил, что платформа сломана.
//
// Кодом это не чинится: настройка живёт снаружи базы. И тут выяснилось
// неудобное: секретный ключ проекта до неё не достаёт, а единственная
// команда CLI (`supabase config push`) шлёт весь раздел auth целиком —
// без локального config.toml она снесла бы хук Send SMS, на котором держится
// вход по коду в Telegram. Менять работающий вход ради сломанного — плохой
// размен.
//
// Отсюда устройство скрипта: ПРОВЕРЯЕТ он всегда, ЧИНИТ — когда есть токен.
// Проверка одна на всех, и после ручной правки в панели она скажет то же
// самое, что после автоматической. Кто нажимал — по результату неразличимо,
// и это единственный способ не спорить о том, сделано или нет.
//
// Правило правки: список редиректов ДОПОЛНЯЕТСЯ, а не заменяется. Там могут
// лежать чужие адреса, о которых мы не знаем; затереть их значит сломать то,
// чего не видели. Ровно этого я и боялся в `config push` — глупо повторять
// ту же ошибку своими руками.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingSecretMessage, projectRef, readAccessToken, readEnvFile, readSecret } from './env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');

const urls = JSON.parse(readFileSync(join(ROOT, 'shared', 'urls.json'), 'utf8'));
const APP_URL = urls.app;

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();
const token = readAccessToken();
const ref = projectRef(url);

if (!secret) {
  console.error(missingSecretMessage('npm run auth:url'));
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

console.log('\nАдрес возврата после письма\n');

// ── 1. Не разошлись ли наши собственные источники ────────────
//
// Приложение на вебе просит адрес текущей вкладки, а для сборки под телефон
// у него зашит запасной. Он обязан совпадать с тем, что мы просим у
// Supabase: разойдутся — половина входов будет уезжать не туда, и заметить
// это по коду нельзя, потому что каждая половина сама по себе верна.
const appSource = readFileSync(join(ROOT, 'src', 'lib', 'supabase.ts'), 'utf8');
const fallback = appSource.match(/EMAIL_RETURN_URL[\s\S]{0,400}?:\s*'([^']+)'/)?.[1];

if (fallback !== APP_URL) {
  console.log(`  ! src/lib/supabase.ts просит ${fallback ?? '(не нашёл)'},`);
  console.log(`    а shared/urls.json — ${APP_URL}. Сначала сведите их.\n`);
  process.exit(1);
}
console.log(`  ✓ приложение и shared/urls.json просят один адрес`);

// ── 2. Что происходит на самом деле ──────────────────────────
//
// generateLink письма не отправляет, а возвращает ту самую ссылку. Значит
// по ней видно и Site URL, и то, принят ли запрошенный адрес возврата.
// Служебный @renthub.test собирает invite.mjs из номера, человек им не
// пользуется — обновление его одноразового токена ничей вход не сломает.
async function actualTarget() {
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const probe = (list?.users ?? []).find((u) => u.email?.endsWith('@renthub.test'));
  if (!probe) return { error: 'не на ком проверить: нет служебного адреса @renthub.test' };

  const { data: link, error } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: probe.email,
    options: { redirectTo: APP_URL },
  });
  if (error) return { error: error.message };

  return {
    target: link?.properties?.action_link
      ? new URL(link.properties.action_link).searchParams.get('redirect_to')
      : null,
  };
}

const before = await actualTarget();

if (before.error) {
  console.log(`  ? ссылка: ${before.error}`);
} else if (before.target === APP_URL) {
  console.log(`  ✓ ссылка из письма возвращает в приложение`);
  if (!apply) {
    console.log('\n✓ Настроено. Чинить нечего.\n');
    process.exit(0);
  }
} else {
  console.log(`  ! ссылка из письма ведёт на ${before.target}`);
}

// ── 3. Две дороги ────────────────────────────────────────────
//
// Инструкция печатается ДО попытки починить, а не вместо неё. Человеку у
// панели она нужна прямо сейчас; тому, кто пришёл за автоматикой, — как
// объяснение, что именно скрипт собирается изменить. Скрытая правка,
// которую нельзя повторить руками, — это не помощь, а зависимость.
const panel = [
  '',
  '  Руками — Supabase → Authentication → URL Configuration:',
  '',
  `    Site URL       ${APP_URL}`,
  '    Redirect URLs  добавить каждый отдельной строкой:',
  ...urls.redirects.map((u) => `                   ${u}`),
  '',
  '  У Site URL своя кнопка Save, отдельная от списка ниже — её легко',
  '  не заметить и уйти, ничего не сохранив.',
].join('\n');

if (!token) {
  console.log(panel);
  console.log('');
  console.log('  Или руками агента — тогда нужен токен аккаунта. Панель →');
  console.log('  верхний правый угол → Account Preferences → Access Tokens →');
  console.log('  Generate new token. Одной строкой в .env.secret:');
  console.log('');
  console.log('    SUPABASE_ACCESS_TOKEN=sbp_...');
  console.log('');
  console.log('  Файл в .gitignore. После этого: npm run auth:url -- --apply');
  console.log('');
  console.log('  Токен управляет всем аккаунтом, а не одним проектом, поэтому');
  console.log('  он необязателен: без него скрипт проверяет, но не трогает.');
  console.log('');
  process.exit(before.target === APP_URL ? 0 : 1);
}

// ── 4. Починка ───────────────────────────────────────────────
const api = `https://api.supabase.com/v1/projects/${ref}/config/auth`;
const auth = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

async function config() {
  const res = await fetch(api, { headers: auth });
  if (!res.ok) {
    const text = await res.text();
    console.error(`\n✗ Management API ответил ${res.status}: ${text.slice(0, 200)}`);
    if (res.status === 401) console.error('  Токен не принят — проверьте SUPABASE_ACCESS_TOKEN.');
    if (res.status === 403) console.error(`  Токен не даёт доступа к проекту ${ref}.`);
    // Дорога руками остаётся открытой. Сломанный токен не должен оставлять
    // человека вообще без пути: с этого и начиналась вся история.
    console.error(panel);
    console.error('');
    process.exit(1);
  }
  return res.json();
}

const current = await config();
const listed = (current.uri_allow_list ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const missing = urls.redirects.filter((u) => !listed.includes(u));
const siteWrong = current.site_url !== APP_URL;

console.log('');
console.log(`  Site URL сейчас   ${current.site_url || '(пусто)'}`);
console.log(`  Redirect URLs     ${listed.length ? listed.join(', ') : '(пусто)'}`);

if (!siteWrong && missing.length === 0) {
  console.log('\n✓ В панели всё уже стоит правильно.\n');
  process.exit(0);
}

console.log('');
if (siteWrong) console.log(`  → Site URL станет ${APP_URL}`);
for (const u of missing) console.log(`  → добавится ${u}`);

if (!apply) {
  console.log('\n  Это разбор, а не правка. Применить: npm run auth:url -- --apply\n');
  process.exit(1);
}

// Только два поля. PATCH мержит, остальной раздел auth — включая хук
// Send SMS, на котором держится вход по коду в Telegram, — не упоминается
// и потому не трогается.
const res = await fetch(api, {
  method: 'PATCH',
  headers: auth,
  body: JSON.stringify({
    site_url: APP_URL,
    uri_allow_list: [...listed, ...missing].join(','),
  }),
});

if (!res.ok) {
  console.error(`\n✗ Не применилось, ${res.status}: ${(await res.text()).slice(0, 200)}\n`);
  process.exit(1);
}

// ── 5. Проверка тем же способом, что и в начале ──────────────
//
// «200 OK» означает «запрос принят», а не «человек войдёт». Спрашиваем
// заново и у конфигурации, и у самой ссылки: обещание проверяется тем же
// измерением, которым был обнаружен дефект.
const after = await config();
const afterList = (after.uri_allow_list ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const stillMissing = urls.redirects.filter((u) => !afterList.includes(u));

if (after.site_url !== APP_URL || stillMissing.length) {
  console.error('\n✗ Приняли, но не записалось. Site URL:', after.site_url);
  if (stillMissing.length) console.error('  Не хватает:', stillMissing.join(', '));
  console.error(panel);
  process.exit(1);
}

const check = await actualTarget();

console.log('');
console.log(`  ✓ Site URL      ${after.site_url}`);
console.log(`  ✓ Redirect URLs ${afterList.join(', ')}`);
console.log(
  check.error
    ? `  ? ссылку не проверить: ${check.error}`
    : check.target === APP_URL
      ? '  ✓ ссылка из письма возвращает в приложение'
      : `  ! ссылка всё ещё ведёт на ${check.target}`,
);
console.log('\n  Полная картина: npm run health\n');
