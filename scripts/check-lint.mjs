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
//
// В `npm run check` эта команда НЕ входит, и это не забывчивость. Ей
// нужен токен аккаунта Supabase — третий секрет проекта, намеренно
// необязательный: ключ проекта открывает один проект, токен аккаунта
// все. Обязательная проверка, которая падает у того, кто токен не
// заводил, учит игнорировать её вывод. Запускается отдельно — перед
// пушем миграции, меняющей права или политики.

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

  // ── Производительность ──────────────────────────────────────
  //
  // Четыре индекса «не использованы» ровно потому, что данных мало и
  // запросов почти не было: пять живых людей, девять объявлений, ноль
  // броней. Удалить их сейчас значит принять статистику пилота за
  // приговор — и остаться без них там, где они и нужны.
  unused_index_public_users_users_telegram_idx:
    'users_telegram_idx: по нему бот ищет привязку — данных пока мало, не повод удалять',
  unused_index_public_users_users_blocked_idx:
    'users_blocked_idx: блокировок ещё не было, индекс нужен на вырост',
  unused_index_public_users_users_verified_idx:
    'users_verified_idx: то же, статистика пилота из пяти человек не приговор',
  unused_index_public_items_items_moderated_idx:
    'items_moderated_idx: модерация ещё не снимала объявлений',

  // Шесть индексов под внешние ключи, созданных 06.09.2026 миграцией
  // 20260906030000. Анализатор считает их неиспользованными сразу же —
  // и будет прав ровно до первого удаления объявления или человека с
  // историей: они нужны не чтению, а проверке on delete restrict,
  // которая без них идёт полным проходом по таблице.
  //
  // Иначе говоря, эти шесть попадут в «использованные» только в тот
  // день, когда без них стало бы больно. Ждать этого дня, чтобы
  // убедиться, — плохая сделка.
  unused_index_public_disputes_disputes_opened_by_idx:
    'disputes_opened_by_idx: под внешний ключ, нужен проверке on delete',
  unused_index_public_favorites_favorites_item_idx:
    'favorites_item_idx: без него удаление объявления сканирует всё избранное',
  unused_index_public_items_items_category_idx:
    'items_category_idx: под внешний ключ категории',
  unused_index_public_notifications_notifications_booking_idx:
    'notifications_booking_idx: под внешний ключ сделки',
  unused_index_public_reviews_reviews_from_user_idx:
    'reviews_from_user_idx: под внешний ключ автора отзыва',
  unused_index_public_support_messages_support_messages_user_idx:
    'support_messages_user_idx: под внешний ключ автора обращения',

  // Пары политик SELECT: участник и модератор на одной таблице. Слить их
  // в одну означало бы написать «свои строки ИЛИ ты модератор» одним
  // выражением и потерять то, ради чего они разделены: каждая читается
  // отдельно и отвечает на свой вопрос.
  multiple_permissive_policies_public_bookings_authenticated_SELECT:
    'bookings: участник и модератор — две политики намеренно, каждая про своё',
  multiple_permissive_policies_public_disputes_authenticated_SELECT:
    'disputes: то же разделение',
  multiple_permissive_policies_public_items_authenticated_SELECT:
    'items: то же разделение',
  multiple_permissive_policies_public_support_messages_authenticated_SELECT:
    'support_messages: то же разделение',
};

const token = readAccessToken();

if (!token) {
  console.error('\n✗ Нет токена аккаунта Supabase — спросить анализатор нечем.');
  console.error('  Строкой SUPABASE_ACCESS_TOKEN в .env.secret, подробности в');
  console.error('  .env.secret.example. Токен необязателен для остальных команд.\n');
  process.exit(1);
}

// Отчётов два, и оба важны по-разному. Безопасность говорит, что видно
// снаружи; производительность — что станет дорого, когда данных станет
// больше. Второе на пилоте из пяти человек не болит, и потому именно его
// легче всего не заметить: шесть внешних ключей без индексов нашлись
// именно так, 06.09.2026, вместе с первым запуском этой команды.
const lints = [];

for (const kind of ['security', 'performance']) {
  const res = await fetch(`https://api.supabase.com/v1/projects/${PROJECT}/advisors/${kind}`, {
    headers: { Authorization: `Bearer ${token}` },
  });

  if (!res.ok) {
    console.error(`\n✗ Supabase ответил ${res.status} на отчёт «${kind}».\n`);
    process.exit(1);
  }

  const body = await res.json();
  lints.push(...(body.lints ?? []));
}

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
