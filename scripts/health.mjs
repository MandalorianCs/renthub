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
  console.log(`\n! Требует внимания: ${alarms.map((a) => a.part).join(', ')}`);
  console.log('  Планировщик — README, раздел «Регулярная задача».');
  console.log('  Доставка уведомлений — бот не запущен: npm run bot.');
  console.log('  Заявки — npm run queue, дальше npm run invite.\n');
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
