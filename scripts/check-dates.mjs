#!/usr/bin/env node
// Даты сделки не съезжают на сутки — ни в одном часовом поясе.
//
//   npm run check:dates
//
// ── Что проверяется ──────────────────────────────────────────
//
// В базе `start_date` и `end_date` — календарные сутки без времени и без
// пояса. Аренда «с 10 по 13 сентября» значит одно и то же везде.
//
// JavaScript тут ошибается молча и в обе стороны:
//
//   new Date('2026-09-10')                → ПОЛНОЧЬ UTC, читается местным
//                                           поясом; западнее Гринвича это
//                                           ещё вчера;
//   new Date().toISOString().slice(0,10)  → UTC-сегодня, а не местное;
//                                           восточнее Гринвича с полуночи
//                                           до утра это вчера.
//
// Вторая ошибка была настоящей и в нашем собственном поясе: кнопка
// «на 3 дня» на карточке вещи подставляла вчерашнюю дату с полуночи до
// пяти утра, календарь красил её как прошедшую, а база отвечала
// RENTHUB_PAST_DATE. Человек ночью не делал ничего неправильного.
//
// ── Почему дочерними процессами ──────────────────────────────
//
// Часовой пояс читается движком один раз при старте: подменить его внутри
// работающего процесса нельзя. Поэтому каждый пояс — отдельный `node` с
// переменной TZ, и функции в нём настоящие, из src/lib/dates.ts, а не
// переписанные для проверки.
//
// Поясов шесть, и каждый выбран за свою беду:
//
//   Asia/Almaty          наш, UTC+5 — тот, где ошибка и жила;
//   UTC                  граница, на которой всё «работает» и потому не
//                        замечается;
//   America/New_York     западнее Гринвича — здесь съезжает разбор дат;
//   Pacific/Kiritimati   UTC+14, самый восточный обитаемый;
//   Pacific/Pago_Pago    UTC−11, самый западный;
//   Europe/Berlin        переход на летнее время — сутки в 23 часа.
//
// Два крайних пояса стоят здесь не для полноты списка, а чтобы проверка
// не зависела от времени суток. Подмена местного «сегодня» гринвичским
// видна, только пока местная дата и UTC-дата различаются: в Кокшетау это
// пять часов в сутки, и днём такая проверка была бы зелёной при живой
// ошибке. UTC+14 расходится с Гринвичем с 10:00 UTC и до полуночи,
// UTC−11 — с полуночи до 11:00. Вместе они покрывают сутки целиком:
// хотя бы один пояс поймает всегда.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DATES = pathToFileURL(join(HERE, '..', 'src', 'lib', 'dates.ts')).href;

const ZONES = [
  ['Asia/Almaty', 'наш пояс, UTC+5'],
  ['UTC', 'граница, где ошибки не видно'],
  ['America/New_York', 'западнее Гринвича'],
  ['Pacific/Kiritimati', 'UTC+14, самый восточный'],
  ['Pacific/Pago_Pago', 'UTC−11, самый западный'],
  ['Europe/Berlin', 'переход на летнее время'],
];

