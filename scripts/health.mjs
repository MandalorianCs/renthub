#!/usr/bin/env node
// Живое состояние платформы.
//
//   npm run health
//
// Зачем. Два обещания продукта держатся не на коде, а на процессах снаружи:
// планировщик pg_cron разбирает просрочки, бот доставляет уведомления. Оба
// настраиваются руками, оба молча перестают работать, и заметить это до
// сих пор можно было только по тишине — то есть по жалобе участника.
//
// Лендинг при этом обещает клиенту: «Не вернули — спор открывается без
// участия людей», а страница для жюри называет это правилом Trust Score.
// Обещание, которое некому проверить, однажды перестаёт быть правдой.
//
// Что здесь проверяется и чем: часть отвечает база через platform_health()
// (планировщик она видит, а мы — нет: схема cron через PostgREST не
// открыта), часть — этот скрипт.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Тот же адрес, что просит приложение (EMAIL_RETURN_URL в
// src/lib/supabase.ts). Сверяем с ним: расхождение и есть дефект.
const APP_URL = 'https://mandaloriancs.github.io/renthub/app/';

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!secret) {
  console.error(missingSecretMessage('npm run health'));
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const rows = [];

function say(part, state, alarm) {
  rows.push({ part, state, alarm });
}

// ── Что видит база ───────────────────────────────────────────
const { data: health, error } = await admin.rpc('platform_health');

if (error) {
  console.error(`\n✗ База не ответила: ${error.message}\n`);
  process.exit(1);
}

for (const row of health ?? []) say(row.part, row.state, row.alarm);

// ── Витрина ──────────────────────────────────────────────────
//
// Имя служебного владельца читается из общего файла — того же, что читают
// приложение и scripts/demo-listings.mjs. Вписать его сюда строкой значило
// бы завести очередную копию правила, ради единственности которого файл и
// существует.
const demoOwner = JSON.parse(readFileSync(join(ROOT, 'shared', 'demo-owner.json'), 'utf8'));

const { data: items } = await admin
  .from('items')
  .select('id, owner:users!items_owner_id_fkey(full_name)')
  .eq('status', 'active');

const total = items?.length ?? 0;
const demo = (items ?? []).filter((i) => i.owner?.full_name === demoOwner.fullName).length;

say(
  'витрина',
  total === 0
    ? 'пусто — человек по ссылке увидит «пока ничего нет»'
    : `${total} ${plural(total, 'объявление', 'объявления', 'объявлений')}, из них демонстрационных ${demo}`,
  // Тревога не в том, что демо есть, а в том, что кроме них ничего нет:
  // реклама приведёт человека к вещам, которые никто не отдаст. README
  // держит это открытым вопросом организатора.
  total > 0 && demo === total,
);

// ── Люди ─────────────────────────────────────────────────────
const { count: people } = await admin
  .from('users')
  .select('id', { count: 'exact', head: true })
  .not('verified_at', 'is', null);

const { count: waiting } = await admin
  .from('join_requests')
  .select('id', { count: 'exact', head: true })
  .is('handled_at', null);

say('участники', `${people ?? 0} с подтверждённым номером`, false);

// Привязка Telegram — не украшение, а условие работы трёх вещей сразу:
// уведомлений о сделках, ответа организатора на обращение и входа по коду
// (вкладка «По SMS» без неё отвечает отказом). Человек без неё пользуется
// половиной продукта и об этом не знает.
//
// 04.09.2026 таких было семеро из восьми — то есть почти все.
const { count: linked } = await admin
  .from('users')
  .select('id', { count: 'exact', head: true })
  .not('telegram_id', 'is', null);

const total_people = people ?? 0;
const withTg = linked ?? 0;

say(
  'Telegram привязан',
  total_people === 0 ? 'участников нет' : `${withTg} из ${total_people}`,
  // Тревога, когда привязали меньше половины: главный канал не работает
  // у большинства, и заметить это иначе нечем — жалоб не будет, человек
  // просто не получит уведомление и не узнает, что должен был.
  total_people > 0 && withTg * 2 < total_people,
);

// ── Почта ────────────────────────────────────────────────────
//
// Служебный адрес вида 77010000001@renthub.test заводит invite.mjs из
// номера — человек его не видит и войти по нему не может. Настоящая почта
// — та, которую он привязал сам. Считаем именно её: это число говорит,
// скольким людям вход по письму вообще доступен.
const { data: authUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
const realEmails = (authUsers?.users ?? []).filter(
  (u) => u.email && !u.email.endsWith('@renthub.test'),
);

say(
  'настоящая почта',
  total_people === 0 ? 'участников нет' : `${realEmails.length} из ${total_people}`,
  false,
);

// Доставку отсюда не проверить — почтового ящика у нас нет. Зато проверяется
// то, что ей предшествует: принимает ли Supabase отправку вообще.
//
// Ответ 200 означает «заявка принята, дальше дело за доставкой»; 429 с
// «email rate limit exceeded» — что исчерпана квота встроенного сервиса.
// Спрашиваем про заведомо несуществующий адрес и с create_user: false:
// такой запрос ничего не создаёт и никому не пишет.
const probe = await fetch(`${url}/auth/v1/otp`, {
  method: 'POST',
  headers: {
    apikey: readEnvFile('EXPO_PUBLIC_SUPABASE_ANON_KEY'),
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ email: 'health-probe@renthub.invalid', create_user: false }),
});
const probeText = await probe.text();

say(
  'отправка писем',
  probe.status === 422
    ? 'Supabase принимает запросы (провайдер включён)'
    : probeText.includes('email rate limit exceeded')
      ? 'исчерпана квота встроенного сервиса — нужен свой SMTP'
      : `неожиданный ответ ${probe.status}: ${probeText.slice(0, 60)}`,
  probe.status !== 422,
);

// Куда ведёт ссылка из письма — единственная проверка, до которой без
// панели не добраться иначе.
//
// generateLink НЕ отправляет письмо, а возвращает ту самую ссылку. Значит
// по ней видно и Site URL проекта, и то, принят ли запрошенный адрес
// возврата: если его нет в списке Redirect URLs, GoTrue не отказывает, а
// молча подставляет Site URL — и человек уезжает туда, куда мы не просили.
//
// 04.09.2026 обе строки показали http://localhost:3000, то есть Supabase
// стоял с настройками по умолчанию. Письмо при этом доходило: ломался
// следующий шаг, и выглядело это как «почта не работает».
//
// Берём служебный адрес (@renthub.test): его собирает invite.mjs из номера,
// человек им не пользуется, и одноразовый токен, который generateLink
// заодно обновит, ничей вход не сломает.
const serviceUser = (authUsers?.users ?? []).find((u) => u.email?.endsWith('@renthub.test'));

if (serviceUser) {
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: serviceUser.email,
    options: { redirectTo: APP_URL },
  });

  const actual = link?.properties?.action_link
    ? new URL(link.properties.action_link).searchParams.get('redirect_to')
    : null;

  say(
    'ссылка из письма',
    linkError
      ? `не проверить: ${linkError.message}`
      : actual === APP_URL
        ? 'возвращает в приложение'
        : `ведёт на ${actual} — письмо дойдёт, а ссылка в нём никуда`,
    Boolean(linkError) || actual !== APP_URL,
  );
}

