#!/usr/bin/env node
// Настройки аутентификации — проверить и починить.
//
//   npm run auth            проверить
//   npm run auth -- --apply починить (нужен токен аккаунта)
//
// Проверяются две вещи, и обе — про обещания, которые продукт даёт словами,
// а держит настройками снаружи кода: куда возвращает ссылка из письма и
// сколько живёт код входа.
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
//
// Второе обещание нашлось через час после первого. Функция telegram-otp
// писала человеку «Действует час», а sms_otp_exp в проекте стоял 60 секунд.
// Обе стороны сами по себе безупречны: текст вежлив, настройка допустима.
// Врёт только их сочетание — и узнаёт об этом человек, вернувшийся к коду
// через пять минут. Такие расхождения не ловятся чтением кода: читать надо
// два места сразу, а они в разных репозиториях и на разных языках.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingSecretMessage, projectRef, readAccessToken, readEnvFile, readSecret } from './env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const apply = process.argv.includes('--apply');

const urls = JSON.parse(readFileSync(join(ROOT, 'shared', 'auth.json'), 'utf8'));
const APP_URL = urls.app;
const OTP = urls.otp;

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();
const token = readAccessToken();
const ref = projectRef(url);

// Два секрета — две независимые возможности, и требовать оба было ошибкой.
//
// Секретный ключ нужен ровно для одного: спросить у Supabase, куда ведёт
// ссылка из письма (generateLink). Править настройку он не умеет — это
// делает токен аккаунта. Пока скрипт требовал ключ на входе, он отказывался
// работать в единственной ситуации, ради которой писался: токен есть,
// ключ потерян, и починить настройку можно прямо сейчас.
const admin = secret
  ? createClient(url, secret, { auth: { persistSession: false, autoRefreshToken: false } })
  : null;

if (!secret && !token) {
  console.error(missingSecretMessage('npm run auth'));
  process.exit(1);
}

console.log('\nНастройки аутентификации\n');

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
  console.log(`    а shared/auth.json — ${APP_URL}. Сначала сведите их.\n`);
  process.exit(1);
}
console.log(`  ✓ приложение и shared/auth.json просят один адрес`);

// Срок жизни кода: что об этом СКАЗАНО человеку.
//
// Функция telegram-otp называет срок словами прямо в тексте сообщения —
// «истечёт» без числа рождает вопрос, а вопрос в момент входа человек
// задать некому. Значит слова обязаны совпадать с настройкой, иначе
// вежливая фраза становится ложью.
//
// Проверяется тут, потому что для этого не нужно ни ключа, ни токена:
// достаточно двух файлов в репозитории.
const otpSource = readFileSync(
  join(ROOT, 'supabase', 'functions', 'telegram-otp', 'index.ts'),
  'utf8',
);
const otpSaid = otpSource.includes(`Действует ${OTP.smsHuman}`);

console.log(
  otpSaid
    ? `  ✓ функция обещает «${OTP.smsHuman}» — как в shared/auth.json`
    : `  ! функция не обещает «${OTP.smsHuman}»: текст в telegram-otp разошёлся с настройкой`,
);

