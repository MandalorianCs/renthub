#!/usr/bin/env node
// Назначить или снять модератора.
//
//   npm run moderator -- +77011234567
//   npm run moderator -- +77011234567 off
//
// Модератор разрешает споры выше порога авторешения — те, где сумма ущерба
// больше 15 000 ₸ и решение принимает человек.
//
// Роль выдаётся только отсюда. Из приложения её выдать нельзя: триггер
// users_protect_moderator_role отклоняет изменение is_moderator, если у
// вызывающего есть jwt-сессия. У сервисного ключа сессии нет — этим они и
// различаются. Без триггера любой пользователь поставил бы себе true одним
// запросом: политика users_update_own разрешает менять свою строку целиком.
//
// Телефоны модераторов намеренно не хранятся в репозитории — он публичный.

import { createClient } from '@supabase/supabase-js';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function normalizePhone(input) {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 11) return `+${digits}`;
  return `+${digits}`;
}

function readEnvFile(key) {
  try {
    const line = readFileSync(join(ROOT, '.env'), 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith(`${key}=`));
    return line ? line.slice(line.indexOf('=') + 1).trim() : null;
  } catch {
    return null;
  }
}

const [rawPhone, flag] = process.argv.slice(2);
const grant = flag !== 'off';

if (!rawPhone) {
  console.error(`
Кого назначаем модератором?

  npm run moderator -- +77011234567        назначить
  npm run moderator -- +77011234567 off    снять
`);
  process.exit(1);
}

const phone = normalizePhone(rawPhone);
const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = process.env.SUPABASE_SECRET_KEY;

if (!url || url.includes('xxxxxxxxxxxx')) {
  console.error('✗ Не найден адрес проекта. Заполните EXPO_PUBLIC_SUPABASE_URL в .env');
  process.exit(1);
}

if (!secret) {
  console.error(
    '✗ Нужен секретный ключ (Project Settings → API Keys → Secret keys).\n' +
      '  Передайте переменной окружения, не сохраняя в файл:\n\n' +
      '    $env:SUPABASE_SECRET_KEY="sb_secret_..."; npm run moderator -- +7701...\n',
  );
  process.exit(1);
}

if (!secret.startsWith('sb_secret_') && !secret.startsWith('eyJ')) {
  console.error('✗ Это не секретный ключ. Нужен sb_secret_… (или legacy service_role JWT)');
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// Ищем по профилю, а не по auth.users: модератором можно быть только тем,
// у кого профиль уже создан триггером.
//
// Ищем сразу в двух форматах. GoTrue хранит телефон без плюса, и триггер
// handle_new_auth_user переносит его в профиль как есть — то есть в базе
// лежит 77758663588, а не +77758663588. Поиск по одному формату молча
// не находил существующего пользователя.
const digitsOnly = phone.replace(/\D/g, '');
const { data: rows, error: findError } = await admin
  .from('users')
  .select('id, full_name, phone, is_moderator')
  .in('phone', [phone, digitsOnly]);

const found = rows?.[0] ?? null;

if (findError) {
  console.error(`✗ ${findError.message}`);
  process.exit(1);
}

if (!found) {
  console.error(`
✗ Пользователя с номером ${phone} в базе нет.

  Сначала пригласите его:
    npm run invite -- ${phone} "Имя Фамилия"
`);
  process.exit(1);
}

const { error } = await admin
  .from('users')
  .update({ is_moderator: grant })
  .eq('id', found.id);

if (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

const name = found.full_name ?? 'без имени';
console.log(`
${grant ? '✓' : '↩'} ${name} (${phone}) ${grant ? 'теперь модератор' : 'больше не модератор'}.

${
  grant
    ? 'Может разбирать споры выше порога авторешения: видит их в приложении\nна вкладке «Споры» и решает, сколько удержать из депозита.'
    : 'Доступ к разбору споров снят.'
}
`);
