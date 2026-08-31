#!/usr/bin/env node
// Привязать участнику настоящую почту.
//
//   npm run email -- +77758663588 name@gmail.com
//
// Зачем отдельный скрипт, если привязка есть в профиле. Самостоятельная
// привязка упирается в настройку Supabase «Secure email change»: при смене
// адреса подтверждение уходит на ОБА — старый и новый. Старый у наших
// участников служебный, `<цифры>@renthub.test`, домен `.test`
// зарезервирован и невалиден, и GoTrue отказывает ещё до отправки письма:
//
//   Email address "77758663588@renthub.test" is invalid
//
// Отсюда две дороги. Выключить Secure email change в панели — тогда
// заработает кнопка в профиле. Или привязать сервисным ключом, что и
// делает этот скрипт: admin-API меняет адрес напрямую, без писем.
//
// Подтверждение владения почтой при этом не пропадает, а переезжает на
// вас: вы привязываете адрес человеку, которого знаете лично, — ровно как
// с приглашением. Для закрытого пилота это честнее, чем письмо: код из
// письма доказывает доступ к ящику, а не то, что человек — участник.

import { createClient } from '@supabase/supabase-js';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';

/** Казахстанские номера: 8 705… и +7 705… — один и тот же номер. */
function normalizePhone(input) {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 11) return `+${digits}`;
  return `+${digits}`;
}

const [rawPhone, rawEmail] = process.argv.slice(2);

if (!rawPhone || !rawEmail) {
  console.error(`
Кому привязываем почту?

  npm run email -- +77758663588 name@gmail.com

Первым — номер участника, вторым — его настоящий адрес. После этого
на экране входа заработает вкладка «Почта»: код или ссылка придут
письмом на указанный адрес.
`);
  process.exit(1);
}

const phone = normalizePhone(rawPhone);
const email = rawEmail.trim().toLowerCase();

if (phone.replace(/\D/g, '').length !== 11) {
  console.error(`✗ Номер «${rawPhone}» не похож на казахстанский: ожидается 11 цифр`);
  process.exit(1);
}

if (!/^[^@\s]+@[^@\s]+\.[^@\s]{2,}$/.test(email)) {
  console.error(`✗ «${rawEmail}» не похоже на адрес почты`);
  process.exit(1);
}

if (email.endsWith('@renthub.test')) {
  console.error('✗ Это служебный адрес, а не настоящий. Нужен ящик, куда придёт письмо.');
  process.exit(1);
}

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!url || url.includes('xxxxxxxxxxxx')) {
  console.error('✗ Не найден адрес проекта. Заполните EXPO_PUBLIC_SUPABASE_URL в .env');
  process.exit(1);
}

if (!secret) {
  console.error(missingSecretMessage('npm run email -- +7701... name@gmail.com'));
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const digits = (s) => (s ?? '').replace(/\D/g, '');
const { data: list, error: listError } = await admin.auth.admin.listUsers({ perPage: 1000 });

if (listError) {
  console.error(`✗ ${listError.message}`);
  process.exit(1);
}

const user = list?.users.find((u) => digits(u.phone) === digits(phone));

if (!user) {
  console.error(`
✗ Участника с номером ${phone} нет.

  Сначала заведите его:  npm run invite -- ${phone} "Имя Фамилия"
`);
  process.exit(1);
}

// Чужой адрес занять нельзя: GoTrue вернёт ошибку про дубликат, но
// понятнее сказать об этом заранее и с именем того, за кем он закреплён.
const taken = list?.users.find((u) => u.email === email && u.id !== user.id);
if (taken) {
  const name = taken.user_metadata?.full_name ?? 'другой участник';
  console.error(`✗ Этот адрес уже привязан: ${name}. Один ящик — один аккаунт.`);
  process.exit(1);
}

const wasServiceEmail = (user.email ?? '').endsWith('@renthub.test');

// email_confirm: true — иначе адрес встанет неподтверждённым, и вход по
// нему всё равно не заработает. Подтверждение здесь ваше, а не почтовое:
// см. комментарий в шапке.
const { error } = await admin.auth.admin.updateUserById(user.id, {
  email,
  email_confirm: true,
});

if (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

const name = user.user_metadata?.full_name ?? 'участник';

console.log(`
✓ Почта привязана: ${name} — ${email}

  На экране входа теперь работает вкладка «Почта»: человек вводит адрес и
  получает письмо. Что придёт — код или ссылка — зависит от того, подключён
  ли свой SMTP; экран принимает оба.
${
  wasServiceEmail
    ? `
  Важное следствие. Адрес учётной записи — это и логин для входа по
  приглашению. Раньше клиент собирал его из номера телефона, теперь у
  человека настоящая почта, и вкладка «Приглашение» с номером ему больше
  не подойдёт: там нужен новый адрес и тот же пароль.
`
    : ''
}`);
