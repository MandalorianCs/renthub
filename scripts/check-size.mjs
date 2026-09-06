#!/usr/bin/env node
// Вес собранного приложения.
//
//   npm run check:size            проверить docs/app против порога
//   npm run check:size -- --set   записать текущий вес как новый порог
//
// Зачем. 06.09.2026 сборка весила 6,7 МБ, из них два мегабайта — шрифты
// иконок, которых мы не используем: импорт `{ Ionicons } from
// '@expo/vector-icons'` тянет набор целиком. После перехода на прямой путь
// осталось 2,7 МБ. Такие вещи возвращаются молча: один невнимательный
// импорт, и на телефоне судьи снова качается лишнее.
//
// Порог, а не «меньше некуда». Приложение будет расти — появятся экраны,
// платежи, карты. Проверка не запрещает рост, она делает его заметным:
// превысил — либо объясни и подними порог одной командой, либо посмотри,
// что прилетело.
//
// Что считаем: всю папку сборки (JS, шрифты, картинки, html) — ровно то,
// что скачает браузер за первое открытие с пустым кешем.

import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const APP = join(ROOT, 'docs', 'app');
const LIMITS = join(ROOT, 'shared', 'size-limits.json');

// Запас к порогу: сборка не байт в байт повторяема — имена файлов
// содержат хеши, а метаданные Expo меняются от версии к версии. Пять
// процентов гасят этот шум, не пряча настоящий рост.
const SLACK = 1.05;

function measure(dir) {
  let bytes = 0;
  let fonts = 0;
  let js = 0;

  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    const info = statSync(path);

    if (info.isDirectory()) {
      const nested = measure(path);
      bytes += nested.bytes;
      fonts += nested.fonts;
      js += nested.js;
      continue;
    }

    bytes += info.size;
    if (name.endsWith('.ttf') || name.endsWith('.woff2')) fonts += info.size;
    if (name.endsWith('.js')) js += info.size;
  }

  return { bytes, fonts, js };
}

if (!existsSync(APP)) {
  console.error('\n✗ Нет docs/app — сначала соберите: npm run build:pages\n');
  process.exit(1);
}

const now = measure(APP);
const kb = (n) => Math.round(n / 1024);

console.log('\n── Вес приложения ──');
console.log(`  всего ${kb(now.bytes)} КБ · JS ${kb(now.js)} КБ · шрифты ${kb(now.fonts)} КБ`);

if (process.argv.includes('--set')) {
  writeFileSync(
    LIMITS,
    `${JSON.stringify(
      {
        комментарий: [
          'Порог веса собранного приложения — то, что скачает браузер при',
          'первом открытии с пустым кешем.',
          '',
          'Записан командой npm run check:size -- --set после осознанного',
          'изменения. Проверка не запрещает рост, она делает его заметным:',
          'история этого файла показывает, чем именно приложение потяжелело',
          'и когда.',
        ],
        всего_кб: kb(now.bytes),
        js_кб: kb(now.js),
        шрифты_кб: kb(now.fonts),
        записано: new Date().toISOString().slice(0, 10),
      },
      null,
      2,
    )}\n`,
    'utf8',
  );

  console.log(`\n✓ Порог записан: ${kb(now.bytes)} КБ\n`);
  process.exit(0);
}

if (!existsSync(LIMITS)) {
  console.log('  ??  порога нет — запишите текущий: npm run check:size -- --set\n');
  process.exit(1);
}

const limit = JSON.parse(readFileSync(LIMITS, 'utf8'));
const allowed = Math.round(limit.всего_кб * SLACK);
const grown = kb(now.bytes) - limit.всего_кб;

if (kb(now.bytes) > allowed) {
  console.log(`  ??  порог ${limit.всего_кб} КБ (от ${limit.записано}), стало ${kb(now.bytes)} КБ — плюс ${grown} КБ`);
  console.log('\n  Что делать:');
  console.log('   1. Посмотреть, что прилетело: крупные файлы в docs/app.');
  console.log('      Самая частая причина — импорт пакета целиком вместо одного модуля.');
  console.log('   2. Если рост осознанный — записать новый порог:');
  console.log('      npm run check:size -- --set\n');
  process.exit(1);
}

console.log(`  ok  порог ${limit.всего_кб} КБ (от ${limit.записано}), запас ${allowed - kb(now.bytes)} КБ`);
console.log('\n✓ Приложение не растолстело.\n');
