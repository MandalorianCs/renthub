#!/usr/bin/env node
// Что говорит о базе сам Supabase.
//
//   npm run check:lint
//
// Зачем. У Supabase есть встроенный анализатор схемы: он видит таблицы с
// включённым RLS и без политик, функции, доступные анониму, расширения в
// public, выключенную защиту от утёкших паролей. Открывается он в панели
// — то есть смотрит туда тот, кто вспомнил.
//
// 06.09.2026 первый же взгляд нашёл двадцать семь функций, которые роль
// anon могла позвать через REST. Дыры среди них не было, но защита
// держалась на одном рубеже вместо двух, и заметить это глазами было
// нечем: в миграциях каждая строка выглядела правильной.
//
// Поэтому здесь не «показать всё», а «показать НОВОЕ». Известное и
// осознанно принятое перечислено ниже с причиной — как NOT_FOR_HUMANS в
// check:errors. Замечание, которого в списке нет, роняет проверку.

import { readAccessToken } from './env.mjs';

const PROJECT = 'owfsfwqwulpossjbnprp';

/**
 * Замечания, принятые осознанно.
 *
 * Ключ — то, чем анализатор их различает (`cache_key`). Значение —
 * причина, по которой мы с ними живём. Причина обязательна: список без
 * причин через месяц превращается в способ не думать.
 */
const ACCEPTED = {
  // Таблицу пишет бот и читает npm run health — оба сервисным ключом,
  // для которого RLS не применяется. Политик нет намеренно: ни anon, ни
  // authenticated к отметкам живости не ходят, и открывать их некому.
  rls_enabled_no_policy_public_heartbeats:
    'heartbeats: пишет и читает только сервисный ключ, сессионным ролям она не нужна',

  // btree_gist нужен ограничению bookings_no_overlap — тому самому, что
  // не даёт забронировать занятые даты. Перенос расширения в другую
  // схему означает пересоздание ограничения на живой базе ради строчки в
  // отчёте: риск выше пользы.
  extension_in_public_btree_gist:
    'btree_gist: на нём держится bookings_no_overlap, перенос дороже пользы',

  // Проверено замером 04.09.2026: из 25 паролей, которые выдаёт npm run
  // invite, в базе утечек нашлись 7 восьмизначных. Длину подняли до
  // двенадцати — там ноль совпадений, — но включение всё равно однажды
  // отклонит валидный пароль, и объяснить это организатору будет некому.
  auth_leaked_password_protection:
    'выключено намеренно: 04.09 замерено по HIBP, объяснять отказ организатору некому',

  // Функция платформы, не наша: в миграциях её нет, на чистом стенде она
  // не существует. Трогать чужое ради отчёта — способ уронить деплой.
  'anon_security_definer_function_executable_public_rls_auto_enable_':
    'rls_auto_enable: функция Supabase, а не наша',

  // Две функции, намеренно оставленные анониму (миграция
  // 20260906020000). Без календаря арендатор выбирает даты вслепую, без
  // счётчика сделок не поймёт, кому отдаёт вещь за 90 000 ₸.
  'anon_security_definer_function_executable_public_item_busy_dates_p_item_id uuid':
    'item_busy_dates: календарь занятости нужен до входа',
  'anon_security_definer_function_executable_public_user_deals_count_p_user_id uuid':
    'user_deals_count: «сдавал N раз» решает, отдать ли вещь незнакомцу',
};

const token = readAccessToken();

if (!token) {
  console.error('\n✗ Нет токена аккаунта Supabase — спросить анализатор нечем.');
  console.error('  Строкой SUPABASE_ACCESS_TOKEN в .env.secret, подробности в');
  console.error('  .env.secret.example. Токен необязателен для остальных команд.\n');
  process.exit(1);
}

const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/advisors/security`, {
  headers: { Authorization: `Bearer ${token}` },
});

if (!res.ok) {
  console.error(`\n✗ Supabase ответил ${res.status} — анализатор недоступен.\n`);
  process.exit(1);
}

const { lints = [] } = await res.json();

// Замечания про authenticated не считаем: «вошедший может позвать
// функцию для вошедших» — это описание продукта, а не находка. Роль
// authenticated и существует, чтобы её действия работали; защита там
// внутри функции, и её проверяет стенд.
const meaningful = lints.filter((l) => l.name !== 'authenticated_security_definer_function_executable');

const unknown = meaningful.filter((l) => !ACCEPTED[l.cache_key]);
const known = meaningful.filter((l) => ACCEPTED[l.cache_key]);

console.log('\nЧто говорит о базе сам Supabase\n');

for (const l of known) {
  console.log(`  ok  ${l.name.padEnd(42)} ${ACCEPTED[l.cache_key]}`);
}

// Список устаревает в обе стороны: замечание могли починить, а строка
// осталась — и однажды прикроет собой настоящую находку с тем же ключом.
const stale = Object.keys(ACCEPTED).filter(
  (key) => !meaningful.some((l) => l.cache_key === key),
);

if (unknown.length === 0 && stale.length === 0) {
  console.log(`\n✓ Новых замечаний нет; принятых осознанно — ${known.length}.\n`);
  process.exitCode = 0;
} else {
  if (unknown.length) {
    console.log(`\n✗ Новые замечания: ${unknown.length}\n`);
    for (const l of unknown) {
      console.log(`  ${l.level} · ${l.name}`);
      console.log(`    ${l.detail}`);
      if (l.remediation) console.log(`    ${l.remediation}`);
    }
    console.log('\n  Почините — либо внесите в ACCEPTED здесь, с причиной.');
    console.log('  Причина обязательна: список без причин через месяц');
    console.log('  превращается в способ не думать.\n');
  }

  if (stale.length) {
    console.log(`\n! В списке принятых есть то, чего анализатор больше не видит:`);
    for (const key of stale) console.log(`  ${key} — ${ACCEPTED[key]}`);
    console.log('  Уберите запись, иначе она однажды прикроет настоящую находку.\n');
  }

  process.exitCode = 1;
}
