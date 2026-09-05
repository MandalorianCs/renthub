#!/usr/bin/env python
"""
Проверка bot/bot.py на переопределения верхнего уровня.

  npm run check:bot

Зачем. Бот — один модуль на 1300 строк, и функции в нём дописываются в
разные места. Второе определение с тем же именем Python принимает молча:
побеждает последнее, а первое перестаёт существовать. Никакой ошибки при
этом нет — ни при запуске, ни при импорте.

Так уже случилось: команда «мои вещи» принесла свой item_line(), который
перекрыл item_line() каталога. Оба вызова ушли в новую функцию, и
/каталог с /найти начали падать на ключе, которого в их данных нет.
Заметить это чтением диффа нельзя — определения разделяют восемьдесят
строк.

Проверка идёт по дереву разбора, а не по тексту: имя внутри функции или
условия — не переопределение, и ругаться на него незачем.

Вторая проверка — про списки, которые бот держит копией правил базы.
Такой список экономит вызов там, где функция заведомо откажет, и это
законно. Незаконно то, что его никто не сверял: 04.09.2026 в
CONTACT_STATUSES было четыре статуса против пяти в booking_contact(), и
комментарий рядом утверждал, что список «повторяет условие внутри»
функции. Цена — владелец, у которого сделка закрылась по таймеру с
невозвращённой вещью, не видел в чате телефона ровно тогда, когда телефон
нужен: база его отдаёт, бот не спрашивал.

Правило, записанное словами, однажды разойдётся с тем, что его держит.
Поэтому теперь оно сверяется.
"""

import ast
import io
import json
import os
import subprocess
import sys
import tempfile
from collections import defaultdict
from pathlib import Path

# Консоль Windows по умолчанию в cp1251 и не берёт даже «✓»: без этой
# строки проверка падала бы на собственном сообщении об успехе.
sys.stdout.reconfigure(encoding="utf-8", errors="replace")

path = Path(__file__).resolve().parent.parent / "bot" / "bot.py"
tree = ast.parse(io.open(path, encoding="utf-8").read(), filename=str(path))

where = defaultdict(list)

for node in tree.body:
    if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
        where[node.name].append(node.lineno)
    elif isinstance(node, ast.Assign):
        for target in node.targets:
            if isinstance(target, ast.Name):
                where[target.id].append(node.lineno)

# Обработчики aiogram намеренно называются по-разному, но декоратор от
# повторов не спасает: имя всё равно живёт в модуле.
clashes = {name: lines for name, lines in where.items() if len(lines) > 1}

failed = False

if clashes:
    failed = True
    print("✗ В bot.py имя определено дважды — победит последнее:\n")
    for name, lines in sorted(clashes.items()):
        print(f"  {name} — строки {', '.join(map(str, lines))}")
    print("\nПереименуйте позднее определение: молчаливое перекрытие ломает")
    print("вызовы, которые рассчитывали на первое.")
else:
    print(f"✓ bot.py: переопределений верхнего уровня нет ({len(where)} имён)")


# ── Списки бота против списков базы ──────────────────────────

import re

ROOT = path.parent.parent
MIGRATIONS = ROOT / "supabase" / "migrations"


def tuple_in_bot(name):
    """Значения кортежа верхнего уровня — из дерева разбора, не регуляркой."""
    for node in tree.body:
        if not isinstance(node, ast.Assign):
            continue
        for target in node.targets:
            if isinstance(target, ast.Name) and target.id == name:
                if isinstance(node.value, (ast.Tuple, ast.List)):
                    return {
                        el.value
                        for el in node.value.elts
                        if isinstance(el, ast.Constant)
                    }
    return None


def latest_sql(function, pattern):
    """
    Последняя миграция, где у нужной ФУНКЦИИ встретился образец.

    Именно последняя: create or replace означает, что правило могли
    переписать, и сверяться надо с тем, что доедет до базы.

    И именно у нужной функции. Первая версия искала образец по всему файлу
    и нашла `v_b.status not in (...)` внутри booking_cancel() — там условие
    другое и означает другое. «Первая похожая строка» здесь значит «не та»,
    и ошибка выглядела бы как настоящее расхождение.
    """
    body = re.compile(
        r"create (?:or replace )?function\s+" + re.escape(function) + r"\s*\(.*?\$\$;",
        re.S,
    )
    found = None
    for file in sorted(MIGRATIONS.glob("*.sql")):
        text = io.open(file, encoding="utf-8").read()
        for fn in body.finditer(text):
            for m in re.finditer(pattern, fn.group(0)):
                found = (file.name, m)
    return found


