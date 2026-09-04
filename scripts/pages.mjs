#!/usr/bin/env node
// Кто публикует сайт — проверить и починить.
//
//   npm run pages            проверить
//   npm run pages -- --apply переключить на один процесс (нужен токен GitHub)
//
// Зачем этот файл существует
// ──────────────────────────
// Сайт публикуют ДВА процесса сразу:
//
//   «Публикация на Pages»        наш workflow, собирает из кода
//   «pages build and deployment» встроенный, берёт папку docs/ из ветки
//
// У обоих deploy завершается успехом, и на адресе оказывается тот, кто
// финишировал вторым. Отсюда случаи «код запушили, а на сайте старое»:
// docs/ в ветке отставала, встроенный процесс публиковал её поверх свежей
// сборки, и оба при этом были зелёными.
//
// HANDOFF до 05.09.2026 считал, что встроенный процесс падает красным и
// потому безвреден. Публичный API GitHub показал обратное: оба success.
// Предположение прожило четыре дня, потому что его не проверяли — Actions
// смотреть было нечем.
//
// Чинится одним полем: build_type = workflow вместо legacy. После этого
// встроенный процесс перестаёт запускаться, публикует один, и папка docs/
// в репозитории становится не нужна.
//
// Устройство то же, что у `npm run auth`: проверяет всегда (статус Actions
// публичного репозитория виден без всякой авторизации), чинит — когда есть
// токен. Проверка общая, исполнитель любой.

import { readGithubToken } from './env.mjs';

const apply = process.argv.includes('--apply');
const REPO = 'MandalorianCs/renthub';
const token = readGithubToken();

const headers = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(token ? { Authorization: `Bearer ${token}` } : {}),
};

console.log('\nКто публикует сайт\n');

// ── 1. Что стоит в настройке ─────────────────────────────────
//
// Читается первой, хотя интереснее история. Причина в том, что настройка
// историю ОБЪЯСНЯЕТ: пока источник — ветка, два имени в списке означают
// гонку; после переключения те же два имени означают «одно из них больше
// не запускается». Первая версия скрипта читала историю раньше и честно
// печатала «! их двое» человеку, который минуту назад всё починил.
const pagesUrl = `https://api.github.com/repos/${REPO}/pages`;
const res = await fetch(pagesUrl, { headers });

if (!res.ok) {
  console.log(`  Настройку не прочитать: ${res.status}.`);
  console.log(token ? '  Токену не хватает права Pages.' : '  Нужен токен — см. ниже.');
  printManual();
  process.exit(1);
}

const cfg = await res.json();
const wrong = cfg.build_type !== 'workflow';

console.log(
  `  Источник      ${wrong ? `ветка ${cfg.source?.branch}${cfg.source?.path}` : 'GitHub Actions'}`,
);

// ── 2. Что говорят сами сборки ───────────────────────────────
//
// Публичный репозиторий отдаёт историю запусков без авторизации, поэтому
// эта половина работает и без токена.
const runs = await fetch(
  `https://api.github.com/repos/${REPO}/actions/runs?per_page=20`,
  { headers },
).then((r) => r.json());

const names = new Set();
for (const run of runs.workflow_runs ?? []) {
  if (run.conclusion === 'success') names.add(run.name);
}

const builtin = [...names].some((n) => n.toLowerCase().includes('pages build'));

console.log(`  В истории     ${[...names].join(', ') || '(ни одного запуска)'}`);

if (wrong && builtin) {
  console.log('  ! публикуют двое — на адресе оказывается тот, кто финишировал вторым');
} else if (builtin) {
  // История помнит встроенный процесс, но с переключённым источником он
  // больше не стартует. Говорим это прямо: иначе знакомое имя в списке
  // читается как «не сработало».
  console.log('  ✓ встроенный процесс есть в истории, но больше не запускается');
} else {
  console.log('  ✓ публикует один процесс');
}

if (!wrong) {
  console.log('\n✓ Источник — GitHub Actions. Публикует один процесс, чинить нечего.\n');
  process.exit(0);
}

console.log('  → станет      GitHub Actions (встроенный процесс перестанет запускаться)');

if (!token) {
  printManual();
  process.exit(1);
}

if (!apply) {
  console.log('\n  Это разбор, а не правка. Применить: npm run pages -- --apply\n');
  process.exit(1);
}

// ── 3. Переключение ──────────────────────────────────────────
//
// Меняется одно поле. Ветку и путь не трогаем: при build_type = workflow
// они не используются, но и стирать их незачем — если настройку когда-то
// вернут назад, пусть возвращается к тому же, что было.
const put = await fetch(pagesUrl, {
  method: 'PUT',
  headers: { ...headers, 'Content-Type': 'application/json' },
  body: JSON.stringify({ build_type: 'workflow' }),
});

if (!put.ok && put.status !== 204) {
  console.error(`\n✗ Не применилось, ${put.status}: ${(await put.text()).slice(0, 200)}`);
  printManual();
  process.exit(1);
}

// Перечитываем: «204 No Content» означает «запрос принят», а не «настройка
// такая». Разница та же, что между «письмо отправлено» и «письмо дошло».
const after = await (await fetch(pagesUrl, { headers })).json();

console.log('');
console.log(
  after.build_type === 'workflow'
    ? '  ✓ Источник теперь GitHub Actions'
    : `  ! Источник всё ещё ${after.build_type}`,
);
console.log('\n  Следующий пуш опубликует один процесс. Проверить, что доехало:');
console.log('  npm run health, строка «публикация».\n');

/** Дорога руками остаётся открытой всегда — см. `npm run auth`, там та же мысль. */
function printManual() {
  console.log('');
  console.log('  Руками — GitHub → Settings → Pages → Build and deployment:');
  console.log('');
  console.log('    Source: GitHub Actions');
  console.log('');
  console.log('  Или руками агента — нужен токен репозитория с правом Pages:');
  console.log('  github.com/settings/personal-access-tokens/new, доступ только');
  console.log(`  к ${REPO}. Строкой в .env.secret:`);
  console.log('');
  console.log('    GITHUB_TOKEN=github_pat_...');
  console.log('');
}
