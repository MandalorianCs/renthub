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
// Секретный ключ лежит в `.env.secret` — файл в .gitignore и, в отличие
// от `.env`, не читается сборкой Expo. Разово его перебивает переменная
// окружения:
//   $env:SUPABASE_SECRET_KEY="sb_secret_..."; npm run invite -- +7701... "Имя"

import { createClient } from '@supabase/supabase-js';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';
import { randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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


// Почта распознаётся по «@», а не по позиции: иначе порядок аргументов
// пришлось бы запоминать, а перепутанные местами имя и адрес дали бы
// человека по имени «name@gmail.com».
const args = process.argv.slice(2);
const [rawPhone, ...rest] = args;
const realEmail = rest.find((a) => a.includes('@'))?.trim().toLowerCase() ?? null;
const fullName = rest.filter((a) => !a.includes('@')).join(' ').trim();

if (!rawPhone) {
  console.error(`
Кого приглашаем?

  npm run invite -- +77011234567 "Ержан Ахметов"
  npm run invite -- +77011234567 "Ержан Ахметов" erzhan@gmail.com

Почта необязательна. С ней человек сможет входить и по письму — код или
ссылка придут на этот адрес. Без неё аккаунт получает служебный адрес,
который человек не видит и не вводит.

Кто уже постучался и ждёт — npm run queue
`);

  process.exit(1);
}


const phone = normalizePhone(rawPhone);
if (phone.replace(/\D/g, '').length !== 11) {
  console.error(`✗ Номер «${rawPhone}» не похож на казахстанский: ожидается 11 цифр`);
  process.exit(1);
}

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!url || url.includes('xxxxxxxxxxxx')) {
  console.error('✗ Не найден адрес проекта. Заполните EXPO_PUBLIC_SUPABASE_URL в .env');
  process.exit(1);
}

if (!secret) {
  console.error(missingSecretMessage('npm run invite -- +7701... "Имя"'));
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
// Настоящая почта, если её назвали, становится адресом учётной записи.
// Второго поля под неё в auth.users нет, и это не обход, а условие:
// signInWithOtp({ email }) ищет пользователя именно по нему. Служебный
// адрес остаётся для тех, чью почту мы не знаем.
const email = realEmail ?? inviteEmail(phone);

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

// Работает ли вход по письму на самом деле.
//
// До 04.09.2026 текст ниже обещал его безусловно, и организатор повторял
// это человеку. А ссылка из письма ведёт на Site URL проекта, и пока он
// стоит по умолчанию — на localhost:3000. Обещание, данное голосом,
// проверить некому: человек просто не войдёт и решит, что сломано.
//
// generateLink письма не отправляет, а возвращает ту самую ссылку —
// значит по ней видно, куда она приведёт. Пользователь только что заведён,
// ни одной ссылкой ещё не пользовался, и обновление его токена ничего не
// ломает.
const APP_URL = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'shared', 'urls.json'), 'utf8'),
).app;
let emailWorks = false;

try {
  const { data: link } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email,
    options: { redirectTo: APP_URL },
  });
  const target = link?.properties?.action_link
    ? new URL(link.properties.action_link).searchParams.get('redirect_to')
    : null;
  emailWorks = target === APP_URL;
} catch {
  // Не смогли проверить — значит не обещаем. Молчаливое «наверное,
  // работает» здесь дороже лишней строки.
  emailWorks = false;
}

const botName = readEnvFile('EXPO_PUBLIC_TELEGRAM_BOT') ?? 'renthub_kokshetau_bot';

console.log(`
Передайте человеку это:

  Ссылка   ${APP_URL}
  Телефон  ${phone}${realEmail ? `
  Почта    ${realEmail}` : ''}
  Пароль   ${password}
  Бот      https://t.me/${botName}

На экране входа — вкладка «Приглашение», свой номер и этот пароль.
Адрес почты вводить не нужно: клиент соберёт его сам.

ВАЖНОЕ ВТОРОЕ ДЕЙСТВИЕ: открыть бота и нажать «Поделиться номером».
Без этого человек не получит ни подтверждения брони, ни напоминания о
возврате, ни ответа на обращение — всё это будет ждать его в приложении,
и он узнает о них, только зайдя сам. На 04.09.2026 привязку сделал один
участник из восьми: это то место, где пилот теряет больше всего.
${realEmail
  ? emailWorks
    ? `
Вход по письму тоже работает: письмо придёт на ${realEmail}.`
    : `
Вход по письму пока НЕ обещайте: ссылка из письма ведёт не в приложение.
Чинится одной настройкой — npm run health, строка «ссылка из письма».`
  : `
Вход по письму человеку недоступен: почта не привязана. Привязать он может
сам в профиле — после этого адрес станет и логином.`}

Пароль нигде не сохранён. Потеряется — запустите команду снова, она
выдаст новый.
`);
