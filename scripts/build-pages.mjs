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

// --clear обязателен, а не «на всякий случай».
//
// Metro вшивает EXPO_PUBLIC_-переменные в момент преобразования модуля и
// кэширует результат. Правка .env кэш не сбрасывает: сборка проходит
// успешно, имя бандла не меняется, а внутри остаётся старое значение.
// Поймано на смене EXPO_PUBLIC_AUTH_MODE с invite на sms — публикация
// молча уехала бы со старым экраном входа.
//
// Цена — лишняя минута на пересборку. Она дешевле часа поисков причины,
// по которой «переменную поменяли, а ничего не изменилось».
execFileSync('npx', ['expo', 'export', '--platform', 'web', '--clear'], {
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

// Страницы схем публикуются отдельными адресами. На питче ссылку открыть
// быстрее, чем искать картинку в переписке, а сами страницы самодостаточны:
// весь SVG внутри, внешних файлов нет.
cpSync(join(ROOT, 'landing', 'diagrams'), join(DOCS, 'diagrams'), { recursive: true });

// Питч — отдельная страница, а не замена лендинга: лендинг написан для
// владельцев инструмента, питч — для жюри и инвесторов. Один текст не
// обслуживает обе аудитории, а адрес /pitch/ удобно диктовать голосом.
mkdirSync(join(DOCS, 'pitch'), { recursive: true });
cpSync(join(ROOT, 'landing', 'pitch.html'), join(DOCS, 'pitch', 'index.html'));

// GitHub Pages прогоняет сайт через Jekyll, а тот игнорирует папки,
// начинающиеся с подчёркивания. Expo кладёт бандл в _expo/static/… —
// без этого файла сайт откроется, а весь JavaScript вернёт 404, и
// симптом будет выглядеть как «белый экран, локально всё работает».
writeFileSync(join(DOCS, '.nojekyll'), '');

// Приложение — SPA с маршрутизацией на клиенте. Прямой заход на
// /renthub/app/item/<id> Pages не найдёт как файл и отдаст свою 404 —
// а без этого нельзя отправить ссылку на конкретное объявление, то есть
// отваливается основа маркетплейса.
//
// Файл обязан лежать в КОРНЕ публикации: GitHub Pages ищет 404.html
// только там, вложенные игнорирует. Внутри — index приложения: ассеты
// в нём прописаны абсолютными путями, поэтому он работает с любой глубины,
// а expo-router разберёт адрес из location сам.
cpSync(join(DOCS, 'app', 'index.html'), join(DOCS, '404.html'));

console.log(`
✓ Собрано в docs/ — это локальный предпросмотр.

  Публикацию делает GitHub Actions при пуше в main
  (.github/workflows/pages.yml): сайт всегда собирается из того кода,
  который лежит в main, и забыть пересборку больше нельзя.

  Открыть собранное локально:
    docs/index.html      лендинг
    docs/app/index.html  приложение

Живые адреса:
  лендинг     https://mandaloriancs.github.io/renthub/
  приложение  https://mandaloriancs.github.io/renthub/app/
`);
