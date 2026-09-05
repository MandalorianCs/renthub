#!/usr/bin/env node
// Два тестовых аккаунта без SMS-провайдера.
//
// Админ-API создаёт пользователя сразу с подтверждённым телефоном
// (phone_confirm: true) — SMS не отправляется, а наши триггеры на auth.users
// видят обычную регистрацию и заводят профиль в public.users с verified_at.
// Значит правило 1 («без верификации нельзя сдавать и арендовать») выполнено
// честно, а не в обход.
//
// Ключ берётся из `.env.secret`. Разово его перебивает переменная
// окружения:
//
//   PowerShell:
//     $env:SUPABASE_SECRET_KEY="sb_secret_..."; npm run seed:users
//
//   bash:
//     SUPABASE_SECRET_KEY=sb_secret_... npm run seed:users
//
// Секретный ключ обходит ВСЕ политики RLS. Ему нельзя в .env — этот файл
// вшивается в бандл и уезжает в браузер каждому посетителю.

import { createClient } from '@supabase/supabase-js';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';
import { randomBytes } from 'node:crypto';

// ── Что создаём ───────────────────────────────────────────────
// Номера из диапазона, который не выдаётся абонентам: даже если позже
// подключите SMS-провайдера, эти аккаунты никому не позвонят.

// У каждого аккаунта два реквизита, и это не избыточность:
//   • телефон с phone_confirm — из него триггер берёт verified_at,
//     то есть правило 1 пропускает пользователя честно;
//   • email с паролем — им входят в приложение, потому что провайдер
//     Email включён в Supabase по умолчанию, а Phone требует SMS-провайдера.
const USERS = [
  { role: 'Владелец',  phone: '+77000000001', email: 'owner@renthub.test',  fullName: 'Тест Владелец' },
  { role: 'Арендатор', phone: '+77000000002', email: 'renter@renthub.test', fullName: 'Тест Арендатор' },
];

// ── Ключи ─────────────────────────────────────────────────────


const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!url || url.includes('xxxxxxxxxxxx')) {
  console.error('✗ Не найден адрес проекта. Заполните EXPO_PUBLIC_SUPABASE_URL в .env');
  process.exit(1);
}

if (!secret) {
  console.error(missingSecretMessage('npm run seed:users'));
  process.exit(1);
}

// Защита от самой дорогой опечатки. Подставленный сюда publishable-ключ
// админ-API не откроет, но ошибка будет невнятной — а перепутать их легко,
// они лежат на одной странице кабинета.
const looksSecret = secret.startsWith('sb_secret_') || secret.startsWith('eyJ');
if (!looksSecret) {
  console.error('✗ Это не секретный ключ. Нужен sb_secret_… (или legacy service_role JWT)');
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Создание ──────────────────────────────────────────────────

const password = 'test-' + randomBytes(6).toString('hex');
const created = [];

console.log(`Проект: ${url}\n`);

for (const u of USERS) {
  // Идемпотентность: повторный запуск не должен падать на «уже существует».
  // Сравниваем по цифрам: GoTrue хранит телефон без «+», а мы задаём с ним.
  const digits = (s) => (s ?? '').replace(/\D/g, '');
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 200 });
  const existing = list?.users.find((x) => digits(x.phone) === digits(u.phone));

  if (existing) {
    const { error } = await admin.auth.admin.updateUserById(existing.id, {
      email: u.email,
      email_confirm: true,
      password,
      phone_confirm: true,
    });
    if (error) {
      console.error(`✗ ${u.role}: ${error.message}`);
      process.exit(1);
    }
    console.log(`↻ ${u.role} ${u.phone} — уже был, email и пароль обновлены`);
    created.push({ ...u, id: existing.id });
    continue;
  }

  const { data, error } = await admin.auth.admin.createUser({
    phone: u.phone,
    email: u.email,
    password,
    phone_confirm: true,
    email_confirm: true,
    user_metadata: { full_name: u.fullName },
  });

  if (error) {
    console.error(`✗ ${u.role}: ${error.message}`);
    process.exit(1);
  }

  console.log(`+ ${u.role} ${u.phone} — создан`);
  created.push({ ...u, id: data.user.id });
}

// ── Проверка: сработали ли триггеры ───────────────────────────
// Секретный ключ обходит RLS, поэтому читаем public.users напрямую
// и смотрим, что профиль появился и отмечен верифицированным.

console.log('\nЧто увидела база:\n');

const { data: profiles, error: readError } = await admin
  .from('users')
  .select('id, phone, full_name, verified_at, passive_mode, rating')
  .in('id', created.map((c) => c.id));

if (readError) {
  console.error('✗ Не удалось прочитать public.users:', readError.message);
  process.exit(1);
}

let allGood = true;

for (const c of created) {
  const p = profiles?.find((x) => x.id === c.id);
  if (!p) {
    console.log(`  ✗ ${c.role}: профиля в public.users НЕТ — триггер on_auth_user_created не сработал`);
    allGood = false;
    continue;
  }
  const verified = p.verified_at ? '✓ верифицирован' : '✗ НЕ верифицирован';
  console.log(`  ${p.verified_at ? '✓' : '✗'} ${c.role.padEnd(10)} ${p.phone}  ${verified}  имя: ${p.full_name ?? '—'}`);
  if (!p.verified_at) allGood = false;
}

if (!allGood) {
  console.log(
    '\n✗ Профиль есть, но verified_at пуст — значит phone_confirmed_at не доехал.\n' +
      '  Смотреть надо на триггер on_auth_user_phone_confirmed в миграции Trust Score.',
  );
  process.exit(1);
}

console.log(`
✓ Оба аккаунта готовы и верифицированы. Правило 1 их пропустит.

  ${USERS.map((u) => `${u.role.padEnd(10)} ${u.email}   (телефон ${u.phone})`).join('\n  ')}

  Пароль, общий для обоих: ${password}

Входить в приложение — вкладкой «Приглашение» на экране входа: в верхнее
поле почту, в нижнее пароль. Блока «Тестовый вход» на экране нет и не
было — это имя жило только здесь, и искать его человек шёл на экран. Телефон нужен не для входа, а для верификации: из phone_confirmed_at
триггер берёт verified_at.

Пароль нигде не сохранён — если потеряете, запустите скрипт снова, он выдаст
новый и обновит его обоим аккаунтам.
`);
