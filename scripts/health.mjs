#!/usr/bin/env node
// Живое состояние платформы.
//
//   npm run health
//
// Зачем. Два обещания продукта держатся не на коде, а на процессах снаружи:
// планировщик pg_cron разбирает просрочки, бот доставляет уведомления. Оба
// настраиваются руками, оба молча перестают работать, и заметить это до
// сих пор можно было только по тишине — то есть по жалобе участника.
//
// Лендинг при этом обещает клиенту: «Не вернули — спор открывается без
// участия людей», а страница для жюри называет это правилом Trust Score.
// Обещание, которое некому проверить, однажды перестаёт быть правдой.
//
// Что здесь проверяется и чем: часть отвечает база через platform_health()
// (планировщик она видит, а мы — нет: схема cron через PostgREST не
// открыта), часть — этот скрипт.

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { missingSecretMessage, readEnvFile, readGithubToken, readSecret } from './env.mjs';
import { isServiceAccount } from './phone.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Тот же адрес, что просит приложение (EMAIL_RETURN_URL в
// src/lib/supabase.ts). Сверяем с ним: расхождение и есть дефект.
//
// Строкой он здесь лежал ровно до тех пор, пока копий не стало три —
// health, invite и auth. Три копии одного адреса расходятся не «если»,
// а «когда», и разойдутся молча: каждая сама по себе верна.
const APP_URL = JSON.parse(readFileSync(join(ROOT, 'shared', 'auth.json'), 'utf8')).app;

const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();

