#!/usr/bin/env node
// Прогон миграций и сценариев на настоящем Postgres в Docker.
//
// Зачем: «tsc проходит и expo собирается» ничего не говорит о том, применятся
// ли миграции и не развалится ли петля сделки. Здесь база поднимается с нуля,
// на неё накатываются 0001–0003 ровно в том же порядке, что в SQL Editor,
// и по ним проезжает полный сценарий от имени двух живых пользователей.
//
//   node db-tests/run.mjs           обычный прогон, контейнер удаляется
//   node db-tests/run.mjs --keep    оставить базу для ручных запросов
//
// Файлы не монтируются томом, а подаются в psql через stdin: путь к проекту
// содержит кириллицу и пробелы, и docker -v на нём ведёт себя непредсказуемо.

import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const CONTAINER = 'renthub-test-db';
const IMAGE = 'postgres:16-alpine';
const KEEP = process.argv.includes('--keep');

// Порядок ровно как в README: сначала платформенная заглушка, потом миграции,
// потом сценарии. Если что-то падает — падает на своём шаге, а не «где-то в SQL».
// Миграции не перечисляются руками: список читается из папки в том же
// порядке, в каком их применит Supabase — по имени файла. Иначе новая
// миграция молча выпадала бы из прогона, и стенд подтверждал бы схему,
// которой на проекте уже нет.
const migrations = readdirSync(join(ROOT, 'supabase', 'migrations'))
  .filter((f) => f.endsWith('.sql'))
  .sort()
  .map((f) => [`миграция — ${f.replace(/^\d+_/, '').replace(/\.sql$/, '')}`, `supabase/migrations/${f}`]);

const STEPS = [
  ['заглушка платформы Supabase', 'db-tests/00_platform_shim.sql'],
  ...migrations,
  ['помощники и регистрация', 'db-tests/10_helpers.sql'],
  ['сценарий 1 — обычная сделка', 'db-tests/20_happy_path.sql'],
  ['сценарий 2 — запреты', 'db-tests/30_guards.sql'],
  ['сценарий 3 — просрочка', 'db-tests/40_overdue.sql'],
  ['сценарий 4 — споры', 'db-tests/50_disputes.sql'],
  ['сценарий 5 — бот от имени участника', 'db-tests/60_bot.sql'],
];

const docker = (args, opts = {}) =>
  spawnSync('docker', args, { encoding: 'utf8', ...opts });

function die(message, detail) {
  console.error(`\n✗ ${message}`);
  if (detail) console.error(detail.trim());
  process.exit(1);
}

// ── Поднимаем чистую базу ─────────────────────────────────────
// Именно чистую: тесты опираются на то, что таблицы пустые, а прошлый
// прогон мог оставить сделки в промежуточных статусах.

if (docker(['version']).status !== 0) {
  die('Docker не отвечает. Запустите Docker Desktop и повторите.');
}

console.log(`Поднимаю ${IMAGE} в контейнере ${CONTAINER}…`);
docker(['rm', '-f', CONTAINER]);

const up = docker([
  'run', '-d', '--name', CONTAINER,
  '-e', 'POSTGRES_PASSWORD=postgres',
  // Supabase держит базу в UTC. Часовой пояс влияет на grace_period_ends_at,
  // поэтому расхождение с продакшном здесь недопустимо.
  '-e', 'TZ=UTC',
  '-e', 'PGTZ=UTC',
  IMAGE,
]);
if (up.status !== 0) die('не удалось запустить контейнер', up.stderr);

// Синхронная пауза: скрипт линейный, разводить вокруг него async ради
// ожидания стартующей базы — лишний шум.
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

let ready = false;
for (let i = 0; i < 60; i++) {
  if (docker(['exec', CONTAINER, 'pg_isready', '-U', 'postgres', '-q']).status === 0) {
    ready = true;
    break;
  }
  sleep(1000);
}
if (!ready) {
  const logs = docker(['logs', '--tail', '40', CONTAINER]);
  die('Postgres не поднялся за 60 попыток', logs.stdout + logs.stderr);
}

