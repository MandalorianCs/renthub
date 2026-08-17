#!/usr/bin/env node
// Приглашение в закрытую бету.
//
//   npm run invite -- +77011234567 "Ержан Ахметов"
//
// Заводит пользователя с подтверждённым телефоном и выдаёт пароль, который
// вы передаёте человеку. SMS-провайдер при этом не нужен: подтверждение
// проставляется админ-API, а не приходом кода.
//
// Почему это не обход проверок. Правило 1 требует verified_at, и оно
// выполняется по-настоящему: телефон отмечен подтверждённым в auth.users,
// триггер переносит отметку в профиль. Меняется не проверка, а способ
// подтверждения — вместо кода из SMS ручное подтверждение оператором,
// то есть вами. Для закрытой беты это честнее SMS: вы знаете человека
// лично, а код подтверждает только владение симкой.
//
// Ключ передаётся переменной окружения и нигде не сохраняется:
//   $env:SUPABASE_SECRET_KEY="sb_secret_..."; npm run invite -- +7701... "Имя"

import { createClient } from '@supabase/supabase-js';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Телефон → внутренний адрес. Человек этого адреса не видит и не вводит:
 * на экране входа он набирает свой номер, а клиент собирает адрес по тому
 * же правилу. Правило обязано совпадать здесь и в src/lib/auth.tsx.
 */
function inviteEmail(phone) {
  return `${phone.replace(/\D/g, '')}@renthub.test`;
}

/** Казахстанские номера: 8 705… и +7 705… — это один и тот же номер. */
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

const [rawPhone, ...nameParts] = process.argv.slice(2);
const fullName = nameParts.join(' ').trim();

if (!rawPhone) {
  console.error(`
Кого приглашаем?

  npm run invite -- +77011234567 "Ержан Ахметов"
`);
  process.exit(1);
}

const phone = normalizePhone(rawPhone);
if (phone.replace(/\D/g, '').length !== 11) {
  console.error(`✗ Номер «${rawPhone}» не похож на казахстанский: ожидается 11 цифр`);
  process.exit(1);
}

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
      '    $env:SUPABASE_SECRET_KEY="sb_secret_..."; npm run invite -- +7701... "Имя"\n',
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

// Пароль короткий и произносимый: его будут диктовать в мессенджере или
// вслух, и «Xk9$mP2!vQ» в этом сценарии проигрывает восьми цифрам.
const password = randomBytes(4).readUInt32BE(0).toString().padStart(8, '0').slice(0, 8);
const email = inviteEmail(phone);

const digits = (s) => (s ?? '').replace(/\D/g, '');
const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
const existing = list?.users.find((u) => digits(u.phone) === digits(phone) || u.email === email);

if (existing) {
  const { error } = await admin.auth.admin.updateUserById(existing.id, {
    password,
    phone_confirm: true,
    email_confirm: true,
    ...(fullName ? { user_metadata: { full_name: fullName } } : {}),
  });
  if (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
  console.log(`\n↻ Пользователь уже был — выдан новый пароль.`);
} else {
  const { error } = await admin.auth.admin.createUser({
    phone,
    email,
    password,
    phone_confirm: true,
    email_confirm: true,
    user_metadata: fullName ? { full_name: fullName } : {},
  });
  if (error) {
    console.error(`✗ ${error.message}`);
    process.exit(1);
  }
  console.log(`\n+ Приглашение создано.`);
}

console.log(`
Передайте человеку это:

  Ссылка   https://mandaloriancs.github.io/renthub/app/
  Телефон  ${phone}
  Пароль   ${password}

На экране входа он выбирает «У меня есть приглашение», вводит свой номер
и этот пароль. Адрес почты вводить не нужно — клиент соберёт его сам.

Пароль нигде не сохранён. Потеряется — запустите команду снова, она
выдаст новый.
`);