if (!secret) {
  console.error(missingSecretMessage('npm run health'));
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

const rows = [];

function say(part, state, alarm) {
  rows.push({ part, state, alarm });
}

// ── Что видит база ───────────────────────────────────────────
const { data: health, error } = await admin.rpc('platform_health');

if (error) {
  console.error(`\n✗ База не ответила: ${error.message}\n`);
  process.exit(1);
}

for (const row of health ?? []) say(row.part, row.state, row.alarm);

// Жив ли бот.
//
// Строка про очередь уведомлений отвечает на вопрос «есть ли невыполненная
// работа». В тишине — а пилот на пять человек это в основном тишина —
// работы нет, и мёртвый бот неотличим от живого.
//
// Отметку ставит сам бот после каждой волны доставки, раз в POLL_SECONDS
// (по умолчанию пятнадцать секунд). Порог в пять минут даёт запас на
// перезапуск, сеть и медленную волну.
const { data: beat } = await admin
  .from('heartbeats')
  .select('seen_at')
  .eq('name', 'bot')
  .maybeSingle();

const beatAgo = beat?.seen_at ? (Date.now() - new Date(beat.seen_at).getTime()) / 1000 : null;

say(
  'бот',
  beatAgo === null
    ? 'отметки нет — миграция heartbeats не доехала'
    : beatAgo > 60 * 60 * 24 * 365
      ? 'ни разу не отмечался — поднимите бота: npm run bot'
      : beatAgo < 300
        ? `отметился ${beatAgo < 60 ? 'только что' : `${Math.round(beatAgo / 60)} мин назад`}`
        : `молчит ${Math.round(beatAgo / 60)} мин — похоже, не запущен`,
  beatAgo === null || beatAgo > 300,
);

// ── Витрина ──────────────────────────────────────────────────
//
// Имя служебного владельца читается из общего файла — того же, что читают
// приложение и scripts/demo-listings.mjs. Вписать его сюда строкой значило
// бы завести очередную копию правила, ради единственности которого файл и
// существует.
const demoOwner = JSON.parse(readFileSync(join(ROOT, 'shared', 'demo-owner.json'), 'utf8'));

const { data: items } = await admin
  .from('items')
  .select('id, title, pickup_area, created_at, condition_photos, owner:users!items_owner_id_fkey(full_name)')
  .eq('status', 'active');

const total = items?.length ?? 0;
const demo = (items ?? []).filter((i) => i.owner?.full_name === demoOwner.fullName).length;

say(
  'витрина',
  total === 0
    ? 'пусто — человек по ссылке увидит «пока ничего нет»'
    : `${total} ${plural(total, 'объявление', 'объявления', 'объявлений')}, из них демонстрационных ${demo}`,
  // Тревога не в том, что демо есть, а в том, что кроме них ничего нет:
  // реклама приведёт человека к вещам, которые никто не отдаст. README
  // держит это открытым вопросом организатора.
  total > 0 && demo === total,
);

// Признак «демо» держится на имени — проверяем, что имя ещё то.
//
// Демо-владелец заводится по телефону (scripts/demo-listings.mjs), а
// помечается по имени: приложение видит full_name с каждой карточкой, а
// телефон закрыт грантом на колонки и до него не доходит. Пока имя в
// базе совпадает с shared/demo-owner.json, всё работает.
//
// Разойдись они — и никто не заметит. Значка «ДЕМО» на карточках не
// станет, блок «подтверждать бронь некому» на экране вещи исчезнет, а
// строка витрины выше насчитает ноль демонстрационных и промолчит:
// тревога «кроме демо ничего нет» гаснет ровно тогда, когда демо
// перестают быть видимыми. Витрина снова начнёт обещать людям вещи,
// которые никто не отдаст, — то самое, из-за чего файл и появился.
//
// Сверяем по телефону, потому что именно он неизменен: имя человек
// правит из профиля в два касания.
const { data: demoAccount } = await admin
  .from('users')
  .select('full_name')
  .eq('phone', demoOwner.phone)
  .maybeSingle();

if (demoAccount && demoAccount.full_name !== demoOwner.fullName) {
  say(
    'признак демо',
    `в базе «${demoAccount.full_name}», в файле «${demoOwner.fullName}»`,
    true,
  );
} else if (!demoAccount && demo > 0) {
  // Объявления считаются демонстрационными, а владельца с таким
  // телефоном нет: значит имя совпало случайно, и признак держится ни
  // на чём.
  say('признак демо', `аккаунта ${demoOwner.phone} нет, а метки стоят`, true);
}

// Живые объявления — отдельной строкой, а не вычитанием в уме.
//
// Строка витрины отвечает на вопрос организатора «чем наполнено», и
// демонстрационные там названы, чтобы никого не вводить в заблуждение.
// Но главное событие пилота — не наполнение, а первый человек, который
// вынес свою вещь на общую витрину. В строке «9 объявлений, из них
// демонстрационных 8» оно спрятано за вычитанием, и 05.09.2026 первую
// живую вещь заметили случайно, читая базу напрямую.
//
// Второе, что здесь названо, — ориентир. Он необязателен, и это верно:
// у части владельцев вещь лежит там, где ориентира нет. Но арендатор
// смотрит на него одним из первых («через дорогу» против «через весь
// город»), а пропустить шаг предлагает кнопка в /сдать. Первое живое
// объявление платформы вышло без ориентира и провисело так сутки.
//
// Тревога — только на отсутствие ориентира, и только когда живые
// объявления есть. Их отсутствие тревогой уже названо строкой выше:
// две тревоги об одном учат не читать обе.
const live = (items ?? []).filter((i) => i.owner?.full_name !== demoOwner.fullName);
const noArea = live.filter((i) => !i.pickup_area);

if (live.length > 0) {
  // Возраст самого свежего: «появилось сегодня» и «висит третью неделю» —
  // разные новости, а число объявлений у обеих одинаковое.
  const newest = live
    .map((i) => new Date(i.created_at).getTime())
    .sort((a, b) => b - a)[0];
  const hours = Math.round((Date.now() - newest) / 3600000);
  const fresh =
    hours < 1
      ? 'последнее — только что'
      : hours < 24
        ? `последнее — ${hours} ч назад`
        : `последнему — ${Math.round(hours / 24)} ${plural(Math.round(hours / 24), 'день', 'дня', 'дней')}`;

  say(
    'живые объявления',
    `${live.length} от участников, ${fresh}` +
      (noArea.length ? `; без ориентира ${noArea.length}` : ''),
    noArea.length > 0,
  );
}

// Картинки витрины.
//
// Ссылка на фото лежит в строке объявления, а сам файл — в Storage, и это
// две разные вещи. Файл можно удалить, бакет — сделать приватным, политику
// — переписать: строка при этом останется, объявление останется, а на
// витрине будет серый прямоугольник.
//
// Молчаливость здесь полная: база отвечает успехом, приложение рисует
// карточку, и только человек видит пустоту вместо инструмента. Проверяем
// первое фото каждого объявления — если не отдаётся оно, остальные тем
// более под вопросом.
const photoChecks = await Promise.all(
  (items ?? []).map(async (item) => {
    const url = item.condition_photos?.[0];
    if (!url) return 'нет ссылки';
    try {
      const res = await fetch(url, { method: 'HEAD' });
      return res.ok ? 'ok' : `${res.status}`;
    } catch {
      return 'сеть';
    }
  }),
);

const brokenPhotos = photoChecks.filter((r) => r !== 'ok').length;

if (total > 0) {
  say(
    'фото на витрине',
    brokenPhotos === 0
      ? `все ${total} отдаются`
      : `${brokenPhotos} из ${total} не открываются (${[...new Set(photoChecks.filter((r) => r !== 'ok'))].join(', ')})`,
    brokenPhotos > 0,
  );
}

// ── Проверки в CI ────────────────────────────────────────────
//
// Появилась после трёх дней красного CI, которого никто не видел.
// Проверка свежести деки падала на каждом прогоне из-за переводов строк
// — на машине CRLF, в репозитории LF, — и сообщала о поломке там, где её
// не было. Локально всё было зелёным, а смотреть на Actions было некому:
// health показывал живое состояние платформы и молчал про то, проходят
// ли собственные проверки.
//
// Это ровно тот случай, о котором написан весь этот файл: тишина и успех
// выглядят одинаково. Здесь тишиной был красный крестик на чужой
// странице.
//
// Токен не нужен: репозиторий публичный, история прогонов открыта. С
// токеном тот же запрос просто не упирается в лимит анонимных обращений.
const ciHeaders = {
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  ...(readGithubToken() ? { Authorization: `Bearer ${readGithubToken()}` } : {}),
};

try {
  const res = await fetch(
    'https://api.github.com/repos/MandalorianCs/renthub/actions/runs?per_page=15',
    { headers: ciHeaders },
  );

  if (!res.ok) {
    say('проверки CI', `GitHub ответил ${res.status} — состояние неизвестно`, false);
  } else {
    const { workflow_runs: allRuns = [] } = await res.json();

    // Берём последний ЗАВЕРШЁННЫЙ прогон каждой работы: идущий сейчас
    // ничего не говорит, а «в процессе» вместо ответа — это та же
    // тишина, ради которой строка и появилась.
    const latest = new Map();
    for (const run of allRuns) {
      if (run.status !== 'completed') continue;
      if (!latest.has(run.name)) latest.set(run.name, run);
    }

    const broken = [...latest.values()].filter((r) => r.conclusion !== 'success');

    if (latest.size === 0) {
      say('проверки CI', 'завершённых прогонов не найдено', false);
    } else if (broken.length === 0) {
      say('проверки CI', `все зелёные (${latest.size})`, false);
    } else {
      say(
        'проверки CI',
        broken.map((r) => `${r.name}: ${r.conclusion}`).join('; '),
        true,
      );
    }
  }
} catch {
  // Нет сети — не повод падать: остальные строки отчёта уже собраны, и
  // человеку полезнее увидеть их, чем сообщение об обрыве.
  say('проверки CI', 'не удалось спросить GitHub', false);
}

// ── Люди ─────────────────────────────────────────────────────
//
// Служебные аккаунты — два тестовых и владелец витрины — верифицированы
// наравне с живыми, и до 04.09.2026 они считались людьми. Получалось «8
// участников» при пяти, а привязка Telegram — «1 из 8» вместо «1 из 5».
// Ошибка удобная: пилот выглядел больше, чем есть. Этим числом меряют
// успех и называют его на питче, так что округлять его в свою пользу —
// худшее, что тут можно сделать.
const { data: verified } = await admin
  .from('users')
  .select('phone, telegram_id')
  .not('verified_at', 'is', null);

const humans = (verified ?? []).filter((u) => !isServiceAccount(u.phone));
const people = humans.length;
const service = (verified ?? []).length - people;

const { count: waiting } = await admin
  .from('join_requests')
  .select('id', { count: 'exact', head: true })
  .is('handled_at', null);

say(
  'участники',
  `${people} ${plural(people, 'живой человек', 'живых человека', 'живых людей')}` +
    (service ? ` (+${service} служебных: тесты и витрина)` : ''),
  false,
);

// Привязка Telegram — не украшение, а условие работы трёх вещей сразу:
// уведомлений о сделках, ответа организатора на обращение и входа по коду
// (вкладка «По SMS» без неё отвечает отказом). Человек без неё пользуется
// половиной продукта и об этом не знает.
//
// 04.09.2026 таких было четверо из пяти — то есть почти все.
const total_people = people;
const withTg = humans.filter((u) => u.telegram_id).length;

say(
  'Telegram привязан',
  total_people === 0 ? 'участников нет' : `${withTg} из ${total_people}`,
  // Тревога, когда привязали меньше половины: главный канал не работает
  // у большинства, и заметить это иначе нечем — жалоб не будет, человек
  // просто не получит уведомление и не узнает, что должен был.
  total_people > 0 && withTg * 2 < total_people,
);

// ── Почта ────────────────────────────────────────────────────
//
// Служебный адрес вида 77010000001@renthub.test заводит invite.mjs из
// номера — человек его не видит и войти по нему не может. Настоящая почта
// — та, которую он привязал сам. Считаем именно её: это число говорит,
// скольким людям вход по письму вообще доступен.
const { data: authUsers } = await admin.auth.admin.listUsers({ perPage: 1000 });
const realEmails = (authUsers?.users ?? []).filter(
  (u) => u.email && !u.email.endsWith('@renthub.test'),
);

say(
  'настоящая почта',
  total_people === 0 ? 'участников нет' : `${realEmails.length} из ${total_people}`,
  false,
);

// Доставку отсюда не проверить — почтового ящика у нас нет. Зато проверяется
// то, что ей предшествует: принимает ли Supabase отправку вообще.
//
// Ответ 200 означает «заявка принята, дальше дело за доставкой»; 429 с
// «email rate limit exceeded» — что исчерпана квота встроенного сервиса.
// Спрашиваем про заведомо несуществующий адрес и с create_user: false:
// такой запрос ничего не создаёт и никому не пишет.
const probe = await fetch(`${url}/auth/v1/otp`, {
  method: 'POST',
  headers: {
    apikey: readEnvFile('EXPO_PUBLIC_SUPABASE_ANON_KEY'),
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({ email: 'health-probe@renthub.invalid', create_user: false }),
});
const probeText = await probe.text();

say(
  'отправка писем',
  probe.status === 422
    ? 'Supabase принимает запросы (провайдер включён)'
    : probeText.includes('email rate limit exceeded')
      ? 'исчерпана квота встроенного сервиса — нужен свой SMTP'
      : `неожиданный ответ ${probe.status}: ${probeText.slice(0, 60)}`,
  probe.status !== 422,
);

// Куда ведёт ссылка из письма — единственная проверка, до которой без
// панели не добраться иначе.
//
// generateLink НЕ отправляет письмо, а возвращает ту самую ссылку. Значит
// по ней видно и Site URL проекта, и то, принят ли запрошенный адрес
// возврата: если его нет в списке Redirect URLs, GoTrue не отказывает, а
// молча подставляет Site URL — и человек уезжает туда, куда мы не просили.
//
// 04.09.2026 обе строки показали http://localhost:3000, то есть Supabase
// стоял с настройками по умолчанию. Письмо при этом доходило: ломался
// следующий шаг, и выглядело это как «почта не работает».
//
// Берём служебный адрес (@renthub.test): его собирает invite.mjs из номера,
// человек им не пользуется, и одноразовый токен, который generateLink
// заодно обновит, ничей вход не сломает.
const serviceUser = (authUsers?.users ?? []).find((u) => u.email?.endsWith('@renthub.test'));

if (serviceUser) {
  const { data: link, error: linkError } = await admin.auth.admin.generateLink({
    type: 'magiclink',
    email: serviceUser.email,
    options: { redirectTo: APP_URL },
  });

  const actual = link?.properties?.action_link
    ? new URL(link.properties.action_link).searchParams.get('redirect_to')
    : null;

  say(
    'ссылка из письма',
    linkError
      ? `не проверить: ${linkError.message}`
      : actual === APP_URL
        ? 'возвращает в приложение'
        : `ведёт на ${actual} — письмо дойдёт, а ссылка в нём никуда`,
    Boolean(linkError) || actual !== APP_URL,
  );
}

// ── Что лежит на публичном адресе ────────────────────────────
//
// Публикуют два процесса сразу — наш workflow и встроенный «pages build and
// deployment». Оба заканчиваются успехом, и на адресе оказывается тот, кто
// финишировал вторым. До 05.09.2026 вопрос «доехала ли правка» решался
// гаданием, а попытка судить по имени бандла обманула меня же: локальная
// сборка и сборка в CI дают разные имена при одном и том же коде.
//
// Отпечаток ставит build-pages.mjs — коммит, из которого собрано. Дальше
// достаточно спросить, знает ли о нём наша история.
try {
  const page = await fetch('https://mandaloriancs.github.io/renthub/app/', {
    cache: 'no-store',
  });
  const published = (await page.text()).match(
    /name="renthub-build" content="([^"]+)"/,
  )?.[1];

  const known = published
    ? execFileSync('git', ['cat-file', '-t', published], { cwd: ROOT, encoding: 'utf8' })
        .trim() === 'commit'
    : false;

  const head = execFileSync('git', ['rev-parse', '--short', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8',
  }).trim();

  const behind = known
    ? execFileSync('git', ['rev-list', '--count', `${published}..HEAD`], {
        cwd: ROOT,
        encoding: 'utf8',
      }).trim()
    : null;

  say(
    'публикация',
    !published
      ? 'отпечатка нет — сайт собран до 05.09.2026, пересоберите'
      : !known
        ? `собрано из ${published}, а такого коммита у нас нет`
        : behind === '0'
          ? `свежая (${head})`
          : `отстаёт на ${behind} ${plural(Number(behind), 'коммит', 'коммита', 'коммитов')} (${published})`,
    !published || !known || behind !== '0',
  );
} catch {
  // Нет сети или нет git — не повод валить весь отчёт: остальные строки
  // уже собраны и полезны сами по себе.
  say('публикация', 'не проверить: нет сети или git недоступен', false);
}

