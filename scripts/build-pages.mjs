#!/usr/bin/env node
// Сборка публичной версии для GitHub Pages.
//
//   npm run build:pages
//
// Раскладка:
//   docs/index.html   — лендинг, он же корень сайта
//   docs/app/         — само приложение (Expo web)
//   docs/.nojekyll    — см. ниже, без него приложение не запустится
//
// Почему docs, а не dist: Pages умеет отдавать сайт из папки docs ветки
// main, и это единственный вариант без отдельной ветки gh-pages и
// дополнительной механики публикации.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DOCS = join(ROOT, 'docs');

console.log('Собираю веб-версию приложения…');
execFileSync('npx', ['expo', 'export', '--platform', 'web'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: process.platform === 'win32',
});

if (!existsSync(join(ROOT, 'dist', 'index.html'))) {
  console.error('✗ expo export не создал dist/index.html');
  process.exit(1);
}

rmSync(DOCS, { recursive: true, force: true });
mkdirSync(join(DOCS, 'app'), { recursive: true });

cpSync(join(ROOT, 'dist'), join(DOCS, 'app'), { recursive: true });
cpSync(join(ROOT, 'landing', 'index.html'), join(DOCS, 'index.html'));

// GitHub Pages прогоняет сайт через Jekyll, а тот игнорирует папки,
// начинающиеся с подчёркивания. Expo кладёт бандл в _expo/static/… —
// без этого файла сайт откроется, а весь JavaScript вернёт 404, и
// симптом будет выглядеть как «белый экран, локально всё работает».
writeFileSync(join(DOCS, '.nojekyll'), '');

// Приложение — SPA с маршрутизацией на клиенте. Прямой заход на
// /renthub/app/item/<id> Pages не найдёт как файл и отдаст свою 404.
// Подкладываем тот же index.html: он загрузится и разберёт адрес сам.
cpSync(join(DOCS, 'app', 'index.html'), join(DOCS, 'app', '404.html'));

console.log(`
✓ Готово. Опубликовать:

  1. git add docs && git commit && git push
  2. В репозитории: Settings → Pages → Source: Deploy from a branch
     Branch: main, папка: /docs → Save

Через минуту-две:
  лендинг     https://mandaloriancs.github.io/renthub/
  приложение  https://mandaloriancs.github.io/renthub/app/
`);