// Проверки живут строкой, потому что выполняются в чужом процессе.
// Каждая возвращает либо null (сошлось), либо текст расхождения.
const PROBE = `
import { addDays, eachDay, formatDate, formatDateRange, formatDay, parseDate, todayISO, toISO } from ${JSON.stringify(DATES)};

const bad = [];
const eq = (what, got, want) => { if (got !== want) bad.push(\`\${what}: «\${got}» вместо «\${want}»\`); };

// ── Разбор не теряет сутки ──────────────────────────────────
const d = parseDate('2026-09-10');
eq('parseDate день',   d.getDate(),        10);
eq('parseDate месяц',  d.getMonth(),       8);
eq('parseDate год',    d.getFullYear(),    2026);
eq('toISO обратно',    toISO(d),           '2026-09-10');

// ── Показ начинается с того же числа ────────────────────────
//
// Сравниваем начало строки, а не строку целиком: сокращение месяца
// зависит от версии ICU, а съезжает от ошибки именно ЧИСЛО.
const startsWith = (what, got, want) => {
  if (!String(got).startsWith(want)) bad.push(\`\${what}: «\${got}» не начинается с «\${want}»\`);
};
startsWith('formatDay',            formatDay('2026-09-10'),                     '10 ');
startsWith('formatDate',           formatDate('2026-09-10'),                    '10 ');
startsWith('formatDateRange',      formatDateRange('2026-09-10','2026-09-13'),  '10 — 13 ');
startsWith('formatDateRange, год', formatDateRange('2026-12-28','2027-01-03'),  '28 ');

// Диапазон через год обязан назвать оба года: «28 дек. — 3 янв.»
// заставляет достраивать самому.
const across = formatDateRange('2026-12-28', '2027-01-03');
if (!across.includes('2026') || !across.includes('2027')) {
  bad.push(\`диапазон через год не назвал оба: «\${across}»\`);
}

// ── Сдвиг на сутки остаётся сдвигом на сутки ────────────────
//
// 29 марта и 25 октября 2026 — ночи перехода в Европе: сутки длятся 23 и
// 25 часов. Сложение через миллисекунды здесь ошибается, через setDate —
// нет, и это стоит держать проверенным, а не подразумеваемым.
eq('addDays через весну',  addDays('2026-03-28', 1), '2026-03-29');
eq('addDays через осень',  addDays('2026-10-24', 1), '2026-10-25');
eq('addDays на месяц',     addDays('2026-01-31', 1), '2026-02-01');
eq('addDays назад',        addDays('2026-01-01', -1), '2025-12-31');

// ── Границы интервала включительно, как в базе ──────────────
eq('eachDay одни сутки',   eachDay('2026-09-10','2026-09-10').length, 1);
eq('eachDay четверо суток',eachDay('2026-09-10','2026-09-13').length, 4);
eq('eachDay через весну',  eachDay('2026-03-28','2026-03-30').length, 3);
eq('eachDay задом наперёд',eachDay('2026-09-13','2026-09-10').length, 0);

// ── Сегодня — по часам человека ─────────────────────────────
//
// Сверяем с независимым источником: Intl умеет назвать местную дату, не
// пользуясь нашим кодом. Формат sv-SE — это и есть ГГГГ-ММ-ДД.
const local = new Intl.DateTimeFormat('sv-SE', { timeZone: process.env.TZ }).format(new Date());
eq('todayISO', todayISO(), local);

console.log(JSON.stringify(bad));
`;

console.log('\n── Даты в чужих часовых поясах ──');

let failed = 0;

for (const [zone, why] of ZONES) {
  let bad;
  try {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', PROBE], {
      env: { ...process.env, TZ: zone },
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    bad = JSON.parse(out.trim().split('\n').pop());
  } catch (error) {
    // Запуск не состоялся — это не «сошлось» и не «разошлось», а
    // сломанная проверка. Молчать о ней хуже всего: она будет зелёной.
    console.log(`  ✗   ${zone.padEnd(20)} проверка не запустилась — ${String(error.message).split('\n')[0]}`);
    failed++;
    continue;
  }

  if (bad.length === 0) {
    console.log(`  ok  ${zone.padEnd(20)} ${why}`);
    continue;
  }

  failed++;
  console.log(`  ✗   ${zone.padEnd(20)} ${why}`);
  for (const line of bad) console.log(`        ${line}`);
}

if (failed === 0) {
  console.log(`\n✓ Сутки остаются сутками во всех ${ZONES.length} поясах.\n`);
  process.exit(0);
}

console.log(`\n✗ Пояса с расхождением: ${failed}.`);
console.log('  Скорее всего, где-то вернулся new Date(строка) вместо parseDate()');
console.log('  или new Date().toISOString().slice(0, 10) вместо todayISO().\n');
process.exit(1);