# ── Правило про телефоны: три языка, одно поведение ──────────
#
# «8 705…» и «+7 705…» — один и тот же номер. Правило живёт в трёх местах,
# и свести их нельзя: Python в боте, TypeScript в приложении, JavaScript в
# скриптах. Раньше их держал в согласии комментарий со списком копий — и он
# уже отстал: moderator.mjs появился позже и в список не попал.
#
# Сверяем не текст, а поведение: вырезаем функцию, запускаем на одних и тех
# же номерах, сравниваем ответы. Текст разойдётся законно — стиль языков
# разный; ответы разойтись не имеют права.
#
# Случаи не случайны. «87011234567» и «+77011234567» — та самая пара, ради
# которой правило существует. «+79261432701» — живой российский номер из
# базы: он тоже одиннадцать цифр с семёркой, и обойтись с ним надо так же.
# «7701123456» короче на цифру, «» пустая — здесь важно не что вернётся, а
# что все три вернут одно.
PHONE_CASES = [
    "+77011234567",
    "87011234567",
    "8 701 123 45 67",
    "+7 (701) 123-45-67",
    "77011234567",
    "+79261432701",
    "7701123456",
    "",
]


def cut_function(path, first_line, keep_last):
    """
    Текст функции: от сигнатуры до первой строки, начинающейся с края.

    В Python эта строка — уже следующее определение, её брать нельзя. В
    JavaScript это закрывающая «}» самой функции, и без неё код не соберётся.
    Отсюда keep_last, а не общее правило: языки заканчивают функцию
    по-разному.
    """
    lines = io.open(path, encoding="utf-8").read().splitlines()
    start = next((i for i, l in enumerate(lines) if l.startswith(first_line)), None)
    if start is None:
        return None
    out = [lines[start]]
    for line in lines[start + 1:]:
        if line and not line[0].isspace():
            if keep_last:
                out.append(line)
            break
        out.append(line)
    return "\n".join(out)


def phone_answers_python():
    src = cut_function(ROOT / "bot" / "bot.py", "def normalize_phone", False)
    if src is None:
        return None
    space = {"re": re}
    exec(src, space)
    return [space["normalize_phone"](c) for c in PHONE_CASES]


def phone_answers_js(path, first_line, name):
    src = cut_function(path, first_line, True)
    if src is None:
        return None
    # Срезаем аннотации типов: функция чистая, и после этого TypeScript
    # становится обычным JavaScript, который node выполнит как есть.
    src = re.sub(r"(\w+):\s*string", r"\1", src).replace("): string {", ") {")
    src = src.replace("export function", "function")

    probe = tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False, encoding="utf-8")
    probe.write(src + "\n")
    probe.write(f"console.log(JSON.stringify({json.dumps(PHONE_CASES)}.map({name})));\n")
    probe.close()
    try:
        out = subprocess.run(
            ["node", probe.name], capture_output=True, text=True, encoding="utf-8"
        )
        return json.loads(out.stdout) if out.returncode == 0 else None
    finally:
        os.unlink(probe.name)


RULES = {
    "bot/bot.py": phone_answers_python(),
    "scripts/phone.mjs": phone_answers_js(
        ROOT / "scripts" / "phone.mjs", "export function normalizePhone", "normalizePhone"
    ),
    "src/lib/auth.tsx": phone_answers_js(
        ROOT / "src" / "lib" / "auth.tsx", "export function normalizePhone", "normalizePhone"
    ),
}

lost = [where for where, answers in RULES.items() if answers is None]
if lost:
    failed = True
    print(f"\n✗ Правило про телефоны не прочитать: {', '.join(lost)}.")
    print("  Переименовали функцию или переписали её — почините образец здесь.")
else:
    unique = {tuple(a) for a in RULES.values()}
    if len(unique) > 1:
        failed = True
        print("\n✗ Правило про телефоны разошлось между языками:")
        for i, case in enumerate(PHONE_CASES):
            answers = {where: a[i] for where, a in RULES.items()}
            if len(set(answers.values())) > 1:
                print(f"  «{case or 'пусто'}»:")
                for where, got in answers.items():
                    print(f"    {where:20} → {got}")
        print("  Человек с верным номером не найдёт свой аккаунт, и причину")
        print("  будут искать в Telegram, где её нет.")
    else:
        print(f"✓ normalize_phone одинаков в трёх языках ({len(PHONE_CASES)} номеров)")


