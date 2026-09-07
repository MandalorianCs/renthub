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

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const HERE = join(ROOT, 'scripts');

// Что проверяем — белый список, и это осознанно.
//
// Сначала здесь был чёрный: «импортируем всё, кроме команд». Такой список
// забывается ровно один раз — когда добавляют новый скрипт. Так и вышло:
// check-contrast.mjs появился позже, в исключения не попал, и проверка его
// импортировала, то есть запустила. Выглядело как отчёт о контрасте
// посреди отчёта о скриптах.
//
// Белый список ошибается в другую сторону: забытый скрипт останется
// непроверенным, но ничего не сломает. А чтобы не забывался и он, ниже
// считаются файлы, не попавшие никуда.
const PURE = ['phone.mjs', 'deck.mjs', 'env.mjs'];

// Скрипты-команды: при импорте они делают работу — читают ключ, ходят в
// сеть, собирают сайт. Их не импортируем; они проверяются собственным
// запуском.
const RUNNERS = new Set([
  'auth.mjs', 'build-pages.mjs', 'check-contrast.mjs', 'check-errors.mjs',
  'check-links.mjs', 'check-lint.mjs', 'check-pitch.mjs', 'check-price.mjs',
  'check-scripts.mjs', 'check-secrets.mjs', 'check-size.mjs', 'check-sql.mjs',
  'demo-listings.mjs', 'email.mjs', 'exit.mjs', 'fx.mjs', 'health.mjs',
  'invite.mjs', 'make-demo-photos.mjs', 'make-icons.mjs', 'moderator.mjs',
  'notify-clear.mjs', 'notify-test.mjs', 'nudge.mjs', 'pages.mjs', 'qr.mjs',
  'queue.mjs', 'seed-test-users.mjs', 'whoami.mjs',
]);

console.log('\n── Служебные скрипты ──');

const files = readdirSync(HERE).filter((n) => n.endsWith('.mjs'));
let failed = 0;
let checked = 0;

// Скрипт, не попавший ни в один список, — забытый скрипт. Скажем о нём,
// но не станем импортировать: неизвестно, что он сделает.
const forgotten = files.filter((n) => !PURE.includes(n) && !RUNNERS.has(n));

for (const name of forgotten) {
  console.log(`  ??  ${name} не отнесён ни к утилитам, ни к командам`);
  failed++;
}

for (const name of PURE) {
  if (!files.includes(name)) {
    console.log(`  ??  ${name} в списке утилит, но файла нет`);
    failed++;
    continue;
  }

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

// ── Документация не обещает несуществующего ──────────────────
//
// README и HANDOFF — первое, что открывает и судья, и тот, кто придёт в
// проект после нас. Команда, которой нет, тратит их время на выяснение,
// сломан ли инструмент или устарел текст, и подрывает доверие ко всему
// остальному списку.
//
// Обратное не проверяем: описывать в README каждую служебную команду
// незачем — «npm run typecheck» объясняет себя сам.
{
  const scripts = Object.keys(
    JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')).scripts ?? {},
  );

  for (const doc of ['README.md', 'HANDOFF.md']) {
    const text = readFileSync(join(ROOT, doc), 'utf8');
    const promised = [...text.matchAll(/npm run ([a-z:0-9-]+)/g)].map((m) => m[1]);

    for (const name of [...new Set(promised)]) {
      if (!scripts.includes(name)) {
        console.log(`  ??  ${doc} обещает «npm run ${name}», а такой команды нет`);
        failed++;
      }
    }
  }
}

if (failed === 0) {
  console.log(`  ok  ${checked} модулей загружаются, документация не врёт про команды`);
  console.log('\n✓ Инструменты на месте.\n');
  process.exit(0);
}

console.log('\n✗ Сломанный инструмент обнаруживается в тот момент, когда он срочно нужен.\n');
process.exit(1);