// ── Прогон ────────────────────────────────────────────────────

function psql(sqlPath) {
  return docker(
    [
      'exec', '-i',
      '-e', 'PGPASSWORD=postgres',
      '-e', 'PGCLIENTENCODING=UTF8',
      CONTAINER,
      'psql', '-U', 'postgres', '-d', 'postgres',
      '-v', 'ON_ERROR_STOP=1',
      '--quiet', '--no-psqlrc',
      // Результаты запросов смысла не несут: всё проверяемое приходит через
      // raise notice в stderr. Без этого вывод тонет в таблицах psql.
      '-o', '/dev/null',
    ],
    { input: readFileSync(join(ROOT, sqlPath)) },
  );
}

const started = Date.now();
let failed = null;
let checks = 0;

for (const [label, file] of STEPS) {
  process.stdout.write(`\n▸ ${label}\n`);
  const res = psql(file);

  // raise notice уходит в stderr — это наши «ok», а не ошибки.
  const noise = (res.stderr || '')
    .split('\n')
    .filter((line) => line.trim() && !line.startsWith('SET') && !line.includes('NOTICE:  extension'))
    .map((line) => line.replace(/^ПРЕДУПРЕЖДЕНИЕ:|^NOTICE:\s*/, '  '))
    .join('\n');

  if (res.stdout?.trim()) console.log(res.stdout.trim());
  if (noise) console.log(noise);

  // Считаем то, что уже печатаем. Отдельного реестра проверок нет и не
  // надо: он разошёлся бы с настоящим числом ровно так же, как с ним
  // разошлась цифра на слайде питча.
  checks += (noise.match(/^ {2}ok {2}/gm) || []).length;

  if (res.status !== 0) {
    failed = { label, file };
    break;
  }
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);

if (KEEP) {
  console.log(
    `\nКонтейнер ${CONTAINER} оставлен. Подключиться:\n` +
      `  docker exec -it ${CONTAINER} psql -U postgres`,
  );
} else {
  docker(['rm', '-f', CONTAINER]);
}

if (failed) {
  console.error(`\n✗ ПРОВАЛ на шаге «${failed.label}» (${failed.file}), ${seconds} с`);
  process.exit(1);
}

// «351 проверок» читается как недоделанный инструмент — то же правило, что
// DESIGN.md держит для экранов. Стенд печатают чаще, чем открывают любой из
// них.
function проверок(n) {
  const two = n % 100;
  const one = n % 10;
  if (two >= 11 && two <= 14) return 'проверок';
  if (one === 1) return 'проверка';
  if (one >= 2 && one <= 4) return 'проверки';
  return 'проверок';
}

console.log(
  `\n✓ Миграции применились, все сценарии прошли. ${checks} ${проверок(checks)}, ${seconds} с`,
);

// ── Цифра на слайде питча ─────────────────────────────────────
//
// «345 автоматических проверок бизнес-правил» — сильнейшее утверждение
// слайда «Результаты инкубации» и единственная цифра деки, которая
// растёт сама. Записанная однажды и забытая, она занижает: 03.09.2026
// там стояло 130 при 345 фактических — в 2,6 раза, причём занижало
// ровно то, чем стоит хвастаться.
//
// Напоминание стоит здесь, а не в отдельной команде, потому что число
// рождается здесь. Тот, кто дописал проверку, узнаёт про слайд в ту же
// секунду — а не за день до защиты.
try {
  const pitchPath = join(ROOT, 'landing', 'pitch.html');
  const claimed = Number(
    (readFileSync(pitchPath, 'utf8').match(/<div class="stat-v">(\d+)<\/div>/) || [])[1],
  );

  if (claimed && claimed !== checks) {
    console.log(
      `\n! На слайде питча заявлено ${claimed} проверок, а прошло ${checks}.\n` +
        `  Поправьте stat-v в landing/pitch.html и пересоберите: npm run build:pages`,
    );
  }
} catch {
  // Питч — не часть стенда: нет файла, нет и напоминания. Ронять из-за
  // этого зелёный прогон миграций было бы неверной ценой.
}