# ── «За вами ход» и кнопка, которой можно ходить ─────────────
#
# shared/next-move.json говорит, ждут ли чего-то от человека. ACTIONS в
# боте говорит, какие кнопки ему показать. Первое читают оба клиента,
# второе — только бот, и разойтись они могут молча.
#
# Цена расхождения несимметрична. Лишняя кнопка дыры не откроет: база
# откажет теми же проверками. А вот «за вами ход» без кнопки — это
# сообщение, которое нечем выполнить: человек в чате не видит экрана и
# ищет действие там, где его нет.
#
# Три состояния исключены осознанно, и это не «пока не сделали»:
#
#   completed/owner, completed/renter — кнопки есть, но собираются отдельной
#   веткой в action_keyboard: оценка это пять звёзд в ряд, а не одна кнопка,
#   и в таблицу ACTIONS такое не ложится.
#
#   active/renter — «Верните вовремя». Действие происходит в реальном мире:
#   человек везёт вещь владельцу. Кнопке здесь взяться неоткуда, и её
#   отсутствие — не дефект, а честность.
MOVES_WITHOUT_BUTTON = {
    ("completed", "owner"): "оценка собирается отдельной веткой (пять звёзд)",
    ("completed", "renter"): "оценка собирается отдельной веткой (пять звёзд)",
    ("active", "renter"): "«верните вовремя» — действие в реальном мире, не в чате",
}


def actions_table():
    """ACTIONS из дерева разбора: literal_eval вместо импорта модуля."""
    for node in tree.body:
        target = None
        if isinstance(node, ast.AnnAssign):
            target = getattr(node.target, "id", "")
        elif isinstance(node, ast.Assign):
            target = next((getattr(t, "id", "") for t in node.targets), "")
        if target == "ACTIONS":
            try:
                return ast.literal_eval(node.value)
            except ValueError:
                return None
    return None


actions = actions_table()
moves_path = ROOT / "shared" / "next-move.json"

if actions is None or not moves_path.exists():
    failed = True
    print("\n✗ Не с чем сверить ходы: ACTIONS или shared/next-move.json не читаются.")
else:
    moves = json.loads(io.open(moves_path, encoding="utf-8").read())
    silent = []
    for status, roles in moves.items():
        if status.startswith("_"):
            continue
        for role, move in roles.items():
            if not isinstance(move, dict) or not move.get("yours"):
                continue
            if (status, role) in MOVES_WITHOUT_BUTTON:
                continue
            if (status, role == "owner") not in actions:
                silent.append(f"{status}/{role} — «{move.get('title', '?')}»")

    if silent:
        failed = True
        print("\n✗ Бот скажет «за вами ход», а кнопки не даст:")
        for line in silent:
            print(f"  {line}")
        print("  Добавьте действие в ACTIONS — либо объясните исключение в")
        print("  MOVES_WITHOUT_BUTTON, если ходить надо не в чате.")
    else:
        print(
            f"✓ каждому «за вами ход» есть чем ответить "
            f"({len(actions)} действий, {len(MOVES_WITHOUT_BUTTON)} исключения)"
        )


# ── Модуль должен загружаться, а не только разбираться ───────
#
# `ast.parse` выше ловит синтаксис и повторные имена. Импорт ловит другое:
# забытый `import`, ошибку в коде верхнего уровня — сборке клавиатур,
# словарей, декораторов aiogram. Всё это разбирается прекрасно и падает
# при первом запуске бота.
#
# Чего он НЕ ловит: опечатку внутри функции. `await ask_lnk(message)` в
# теле обработчика переживёт и разбор, и импорт, и упадёт у человека в
# чате. Для этого нужен запуск сценария, а не загрузка модуля.
#
# Импорт выполняет модуль целиком: все определения, декораторы aiogram,
# сборку клавиатур. Сетевых запросов при этом нет — polling начинается
# в main(), под `if __name__ == "__main__"`.
#
# Отсутствие окружения не считается ошибкой: bot.py останавливается сам,
# когда не находит токена, и это правильное поведение, а не поломка.
def module_loads():
    import importlib.util

    spec = importlib.util.spec_from_file_location("renthub_bot", ROOT / "bot" / "bot.py")
    module = importlib.util.module_from_spec(spec)
    try:
        spec.loader.exec_module(module)
        return module, None
    except SystemExit:
        return None, "нет окружения"
    except ModuleNotFoundError as error:
        # Нет aiogram или httpx — значит проверку запускают там, где бота не
        # ставили: в CI, на чужой машине. Это не поломка кода, и валить сборку
        # из-за неё нельзя. Настоящие ошибки импорта ловит ветка ниже.
        return None, f"нет зависимостей бота ({error.name})"
    except Exception as error:  # noqa: BLE001 — сюда и целимся
        return None, f"{type(error).__name__}: {error}"


loaded, why = module_loads()

if why and why.startswith(("нет окружения", "нет зависимостей")):
    print(f"?  bot.py не загрузить: {why} — проверка пропущена")
elif loaded is None:
    failed = True
    print(f"\n✗ bot.py разбирается, но не загружается: {why}")
    print("  Синтаксис такое пропускает — падает при запуске бота.")