// ── 2. Что происходит на самом деле ──────────────────────────
//
// generateLink письма не отправляет, а возвращает ту самую ссылку. Значит
// по ней видно и Site URL, и то, принят ли запрошенный адрес возврата.
// Служебный @renthub.test собирает invite.mjs из номера, человек им не
// пользуется — обновление его одноразового токена ничей вход не сломает.
async function actualTarget() {
  if (!admin) return { error: 'нет секретного ключа — проверить нечем' };

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
  // Уйти отсюда можно, только когда проверять больше нечем. Токен есть —
  // значит впереди ещё сверка срока кода с живой конфигурацией, и ранний
  // выход соврал бы «настроено», не посмотрев вторую половину.
  if (!apply && !token && otpSaid) {
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
  '',
  '  Там же → Sign In / Providers → Phone → OTP Expiry:',
  '',
  `    ${OTP.smsSeconds} секунд (${OTP.smsHuman}) — столько живёт код входа`,
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
  console.log('  Файл в .gitignore. После этого: npm run auth -- --apply');
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

// Хук Send SMS — то, ради чего мы отказались от `supabase config push`.
// Через него приходят коды входа в Telegram; сотрётся — вход по коду
// перестанет работать, причём молча: приложение будет отправлять код, а
// человек не получит ничего.
//
// PATCH его не упоминает и трогать не должен. «Не должен» — это ожидание,
// а проверка дешевле ожидания: запоминаем состояние до правки и сверяем
// после. Если однажды Supabase изменит поведение PATCH, узнаем об этом мы,
// а не участник пилота на экране входа.
const hookBefore = {
  enabled: current.hook_send_sms_enabled,
  uri: current.hook_send_sms_uri,
  hasSecret: Boolean(current.hook_send_sms_secrets),
};

const listed = (current.uri_allow_list ?? '').split(',').map((s) => s.trim()).filter(Boolean);
const missing = urls.redirects.filter((u) => !listed.includes(u));
const siteWrong = current.site_url !== APP_URL;
const otpWrong = current.sms_otp_exp !== OTP.smsSeconds;

// Сколько писем в час пропускает проект.
//
// По умолчанию два — и это два на ВЕСЬ проект, а не на человека. Третий за
// час получает 429 и видит ровно то же, что при поломке: тишину.
//
// Поднять это МЫ НЕ МОЖЕМ, и попытка была: Supabase отвечает 401 «Custom
// SMTP required to configure RATE_LIMIT_EMAIL_SENT». То есть два письма —
// не настройка, а потолок встроенной отправки, и обходится он ровно одним
// способом: своим SMTP.
//
// Поэтому лимит здесь не чинится, а показывается. Скрипт, который каждый
// раз пробует невозможное и каждый раз падает, учит не читать его вывод.
const mailLow = current.rate_limit_email_sent < OTP.emailPerHourMin;

console.log('');
console.log(`  Site URL сейчас   ${current.site_url || '(пусто)'}`);
console.log(`  Код входа живёт   ${current.sms_otp_exp} сек`);
console.log(
  `  Писем в час       ${current.rate_limit_email_sent}` +
    (mailLow ? '  ← потолок встроенной отправки, поднимается только своим SMTP' : ''),
);

// Хук Send SMS — то, на чём держится вход по коду в Telegram.
//
// До сих пор он смотрелся только вокруг правки: снимали состояние до PATCH
// и сверяли после. Это защищало от нас самих, но не от всего остального —
// хук можно выключить в панели, у него может истечь секрет, функция может
// не развернуться после переименования.
//
// Отказ при этом молчаливый и полный: человек жмёт «Получить код», Supabase
// зовёт хук, хука нет — и на экране английская строка, которую он не читал
// и понять не может. Заметить это можно было только жалобой участника.
//
// Строка печатается всегда, когда есть токен: одна проверка на каждый
// запуск дешевле одного потерянного входа.
const hookOk =
  current.hook_send_sms_enabled &&
  Boolean(current.hook_send_sms_uri) &&
  Boolean(current.hook_send_sms_secrets);

console.log(
  hookOk
    ? `  Коды в Telegram   хук включён, ${current.hook_send_sms_uri.split('/').pop()}`
    : `  Коды в Telegram   ! ${
        !current.hook_send_sms_enabled
          ? 'хук выключен — вход по коду не работает'
          : !current.hook_send_sms_uri
            ? 'у хука нет адреса функции'
            : 'у хука нет секрета — Supabase не сможет подписать вызов'
      }`,
);
console.log(`  Redirect URLs     ${listed.length ? listed.join(', ') : '(пусто)'}`);

if (!hookOk) {
  // Отдельным сообщением, а не строчкой в списке: это единственный отказ
  // здесь, который ломает вход прямо сейчас, а не портит впечатление.
  console.log('\n! Вход по коду в Telegram сломан.');
  console.log('  Панель → Authentication → Hooks → Send SMS:');
  console.log(`  адрес ${url}/functions/v1/telegram-otp, секрет из функции.`);
  console.log('  Развернуть саму функцию: npx supabase functions deploy telegram-otp\n');
  process.exitCode = 1;
}

if (!siteWrong && missing.length === 0 && !otpWrong) {
  console.log(hookOk ? '\n✓ В панели всё уже стоит правильно.\n' : '');
  process.exit(0);
}

console.log('');
if (siteWrong) console.log(`  → Site URL станет ${APP_URL}`);
if (otpWrong) console.log(`  → код входа будет жить ${OTP.smsSeconds} сек (${OTP.smsHuman})`);

for (const u of missing) console.log(`  → добавится ${u}`);

if (!apply) {
  console.log('\n  Это разбор, а не правка. Применить: npm run auth -- --apply\n');
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
    sms_otp_exp: OTP.smsSeconds,
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

const hookAfter = {
  enabled: after.hook_send_sms_enabled,
  uri: after.hook_send_sms_uri,
  hasSecret: Boolean(after.hook_send_sms_secrets),
};

if (JSON.stringify(hookBefore) !== JSON.stringify(hookAfter)) {
  console.error('\n✗ Правка задела хук Send SMS — вход по коду в Telegram под угрозой:');
  console.error(`  было:  включён ${hookBefore.enabled}, адрес ${hookBefore.uri}, секрет ${hookBefore.hasSecret ? 'есть' : 'нет'}`);
  console.error(`  стало: включён ${hookAfter.enabled}, адрес ${hookAfter.uri}, секрет ${hookAfter.hasSecret ? 'есть' : 'нет'}`);
  console.error('  Панель → Authentication → Hooks, восстановите Send SMS.');
  process.exit(1);
}

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
console.log(`  ✓ Код входа     ${after.sms_otp_exp} сек`);

console.log(`  ✓ Redirect URLs ${afterList.join(', ')}`);
console.log(
  check.error
    ? `  ? ссылку не проверить: ${check.error}`
    : check.target === APP_URL
      ? '  ✓ ссылка из письма возвращает в приложение'
      : `  ! ссылка всё ещё ведёт на ${check.target}`,
);
console.log('\n  Полная картина: npm run health\n');
