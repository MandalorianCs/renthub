#!/usr/bin/env node
// Живые ли ссылки на сайте.
//
//   npm run check:links            опубликованный сайт
//   npm run check:links -- <адрес> любой другой
//
// Зачем. Дека, лендинг и приложение связаны ссылками, и половина из них
// ведёт наружу: бот в Telegram, репозиторий, папка со стендом. Любая из
// них может умереть тихо — бот переименован, ветка удалена, папка
// переехала. Узнать об этом на защите, когда судья нажал и попал на 404,
// дороже всего.
//
// Чем проверяем. linkinator (github.com/JustinBeckwith/linkinator, MIT):
// обходит страницы, собирает ссылки и стучится в каждую. Внешние тоже —
// именно они гниют первыми.
//
// Почему не в общем npm run check. Проверке нужна сеть и живой сайт, а
// общая проверка должна работать без интернета и до публикации. Это
// команда «перед защитой», а не «перед коммитом».

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SITE = process.argv[2] ?? 'https://mandaloriancs.github.io/renthub/';
const report = join(tmpdir(), `renthub-links-${Date.now()}.json`);

console.log(`\n── Ссылки: ${SITE} ──`);

const run = spawnSync(
  'npx',
  ['--yes', 'linkinator', SITE, '--recurse', '--format', 'json', '--timeout', '15000'],
  { encoding: 'utf8', shell: true, timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
);

if (run.error) {
  console.error(`\n✗ Не удалось запустить linkinator: ${run.error.message}\n`);
  process.exit(1);
}

let data;

try {
  data = JSON.parse(run.stdout);
} catch {
  console.error('\n✗ Ответ linkinator не разобрался. Проверьте сеть.\n');
  console.error(`${(run.stdout || run.stderr || '').slice(0, 600)}\n`);
  process.exit(1);
}

rmSync(report, { force: true });

const links = data.links ?? [];
const broken = links.filter((l) => l.state === 'BROKEN');
const skipped = links.filter((l) => l.state === 'SKIPPED').length;

console.log(`  проверено ссылок: ${links.length}, пропущено: ${skipped}`);

if (broken.length === 0) {
  console.log('  ok  все ссылки живые');
  console.log('\n✓ Судья не попадёт на 404.\n');
  process.exit(0);
}

console.log(`\n  ??  битых ссылок: ${broken.length}\n`);

for (const link of broken) {
  console.log(`  [${link.status ?? '—'}] ${link.url}`);
  console.log(`        со страницы ${link.parent ?? '—'}`);
}

console.log('\n  Ссылка, умершая тихо, находится на защите — и всегда судьёй.\n');
process.exit(1);
