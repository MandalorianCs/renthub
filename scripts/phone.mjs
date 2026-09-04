// Одно правило про телефоны на все служебные скрипты.
//
// Правило простое: «8 705…» и «+7 705…» — один и тот же номер. Копий у него
// было четыре: bot/bot.py, scripts/invite.mjs, scripts/moderator.mjs и
// src/lib/auth.tsx. Комментарий в боте честно перечислял копии — и уже
// отстал: moderator.mjs в списке не было, хотя он появился позже.
//
// Цена расхождения не абстрактная. Человек с верным номером не находит свой
// аккаунт, и причину ищут в Telegram, где её нет: приглашение записало
// «+77011234567», а вход искал «87011234567». Каждая половина сама по себе
// верна — потому и молчит.
//
// Два языка свести нельзя: Python в боте и TypeScript в приложении. Их
// правило сверяет scripts/check_bot.py — сравнением текста, а не доверием.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Казахстанские номера: 8 705… и +7 705… — это один и тот же номер. */
export function normalizePhone(input) {
  const digits = String(input ?? '').replace(/\D/g, '');
  if (digits.startsWith('8') && digits.length === 11) return `+7${digits.slice(1)}`;
  if (digits.startsWith('7') && digits.length === 11) return `+${digits}`;
  return `+${digits}`;
}

const service = JSON.parse(readFileSync(join(ROOT, 'shared', 'service-accounts.json'), 'utf8'));

/**
 * Аккаунт не человека: тестовый или владелец демо-витрины.
 *
 * Нужен там, где считают людей. Служебные аккаунты верифицированы наравне
 * с живыми, и без этой проверки пилот выглядит больше, чем он есть.
 */
export function isServiceAccount(phone) {
  return normalizePhone(phone).startsWith(service.phonePrefix);
}
