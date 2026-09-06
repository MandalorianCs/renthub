#!/usr/bin/env node
// Миграции глазами линтера Postgres.
//
//   npm run check:sql
//
// Что проверяем. Squawk (github.com/sbdchd/squawk, MIT) читает SQL и
// говорит, какие операции блокируют таблицу: индекс без concurrently,
// constraint без not valid, отсутствующий lock_timeout. База не нужна —
// разбор статический.
//
// Зачем нам. Схема разворачивается пушем в main: миграция уезжает в
// продакшн через минуту после коммита, и увидеть блокировку постфактум
// значит увидеть её на живых пользователях. Пока пилот пуст, цена
// ошибки — ноль; ровно поэтому правило и стоит завести сейчас, а не
// после первой сотни объявлений.
//
// Почему с базовым уровнем, а не «ноль замечаний». Шестьдесят миграций
// уже применены, и переписать их нельзя: миграция — это история, а не
// код. Их замечания зафиксированы в shared/squawk-baseline.json как
// принятые, с общей причиной. Проверка падает на НОВОМ: на файле,
// которого в списке нет, или на замечании, которого в нём не было.
//
// Что делать, когда проверка упала. Либо исправить миграцию (обычно это
// concurrently, not valid или lock_timeout), либо, если правило здесь
// неприменимо, добавить файл в базовый уровень — руками и с причиной,
// потому что молча принятое замечание ничем не отличается от
// пропущенного.

import { execSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, basename, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readdirSync } from 'node:fs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const MIGRATIONS = join(ROOT, 'supabase', 'migrations');
const BASELINE = join(ROOT, 'shared', 'squawk-baseline.json');

if (!existsSync(MIGRATIONS)) {
  console.error('\n✗ Нет папки supabase/migrations — проверять нечего.\n');
  process.exit(1);
}

const files = readdirSync(MIGRATIONS)
  .filter((name) => name.endsWith('.sql'))
  .map((name) => join(MIGRATIONS, name));

console.log(`\n── Миграции: ${files.length} файлов ──`);

let report;

try {
  // npx тянет squawk при первом запуске; на машине с кешем это мгновенно,
  // в CI — секунды. Отдельной зависимости в package.json не заводим: линтер
  // нужен в момент проверки, а не в сборке приложения.
  // Через оболочку и относительными путями — так надо на Windows.
  //
  // execFileSync не запускает npx.cmd напрямую: Node 20+ отвечает EINVAL.
  // А относительные пути нужны потому, что абсолютный путь проекта здесь
  // содержит кириллицу и пробелы, и склейка
  // командной строки на них спотыкается. Глоб не используем: cmd.exe его
  // не раскрывает, поэтому файлы перечислены явно.
  const args = files.map((f) => '"' + relative(ROOT, f).split(sep).join('/') + '"').join(' ');
  const out = execSync(`npx --yes squawk-cli --reporter=json ${args}`, {
    cwd: ROOT,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 300_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  report = JSON.parse(out || '[]');
} catch (error) {
  // Squawk возвращает ненулевой код, когда нашёл замечания: это не сбой.
  const out = error.stdout?.toString?.() ?? '';
  if (!out.trim()) {
    console.error('\n✗ Squawk не отработал. Проверьте сеть и доступ к npx.\n');
    console.error(`  ${error.message}\n`);
    process.exit(1);
  }
  report = JSON.parse(out);
}

const baseline = existsSync(BASELINE)
  ? JSON.parse(readFileSync(BASELINE, 'utf8')).принято ?? {}
  : {};

// Считаем замечания по файлу и правилу — так база сравнения не зависит от
// номеров строк, которые сдвигаются от любой правки комментария.
const found = {};

for (const item of report) {
  const file = basename(item.file ?? '');
  const rule = item.rule_name ?? 'unknown';
  found[file] ??= {};
  found[file][rule] = (found[file][rule] ?? 0) + 1;
}

const problems = [];

for (const [file, rules] of Object.entries(found)) {
  const accepted = baseline[file];

  if (!accepted) {
    problems.push({
      file,
      text: `новый файл с замечаниями: ${Object.entries(rules)
        .map(([r, n]) => `${r} ×${n}`)
        .join(', ')}`,
    });
    continue;
  }

  for (const [rule, count] of Object.entries(rules)) {
    const was = accepted.правила?.[rule] ?? 0;
    if (count > was) {
      problems.push({ file, text: `${rule}: было ${was}, стало ${count}` });
    }
  }
}

const total = report.length;
const acceptedTotal = Object.values(baseline).reduce(
  (sum, entry) => sum + Object.values(entry.правила ?? {}).reduce((a, b) => a + b, 0),
  0,
);

if (problems.length === 0) {
  console.log(`  ok  замечаний ${total}, все приняты и объяснены (${acceptedTotal} в базовом уровне)`);
  console.log('\n✓ Новых опасных операций в миграциях нет.\n');
  process.exit(0);
}

console.log(`  ??  новых замечаний: ${problems.length}\n`);

for (const p of problems) {
  console.log(`  ${p.file}`);
  console.log(`      ${p.text}`);
}

console.log('\n  Что делать:');
console.log('   1. Исправить миграцию — чаще всего это concurrently, not valid');
console.log('      или set lock_timeout в начале файла.');
console.log('   2. Если правило здесь неприменимо — добавить файл в');
console.log('      shared/squawk-baseline.json с причиной. Руками: молча принятое');
console.log('      замечание ничем не отличается от пропущенного.\n');
console.log('  Подробности правил: https://squawkhq.com/docs/rules\n');

process.exit(1);