else:
    names = [n for n in ("ask_link", "ask_link_query", "item_url", "humanize") if callable(getattr(loaded, n, None))]
    print(f"✓ bot.py загружается целиком ({len(names)} ключевых функций на месте)")


# ── Ссылка на объявление: два языка, один адрес ──────────────
#
# Правило уже расходилось однажды, и комментарий в боте это признаёт: бот
# писал `app/#/item/<id>`, приложение — `app/item/<id>`, и все ссылки бота
# на вещи вели мимо. Держалось согласие комментарием «обязано совпадать»,
# то есть ничем.
#
# 05.09.2026 адрес сменился на `app/?item=<id>`: путь вида /app/item/<uuid>
# на GitHub Pages отвечает 404, файла с таким именем нет, и мессенджеры на
# 404 не строят превью. Смена — ровно тот момент, когда две копии обычно и
# расходятся: правят одну.
#
# Сверяется поведение, а не текст: вырезаем обе функции с их константами и
# спрашиваем адрес для одного и того же идентификатора.
ITEM_ID = "64a6fde6-1fcd-4d8c-bb41-059dc2086620"


def item_url_python():
    src = cut_function(ROOT / "bot" / "bot.py", "def item_url", False)
    if src is None:
        return None
    text = io.open(ROOT / "bot" / "bot.py", encoding="utf-8").read()
    app_url = re.search(r'APP_URL = "([^"]+)"', text)
    if app_url is None:
        return None
    space = {"APP_URL": app_url.group(1)}
    exec(src, space)
    return space["item_url"](ITEM_ID)


def item_url_ts():
    path = ROOT / "src" / "lib" / "share.ts"
    src = cut_function(path, "export function itemUrl", True)
    if src is None:
        return None
    text = io.open(path, encoding="utf-8").read()
    site = re.search(r"const SITE = '([^']+)'", text)
    if site is None:
        return None

    src = re.sub(r"(\w+):\s*string", r"\1", src).replace("): string {", ") {")
    src = src.replace("export function", "function")

    probe = tempfile.NamedTemporaryFile("w", suffix=".mjs", delete=False, encoding="utf-8")
    probe.write(f"const SITE = {json.dumps(site.group(1))};\n")
    probe.write(src + "\n")
    probe.write(f"console.log(itemUrl({json.dumps(ITEM_ID)}));\n")
    probe.close()
    try:
        out = subprocess.run(["node", probe.name], capture_output=True, text=True, encoding="utf-8")
        return out.stdout.strip() if out.returncode == 0 else None
    finally:
        os.unlink(probe.name)


py_url, ts_url = item_url_python(), item_url_ts()

if py_url is None or ts_url is None:
    failed = True
    print("\n✗ Ссылку на объявление не прочитать: образец больше не находится.")
    print("  Переименовали item_url/itemUrl или переписали — почините образец здесь.")
elif py_url != ts_url:
    failed = True
    print("\n✗ Ссылка на объявление собирается по-разному:")
    print(f"  бот:         {py_url}")
    print(f"  приложение:  {ts_url}")
    print("  Пересланная ссылка откроет не то, что человек показывал.")
else:
    print(f"✓ ссылка на объявление одинакова в двух языках ({py_url.split('/')[-1][:22]}…)")


PAIRS = [
    (
        "CONTACT_STATUSES",
        "booking_contact",
        r"v_b\.status not in \(([^)]*)\)",
        "контакт второй стороны",
    ),
]

for name, function, pattern, what in PAIRS:
    where_sql = function + "()"
    mine = tuple_in_bot(name)
    found = latest_sql(function, pattern)

    if mine is None or found is None:
        failed = True
        print(f"\n✗ Не с чем сверить {name}: образец больше не находится.")
        print("  Правили имя списка или текст функции — почините образец здесь.")
        continue

    file_name, match = found
    theirs = set(re.findall(r"'([a-z_]+)'", match.group(1)))

    if mine != theirs:
        failed = True
        print(f"\n✗ {name} разошёлся с {where_sql} ({what}):")
        print(f"  в боте:  {', '.join(sorted(mine)) or '—'}")
        print(f"  в базе:  {', '.join(sorted(theirs)) or '—'}   ({file_name})")
        only_db = theirs - mine
        only_bot = mine - theirs
        if only_db:
            print(f"  бот не спросит там, где база отдала бы: {', '.join(sorted(only_db))}")
        if only_bot:
            print(f"  бот спросит зря, база откажет: {', '.join(sorted(only_bot))}")
    else:
        print(f"✓ {name} совпадает с {where_sql} ({len(mine)} статусов)")

sys.exit(1 if failed else 0)