say(
  'заявки на участие',
  waiting ? `${waiting} ждут ответа` : 'очередь пуста',
  // Заявка — человек, который постучался и ждёт. Молчание в ответ он
  // читает как «сюда не пускают».
  (waiting ?? 0) > 0,
);

// ── Вывод ────────────────────────────────────────────────────
const width = Math.max(...rows.map((r) => r.part.length));
const alarms = rows.filter((r) => r.alarm);

console.log('\nЖивое состояние платформы\n');
for (const { part, state, alarm } of rows) {
  console.log(`  ${alarm ? '!' : ' '} ${part.padEnd(width)}  ${state}`);
}

if (alarms.length === 0) {
  console.log('\n✓ Всё, что обещано словами, работает.\n');
} else {
  // Подсказка печатается только к тому, что действительно горит. Раньше
  // печатались все три сразу, и организатору советовали запустить бота,
  // когда бот работает. Совет, не совпадающий с положением дел, учит не
  // читать советы — и однажды не прочтётся нужный.
  const hints = {
    'планировщик': 'README, раздел «Регулярная задача» — задача pg_cron.',
    'доставка уведомлений': 'бот не запущен, поднимите его: npm run bot',
    'бот':
      'он доставляет уведомления и принимает команды в чате. Пока он лежит,\n' +
      '      участники не узнают ни о бронях, ни о возвратах: поднимите\n' +
      '      npm run bot (отдельное окно, свой bot/.env)',
    'витрина':
      'на витрине только демонстрационные вещи. Реклама приведёт человека к тому,\n' +
      '      что никто не отдаст: нужны живые объявления или npm run demo:clear',
    'заявки на участие': 'npm run queue, дальше npm run invite',
    'проверки CI':
      'красный прогон означает, что что-то из проверок не проходит на чистой\n' +
      '      машине — даже если локально всё зелено. Открыть лог: вкладка Actions\n' +
      '      в репозитории, либо npm run check и npm run test:db у себя',
    'признак демо':
      'демонстрационные объявления помечаются по имени владельца, и оно разошлось\n' +
      '      с shared/demo-owner.json. Значка «ДЕМО» на карточках нет, блок\n' +
      '      «подтверждать бронь некому» не показывается: витрина обещает вещи,\n' +
      '      которые никто не отдаст. Верните имя в базе или поправьте файл',
    'живые объявления':
      'у живой вещи не указано, где её забирать, — арендатор не увидит, ехать\n' +
      '      ему через дорогу или через весь город. Владелец добавит сам:\n' +
      '      в чате /вещи → «Добавить ориентир», в приложении — правка объявления',
    'фото на витрине':
      'карточки покажут серые прямоугольники вместо инструмента. Проверьте\n' +
      '      бакет item-photos: публичный ли он и на месте ли файлы. Заново\n' +
      '      залить демонстрационные — npm run demo:photos, затем demo:fill',
    'публикация':
      'на публичном адресе не то, что в main. Публикуют два процесса сразу — наш\n' +
      '      workflow и встроенный «pages build and deployment»; побеждает тот, кто\n' +
      '      финишировал вторым. Чинится один раз, в вебе: Settings → Pages → Build\n' +
      '      and deployment → Source: GitHub Actions',
    'ссылка из письма':
      'Supabase подставляет свой Site URL, письмо доходит — а ссылка в нём\n' +
      '      никуда. Что нажать в панели, печатает npm run auth; он же\n' +
      '      чинит сам (npm run auth -- --apply), если есть токен аккаунта',
    'отправка писем':
      'Supabase отвечает не так, как ожидалось. Проверьте, включён ли провайдер\n' +
      '      Email: Authentication → Sign In / Providers → Email',
    'Telegram привязан':
      'у большинства участников нет привязки — они не получают уведомлений,\n' +
      '      ответов организатора и не могут войти по коду. Кому написать и\n' +
      '      каким текстом, печатает npm run nudge',
  };

  console.log(`\n! Требует внимания\n`);
  for (const { part } of alarms) {
    console.log(`  ${part} — ${hints[part] ?? 'разберитесь по состоянию выше.'}`);
  }
  console.log();
}

/** Склонение — то же правило, что на экранах: «1 объявлений» читается как сбой. */
function plural(n, one, few, many) {
  const two = n % 100;
  const last = n % 10;
  if (two >= 11 && two <= 14) return many;
  if (last === 1) return one;
  if (last >= 2 && last <= 4) return few;
  return many;
}
