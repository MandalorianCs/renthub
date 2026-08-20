#!/usr/bin/env node
// Убирает проверочные уведомления.
//
//   npm run notify:clear
//
// Трогает только записи с type = 'connection_test' — настоящие уведомления
// о сделках остаются на месте. Отдельная команда, а не флаг у notify-test:
// удаление и создание не должны жить в одном вызове, иначе однажды опечатка
// в аргументе сотрёт не то.

import { createClient } from '@supabase/supabase-js';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!secret) {
  console.error(missingSecretMessage('npm run notify:clear'));
  process.exit(1);
}

const admin = createClient(url, secret, { auth: { persistSession: false } });

const { data, error } = await admin
  .from('notifications')
  .delete()
  .eq('type', 'connection_test')
  .select('id');

if (error) {
  console.error(`✗ Не удалось убрать: ${error.message}`);
  process.exit(1);
}

console.log(`✓ Удалено проверочных уведомлений: ${data?.length ?? 0}`);
