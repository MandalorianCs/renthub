#!/usr/bin/env node
// Кто ждёт приглашения.
//
//   npm run queue
//
// Заявки оставляют в Telegram-боте люди, у которых приглашения нет: витрина
// открыта всем, а забронировать без аккаунта нельзя. Номер в заявке
// подтверждён самим Telegram кнопкой «Поделиться номером» — не набран
// руками, поэтому по нему сразу можно заводить участника.
//
// Отдельной командой, а не внутри `npm run invite`: подсказка там требовала
// сетевого запроса перед process.exit(), и Node на Windows роняет ассерт
// libuv поверх вывода — выглядит как сбой скрипта, хотя он просто
// договорил. Здесь скрипт завершается сам, и проблемы нет.
//
// Ходит обычным fetch, а не клиентом Supabase: одного запроса ради очереди
// клиент не стоит.

import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!url || !secret) {
  console.error(missingSecretMessage('npm run queue'));
  process.exit(1);
}

const response = await fetch(`${url}/rest/v1/rpc/join_requests_open`, {
  method: 'POST',
  headers: {
    apikey: secret,
    Authorization: `Bearer ${secret}`,
    'Content-Type': 'application/json',
  },
  body: '{}',
});

if (!response.ok) {
  console.error(`✗ ${response.status}: ${(await response.text()).slice(0, 200)}`);
  process.exitCode = 1;
} else {
  const rows = await response.json();

  if (!rows.length) {
    console.log('\nЗаявок нет — очередь пуста.\n');
  } else {
    console.log(`\nЖдут приглашения — ${rows.length}:\n`);

    for (const r of rows) {
      // Готовая команда, а не просто номер: следующий шаг всегда один и тот
      // же, а переписанный с экрана номер — это способ однажды пригласить
      // не того человека.
      console.log(`  npm run invite -- ${r.phone}${r.full_name ? ` "${r.full_name}"` : ''}`);

      const who = [r.full_name, r.telegram_username && `@${r.telegram_username}`]
        .filter(Boolean)
        .join(' · ');
      const day = new Date(r.created_at).toLocaleDateString('ru-RU');
      console.log(`      ${who || 'без имени'} · заявка от ${day}`);
      if (r.note) console.log(`      «${r.note}»`);
      console.log('');
    }

    console.log('Заявка закроется сама, когда аккаунт появится.\n');
  }
}
