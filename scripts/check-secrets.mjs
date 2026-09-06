#!/usr/bin/env node
// Ключи, случайно попавшие в репозиторий.
//
//   npm run check:secrets
//
// Зачем. Репозиторий публичный, и это не оплошность, а часть питча:
// слайд «проверить можно самим» ведёт судью в открытый код. Цена такой
// открытости в том, что ключ, попавший в коммит, становится общим
// достоянием мгновенно и навсегда — историю переписать можно, но копии
// уже разошлись, и первым их читает не человек, а бот.
//
// Что проверяем. secretlint (github.com/secretlint/secretlint, MIT) —
// набор правил под известные форматы токенов: AWS, GCP, Slack, npm,
// SendGrid, приватные ключи, базовая аутентификация в адресах. Проверка
// статическая, ключей никуда не отправляет.
//
// Что НЕ считается секретом. Публичный ключ Supabase и адрес проекта: они
// лежат в бандле приложения, который отдаётся браузеру. Доступ
// ограничивают политики базы, а не тайна ключа — и правило про токены их
// не трогает, потому что ищет форматы с секретной частью.
//
// Проверяются только файлы под контролем git: то, что лежит в .gitignore
// (.env, .env.secret), в репозиторий не попадает и проверке не подлежит.

import { execSync, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

console.log('\n── Секреты в репозитории ──');

let files;

try {
  files = execSync('git ls-files', { cwd: ROOT, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // Двоичные файлы проверять незачем, а деку и презентацию — тем более:
    // это снимки страницы, и внутри них ничего, кроме картинок, нет.
    .filter((name) => !/\.(png|jpg|jpeg|webp|ico|pdf|pptx|ttf|woff2?|apk|keystore|sha)$/i.test(name));
} catch (error) {
  console.error(`  ??  git не отдал список файлов: ${error.message}`);
  process.exit(1);
}

console.log(`  проверяю файлов: ${files.length}`);

// Правила и сам линтер тянутся через npx в момент запуска: в сборке
// приложения они не нужны, нужен только их вердикт.
const run = spawnSync(
  'npx',
  [
    '--yes',
    '--package', 'secretlint',
    '--package', '@secretlint/secretlint-rule-preset-recommend',
    'secretlint',
    '--secretlintrc', '.secretlintrc.json',
    '--maskSecrets',
    ...files,
  ],
  { cwd: ROOT, encoding: 'utf8', shell: true, timeout: 600_000 },
);

const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trim();

if (run.error) {
  console.error(`\n✗ Не удалось запустить secretlint: ${run.error.message}\n`);
  process.exit(1);
}

// Находки печатаются с «error» в строке; при чистом прогоне вывод пустой.
if (output.includes('error') || run.status !== 0) {
  console.log(`\n${output}\n`);
  console.error('✗ Найдено похожее на ключ. Ключ, попавший в публичный коммит,');
  console.error('  считается скомпрометированным — его меняют, а не удаляют.\n');
  process.exit(1);
}

console.log('  ok  ключей в отслеживаемых файлах нет');
console.log('\n✓ Репозиторий можно открывать судьям.\n');
