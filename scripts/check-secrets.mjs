#!/usr/bin/env node
// Ключи, случайно попавшие в репозиторий.
//
//   npm run check:secrets
//
// Зачем. Репозиторий публичный, и это не оплошность, а часть питча: слайд
// «проверить можно самим» ведёт судью в открытый код. Цена такой
// открытости в том, что ключ, попавший в коммит, становится общим
// достоянием мгновенно и навсегда — историю переписать можно, но копии
// уже разошлись, и первыми их читают боты.
//
// Что проверяем. secretlint (github.com/secretlint/secretlint, MIT) —
// набор правил под известные форматы: AWS, GCP, Slack, npm, SendGrid,
// приватные ключи, пароли в адресах. Разбор статический, ничего никуда
// не отправляется.
//
// Что НЕ секрет. Публичный ключ Supabase и адрес проекта: они лежат в
// бандле приложения, который отдаётся браузеру. Доступ ограничивают
// политики базы, а не тайна ключа.
//
// Что не проверяется: всё из .gitignore — .env, .env.secret, node_modules,
// собранный сайт. В репозиторий они не попадают.

import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('\n── Секреты в репозитории ──');

// Маска вместо списка файлов — и это не вкусовщина.
//
// Первая версия передавала secretlint перечень из git ls-files. На
// Windows это работало, в CI — нет: пути вроде app/(tabs)/index.tsx
// содержат скобки, а оболочка Linux читает их как синтаксис и падает со
// словами «Syntax error: "(" unexpected». Проверка при этом честно
// сообщала «найдено похожее на ключ», хотя ничего не нашла, — худший
// вид поломки: красный CI, который врёт о причине.
//
// Маска уходит одним аргументом в кавычках, скобок в ней нет, а что
// исключить — берётся из .gitignore.
const args = [
  '--yes',
  '--package', 'secretlint',
  '--package', '@secretlint/secretlint-rule-preset-recommend',
  'secretlint',
  '--secretlintrc', '.secretlintrc.json',
  '--secretlintignore', '.gitignore',
  '--maskSecrets',
  '"**/*"',
];

const run = spawnSync('npx', args, {
  cwd: ROOT,
  encoding: 'utf8',
  shell: true,
  timeout: 600_000,
  maxBuffer: 32 * 1024 * 1024,
});

if (run.error) {
  console.error(`\n✗ Не удалось запустить secretlint: ${run.error.message}\n`);
  process.exit(1);
}

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();

// Сбой запуска и находка — разные вещи, и путать их нельзя: одна требует
// чинить окружение, другая — менять ключ.
const failedToRun = /Syntax error|command not found|Cannot find module|ENOENT/i.test(output);

if (failedToRun) {
  console.error('\n✗ secretlint не отработал — это сбой запуска, а не находка.\n');
  console.error(`${output.slice(0, 800)}\n`);
  process.exit(1);
}

if (output.includes('error') || run.status !== 0) {
  console.log(`\n${output}\n`);
  console.error('✗ Найдено похожее на ключ. Ключ, попавший в публичный коммит,');
  console.error('  считается скомпрометированным — его меняют, а не удаляют.\n');
  process.exit(1);
}

console.log('  ok  ключей в отслеживаемых файлах нет');
console.log('\n✓ Репозиторий можно открывать судьям.\n');
