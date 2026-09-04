// Откуда служебные скрипты берут адрес проекта и секретный ключ.
//
// Публичные значения лежат в `.env` — тот же файл читает Expo при сборке.
// Секретному ключу там не место: `.env` вшивается в бандл и уезжает в
// браузер вместе с приложением. Поэтому у него отдельный файл
// `.env.secret`, которого не касаются ни Expo, ни git.
//
// Раньше ключ передавался переменной окружения при каждом запуске. Это
// безопасно ровно до того момента, когда набирать его надоедает: дальше
// он переезжает в историю команд PowerShell, а `Get-History` — не то
// место, за которым кто-то следит.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Значение из файла формата .env.
 *
 * BOM отрезается не для красоты: PowerShell пишет файлы в UTF-8 с меткой,
 * и без этой строки первый ключ читается как «\uFEFFSUPABASE_SECRET_KEY»,
 * то есть не находится вовсе. Ошибка выглядит как «ключа нет», хотя он
 * лежит на месте.
 */
function readFrom(file, key) {
  try {
    const line = readFileSync(join(ROOT, file), 'utf8')
      .replace(/^\uFEFF/, '')
      .split('\n')
      .find((l) => l.trim().startsWith(`${key}=`));
    if (!line) return null;
    const value = line
      .slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    return value || null;
  } catch {
    return null;
  }
}

/** Публичное значение из `.env` — адрес проекта, город пилота. */
export function readEnvFile(key) {
  return readFrom('.env', key);
}

/**
 * Секретный ключ: сначала переменная окружения, потом файл.
 *
 * Порядок именно такой. Разовая команда против другой базы — чужого
 * проекта, тестового стенда — задаётся переменной, и она обязана
 * перебивать сохранённый ключ. Наоборот было бы ловушкой: человек
 * подставляет ключ явно, а скрипт молча берёт другой.
 */
export function readSecret() {
  return process.env.SUPABASE_SECRET_KEY ?? readFrom('.env.secret', 'SUPABASE_SECRET_KEY');
}

/**
 * Токен управления аккаунтом — не то же самое, что секретный ключ.
 *
 * Секретный ключ открывает всё ВНУТРИ проекта: таблицы, пользователей,
 * отправку писем. Настройки самого проекта — Site URL, список редиректов,
 * включённые провайдеры — лежат СНАРУЖИ базы, и ключ до них не достаёт.
 * Ими управляет Management API, а он спрашивает токен аккаунта (`sbp_...`).
 *
 * Разделение не случайно: скомпрометированный ключ проекта — потеря одного
 * проекта, токен аккаунта — потеря всех. Поэтому он необязателен: без него
 * скрипты обязаны продолжать работать и объяснять, что нажать руками.
 */
export function readAccessToken() {
  return process.env.SUPABASE_ACCESS_TOKEN ?? readFrom('.env.secret', 'SUPABASE_ACCESS_TOKEN');
}

/**
 * Токен GitHub — третий секрет, и снова с другой областью.
 *
 * Ключ проекта открывает базу, токен Supabase — настройки проекта, этот —
 * репозиторий: статус сборок и настройку публикации Pages. Область у всех
 * трёх разная, и складывать их в один «главный ключ» было бы удобно ровно
 * до первой утечки.
 *
 * Необязателен: без него `npm run pages` проверяет и объясняет, что нажать.
 */
export function readGithubToken() {
  return process.env.GITHUB_TOKEN ?? readFrom('.env.secret', 'GITHUB_TOKEN');
}

/** Идентификатор проекта из его адреса: https://<ref>.supabase.co */
export function projectRef(url) {
  return url?.match(/^https:\/\/([a-z0-9]+)\.supabase\./)?.[1] ?? null;
}

/** Одинаковая подсказка для всех скриптов, пример команды у каждого свой. */
export function missingSecretMessage(example) {
  return (
    '✗ Нужен секретный ключ (Project Settings → API Keys → Secret keys).\n' +
    '  Положите его один раз в `.env.secret` рядом с `.env`:\n\n' +
    '    SUPABASE_SECRET_KEY=sb_secret_...\n\n' +
    '  Файл в .gitignore, в бандл не попадает, набирать ключ больше не нужно.\n' +
    '  Разово можно и переменной окружения — она перебивает файл:\n\n' +
    `    $env:SUPABASE_SECRET_KEY="sb_secret_..."; ${example}\n`
  );
}
