#!/usr/bin/env node
// Служебные скрипты загружаются без ошибок.
//
//   npm run check:scripts
//
// Зачем. Скрипты в scripts/ — это инструменты, которыми чинят и проверяют
// продукт: приглашение участника, здоровье системы, сборка сайта, деки,
// иконок. Их никто не компилирует и не покрывает типами; ломается такой
// скрипт молча и обнаруживается в тот момент, когда он срочно нужен.
//
// Так и вышло 07.09.2026. Правка свела правило про телефоны в один модуль,
// и scripts/phone.mjs стал реэкспортом: `export { normalizePhone } from …`.
// Короткая форма создаёт ТОЛЬКО внешний экспорт — внутри файла имени не
// появляется, и соседняя функция isServiceAccount упала с «normalizePhone
// is not defined». Файл при этом разбирается, типы проходят, npm run check
// зелёный: ошибка ждала запуска npm run health.
//
// Что проверяем. Каждый скрипт импортируется — то есть выполняется его
// верхний уровень и разрешаются все импорты. Это ловит опечатки в путях,
// потерянные экспорты и синтаксис. Чего НЕ проверяем: что скрипт делает,
// — для этого он должен работать с живой базой, а проверке этого не нужно.
//
// Скрипты, которые при импорте что-то делают (просят ключ, лезут в сеть,
// печатают отчёт), перечислены в списке исключений: их верхний уровень
// нельзя выполнить «просто так», и они проверяются собственным запуском.

import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HERE = join(ROOT, 'scripts');

// Скрипты-команды: при импорте они сразу делают работу — читают ключ,
// ходят в сеть, собирают сайт. Импортировать их проверкой значит запустить,
// а этого проверка делать не должна.
const RUNNERS = new Set([
  'auth.mjs',
  'build-pages.mjs',
  'check-errors.mjs',
  'check-lint.mjs',
  'check-links.mjs',
  'check-pitch.mjs',
  'check-price.mjs',
  'check-scripts.mjs',
  'check-secrets.mjs',
  'check-size.mjs',
  'check-sql.mjs',
  'demo-listings.mjs',
  'email.mjs',
  'exit.mjs',
  'fx.mjs',
  'health.mjs',
  'invite.mjs',
  'make-demo-photos.mjs',
  'make-icons.mjs',
  'moderator.mjs',
  'notify-clear.mjs',
  'notify-test.mjs',
  'nudge.mjs',
  'pages.mjs',
  'phone.mjs',
  'qr.mjs',
  'queue.mjs',
  'seed-test-users.mjs',
  'whoami.mjs',
]);

// Чистые утилиты: только функции, никаких действий при импорте. Их и
// проверяем — phone.mjs в этом списке потому, что сломался именно он.
//
// auth.mjs сюда не входит, хотя выглядит утилитой: при импорте он ходит в
// панель Supabase и печатает отчёт. Первый запуск этой проверки его и
// запустил — признак того, что список должен быть коротким и явным, а не
// «всё, что не похоже на команду».
const PURE = ['phone.mjs', 'deck.mjs', 'env.mjs'];

console.log('\n── Служебные скрипты ──');

const files = readdirSync(HERE).filter((n) => n.endsWith('.mjs'));
let failed = 0;
let checked = 0;

for (const name of files) {
  const isPure = PURE.includes(name);
  if (RUNNERS.has(name) && !isPure) continue;

  try {
    const module = await import(pathToFileURL(join(HERE, name)).href);

    // Импорт прошёл — но экспортированная функция могла остаться без
    // своего окружения: ровно этот случай и был с phone.mjs. Зовём каждую
    // функцию без аргументов и считаем ошибкой только ReferenceError:
    // «нет такого имени» — это поломка модуля, а «нельзя без аргумента» —
    // нормальная реакция на пустой вызов.
    for (const [key, value] of Object.entries(module)) {
      if (typeof value !== 'function') continue;
      try {
        value();
      } catch (error) {
        if (error instanceof ReferenceError) {
          console.log(`  ??  ${name}: ${key}() падает с «${error.message}»`);
          failed++;
        }
      }
    }

    checked++;
  } catch (error) {
    console.log(`  ??  ${name} не загружается: ${error.message}`);
    failed++;
  }
}

if (failed === 0) {
  console.log(`  ok  ${checked} модулей загружаются и их функции вызываются`);
  console.log('\n✓ Инструменты на месте.\n');
  process.exit(0);
}

console.log('\n✗ Сломанный инструмент обнаруживается в тот момент, когда он срочно нужен.\n');
process.exit(1);