say(
  'заявки на участие',
  waiting ? `${waiting} ждут ответа` : 'очередь пуста',
  // Заявка — человек, который постучался и ждёт. Молчание в ответ он
  // читает как «сюда не пускают».
  (waiting ?? 0) > 0,
);

// ── Вывод ────────────────────────────────────────────────────
const width = Math.max(...rows.map((r) => r.part.length));
const alarms = rows.filter((r) => r.alarm);

console.log('\nЖивое состояние платформы\n');
for (const { part, state, alarm } of rows) {
  console.log(`  ${alarm ? '!' : ' '} ${part.padEnd(width)}  ${state}`);
}

if (alarms.length === 0) {
  console.log('\n✓ Всё, что обещано словами, работает.\n');
} else {
  // Подсказка печатается только к тому, что действительно горит. Раньше
  // печатались все три сразу, и организатору советовали запустить бота,
  // когда бот работает. Совет, не совпадающий с положением дел, учит не
  // читать советы — и однажды не прочтётся нужный.
  const hints = {
    'планировщик': 'README, раздел «Регулярная задача» — задача pg_cron.',
    'доставка уведомлений': 'бот не запущен, поднимите его: npm run bot',
    'витрина':
      'на витрине только демонстрационные вещи. Реклама приведёт человека к тому,\n' +
      '      что никто не отдаст: нужны живые объявления или npm run demo:clear',
    'заявки на участие': 'npm run queue, дальше npm run invite',
    'ссылка из письма':
      'Supabase подставляет свой Site URL. Панель → Authentication → URL\n' +
      '      Configuration: Site URL = https://mandaloriancs.github.io/renthub/app/\n' +
      '      и тот же адрес в Redirect URLs. Без этого письмо доходит, а ссылка\n' +
      '      в нём ведёт на localhost:3000 — README, «Что настроить в панели»',
    'отправка писем':
      'Supabase отвечает не так, как ожидалось. Проверьте, включён ли провайдер\n' +
      '      Email: Authentication → Sign In / Providers → Email',
    'Telegram привязан':
      'у большинства участников нет привязки — они не получают уведомлений,\n' +
      '      ответов организатора и не могут войти по коду. Дайте ссылку на бота:\n' +
      '      t.me/renthub_kokshetau_bot, одно нажатие «Поделиться номером»',
  };

  console.log(`\n! Требует внимания\n`);
  for (const { part } of alarms) {
    console.log(`  ${part} — ${hints[part] ?? 'разберитесь по состоянию выше.'}`);
  }
  console.log();
}

/** Склонение — то же правило, что на экранах: «1 объявлений» читается как сбой. */
function plural(n, one, few, many) {
  const two = n % 100;
  const last = n % 10;
  if (two >= 11 && two <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
