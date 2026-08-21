#!/usr/bin/env node
// Состояние аккаунта по номеру.
//
//   npm run whoami -- +77011234567
//
// Отвечает на вопросы, которые иначе выясняются гаданием: подтверждён ли
// номер, есть ли право модератора, привязан ли Telegram, сколько объявлений
// и сделок. Ровно то, что определяет, какие вкладки человек видит в
// приложении и почему.
//
// Нужен потому, что приложение показывает следствия, а не причины: вкладка
// «Модерация» либо есть, либо нет, и по её отсутствию невозможно понять,
// флаг не выдан или профиль не загрузился.

import { createClient } from '@supabase/supabase-js';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';

const [rawPhone] = process.argv.slice(2);

if (!rawPhone) {
  console.error('\nЧей аккаунт смотрим?\n\n  npm run whoami -- +77011234567\n');
  process.exit(1);
}

function normalizePhone(input) {
  const digits = input.replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 11) return `+${digits}`;
  return `+${digits}`;
}

const phone = normalizePhone(rawPhone);
const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!secret) {
  console.error(missingSecretMessage('npm run whoami -- +7701...'));
  process.exit(1);
}

const admin = createClient(url, secret, { auth: { persistSession: false } });

const { data: user, error } = await admin
  .from('users')
  .select('id, full_name, verified_at, is_moderator, telegram_id, rating, ratings_count, created_at')
  .eq('phone', phone)
  .maybeSingle();

if (error) {
  console.error(`✗ ${error.message}`);
  process.exit(1);
}

if (!user) {
  console.error(`✗ Номер ${phone} не заведён. Завести: npm run invite -- ${phone} "Имя"`);
  process.exit(1);
}

const [{ count: items }, { count: bookings }] = await Promise.all([
  admin.from('items').select('id', { count: 'exact', head: true }).eq('owner_id', user.id),
  admin.from('bookings').select('id', { count: 'exact', head: true }).eq('renter_id', user.id),
]);

const yesNo = (value) => (value ? 'да' : 'нет');

console.log(`
  ${user.full_name ?? 'Без имени'} — ${phone}

  Телефон подтверждён   ${yesNo(user.verified_at)}
  Модератор             ${yesNo(user.is_moderator)}${user.is_moderator ? '' : '   → выдать: npm run moderator -- ' + phone}
  Telegram привязан     ${yesNo(user.telegram_id)}${user.telegram_id ? '' : '   → открыть бота и нажать «Поделиться номером»'}
  Рейтинг               ${user.rating ?? '—'} (${user.ratings_count} отзывов)
  Объявлений            ${items ?? 0}
  Аренд                 ${bookings ?? 0}

  Вкладка «Модерация» в приложении появляется, только когда «Модератор — да».
  Если флаг выдан, а вкладки нет — выйдите и войдите заново: профиль читается
  один раз при входе.
`);
