#!/usr/bin/env node
// Уязвимости в зависимостях: известные — названы, новые — видны.
//
//   npm run check:deps            сверить с записанным списком
//   npm run check:deps -- --set   записать текущие как известные
//
// ── Зачем не просто `npm audit` ──────────────────────────────
//
// `npm audit` на этом проекте показывает восемнадцать строк и четыре
// «high». Все они приходят транзитивно из Expo и Metro, чинятся только
// сменой мажорной версии Expo, и починить их мы не можем. Команда,
// которая всегда красная и всегда по одной и той же причине, не
// защищает ни от чего: её перестают читать на второй неделе.
//
// Отсюда список известных — тот же приём, что у миграций
// (shared/squawk-baseline.json). Известное молчит, новое кричит.
//
// ── Почему у каждой строки есть «почему» ─────────────────────
//
// Записать уязвимость в список — это решение «с этим живём», и оно
// должно быть чьим-то. Пустое объяснение не проходит: проверка падает и
// на нём тоже. Заглушить её, не сказав почему, нельзя — а это и есть
// разница между списком известных проблем и ковром, под который метут.
//
// ── Что здесь важно на самом деле ────────────────────────────
//
// Не число уязвимостей, а ГДЕ они. Metro и config-plugins работают при
// сборке, на наших же файлах: их «отказ в обслуживании» означает, что
// сборка зависнет у нас на глазах. А вот query-string уезжает в бандл и
// разбирает адрес в браузере посетителя — это единственная строка,
// которая живёт рядом с человеком. Список это различие хранит словами,
// потому что ни `npm audit`, ни уровень severity его не знают.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BASELINE = join(ROOT, 'shared', 'audit-baseline.json');
const setMode = process.argv.includes('--set');

/**
 * Спросить реестр.
 *
 * `npm audit` выходит с ненулевым кодом, когда что-то нашёл, — то есть
 * почти всегда. Поэтому код возврата игнорируем и смотрим на разбор
 * JSON: он и отличает «нашлись уязвимости» от «команда не отработала».
 */
function audit() {
  let out;
  try {
    out = execFileSync('npm', ['audit', '--json'], {
      cwd: ROOT,
      encoding: 'utf8',
      shell: process.platform === 'win32',
      maxBuffer: 32 * 1024 * 1024,
    });
  } catch (error) {
    out = error.stdout ?? '';
  }

  try {
    return JSON.parse(out);
  } catch {
    return null;
  }
}

/** Уникальные советы: один совет — одна запись, сколько бы пакетов он ни задел. */
function advisories(report) {
  const found = new Map();
  for (const vuln of Object.values(report.vulnerabilities ?? {})) {
    for (const via of vuln.via ?? []) {
      if (typeof via !== 'object' || !via.source) continue;
      found.set(String(via.source), {
        пакет: via.name,
        уровень: via.severity,
        затронуто: via.range,
        что: via.title,
        ссылка: via.url,
      });
    }
  }
  return found;
}

console.log('\n── Уязвимости в зависимостях ──');

const report = audit();

if (!report || !report.vulnerabilities) {
  console.log('  ✗   npm audit не отработал — реестр недоступен или изменился формат');
  console.log('      это не «уязвимостей нет»: проверка не состоялась\n');
  process.exit(1);
}

const found = advisories(report);

// ── Запись списка ─────────────────────────────────────────────
if (setMode) {
  const old = existsSync(BASELINE) ? JSON.parse(readFileSync(BASELINE, 'utf8')) : { известные: {} };
  const известные = {};

  for (const [id, info] of [...found].sort(([a], [b]) => Number(a) - Number(b))) {
    известные[id] = {
      ...info,
      // Объяснение переживает перезапись: оно написано человеком, а всё
      // остальное — реестром.
      где: old.известные?.[id]?.где ?? '',
      почему: old.известные?.[id]?.почему ?? '',
    };
  }

  writeFileSync(
    BASELINE,
    JSON.stringify(
      {
        комментарий: [
          'Известные уязвимости зависимостей — те, с которыми решено жить.',
          '',
          'Записывается командой npm run check:deps -- --set. Поля «где» и',
          '«почему» пишет человек: пустое объяснение проверку не проходит.',
          '',
          'Смысл списка не в том, чтобы уязвимостей стало ноль, а в том,',
          'чтобы НОВАЯ была видна на фоне известных.',
        ],
        известные,
      },
      null,
      2,
    ) + '\n',
    'utf8',
  );

  console.log(`  ✓ Записано известных: ${Object.keys(известные).length}`);
  console.log(`    ${BASELINE}\n`);
  process.exit(0);
}

// ── Сверка ────────────────────────────────────────────────────
if (!existsSync(BASELINE)) {
  console.log('  ??  списка известных нет — запишите: npm run check:deps -- --set\n');
  process.exit(1);
}

const known = JSON.parse(readFileSync(BASELINE, 'utf8')).известные ?? {};
let failed = 0;

for (const [id, info] of found) {
  const row = known[id];

  if (!row) {
    console.log(`  ✗   НОВАЯ · ${info.уровень} · ${info.пакет} ${info.затронуто}`);
    console.log(`        ${info.что}`);
    console.log(`        ${info.ссылка}`);
    failed++;
    continue;
  }

  if (!row.почему?.trim()) {
    console.log(`  ✗   ${info.пакет} записан в известные, но без объяснения`);
    console.log('        заполните «где» и «почему» в shared/audit-baseline.json');
    failed++;
    continue;
  }

  console.log(`  ok  ${info.уровень.padEnd(8)} ${info.пакет.padEnd(22)} ${row.где}`);
}

// Исчезнувшие — не отказ: зависимость обновили, и это хорошая новость.
// Но список надо подчистить, иначе он превратится в архив.
const gone = Object.keys(known).filter((id) => !found.has(id));
for (const id of gone) {
  console.log(`  ··  ${known[id].пакет} больше не уязвим — уберите строку: npm run check:deps -- --set`);
}

if (failed === 0) {
  console.log(`\n✓ Новых уязвимостей нет; известных ${found.size}, и каждая объяснена.\n`);
  process.exit(0);
}

console.log(`\n✗ Требуют решения: ${failed}.`);
console.log('  Либо обновить зависимость, либо записать и объяснить:');
console.log('  npm run check:deps -- --set, затем заполнить «где» и «почему».\n');
process.exit(1);
