"""
Телеграм-бот RentHUB.

Делает две вещи, которых не может приложение:

1. Привязывает Telegram к аккаунту. Человек нажимает «Поделиться номером»,
   и Telegram отдаёт номер, подтверждённый им самим. Это сильнее SMS-кода:
   код доказывает владение симкой в момент ввода, а Telegram проверил номер
   при регистрации и хранит эту связь.

2. Доставляет уведомления. Таблица notifications заполняется триггерами и
   планировщиком в Postgres; бот забирает записи с пустым sent_at и шлёт их
   в Telegram. Приложение и бот — два окна в одну базу, а не два продукта.

Чего бот НЕ делает и почему.

Он не отправляет сообщение первым тому, кто не начинал с ним диалог: это
запрещено самим Telegram, а не выбором архитектуры. Отсюда порядок: сначала
человек открывает бота, потом ему можно писать.

Он не проверяет правила сделки — ни кто владелец, ни какой статус. Действия
идут через обёртки bot_* : они выставляют auth.uid() и зовут ту же функцию,
что зовёт приложение. Поэтому «подтверждать бронь может только владелец» —
это ответ базы, а не проверка в боте. Скопировать сюда хоть одно правило
означало бы завести второй источник правды, который однажды разойдётся
молча (см. README, раздел про Trust Score).

Он не показывает витрину. Каталог с фото, календарём занятости и формой
публикации в чате получится хуже, чем в приложении, — поэтому здесь только
то, ради чего человека дёргают: сделки и действия по ним.
"""

import asyncio
import datetime
import html
import json
import logging
import os
import re
import secrets
import sys
import time

# Консоль Windows по умолчанию не в UTF-8, и Python выводит в неё русский
# текст с заменами вида ✗ вместо символов. Одна строка снимает весь
# класс проблемы: сообщения бота читаются одинаково в PowerShell и в логах.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import httpx
from aiogram import Bot, Dispatcher, F
from aiogram.exceptions import TelegramForbiddenError
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    CallbackQuery,
    BotCommand,
    BotCommandScopeAllPrivateChats,
    ErrorEvent,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
    InputMediaPhoto,
    KeyboardButton,
    Message,
    ReplyKeyboardMarkup,
    ReplyKeyboardRemove,
)
from dotenv import load_dotenv

BOT_DIR = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(BOT_DIR)

# Три файла вместо одного — чтобы каждое значение лежало ровно в одном месте
# и не переписывалось копированием. bot/.env — только токен Telegram; адрес
# проекта уже есть в корневом .env (его же читает Expo), секретный ключ —
# в .env.secret, откуда его берут и служебные скрипты. Дубли ключа в двух
# файлах опаснее неудобства: однажды поменяют один и будут искать причину
# в третьем.
load_dotenv(os.path.join(BOT_DIR, ".env"))
load_dotenv(os.path.join(ROOT, ".env"))
load_dotenv(os.path.join(ROOT, ".env.secret"))


def required(name: str, where: str, *fallbacks: str) -> str:
    """
    Значение или понятная остановка.

    Питоновский KeyError с именем переменной ничего не говорит человеку,
    который первый раз запускает бота: непонятно ни где искать, ни что
    вписать. Поэтому — своё сообщение с адресом файла и строкой.
    """
    for key in (name, *fallbacks):
        value = os.environ.get(key, "").strip()
        if value:
            return value

    raise SystemExit(
        f"\n✗ Не задано {name}.\n"
        f"  Где: {where}\n"
        f"  Бот без этого значения работать не может — заполните и запустите снова.\n"
    )


BOT_TOKEN = required(
    "TELEGRAM_BOT_TOKEN",
    "bot/.env, строка TELEGRAM_BOT_TOKEN= — токен берётся у @BotFather",
)
SUPABASE_URL = required(
    "SUPABASE_URL",
    "корневой .env, строка EXPO_PUBLIC_SUPABASE_URL=",
    "EXPO_PUBLIC_SUPABASE_URL",
).rstrip("/")
SECRET_KEY = required(
    "SUPABASE_SECRET_KEY",
    ".env.secret в корне проекта, строка SUPABASE_SECRET_KEY=sb_secret_… "
    "(Supabase → Project Settings → API Keys → Secret keys)",
)
POLL_SECONDS = int(os.environ.get("POLL_SECONDS", "15"))

# Город пилота берётся из того же корневого .env, что читает Expo. Значение
# обязано совпадать с дефолтом items.city в базе: разойдутся — объявления
# будут создаваться в одном городе, а искаться в другом, и витрина окажется
# пустой при полной базе.
PILOT_CITY = os.environ.get("EXPO_PUBLIC_PILOT_CITY", "kokshetau").strip() or "kokshetau"

# Потолок цены за сутки — тот же миллион, что стоит ограничением
# `items_daily_price_max` в базе и проверкой в `assert_item_price()`.
#
# Константа потерялась при появлении: 03.09.2026 в `on_item_price` добавили
# `if price > MAX_DAILY_PRICE`, а само значение не объявили. Два дня шаг
# цены в `/сдать` падал с NameError, и человек видел «Не получилось
# связаться с сервером» — сообщение о сети там, где сети ничего не мешало.
#
# Нашлось только когда участник дошёл до этого шага и прислал скриншот.
# Ни разбор дерева, ни импорт модуля такого не ловят: имя внутри функции
# проверяется в момент вызова. Теперь ловит `npm run check:bot`.
MAX_DAILY_PRICE = 1_000_000

APP_URL = "https://mandaloriancs.github.io/renthub/app/"


def item_url(item_id: str) -> str:
    """
    Ссылка на объявление.

    Собирается здесь одним местом, потому что раньше собиралась двумя — и
    обе были неверны. Бот писал `app/#/item/<id>`, приложение в
    src/lib/share.ts — `app/item/<id>`. Маршрутизация у приложения по пути,
    а не по хэшу: адрес с решёткой открывает каталог, и все ссылки бота на
    вещи вели мимо. Проверено на живом сайте.

    Правило обязано совпадать с itemUrl() в src/lib/share.ts. Общего кода у
    Python и TypeScript тут нет, поэтому связь держится комментарием — но
    сама строка теперь одна на весь модуль.
    """
    # Через параметр, а не через путь. /app/item/<id> на GitHub Pages
    # отвечает 404: файла с таким именем нет, страницу спасает 404.html.
    # Человек этого не видит, а краулер мессенджера видит и превью не
    # строит — ссылка приходит в чат голым адресом. Адрес с параметром
    # существует и отвечает 200; каталог читает `item` и открывает
    # карточку сам.
    return f"{APP_URL}?item={item_id}"

REST = f"{SUPABASE_URL}/rest/v1"
HEADERS = {
    "apikey": SECRET_KEY,
    "Authorization": f"Bearer {SECRET_KEY}",
    "Content-Type": "application/json",
}

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# httpx пишет строку на каждый запрос, а бот опрашивает базу раз в 15 секунд —
# это 240 строк в час о том, что ничего не произошло. В таком потоке
# теряется единственное, ради чего в лог вообще смотрят: привязка человека,
# доставленное уведомление, ошибка. Ошибки самого httpx остаются видны.
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("aiogram.event").setLevel(logging.WARNING)

log = logging.getLogger("renthub-bot")

# Хранилище состояний в памяти: единственный диалог в несколько шагов —
# претензия по порче, и он живёт минуты. При перезапуске бота недособранная
# претензия потеряется, и это правильнее, чем поднимать ради неё Redis:
# человек начнёт заново, а не отправит фото в пустоту.
dp = Dispatcher(storage=MemoryStorage())


class Damage(StatesGroup):
    """Шаги претензии: сначала фото «после», потом сумма ущерба."""

    photos = State()
    amount = State()


class Support(StatesGroup):
    """
    Обращение к организатору.

    Два шага, а не один: записывать в очередь всё подряд, что человек
    напишет боту, значит наполнить её опечатками и «спасибо». Кнопка —
    осознанное «да, это вопрос», и только следующее сообщение уходит
    модератору.
    """

    waiting = State()


class JoinNote(StatesGroup):
    """
    Вопрос от того, у кого аккаунта ещё нет.

    Отдельно от Support, потому что дверь другая. Support пишет в
    support_messages и требует user_id — у заявителя его нет и не будет
    до приглашения. Здесь текст уходит в join_requests.note, то есть
    в ту же строку очереди модерации, где организатор и так видит
    номер и имя.

    Зачем это вообще. С клиентского сайта на бота ведёт строка «Вопрос
    организатору», и приходит по ней ровно тот, у кого аккаунта нет, —
    человек с рекламы. До этой правки он получал «Сначала свяжите
    Telegram», проходил заявку и оставался с вопросом, который никто
    не услышал: спросить было негде, а ответить некому и не на что.
    """

    waiting = State()


class NewPrice(StatesGroup):
    """
    Смена цены — единственный шаг, и это осознанно.

    Правка объявления целиком в чате упирается в то, что человеку надо
    показать все текущие значения и дать выбрать, какое менять, — это уже
    экран, а не диалог. Цена другая: её правят чаще всего остального
    вместе взятого, текущее значение помещается в одну строку, а новое —
    это одно число.
    """

    waiting = State()


class NewPickup(StatesGroup):
    """
    Смена ориентира «где забирать» — второе исключение рядом с ценой.

    Аргумент против правки объявления из чата записан в NewPrice: показать
    все значения и дать выбрать, какое менять, — это уже экран. Для
    описания и фото он верен. Для ориентира — нет, по тем же признакам,
    что и у цены: текущее значение в одну строку, новое — один ответ.

    Признак, которого нет у цены: шаг «где забирать» в публикации можно
    ПРОПУСТИТЬ, и кнопку «Пропустить» предлагаем мы сами. Первое живое
    объявление платформы вышло на витрину без ориентира — рядом с восемью
    демонстрационными, у которых он есть. Дверь, которую мы открыли,
    обязана открываться в обе стороны.
    """

    waiting = State()


class NewItem(StatesGroup):
    """
    Шаги публикации.

    Пять вопросов подряд — много для чата, и короче не выходит: без цены,
    депозита и фото объявление либо не создастся, либо будет бесполезным.
    Зато владелец, который сдаёт вторую однотипную вещь, не открывает
    приложение вовсе, а он и есть основной сценарий пилота.

    Шестой шаг — ориентир — единственный необязательный, и поэтому у него
    есть кнопка «Пропустить». Без неё он стоил бы всем лишнего сообщения
    ради поля, которое части владельцев нечем заполнить.
    """

    category = State()
    title = State()
    price = State()
    deposit = State()
    pickup = State()
    photos = State()


MONTHS_RU = (
    "января", "февраля", "марта", "апреля", "мая", "июня",
    "июля", "августа", "сентября", "октября", "ноября", "декабря",
)


def human_date(iso: str | None) -> str:
    """
    «2026-09-12» → «12 сентября».

    База отдаёт даты в ISO, и до 05.09.2026 бот показывал их как есть.
    Машине так удобнее, человеку — нет: в списке сделок «2026-09-12 →
    2026-09-15» читается как строка кода, а не как «с двенадцатого по
    пятнадцатое».

    Год не пишем, пока он текущий: «12 сентября 2026» в сентябре 2026-го
    добавляет четыре знака и ноль смысла. В декабре про март следующего
    года год появится сам.

    Неразобранное возвращаем как есть: показать сырую строку лучше, чем
    уронить сообщение из-за формата, которого мы не ждали.
    """
    if not iso:
        return "—"
    try:
        d = datetime.date.fromisoformat(str(iso)[:10])
    except ValueError:
        return str(iso)

    today = datetime.date.today()
    tail = "" if d.year == today.year else f" {d.year}"
    return f"{d.day} {MONTHS_RU[d.month - 1]}{tail}"


def normalize_phone(raw: str) -> str:
    """
    Казахстанские номера: 8 705… и +7 705… — один и тот же номер.

    Правило продублировано в scripts/invite.mjs и src/lib/auth.tsx и обязано
    совпадать. Разойдётся — человек с верным номером не найдёт свой аккаунт,
    а причину будут искать в Telegram.
    """
    digits = re.sub(r"\D", "", raw)
    if digits.startswith("8") and len(digits) == 11:
        return "+7" + digits[1:]
    if digits.startswith("7") and len(digits) == 11:
        return "+" + digits
    return "+" + digits


async def rest_get(client: httpx.AsyncClient, path: str, params: dict) -> list[dict]:
    response = await client.get(f"{REST}/{path}", params=params, headers=HEADERS)
    response.raise_for_status()
    return response.json()


async def rest_patch(client: httpx.AsyncClient, path: str, params: dict, body: dict) -> None:
    response = await client.patch(f"{REST}/{path}", params=params, headers=HEADERS, json=body)
    response.raise_for_status()


class RentHubError(Exception):
    """Отказ базы, уже переведённый на человеческий язык."""


# Часть запретов — это ограничения самого Postgres, и текст у них английский
# и технический. «conflicting key value violates exclusion constraint» не
# говорит человеку ничего, хотя означает всего лишь «даты уже заняты».
# Список повторяет humanizeError в src/lib/supabase.ts: один и тот же отказ
# обязан звучать одинаково в приложении и в чате.
CONSTRAINT_MESSAGES = (
    ("bookings_no_overlap", "Эти даты уже заняты — выберите другие"),
    ("reviews_booking_id_from_user_id_key", "Вы уже оставили отзыв по этой сделке"),
    ("disputes_booking_id_type_key", "Претензия по этой сделке уже подана"),
    ("items_photos_count", "Нужно от одного до шести фото вещи"),
    ("items_pickup_area_check", "Ориентир: от 2 до 80 символов, или пропустите шаг"),
    # Эти два ограничения бот мог получить с первого дня публикации из чата,
    # а перевода у них не было: человек, назвавший вещь двумя буквами,
    # доходил до последнего шага и читал «Не получилось. Попробуйте ещё раз».
    # Измерено 03.09.2026 на стенде — база отвечает ровно
    # «violates check constraint "items_title_check"».
    ("items_title_check", "Название — минимум 3 символа"),
    ("items_daily_price_check", "Цена должна быть больше нуля"),
    ("items_daily_price_max",
     "Цена за сутки больше миллиона — проверьте, нет ли лишнего нуля"),
    # Обращение длиннее двух тысяч знаков. В приложении это ограничение
    # недостижимо — поле там обрезает ввод, — а в чате достижимо: Telegram
    # пропускает сообщение вчетверо длиннее, и человек, подробно
    # описавший беду, читал «Не получилось, попробуйте ещё раз».
    ("support_messages_text_check",
     "Слишком длинно: помещается 2000 знаков. Оставьте главное — остальное "
     "расскажете организатору в переписке"),
    # Шесть ограничений, найденных 05.09.2026 сверкой pg_constraint с этой
    # таблицей. В базе их семнадцать, переведено было шесть — остальные
    # доходили до человека строкой вида
    # `violates check constraint "bookings_check1"`.
    #
    # Первое из них человек встретит наверняка: попробовать снять СВОЮ вещь
    # — обычное любопытство, и до сих пор ответом на него была латиница.
    ("bookings_check1", "Свою вещь забронировать нельзя — она и так ваша"),
    ("bookings_check", "Конец аренды не может быть раньше начала"),
    ("bookings_days_check", "Аренда — минимум на сутки"),
    ("items_deposit_amount_check", "Депозит не может быть отрицательным"),
    ("disputes_claim_amount_check", "Сумма ущерба не может быть отрицательной"),
    # Вопрос в заявке на участие: его пишут прямо в чат, где длину никто
    # не ограничивает.
    ("join_requests_note_check", "Вопрос — от 2 до 300 знаков"),
    ("reviews_rating_check", "Оценка — от одной до пяти звёзд"),
    # Уникальность: номер или этот Telegram уже за кем-то числятся.
    # В боте это достижимо на привязке — там, где человек как раз и
    # нажимает «Поделиться номером».
    ("users_phone_key", "Этот номер уже привязан к другому аккаунту"),
    ("users_telegram_id_key",
     "Этот Telegram уже привязан к другому аккаунту. Отвязать — /unlink"),
)

# Отказы вида «RENTHUB_CODE» без русского хвоста. Их пять на всю базу, и до
# 03.09.2026 приложение показывало их человеку заглавной латиницей — теперь
# у него есть эта же карта (humanizeError в src/lib/supabase.ts).
#
# Боту она нужна по той же причине, по которой рядом лежит CONSTRAINT_MESSAGES:
# один и тот же отказ обязан звучать одинаково в приложении и в чате. Без неё
# устаревшая кнопка «Закрыть сделку» отвечала в чат «Не получилось. Попробуйте
# ещё раз» — а на том же отказе экран говорил «Это действие доступно другой
# стороне сделки».
BARE_CODE_MESSAGES = {
    "RENTHUB_FORBIDDEN": "Это действие доступно другой стороне сделки",
    "RENTHUB_ITEM_NOT_FOUND": "Объявление больше не существует",
    "RENTHUB_BOOKING_NOT_FOUND": "Сделка не найдена — откройте /deals заново",
    "RENTHUB_DISPUTE_NOT_FOUND": "Спор не найден — возможно, его уже разобрали",
}


def humanize(response: httpx.Response) -> str:
    try:
        raw = (response.json() or {}).get("message") or response.text
    except ValueError:
        raw = response.text

    for needle, text in CONSTRAINT_MESSAGES:
        if needle in raw:
            return text

    # Свои отказы приходят как «RENTHUB_FORBIDDEN: подтверждать бронь может
    # только владелец» — хвост уже написан для человека, его и показываем.
    match = re.search(r"RENTHUB_[A-Z_]+:\s*(.+)", raw)
    if match:
        return match.group(1).strip()

    # Хвоста нет — значит отказ бросили одним кодом. Показывать его нельзя:
    # заглавная латиница читается человеком как поломка, причём без подсказки,
    # что делать.
    bare = re.search(r"RENTHUB_[A-Z_]+", raw)
    if bare and bare.group(0) in BARE_CODE_MESSAGES:
        return BARE_CODE_MESSAGES[bare.group(0)]

    log.warning("непереведённый отказ базы: %s", raw[:300])
    return "Не получилось. Попробуйте ещё раз или откройте приложение."


async def rest_rpc(client: httpx.AsyncClient, fn: str, body: dict):
    """
    Вызов функции Postgres — единственный способ, которым бот меняет данные.

    Обёртки bot_* выставляют auth.uid() и зовут ту же функцию, что зовёт
    приложение. Поэтому бот не проверяет ни владельца, ни статус сделки — он
    их не знает и знать не должен. Отказ приходит текстом самой функции.
    """
    response = await client.post(f"{REST}/rpc/{fn}", headers=HEADERS, json=body)
    if response.status_code >= 400:
        raise RentHubError(humanize(response))
    return response.json() if response.content else None


# Тот же bucket и тот же вид пути, что у приложения: <user_id>/<файл>.
# Это не косметика — политика item_photos_write разрешает человеку писать
# только в свою папку, а item_photos_delete по ней же даёт удалять. Положи
# бот файл в свою папку или в корень, владелец не смог бы удалить снимок
# собственной вещи.
STORAGE = f"{SUPABASE_URL}/storage/v1"
PHOTO_BUCKET = "item-photos"


async def upload_photo(client: httpx.AsyncClient, user_id: str, data: bytes) -> str:
    """
    Фото из Telegram в хранилище проекта. Возвращает публичный адрес.

    Telegram отдаёт снимки перекодированными в JPEG, поэтому расширение
    здесь одно и угадывать тип не из чего — в отличие от приложения, куда
    файл приходит из галереи как есть.
    """
    name = f"{user_id}/{int(time.time() * 1000)}-{secrets.token_hex(3)}.jpg"
    response = await client.post(
        f"{STORAGE}/object/{PHOTO_BUCKET}/{name}",
        headers={**HEADERS, "Content-Type": "image/jpeg"},
        content=data,
    )
    if response.status_code >= 400:
        raise RentHubError(humanize(response))

    return f"{STORAGE}/object/public/{PHOTO_BUCKET}/{name}"


async def user_by_telegram(client: httpx.AsyncClient, telegram_id: int) -> dict | None:
    found = await rest_get(
        client,
        "users",
        {"telegram_id": f"eq.{telegram_id}", "select": "id,full_name", "limit": "1"},
    )
    return found[0] if found else None


# ── Чей ход ───────────────────────────────────────────────────
#
# Таблица лежит в shared/next-move.json и читается ещё и приложением
# (src/lib/nextMove.ts). Переписать её здесь по-питоновски значило бы
# завести второй источник правды о том, ждут ли чего-то от человека, —
# и он разошёлся бы с приложением на первой же правке текста.

# Справочник инструмента — тот же приём и по той же причине: список читают
# и форма публикации в приложении, и шаг названия здесь. Один файл на оба
# входа, иначе в чате и на экране предлагались бы разные вещи.
with open(os.path.join(ROOT, "shared", "tools.json"), encoding="utf-8") as _f:
    TOOLS = json.load(_f)

# Кто владеет демонстрационными объявлениями — тот же файл, что читают
# приложение и scripts/demo-listings.mjs.
#
# До 05.09.2026 бот про них не знал вовсе. Приложение ставило на карточку
# значок «ДЕМО» и объясняло полосой, что витрина показательная, а в чате те
# же восемь объявлений выглядели живым рынком. Человек, пришедший по ссылке
# в Telegram, видел восемь вещей, писал владельцу — и упирался в тишину,
# потому что владельца нет.
#
# Расхождение между окнами в одну базу опаснее отсутствия любого из них:
# одно окно показывает правду, второе — нет, и человек верит тому, которое
# увидел первым.
with open(os.path.join(ROOT, "shared", "demo-owner.json"), encoding="utf-8") as _f:
    DEMO_OWNER_NAME = json.load(_f)["fullName"]


def is_demo(row: dict) -> bool:
    """Объявление демонстрационной витрины — по владельцу, как в приложении."""
    return ((row.get("owner") or {}).get("full_name")) == DEMO_OWNER_NAME


def tool_example(slug: str) -> str:
    """Пример названия для категории — тот же, что в placeholder приложения."""
    cat = TOOLS["categories"].get(slug)
    return cat["example"] if cat else "Перфоратор Bosch GBH 2-26"


def _fold(text: str) -> str:
    """Регистр и «ё» не должны мешать найти вещь. Повторяет fold() в tools.ts."""
    return text.lower().replace("ё", "е").strip()


def brand_spellings(query: str) -> list[str]:
    """
    Как ещё может быть написана та же марка.

    Подсказки при публикации кладут в название латиницу — «Перфоратор
    Bosch», — а ищут её кириллицей: «бош». Без перевода поиск в чате
    находил бы не то же, что поиск на экране, хотя витрина одна.

    Повторяет brandSpellings() из src/lib/tools.ts. Общего кода у Python и
    TypeScript нет, но справочник у них общий — расходятся только эти
    двадцать строк.
    """
    q = _fold(query)
    if len(q) < 2:
        return []

    out: list[str] = []
    for brand, aliases in TOOLS["brandAliases"].items():
        forms = [brand, *aliases]
        if any(_fold(f).startswith(q) for f in forms):
            out.extend(forms)

    return [f for f in out if f != query.strip()]


def tool_popular(slug: str, limit: int = 4) -> list[str]:
    """
    С чего чаще всего начинают в этой категории.

    В чате нет живого поиска по мере набора, как в форме приложения:
    inline-режим — это отдельный механизм и отдельная настройка у бота.
    Поэтому здесь показывается короткий список готовых названий кнопками —
    он закрывает частый случай и не заставляет ничего печатать.
    """
    cat = TOOLS["categories"].get(slug)
    return list(cat["popular"][:limit]) if cat else []


with open(os.path.join(ROOT, "shared", "next-move.json"), encoding="utf-8") as _f:
    NEXT_MOVE = json.load(_f)


def next_move(status: str, is_owner: bool) -> dict:
    return (NEXT_MOVE.get(status) or {}).get("owner" if is_owner else "renter") or {}


# ── Действия ──────────────────────────────────────────────────
#
# Ключ — статус сделки и «вы владелец». Значение — кнопки, ровно те же, что
# доступны на экране сделки. Лишняя кнопка дыры не откроет: база откажет
# теми же проверками. Но она обманет ожидание, а в чате это дороже — человек
# не видит экрана и верит кнопке.

ACTIONS: dict[tuple[str, bool], tuple[tuple[str, str], ...]] = {
    ("pending", True): (("✅ Подтвердить бронь", "confirm"),),
    ("pending", False): (("✖️ Отменить заявку", "cancel"),),
    # Отмена подтверждённой — у обеих сторон: встреча срывается, и без
    # кнопки такая бронь висела бы, держа даты занятыми. Владельцу кнопка
    # нужна отдельной строкой — у него в confirmed своего действия нет.
    ("confirmed", False): (
        ("📦 Забрал вещь", "picked_up"),
        ("✖️ Отказаться", "cancel"),
    ),
    ("confirmed", True): (("✖️ Отменить бронь", "cancel"),),
    ("active", True): (("📥 Принял вещь обратно", "returned"),),
    # Тот же ход и в disputed — потому что disputed бывает двух видов.
    #
    # Автоспор о невозврате открывает планировщик, когда истёк запас
    # времени после срока: вещь ещё у арендатора. Когда её привозят,
    # владелец обязан суметь отметить возврат — иначе выхода из спора
    # нет вовсе. На экране сделки эта кнопка была с самого начала, в
    # чате — нет, и владелец в пассивном режиме, ради которого бот и
    # сделан, оставался в чате без единственного нужного действия.
    #
    # Второй вид disputed — разбор порчи: вещь давно вернулась. Там
    # кнопка не нужна и теперь отклоняется базой
    # (20260904100000_return_only_from_non_return). Отказ придёт её
    # текстом: «вещь уже возвращена, идёт разбор претензии».
    #
    # Различить два вида по строке сделки бот не может — тип спора в
    # неё не приходит. Показать кнопку, которую база иногда отклонит,
    # здесь честнее, чем не показать ту, без которой человек застревает:
    # первое стоит одного понятного отказа, второе — застрявшей сделки.
    ("disputed", True): (("📥 Принял вещь обратно", "returned"),),
    ("returned", True): (
        ("✅ Всё в порядке, закрыть", "complete"),
        ("⚠️ Заявить о порче", "dispute"),
    ),
}

RPC_BY_ACTION = {
    "confirm": "bot_booking_confirm",
    "cancel": "bot_cancel_booking",
    "picked_up": "bot_booking_picked_up",
    "returned": "bot_booking_returned",
    "complete": "bot_booking_complete",
}

# Что сказать после успеха. Не «готово»: человек должен узнать, что
# изменилось и чего ждать дальше, иначе он пойдёт проверять в приложение —
# то есть кнопка не сэкономила ему ничего.
DONE_TEXT = {
    "confirm": "Бронь подтверждена — арендатор уже знает. Дальше он отметит, что забрал вещь.",
    # Годится и для заявки, и для подтверждённой брони: слово «бронь»
    # покрывает оба случая, а разводить два текста по статусу ради
    # одного слова — лишняя развилка там, где смысл один.
    "cancel": "Бронь отменена, даты снова свободны. Вторая сторона уведомлена.",
    "picked_up": "Отметил: вещь у вас, срок аренды пошёл. Вернуть — до конца брони.",
    "returned": "Принято. Теперь можно закрыть сделку или заявить о порче.",
    "complete": "Сделка закрыта, депозит отпущен. Осталось оценить вторую сторону.",
}


def action_keyboard(booking_id: str, status: str, is_owner: bool) -> InlineKeyboardMarkup | None:
    rows = [
        [InlineKeyboardButton(text=label, callback_data=f"a:{action}:{booking_id}")]
        for label, action in ACTIONS.get((status, is_owner), ())
    ]

    # Оценка — тоже действие, но выбор из пяти, а не одна кнопка. Ставится
    # в один ряд: пять отдельных строк заняли бы весь экран телефона.
    if status == "completed":
        rows.append([
            InlineKeyboardButton(text="★" * n, callback_data=f"r:{n}:{booking_id}")
            for n in (1, 2, 3, 4, 5)
        ])

    return InlineKeyboardMarkup(inline_keyboard=rows) if rows else None


# ── Привязка ──────────────────────────────────────────────────

SHARE_KEYBOARD = ReplyKeyboardMarkup(
    keyboard=[[KeyboardButton(text="📱 Поделиться номером", request_contact=True)]],
    resize_keyboard=True,
    one_time_keyboard=True,
)


async def ask_link_query(query: CallbackQuery) -> None:
    """
    То же самое, но человек нажал кнопку, а не набрал команду.

    Всплывающее окно Telegram не умеет носить клавиатуру и обрезается на
    двух сотнях знаков — поэтому в нём короткая причина, а кнопка приходит
    следующим сообщением. Иначе человек читает «нужно связать» и остаётся
    ровно там же, где был.
    """
    await query.answer("Нужно связать Telegram — смотрите сообщение ниже", show_alert=True)
    if query.message:
        await ask_link(query.message)


async def ask_link(message: Message) -> None:
    """
    Отказ непривязанному — с кнопкой, а не с просьбой набрать команду.

    До 05.09.2026 таких отказов было семнадцать, и они разошлись текстами:
    «Сначала свяжите Telegram — /start», «...нажмите /start и поделитесь
    номером». Общее у них было одно: человеку предлагали НАБРАТЬ команду
    там, где хватило бы нажатия. Каждый лишний шаг на этом месте — потеря,
    а место это самое частое: привязку сделал один живой участник из пяти.

    Здесь же говорится про каталог. Он открыт без привязки, и человек,
    которого только что развернули, должен узнать, что смотреть вещи можно
    прямо сейчас, — иначе отказ выглядит как «сюда нельзя».
    """
    await message.answer(
        "Для этого нужно связать Telegram с аккаунтом — одно нажатие на "
        "кнопку ниже. Telegram передаст ваш номер сам.\n\n"
        "Посмотреть, что сдают, можно и без этого: /каталог",
        reply_markup=SHARE_KEYBOARD,
    )


@dp.message(CommandStart())
async def on_start(message: Message) -> None:
    """
    Первая команда в меню — и то, что жмут, когда не знают, что делать.

    Раньше она отвечала одинаково всем: «нажмите кнопку, чтобы связать
    Telegram с вашим аккаунтом» и клавиатура с номером. Уже привязанному
    это говорит, что связи нет, — а он сюда и пришёл потому, что она есть.
    Нажатие ничего не ломает (телефон тот же, привязка та же), но человек
    получает ответ на вопрос, которого не задавал, вместо ответа на свой.

    Поэтому ответов два. Не привязан — прежний текст: без «Поделиться
    номером» бот действительно ничего не может. Привязан — короткая сводка:
    кто вы, есть ли ход за вами и куда идти. Это то, ради чего человек
    открывает чат, не открывая приложение.
    """
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)

        if user is None:
            # Текст обязан работать для ДВУХ разных людей, потому что бот их
            # здесь не различает: участник, который ещё не привязал чат, и
            # человек с рекламы, у которого аккаунта нет вовсе.
            #
            # Прежний текст говорил «свяжите Telegram с вашим аккаунтом» —
            # второму это неправда, и он уходит, не нажав ничего. При этом
            # кнопка работает для обоих: у участника номер найдётся и чат
            # привяжется, у новичка — уйдёт заявка (см. on_contact).
            #
            # И главное: каталог открыт без привязки. Показать, что тут
            # вообще есть, ДО того как человек что-то отдаёт, — единственный
            # честный способ объяснить, зачем нажимать кнопку.
            await message.answer(
                "<b>RentHUB — аренда инструмента у соседей в Кокшетау.</b>\n\n"
                "Посмотреть, что сдают, можно прямо сейчас: /каталог. "
                "Регистрация для этого не нужна.\n\n"
                "Кнопка ниже нужна, чтобы бронировать и сдавать своё. "
                "Telegram передаст ваш номер — вводить его не придётся:\n"
                "• если вы уже участник, чат привяжется, и сюда начнут "
                "приходить подтверждения броней, напоминания о возврате и "
                "ответы организатора;\n"
                "• если нет — уйдёт заявка на участие, пилот закрытый.\n\n"
                "Что ещё умеет бот — /help.",
                parse_mode="HTML",
                reply_markup=SHARE_KEYBOARD,
            )
            return

        # Чей ход — по той же таблице, что читает экран сделки. Считаем, а
        # не перечисляем: список сделок это /сделки, а здесь нужен ответ на
        # «требуется ли от меня что-нибудь прямо сейчас».
        statuses = ",".join(LIVE_STATUSES)
        as_owner, as_renter = [
            await rest_get(
                client,
                "bookings",
                {
                    role: f"eq.{user['id']}",
                    "status": f"in.({statuses})",
                    "select": "status",
                    "limit": "20",
                },
            )
            for role in ("owner_id", "renter_id")
        ]

    mine = sum(
        1
        for rows, is_owner in ((as_owner, True), (as_renter, False))
        for row in rows
        if next_move(row["status"], is_owner).get("yours")
    )
    live = len(as_owner) + len(as_renter)

    name = user.get("full_name") or "без имени"

    if mine:
        head = (
            f"{esc(name)}, за вами ход по "
            f"{mine} {plural_ru(mine, 'сделке', 'сделкам', 'сделкам')}."
        )
        tail = "Что именно — /сделки: там кнопки, нажимать в приложении не нужно."
    elif live:
        head = (
            f"{esc(name)}, у вас "
            f"{live} {plural_ru(live, 'живая сделка', 'живые сделки', 'живых сделок')}, "
            "и ход не за вами."
        )
        tail = "Посмотреть сроки и связаться со второй стороной — /сделки."
    else:
        head = f"{esc(name)}, активных сделок сейчас нет."
        tail = "Посмотреть, что сдают, — /каталог. Выложить своё — /сдать."

    await message.answer(
        f"<b>{head}</b>\n\n{tail}\n\n"
        "Уведомления о бронях, возвратах и спорах приходят сюда сами. "
        "Всё остальное — /help.",
        parse_mode="HTML",
        reply_markup=ReplyKeyboardRemove(),
    )


@dp.message(F.contact)
async def on_contact(message: Message) -> None:
    contact = message.contact

    # Telegram позволяет переслать чужой контакт — проверка обязательна.
    # Без неё любой мог бы привязать к своему чату чужой номер и получать
    # чужие уведомления о сделках.
    if contact.user_id != message.from_user.id:
        await message.answer(
            "Это чужой контакт. Нажмите кнопку «Поделиться номером» — "
            "Telegram отправит именно ваш, подтверждённый им номер.",
            reply_markup=SHARE_KEYBOARD,
        )
        return

    phone = normalize_phone(contact.phone_number)

    async with httpx.AsyncClient(timeout=20) as client:
        found = await rest_get(
            client,
            "users",
            {"phone": f"eq.{phone}", "select": "id,full_name,telegram_id", "limit": "1"},
        )

        if not found:
            # Раньше здесь стояло «напишите организатору» — без имени, без
            # ссылки, без способа. Человек, пришедший по рекламе, упирался в
            # тупик ровно на том шаге, ради которого его и звали.
            #
            # Заявка подаётся прямо сейчас и без единого вопроса: номер уже
            # подтверждён самим Telegram кнопкой «Поделиться номером», имя и
            # ник тоже пришли вместе с контактом. Спрашивать что-то ещё —
            # значит терять людей на пустом месте.
            try:
                result = await rest_rpc(
                    client,
                    "submit_join_request",
                    {
                        "p_phone": phone,
                        "p_full_name": (contact.first_name or "") + (
                            " " + contact.last_name if contact.last_name else ""
                        ),
                        "p_telegram_id": message.from_user.id,
                        "p_telegram_username": message.from_user.username,
                    },
                )
            except RentHubError as error:
                await message.answer(str(error), reply_markup=ReplyKeyboardRemove())
                return

            if result == "already_member":
                # Такого быть не должно: номер только что не нашёлся. Но если
                # база говорит иначе, врать ей поверх нельзя.
                await message.answer(
                    "Аккаунт с этим номером уже есть. Попробуйте /start ещё раз.",
                    reply_markup=SHARE_KEYBOARD,
                )
            elif result == "already_waiting":
                await message.answer(
                    f"Заявка с номером {phone} уже в очереди — второй раз "
                    "подавать не нужно.\n\n"
                    "Организатор заведёт аккаунт и выдаст пароль. Пока можно "
                    "посмотреть, что уже сдают: /каталог.",
                    reply_markup=ReplyKeyboardRemove(),
                )
                # Клавиатура убрана предыдущим сообщением, поэтому кнопка —
                # отдельным: две разметки в одном сообщении Telegram не
                # принимает.
                await message.answer(
                    "Есть вопрос? Напишу его организатору вместе с заявкой.",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(
                text="Задать вопрос организатору", callback_data="j:ask")]]
        ),
                )
            else:
                await message.answer(
                    f"Заявка принята: {phone}.\n\n"
                    "Пилот идёт по приглашениям — организатор заведёт аккаунт и "
                    "выдаст пароль, и вы получите сообщение сюда же.\n\n"
                    "Пока можно посмотреть витрину: /каталог или /найти перфоратор.",
                    reply_markup=ReplyKeyboardRemove(),
                )
                await message.answer(
                    "Есть вопрос? Напишу его организатору вместе с заявкой.",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(
                text="Задать вопрос организатору", callback_data="j:ask")]]
        ),
                )
            return

        user = found[0]

        # Занятость проверяем до записи: telegram_id уникален, и повторная
        # привязка того же чата к другому аккаунту вернула бы ошибку базы
        # вместо понятного текста.
        taken = await rest_get(
            client,
            "users",
            {
                "telegram_id": f"eq.{message.from_user.id}",
                "select": "id",
                "limit": "1",
            },
        )
        if taken and taken[0]["id"] != user["id"]:
            await message.answer(
                "Этот Telegram уже связан с другим аккаунтом RentHUB. "
                "Отвяжите его командой /unlink или напишите организатору.",
                reply_markup=ReplyKeyboardRemove(),
            )
            return

        await rest_patch(
            client,
            "users",
            {"id": f"eq.{user['id']}"},
            {
                "telegram_id": message.from_user.id,
                "telegram_username": message.from_user.username,
            },
        )

    name = user.get("full_name") or "без имени"
    await message.answer(
        f"Готово, {name}. Telegram связан с аккаунтом {phone}.\n\n"
        "Теперь уведомления по сделкам приходят сюда.",
        reply_markup=ReplyKeyboardRemove(),
    )
    log.info("привязан tg=%s к пользователю %s", message.from_user.id, user["id"])


# ── Мои сделки ────────────────────────────────────────────────

# Подписи статусов повторяют BOOKING_STATUS из src/lib/format.ts.
# Дублирование здесь осознанное и минимальное: переносить тексты интерфейса
# в базу ради одного списка — плохой размен, а расхождение заметно сразу и
# правится в двух местах. Правило противоположно тому, что в Postgres: там
# живут правила перехода, здесь — только их названия.
#
# Отличие одно и намеренное: returned в приложении подписан «Возвращено», а
# здесь — «возвращено, ждёт проверки». На экране рядом со значком статуса
# стоит блок «чей ход», который это и объясняет; в списке чата строка стоит
# одна, и «возвращено» без продолжения читается как «всё, конец».
#
# Записано, потому что молчаливое отличие следующий читатель примет за
# рассинхрон и «починит» — приведя к короткому варианту.
STATUS_LABEL = {
    "pending": "ждёт подтверждения",
    "confirmed": "подтверждено",
    "active": "в аренде",
    "returned": "возвращено, ждёт проверки",
    "completed": "завершено",
    "disputed": "спор",
    "cancelled": "отменено",
}

# Показываем только живые сделки: завершённые и отменённые уходят в
# приложение. Список в мессенджере отвечает на вопрос «что сейчас», а не
# заменяет историю.
LIVE_STATUSES = ("pending", "confirmed", "active", "returned", "disputed")


def money(value: int | None) -> str:
    """
    Тенге с разделителем разрядов — теми же символами, что formatTenge.

    Пробелы неразрывные (U+00A0), и это не педантизм. Telegram переносит
    строки по обычным пробелам, и «20 000 ₸» разрывалось надвое: «20» в
    конце строки, «000 ₸» в начале следующей. Сумма, разорванная пополам,
    читается как другое число.

    До 05.09.2026 здесь стояли обычные пробелы, а комментарий утверждал,
    что формат «как в приложении». Приложение к тому времени уже перешло
    на неразрывные — toLocaleString('ru-RU') ставит их между разрядами
    сам, — и совпадали только цифры.
    """
    return f"{value or 0:,}".replace(",", " ") + " ₸"


# Отмена регистрируется здесь, до всех диалогов, и это не вкусовщина.
# aiogram выбирает первый подходящий обработчик, а у шагов публикации и
# претензии фильтр F.text — они перехватили бы «/отмена» раньше и ответили
# «напишите название». Человек оказался бы заперт в диалоге командой, которую
# сам же диалог ему и предложил.
@dp.message(Command("отмена", "cancel"))
async def on_cancel(message: Message, state: FSMContext) -> None:
    if await state.get_state() is None:
        await message.answer("Сейчас нечего отменять.")
        return

    # Что именно отменили, зависит от состояния. Раньше здесь всегда стоял
    # текст про претензию — и человек, отменивший публикацию вещи, читал
    # «претензию не подал». Сообщение, не совпадающее с действием, заставляет
    # гадать, не сделал ли бот чего-то ещё.
    current = await state.get_state()
    await state.clear()

    if current == Damage.photos.state or current == Damage.amount.state:
        text = (
            "Отменил, претензию не подал. Загруженные снимки остались в хранилище — "
            "они никому не показываются, пока претензии нет."
        )
    elif current == NewPrice.waiting.state:
        text = "Отменил, цена осталась прежней."
    elif current == Support.waiting.state:
        text = "Отменил, сообщение не отправлено."
    elif current == JoinNote.waiting.state:
        # Ветка обязательна, а не для полноты: без неё человек, отменивший
        # вопрос, читал бы «объявление не опубликовано» — ровно та ошибка,
        # ради которой этот разбор по состояниям и появился.
        text = "Отменил, вопрос не отправлен. Заявка на участие осталась в очереди."
    else:
        text = "Отменил, объявление не опубликовано. Начать заново — /сдать."

    await message.answer(text)


@dp.message(F.text.in_({"/deals", "/сделки"}))
async def on_deals(message: Message) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        found = await rest_get(
            client,
            "users",
            {"telegram_id": f"eq.{message.from_user.id}", "select": "id,full_name", "limit": "1"},
        )

        if not found:
            await ask_link(message)
            return

        user_id = found[0]["id"]
        statuses = ",".join(LIVE_STATUSES)

        # Две выборки вместо одной: PostgREST не умеет условие «или» по
        # разным колонкам так, чтобы это осталось читаемым. Двадцать строк
        # на человека — не та нагрузка, ради которой стоит усложнять запрос.
        as_owner, as_renter = [
            await rest_get(
                client,
                "bookings",
                {
                    role: f"eq.{user_id}",
                    "status": f"in.({statuses})",
                    # Присоединение без имени ключа: у bookings ровно одна
                    # связь с items, и PostgREST разрешает её однозначно.
                    # Так же записано в приложении — расходиться незачем.
                    # Сроки: до них сделка идёт сама, после — система
                    # решает за человека. Экран сделки их показывает давно,
                    # а чат — нет, хотя владелец в пассивном режиме живёт
                    # именно здесь и другого места не открывает.
                    "select": "id,status,start_date,end_date,rent_total,renter_total,"
                    "grace_period_ends_at,damage_claim_ends_at,"
                    # Ориентир вместе с названием: человеку, которому пора
                    # ехать, «куда» нужнее, чем «что» — а открывать ради этого
                    # приложение значит обесценить кнопки в чате.
                    "item:items(title,pickup_area)",
                    "order": "start_date.asc",
                    "limit": "20",
                },
            )
            for role in ("owner_id", "renter_id")
        ]

        # Что осталось оценить. Таблица «чей ход» называет это ходом
        # человека — «оцените вторую сторону, это единственное, что
        # осталось», — а сделать его в чате можно было ровно один раз, из
        # уведомления о закрытии. Пролистал — и негде: /сделки показывает
        # только живые, закрытая туда не попадает по построению.
        try:
            to_rate = await rest_rpc(client, "bot_pending_reviews", {"p_actor": user_id})
        except RentHubError:
            # Список — дополнение к главному ответу. Его сбой не должен
            # мешать человеку увидеть свои живые сделки.
            to_rate = []

    if not as_owner and not as_renter and not to_rate:
        await message.answer(
            "Сейчас активных сделок нет.\n\n"
            "Каталог открыт без входа: "
            "https://mandaloriancs.github.io/renthub/app/"
        )
        return

    # Контакты обеих ролей сразу: человек видит, с кем связаться, не
    # открывая приложение — ради этого бот и существует.
    async with httpx.AsyncClient(timeout=20) as client:
        contacts = {
            **await contacts_for(client, user_id, as_owner),
            **await contacts_for(client, user_id, as_renter),
            # Закрытые сделки тоже: bot_pending_reviews отдаёт только
            # completed, поэтому статус проставляем сами — своего поля у
            # неё нет, а contacts_for фильтрует именно по нему.
            **await contacts_for(
                client, user_id, [{**r, "status": "completed"} for r in to_rate]
            ),
        }

    lines: list[str] = []

    def block(title: str, rows: list[dict], mine: bool) -> None:
        if not rows:
            return
        lines.append(f"<b>{esc(title)}</b>")
        for row in rows:
            item = esc((row.get("item") or {}).get("title") or "объявление удалено")
            status = STATUS_LABEL.get(row["status"], row["status"])
            # Владельцу показываем его выручку, арендатору — что он платит:
            # одна и та же сделка выглядит по-разному с двух сторон, и общая
            # сумма запутала бы обоих.
            amount = money(row.get("rent_total") if mine else row.get("renter_total"))
            area = (row.get("item") or {}).get("pickup_area")
            place = f"\n  \U0001F4CD {esc(area)}" if area else ""
            lines.append(f"• {item} — {status}{place}")
            lines.append(
                f"  {human_date(row['start_date'])} → {human_date(row['end_date'])} · {amount}"
                         + deadline_line(row, mine)
                         + contact_line(contacts.get(row["id"])))
        lines.append("")

    block("Сдаёте", as_owner, mine=True)
    block("Арендуете", as_renter, mine=False)

    lines.append("Подробности — в приложении:")
    lines.append("https://mandaloriancs.github.io/renthub/app/")

    await message.answer("\n".join(lines), parse_mode="HTML")

    # Оценки идут отдельными сообщениями: у одного сообщения одна клавиатура,
    # а звёзды нужны к каждой сделке свои. Тот же приём, что в /вещи.
    #
    # После списка, а не до: человек открывает /сделки ради того, что идёт
    # сейчас. Просьба оценить закрытое сверху отодвинула бы главное.
    for row in to_rate:
        # Контакт здесь — не украшение карточки. Сделка, закрытая
        # планировщиком, уходит из живого списка, и это единственное
        # место в чате, где человек её ещё видит. Если вещь на самом
        # деле не вернули, телефон нужен именно отсюда.
        await message.answer(
            f"Оцените сделку: <b>{esc(row['title'])}</b>\n"
            f"Вторая сторона — {esc(row['other_name'] or 'без имени')}."
            + contact_line(contacts.get(row["id"]))
            + "\n\nРейтинг и есть то, ради чего незнакомец соглашается отдать вещь.",
            parse_mode="HTML",
            reply_markup=InlineKeyboardMarkup(
                inline_keyboard=[[
                    InlineKeyboardButton(text="★" * n, callback_data=f"r:{n}:{row['id']}")
                    for n in range(1, 6)
                ]]
            ),
        )


    # Отдельными сообщениями — то, где ход за человеком или есть что нажать.
    # Карточка под каждой из двадцати сделок превратила бы чат в ленту, а
    # владельца в пассивном режиме дёргают ровно там, где без него сделка не
    # сдвинется. Отбор — в send_move_card, там же и разбор второго условия.
    for rows, is_owner in ((as_owner, True), (as_renter, False)):
        for row in rows:
            await send_move_card(message.answer, row, is_owner)


async def send_move_card(send, row: dict, is_owner: bool) -> None:
    """
    Карточка «ваш ход»: что от вас ждут и кнопка, которая это делает.

    Текст берётся из общей таблицы, а не сочиняется здесь: то же самое
    читает экран сделки в приложении. Если человек прочитал в чате одно, а
    на экране увидел другое — он перестанет верить обоим.
    """
    move = next_move(row["status"], is_owner)

    # Клавиатуры может не быть, и карточка всё равно нужна: у арендатора в
    # «active» ход за ним — вернуть вовремя, — но нажимать нечего. Молчание
    # здесь означало бы, что человек узнает о просрочке только из спора.
    keyboard = action_keyboard(row["id"], row["status"], is_owner)

    # Обратное тоже верно, и это упускалось: ход может быть не ваш, а
    # кнопка — ваша. Таблица «чей ход» ключуется одним статусом и такого
    # сказать не умеет.
    #
    # Так терялись три действия из семи в ACTIONS. Арендатор не мог из
    # /deals отменить неподтверждённую заявку. Владелец не мог отменить
    # подтверждённую бронь — а без этого она висит в confirmed и держит
    # даты занятыми; на экране сделки эта кнопка есть, и причина
    # записана там же. Владелец не мог отметить возврат в автоспоре о
    # невозврате — единственный выход из него.
    #
    # Кнопка, до которой нельзя дотянуться, ничем не лучше отсутствующей.
    # Цена — лишняя карточка там, где ход не ваш: её показывают только
    # трём парам «статус + роль» из семи, и у каждой есть что нажать.
    if not move.get("yours") and keyboard is None:
        return

    item = esc((row.get("item") or {}).get("title") or "объявление удалено")
    text = f"<b>{esc(move['title'])}</b>\n{item}\n\n{esc(move['body'])}"
    await send(text, parse_mode="HTML", reply_markup=keyboard)


# ── Нажатия ───────────────────────────────────────────────────


@dp.callback_query(F.data.startswith("a:"))
async def on_action(query: CallbackQuery, state: FSMContext) -> None:
    _, action, booking_id = query.data.split(":", 2)

    if action == "dispute":
        await start_damage(query, state, booking_id)
        return

    # Отметка «забрал» закрывает арендатору единственный выход.
    #
    # До неё бронь отменяется без последствий: деньги не списывались, депозит
    # разблокируется. После — аренда началась, и отменить её нельзя. При этом
    # заявить о неисправности арендатор не может: спор открывает только
    # владелец и только после возврата.
    #
    # На экране сделки об этом сказано текстом над кнопкой. В чате текст над
    # кнопкой не поставишь — она приходит вместе с уведомлением, — поэтому
    # переспрашиваем. Один лишний тап против необратимой ошибки: размен
    # честный.
    if action == "picked_up":
        await query.answer()
        await query.message.answer(
            "Осмотрели вещь? Работает, комплект на месте?\n\n"
            "Сейчас бронь ещё можно отменить без последствий. После отметки "
            "аренда началась, и отменить её нельзя — вещь у вас.",
            reply_markup=InlineKeyboardMarkup(
                inline_keyboard=[[
                    InlineKeyboardButton(
                        text="✅ Да, всё в порядке", callback_data=f"a:picked_up_ok:{booking_id}"
                    )
                ], [
                    InlineKeyboardButton(
                        text="✖️ Отказаться от брони", callback_data=f"a:cancel:{booking_id}"
                    )
                ]]
            ),
        )
        return

    # Подтверждённый шаг зовёт ту же функцию: развилка только в интерфейсе,
    # правило одно.
    if action == "picked_up_ok":
        action = "picked_up"

    fn = RPC_BY_ACTION.get(action)

    if fn is None:
        await query.answer("Не знаю такого действия", show_alert=True)
        return

    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, query.from_user.id)
        if user is None:
            await ask_link_query(query)
            return

        try:
            await rest_rpc(client, fn, {"p_actor": user["id"], "p_booking_id": booking_id})
        except RentHubError as error:
            # Отказ показываем всплывающим окном и оставляем кнопку на месте:
            # человек мог нажать вторым, и «сделка уже в другом статусе» —
            # это ответ, а не повод прятать интерфейс.
            await query.answer(str(error), show_alert=True)
            return

    await query.answer("Готово")
    # Кнопку убираем: действие сделано, и повторное нажатие получило бы
    # отказ от базы. Оставленная кнопка выглядит как «можно ещё раз».
    await query.message.edit_reply_markup(reply_markup=None)
    await query.message.answer(DONE_TEXT.get(action, "Готово."))


@dp.callback_query(F.data.startswith("r:"))
async def on_rate(query: CallbackQuery) -> None:
    _, rating, booking_id = query.data.split(":", 2)

    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, query.from_user.id)
        if user is None:
            await ask_link_query(query)
            return

        # Кого оцениваем, бот не решает — он смотрит, кем человек был в этой
        # сделке. Взять «кого» из кнопки было бы приглашением подставить
        # чужого: в callback_data лежит то, что прислал клиент.
        found = await rest_get(
            client,
            "bookings",
            {"id": f"eq.{booking_id}", "select": "owner_id,renter_id", "limit": "1"},
        )
        if not found:
            await query.answer("Сделка не найдена", show_alert=True)
            return

        booking = found[0]
        if user["id"] == booking["owner_id"]:
            to_user = booking["renter_id"]
        elif user["id"] == booking["renter_id"]:
            to_user = booking["owner_id"]
        else:
            await query.answer("Это не ваша сделка", show_alert=True)
            return

        try:
            await rest_rpc(client, "bot_submit_review", {
                "p_actor": user["id"],
                "p_booking_id": booking_id,
                "p_to_user": to_user,
                "p_rating": int(rating),
            })
        except RentHubError as error:
            await query.answer(str(error), show_alert=True)
            return

    await query.answer("Спасибо")
    await query.message.edit_reply_markup(reply_markup=None)
    await query.message.answer(
        f"Оценка {rating} из 5 засчитана. Комментарий можно оставить в приложении — "
        "в чате его неудобно писать и ещё неудобнее править."
    )


@dp.message(F.text.in_({"/help", "/помощь"}))
async def on_help(message: Message) -> None:
    """
    Справка знает, с кем говорит.

    До 05.09.2026 она была одна на всех и перечисляла двенадцать команд.
    Непривязанному человеку девять из них отвечают отказом: /вещи, /профиль,
    /сдать, /сделки — всё это про аккаунт, которого у него ещё нет.

    Читать список возможностей и упираться в отказ на каждой второй —
    худший способ знакомства. Причём отказ он получит не сразу, а после
    того, как выберет команду и наберёт её.

    Поэтому непривязанному сначала то, что работает прямо сейчас, потом
    одна кнопка и честный список того, что она открывает. Привязанному —
    прежний полный текст: он и есть его инструмент.
    """
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)

    if user is None:
        await message.answer(
            "<b>Сейчас доступно без всего:</b>\n"
            "/каталог — что сдают в Кокшетау\n"
            "/найти перфоратор — поиск по названию и району\n\n"
            "<b>После кнопки ниже откроется:</b>\n"
            "• уведомления о бронях, возвратах и спорах — сюда, в чат\n"
            "• /сдать — опубликовать свою вещь, не открывая приложение\n"
            "• /сделки — что сдаёте, что арендуете, с кем связаться\n"
            "• /вещи, /профиль, /поддержка\n\n"
            "Кнопка передаёт номер, который Telegram уже подтвердил. "
            "Если вы участник пилота — чат привяжется, если нет — уйдёт "
            "заявка: пилот закрытый.\n\n"
            "Витрина целиком, с фото и календарём занятости:\n"
            f"{APP_URL}",
            parse_mode="HTML",
            reply_markup=SHARE_KEYBOARD,
        )
        return

    await message.answer(
        "Что я умею:\n\n"
        "/start — связать Telegram с аккаунтом\n"
        "/deals — активные сделки: что сдаёте, что арендуете и с кем связаться\n"
        "/unlink — отвязать Telegram\n\n"
        "Уведомления о бронях, возвратах и спорах приходят сюда сами, "
        "и то, что зависит от вас, можно сделать кнопкой прямо в чате: "
        "подтвердить бронь, отметить получение и возврат, закрыть сделку, "
        "отменить заявку, поставить оценку.\n\n"
        "/каталог — свежие объявления, /найти перфоратор — поиск\n"
        "/сдать — опубликовать свою вещь, не открывая приложение\n"
        "/вещи — ваши объявления: снять с публикации, вернуть, изменить цену\n"
        "/профиль — рейтинг, сделки и статус номера\n"
        "/поддержка — написать организатору, если что-то пошло не так\n"
        "/отмена — выйти из начатого диалога, ничего не сохранив\n\n"
        "В меню рядом с полем ввода те же команды латиницей — "
        "/catalog, /find, /publish: Telegram не пускает в меню кириллицу. "
        "Работают оба написания.\n\n"
        "Витрина целиком, с фото и календарём занятости, — в приложении: "
        "https://mandaloriancs.github.io/renthub/app/"
    )


@dp.message(F.text == "/unlink")
async def on_unlink(message: Message) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        await rest_patch(
            client,
            "users",
            {"telegram_id": f"eq.{message.from_user.id}"},
            {"telegram_id": None, "telegram_username": None},
        )
    await message.answer(
        "Отвязал. Уведомления сюда больше не придут. "
        "Чтобы связать снова — /start."
    )


# ── Публикация объявления ─────────────────────────────────────
#
# Правила публикации бот не знает: верификацию, блокировку и цену больше нуля
# проверяет create_item() вместе с триггерами таблицы. Здесь только сбор
# ответов и понятные вопросы.
#
# Два исключения — длина названия и длина ориентира. Оба ограничения таблицы,
# оба сработали бы и сами, но отказ пришёл бы на последнем шаге, после фото, и
# вернуться к нужному полю из диалога нечем: состояние уже «жду фото». Дублем
# правила это не становится — база остаётся авторитетом, а перевод её отказа
# лежит рядом, в CONSTRAINT_MESSAGES, вторым рубежом.


def amount_or_none(text: str) -> int | None:
    digits = re.sub(r"[^0-9]", "", text or "")
    return int(digits) if digits else None


@dp.message(F.text.in_({"/publish", "/сдать"}))
async def on_publish(message: Message, state: FSMContext) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await ask_link(message)
            return

        categories = await rest_get(
            client, "categories", {"select": "slug,title_ru", "order": "sort_order.asc"}
        )

    await state.set_state(NewItem.category)
    await state.update_data(photos=[])
    await message.answer(
        "Что сдаёте? Выберите раздел.",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text=row["title_ru"], callback_data=f"c:{row['slug']}")]
                for row in categories
            ]
        ),
    )


@dp.callback_query(F.data.startswith("c:"), NewItem.category)
async def on_pick_category(query: CallbackQuery, state: FSMContext) -> None:
    slug = query.data.split(":", 1)[1]
    await state.update_data(category=slug)
    await state.set_state(NewItem.title)
    await query.answer()
    await query.message.edit_reply_markup(reply_markup=None)
    popular = tool_popular(slug)

    await query.message.answer(
        f"Название — коротко и узнаваемо: «{tool_example(slug)}».\n\n"
        "По нему ищут, поэтому марка и модель работают лучше, чем «хороший инструмент»."
        + ("\n\nМожно взять готовое и дописать модель:" if popular else ""),
        reply_markup=(
            InlineKeyboardMarkup(
                inline_keyboard=[
                    [InlineKeyboardButton(text=name, callback_data=f"n:{i}")]
                    for i, name in enumerate(popular)
                ]
            )
            if popular
            else None
        ),
    )


@dp.callback_query(F.data.startswith("n:"), NewItem.title)
async def on_pick_name(query: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()
    popular = tool_popular(data.get("category", ""))

    index = int(query.data.split(":", 1)[1])
    if index >= len(popular):
        # Список мог измениться между показом и нажатием — например, если бот
        # перезапустили с новым справочником. Просить набрать руками честнее,
        # чем подставить не то, что человек видел на кнопке.
        await query.answer("Список обновился, напишите название сами", show_alert=True)
        return

    name = popular[index]
    await query.answer()
    await query.message.edit_reply_markup(reply_markup=None)

    # Название не подставляется молча: человек должен увидеть, что именно
    # записано, и понять, что модель ещё можно дописать следующим шагом —
    # в чате нет поля, в которое он мог бы заглянуть.
    await state.update_data(title=name)
    await state.set_state(NewItem.price)
    await query.message.answer(
        f"Записал: <b>{esc(name)}</b>\n\n"
        "Сколько берёте за сутки? Напишите числом, в тенге.\n\n"
        "Платформа удержит 20% — остальное ваше.",
        parse_mode="HTML",
    )


@dp.message(NewItem.title, F.text)
async def on_item_title(message: Message, state: FSMContext) -> None:
    title = (message.text or "").strip()

    if title.startswith("/"):
        await message.answer("Идёт публикация. Напишите название или /отмена.")
        return

    # Граница та же, что в ограничении таблицы (length(trim(title)) >= 3), и
    # проверяется она здесь по той же причине, что и ориентир двумя шагами
    # ниже: отказ базы приходит после шага с фото, а вернуться к названию из
    # состояния «жду фото» человеку нечем. Он упирался в бесконечный круг —
    # «Опубликовать» отвечало отказом, а любой текст «на этом шаге нужны
    # снимки». Выход был один, /отмена, то есть заново все шесть ответов.
    if len(title) < 3:
        await message.answer(
            "Слишком коротко — по названию будут искать. "
            "Напишите марку и модель: «Перфоратор Bosch GBH 2-26»."
        )
        return

    await state.update_data(title=title)
    await state.set_state(NewItem.price)
    await message.answer(
        "Сколько берёте за сутки? Напишите числом, в тенге.\n\n"
        "Платформа удержит 20% — остальное ваше."
    )


@dp.message(NewItem.price, F.text)
async def on_item_price(message: Message, state: FSMContext) -> None:
    if (message.text or "").strip().startswith("/"):
        await message.answer("Идёт публикация. Напишите цену или /отмена.")
        return

    price = amount_or_none(message.text)
    if not price:
        await message.answer("Нужна сумма числом, например 3000.")
        return

    # Отказ базы пришёл бы через три шага, на кнопке «Опубликовать», и
    # вернуться к цене из состояния «жду фото» было бы нечем — та же ловушка,
    # что была с коротким названием.
    #
    # В соседнем диалоге «Изменить цену» такой проверки нет намеренно: там шаг
    # один, отказ item_set_price() приходит по-русски и человек просто пишет
    # число заново. Проверка здесь стоит не потому, что правило надо повторить,
    # а потому, что до отказа там некуда вернуться.
    if price > MAX_DAILY_PRICE:
        await message.answer(
            "Больше миллиона за сутки — проверьте, нет ли лишнего нуля. "
            "Напишите цену ещё раз."
        )
        return

    await state.update_data(price=price)
    await state.set_state(NewItem.deposit)
    # Считаем заработок сразу: ради него владелец и публикует, а 20% в уме
    # от трёх тысяч — не та арифметика, которую делают в чате.
    await message.answer(
        f"Ваш заработок: {money(round(price * 0.8))} за сутки.\n\n"
        "Теперь депозит — сумма, которую заморозят у арендатора на время аренды "
        "и вернут при целом возврате. Обычно это цена ремонта, а не цена вещи."
    )


@dp.message(NewItem.deposit, F.text)
async def on_item_deposit(message: Message, state: FSMContext) -> None:
    if (message.text or "").strip().startswith("/"):
        await message.answer("Идёт публикация. Напишите депозит или /отмена.")
        return

    deposit = amount_or_none(message.text)
    if deposit is None:
        await message.answer("Нужна сумма числом, например 15000.")
        return

    await state.update_data(deposit=deposit)
    await state.set_state(NewItem.pickup)
    await message.answer(
        "Где забирать? Район или ориентир — «мкр. Васильковский», «возле "
        "вокзала». Точный адрес не нужен: его скажете тому, чью бронь "
        "подтвердите.\n\n"
        "Это помогает выбрать: вещь надо привезти и вернуть.",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(text="Пропустить", callback_data="item:nopickup")]]
        ),
    )


ASK_PHOTOS = (
    "Осталось фото — это фото «до». Именно с ними будут сверять состояние "
    "вещи при возврате, поэтому снимайте то, что потом захотите доказать: "
    "царапины, комплектацию, следы использования.\n\n"
    "Пришлите один снимок или несколько."
)


@dp.message(NewItem.pickup, F.text)
async def on_item_pickup(message: Message, state: FSMContext) -> None:
    if (message.text or "").strip().startswith("/"):
        await message.answer("Идёт публикация. Напишите ориентир или /отмена.")
        return

    area = (message.text or "").strip()
    # Границы те же, что в ограничении таблицы: короче двух символов —
    # опечатка, длиннее восьмидесяти — не ориентир, а рассказ. Проверить
    # здесь дешевле, чем показать человеку отказ базы после шага с фото.
    if len(area) < 2:
        await message.answer("Слишком коротко — напишите район или ориентир.")
        return
    if len(area) > 80:
        await message.answer("Слишком длинно. Хватит района или заметного ориентира.")
        return

    await state.update_data(pickup=area)
    await state.set_state(NewItem.photos)
    await message.answer(ASK_PHOTOS)


@dp.callback_query(F.data == "item:nopickup")
async def on_item_skip_pickup(query: CallbackQuery, state: FSMContext) -> None:
    await state.update_data(pickup=None)
    await state.set_state(NewItem.photos)
    await query.answer()
    await query.message.edit_reply_markup(reply_markup=None)
    await query.message.answer(ASK_PHOTOS)


@dp.message(NewItem.photos, F.photo)
async def on_item_photo(message: Message, state: FSMContext) -> None:
    data = await state.get_data()
    photos = list(data.get("photos", []))

    if len(photos) >= 6:
        await message.answer("Шести снимков достаточно — нажмите «Опубликовать».")
        return

    async with httpx.AsyncClient(timeout=60) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await state.clear()
            await ask_link(message)
            return

        file = await message.bot.get_file(message.photo[-1].file_id)
        buffer = await message.bot.download_file(file.file_path)

        try:
            url = await upload_photo(client, user["id"], buffer.read())
        except RentHubError as error:
            await message.answer(str(error))
            return

    photos.append(url)
    await state.update_data(photos=photos)
    await message.answer(
        f"Принял, всего {len(photos)} фото.",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(text="🚀 Опубликовать", callback_data="p:go")]]
        ),
    )


# ── Вопрос от того, у кого аккаунта ещё нет ───────────────────
#
# Текст уходит в join_requests.note той же функцией submit_join_request:
# при открытой заявке она не создаёт вторую строку, а дописывает note.
# Поэтому отдельной функции в базе не понадобилось — и правило «одна
# открытая заявка на номер» осталось в одном месте.

@dp.callback_query(F.data == "j:ask")
async def on_join_ask(query: CallbackQuery, state: FSMContext) -> None:
    await state.set_state(JoinNote.waiting)
    await query.answer()
    await query.message.edit_reply_markup(reply_markup=None)
    await query.message.answer(
        "Напишите вопрос одним сообщением — организатор прочитает его "
        "вместе с заявкой.\n\n"
        "Передумали — /отмена."
    )


@dp.message(JoinNote.waiting, F.text)
async def on_join_note(message: Message, state: FSMContext) -> None:
    if (message.text or "").strip().startswith("/"):
        await message.answer("Жду вопрос для организатора. Или /отмена.")
        return

    text = (message.text or "").strip()

    # Границы те же, что у join_requests_note_check в базе. Проверяем
    # здесь по той же причине, что длину названия при публикации: отказ
    # придёт по-английски именем ограничения, а исправить его человеку
    # будет нечем — он уже написал.
    if len(text) < 2:
        await message.answer("Слишком коротко — напишите, что случилось.")
        return
    if len(text) > 300:
        await message.answer(
            f"Длинновато: {len(text)} символов, а поместится 300. "
            "Оставьте самое главное — остальное обсудите с организатором."
        )
        return

    async with httpx.AsyncClient(timeout=20) as client:
        # Номер берём из уже поданной заявки: спрашивать его второй раз
        # значит просить человека набрать руками то, что Telegram уже
        # подтвердил кнопкой.
        rows = await rest_get(
            client,
            "join_requests",
            {
                "telegram_id": f"eq.{message.from_user.id}",
                "handled_at": "is.null",
                "select": "phone",
                "limit": "1",
            },
        )

        if not rows:
            await state.clear()
            await message.answer(
                "Не нашёл вашу заявку — возможно, организатор уже завёл "
                "аккаунт. Нажмите /start, и напишите снова через /поддержка."
            )
            return

        try:
            await rest_rpc(
                client,
                "submit_join_request",
                {"p_phone": rows[0]["phone"], "p_note": text},
            )
        except RentHubError as error:
            await message.answer(str(error))
            return

    await state.clear()
    await message.answer(
        "Передал. Организатор увидит вопрос рядом с вашей заявкой и "
        "ответит сюда же, когда заведёт аккаунт."
    )


@dp.message(JoinNote.waiting)
async def on_join_note_wrong(message: Message) -> None:
    await message.answer("Здесь нужен текст. Или /отмена.")


# ── Ответ не того вида ────────────────────────────────────────
#
# Без этих двух обработчиков бот просто молчит: aiogram не находит хендлер
# под сообщение и роняет его. Снаружи это выглядит поломкой — человек
# прислал что-то и не получил ничего, хотя ошибся всего лишь видом ответа.
#
# Регистрируются после основных: aiogram проверяет обработчики в порядке
# объявления, и поставленные выше перехватили бы правильные ответы.

@dp.message(NewItem.pickup)
async def on_item_pickup_wrong(message: Message) -> None:
    await message.answer(
        "Здесь нужен текст — район или ориентир. Если его нет, нажмите "
        "«Пропустить» в сообщении выше."
    )


@dp.message(NewItem.photos)
async def on_item_photo_wrong(message: Message) -> None:
    if (message.text or "").strip().startswith("/"):
        await message.answer("Идёт публикация. Пришлите фото или /отмена.")
        return
    await message.answer(
        "На этом шаге нужны снимки вещи — пришлите фото. Текст в объявление "
        "уже записан."
    )


@dp.callback_query(F.data == "p:go", NewItem.photos)
async def on_item_publish(query: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()

    if not data.get("photos"):
        await query.answer("Сначала пришлите хотя бы одно фото", show_alert=True)
        return

    async with httpx.AsyncClient(timeout=30) as client:
        user = await user_by_telegram(client, query.from_user.id)
        if user is None:
            await state.clear()
            await ask_link_query(query)
            return

        try:
            item_id = await rest_rpc(
                client,
                "bot_create_item",
                {
                    "p_actor": user["id"],
                    "p_category": data["category"],
                    "p_title": data["title"],
                    "p_daily_price": data["price"],
                    "p_deposit_amount": data["deposit"],
                    "p_photos": data["photos"],
                    "p_pickup_area": data.get("pickup"),
                },
            )
        except RentHubError as error:
            # Состояние не чистим: человек ввёл пять ответов, и терять их
            # из-за короткого названия значило бы заставить пройти всё заново.
            await query.answer(str(error), show_alert=True)
            return

    skipped_pickup = not data.get("pickup")

    await state.clear()
    await query.answer("Опубликовано")
    await query.message.edit_reply_markup(reply_markup=None)

    text = (
        f"Готово, объявление на витрине.\n{item_url(item_id)}\n\n"
        "Когда его забронируют, я напишу — подтвердить можно будет кнопкой отсюда."
    )

    # Про пропущенный ориентир говорим здесь, а не на самом шаге: там это
    # был бы уговор не нажимать кнопку, которую мы же и предложили. Здесь —
    # сообщение о последствии, у которого есть адрес.
    #
    # Первое живое объявление платформы вышло без ориентира и провисело так
    # сутки. Владелец не знал ни того, что это видно в каталоге, ни того,
    # что добавить его теперь можно оттуда же, из чата.
    if skipped_pickup:
        text += (
            "\n\nОриентир вы пропустили — в каталоге не будет видно, куда "
            "ехать за вещью. Это одно из первых, на что смотрят: «через "
            "дорогу» и «через весь город» решают сильнее, чем двести тенге "
            "в цене.\n\nДобавить в любой момент: /вещи → «Добавить ориентир»."
        )

    await query.message.answer(text)


# ── Витрина ───────────────────────────────────────────────────
#
# Каталог в чате намеренно беднее, чем в приложении: ни фото, ни календаря
# занятости, ни фильтров. Лента карточек с картинками в мессенджере читается
# хуже сетки на экране, а забронировать всё равно можно только выбрав даты —
# то есть в приложении.
#
# Смысл команды другой: ответить на вопрос «а есть ли вообще перфоратор»
# не выходя из чата. Ссылка на карточку стоит у каждой строки — переход
# нужен ровно тогда, когда ответ «есть».

CATALOG_LIMIT = 8


def esc(value) -> str:
    """
    Текст из базы — в HTML-сообщение Telegram.

    Бот шлёт с parse_mode="HTML", а подставляет то, что ввели люди: название
    вещи пишет владелец, текст сообщения — модератор. «Дрель <мощная>» или
    «цена < 1000» ломают разметку, и Telegram отклоняет сообщение целиком.

    Отказ виден только в логе: доставка ловит исключение и идёт дальше, не
    ставя отметку. Снаружи это «уведомление не пришло» — причём именно у тех
    объявлений, где в названии попался угловой знак. Тише не бывает.
    """
    return html.escape(str(value or ""), quote=False)


# Статусы, в которых контакт уже открыт. Список повторяет условие внутри
# booking_contact(): держать его здесь — не дублирование правила, а способ
# не звать функцию там, где она заведомо откажет. Ошибётся список — бот
# просто не покажет телефон, а не покажет лишний.
#
# Он и ошибался: до 04.09.2026 здесь было четыре статуса против пяти в
# базе — не хватало completed. Комментарий выше утверждал, что список
# повторяет условие функции, а он его сужал.
#
# Цена ошибки — тот самый случай, ради которого база completed и
# сохраняет, и она написала об этом прямо: «вещь могли забыть вернуть, и
# связаться нужно ровно тогда, когда сделка уже закрыта». Сделка,
# закрытая планировщиком по таймеру, уходит из «Сдаёте», и владелец в
# чате оставался без телефона ровно в ту минуту, когда телефон нужен.
CONTACT_STATUSES = ("confirmed", "active", "returned", "completed", "disputed")


async def contacts_for(client, actor_id: str, rows: list[dict]) -> dict:
    """
    Контакты вторых сторон для списка сделок — одним заходом.

    Запросы идут параллельно: последовательно они складывались бы в
    заметную паузу перед первым сообщением, а /deals человек открывает
    именно чтобы быстро посмотреть.

    return_exceptions=True намеренно: отказ по одной сделке не должен
    ронять весь список. Контакта не будет только у неё.
    """
    live = [r for r in rows if r.get("status") in CONTACT_STATUSES]
    if not live:
        return {}

    results = await asyncio.gather(
        *[
            rest_rpc(client, "bot_booking_contact",
                     {"p_actor": actor_id, "p_booking_id": r["id"]})
            for r in live
        ],
        return_exceptions=True,
    )

    out: dict = {}
    for row, res in zip(live, results):
        if isinstance(res, list) and res:
            out[row["id"]] = res[0]
    return out


def contact_line(contact: dict | None) -> str:
    """Строка «с кем связаться» или пусто, если контакт ещё не открыт."""
    if not contact:
        return ""
    parts = [esc(contact.get("phone") or "")]
    if contact.get("telegram_username"):
        parts.append("@" + esc(contact["telegram_username"]))
    who = esc(contact.get("full_name") or "вторая сторона")
    return f"\n  {who}: {' · '.join(p for p in parts if p)}"


def deadline_line(row: dict, mine: bool) -> str:
    """
    Срок, который сейчас важен.

    Их всего два, и одновременно не бывает: до возврата — запас времени
    после окончания аренды, после возврата — окно на претензию. Повторяет
    ту же развилку, что на экране сделки: одна и та же сделка не должна
    объясняться в чате иначе, чем на экране.

    Строка появляется только когда срок есть: «срок: —» занимает место и
    ничего не сообщает.
    """
    if row["status"] == "active" and row.get("grace_period_ends_at"):
        when = row["grace_period_ends_at"][:16].replace("T", " ")
        return (
            f"\n  ⏳ вернуть до {when} — иначе система откроет спор о невозврате"
            if not mine
            else f"\n  ⏳ ждём возврата до {when}"
        )

    if row["status"] == "returned" and row.get("damage_claim_ends_at"):
        when = row["damage_claim_ends_at"][:16].replace("T", " ")
        return (
            f"\n  ⏳ заявить о порче можно до {when}, потом сделка закроется сама"
            if mine
            else f"\n  ⏳ депозит вернётся до {when}"
        )

    return ""


# Статусы, при которых вещь считается занятой. Те же три, что учитывает
# ограничение bookings_no_overlap в базе и экран «Мои вещи» в приложении.
# Четвёртая копия правила — поэтому и записано, откуда она.
BUSY_STATUSES = ("pending", "confirmed", "active")


def item_line(row: dict, busy_until: str | None = None) -> str:
    owner = row.get("owner") or {}
    rating = owner.get("rating")
    # Оценку показываем только когда она есть. «0.0» рядом с новым владельцем
    # читается как «плохой», хотя верно «его ещё не оценивали».
    mark = f" · ★ {rating}" if rating else ""
    # Где забирать — то же, что показывает карточка каталога в приложении.
    # Пустое поле строкой не занимаем: у части вещей ориентира нет, и
    # выдуманное «Кокшетау» вместо него ничего не сообщает.
    area = f"\n  📍 {esc(row['pickup_area'])}" if row.get("pickup_area") else ""
    # Пометка стоит у названия, а не в конце строки: человек читает список
    # взглядом сверху вниз и до конца строки может не дойти.
    demo = " 🛠 демо" if is_demo(row) else ""
    # Занятость показывается только когда вещь занята: «свободно» у каждой
    # строки — восемь одинаковых слов подряд, которые перестают читаться уже
    # на второй. Молчание здесь и означает «свободна».
    busy = f"\n  🔒 занято до {busy_until}" if busy_until else ""
    return (
        f"• <b>{esc(row['title'])}</b>{demo} — {money(row.get('daily_price'))} / сутки\n"
        f"  депозит {money(row.get('deposit_amount'))}{mark}{area}{busy}\n"
        f"  {item_url(row['id'])}"
    )


async def busy_map(client: httpx.AsyncClient, rows: list[dict]) -> dict[str, str]:
    """
    До какого числа занята каждая вещь из выдачи.

    Одним запросом на весь список, а не по запросу на строку: восемь
    объявлений — восемь обращений к базе ради одной подписи, и это тот
    случай, когда удобство стоит дороже пользы.

    Зачем вообще. В чате человек видел цену и депозит, а свободна ли вещь —
    узнавал, только открыв приложение. Половина пути ради одного слова, и
    половина людей его не пройдёт.
    """
    ids = [row["id"] for row in rows]
    if not ids:
        return {}

    found = await rest_get(
        client,
        "bookings",
        {
            "item_id": f"in.({','.join(ids)})",
            "status": f"in.({','.join(BUSY_STATUSES)})",
            "select": "item_id,end_date",
            "order": "end_date.desc",
        },
    )

    # Первая запись на вещь — самая поздняя дата: порядок задан выше.
    busy: dict[str, str] = {}
    for booking in found:
        busy.setdefault(booking["item_id"], human_date(booking["end_date"]))
    return busy


async def show_catalog(message: Message, search: str | None) -> None:
    params = {
        "select": "id,title,daily_price,deposit_amount,pickup_area,"
        "owner:users!items_owner_id_fkey(full_name,rating)",
        "status": "eq.active",
        "city": f"eq.{PILOT_CITY}",
        "order": "created_at.desc",
        "limit": str(CATALOG_LIMIT),
    }

    if search:
        # Запятая и скобки — служебные символы PostgREST: «дрель, буры»
        # развалило бы фильтр на два условия и вернуло мусор. То же самое
        # делает fetchCatalog в приложении.
        clean = re.sub(r"[,()]", " ", search).strip()
        # Ориентир входит в поиск наравне с названием: «Васильковский» —
        # это запрос не про инструмент, а про то, куда за ним ехать.
        # Список полей обязан совпадать с fetchCatalog в приложении,
        # иначе один и тот же запрос даст в чате и на экране разное.
        # Марку ищем во всех написаниях — так же, как fetchCatalog в
        # приложении. Иначе «бош» в чате не найдёт «Перфоратор Bosch».
        terms = [clean, *(re.sub(r"[,()]", " ", t) for t in brand_spellings(clean))]
        parts = ",".join(
            f"title.ilike.*{t}*,description.ilike.*{t}*,pickup_area.ilike.*{t}*"
            for t in terms
        )
        params["or"] = f"({parts})"

    async with httpx.AsyncClient(timeout=20) as client:
        rows = await rest_get(client, "items", params)
        # Занятость спрашивается здесь, пока соединение открыто: ниже блок
        # заканчивается, и второй раз открывать клиент ради одной подписи
        # дороже, чем донести значение оттуда.
        busy = await busy_map(client, rows)

        # Пустая выдача — это три разных положения, и человеку в каждом
        # нужно разное. На экране так и сделано: пустой каталог называет
        # включённые фильтры, а «Пока пусто» зовёт стать первым. В чате все
        # три отвечали одним «Ничего не нашлось», после которого делать
        # нечего — фильтр в чате не снимешь, он и есть слово запроса.
        #
        # Поэтому при пустом поиске витрину спрашиваем ещё раз, уже без
        # слова. Ответ «по вашему слову нет, а вот что есть» продолжает
        # разговор; «ничего не нашлось» его заканчивает.
        if not rows and search:
            del params["or"]
            rows = await rest_get(client, "items", params)

            if rows:
                busy = await busy_map(client, rows)
                await message.answer(
                    f"По запросу «{search}» ничего нет. Вот что сдают сейчас:\n\n"
                    + "\n\n".join(item_line(row, busy.get(row["id"])) for row in rows)
                    + f"\n\nСпросите иначе — /найти дрель — или откройте "
                      f"витрину целиком: {APP_URL}",
                    parse_mode="HTML",
                    disable_web_page_preview=True,
                )
                return

    if not rows:
        # Сюда попадают двое: искавший в пустой витрине и открывший пустой
        # /каталог. Обоим звать смотреть витрину незачем — они только что
        # оттуда. Зато у обоих дома есть инструмент, и это ровно тот
        # момент, когда предложение сдать его осмысленно: спрос человек
        # показал сам, своим же запросом.
        await message.answer(
            "Витрина пока пуста — пилот только начался.\n\n"
            "Первое объявление можно выложить прямо отсюда: /сдать."
        )
        return

    # Витрина целиком из демонстрационных вещей — то же положение, которое
    # приложение объясняет полосой над списком. Значок у каждой строки
    # честен, но объясняет только строку: человек, пролиставший восемь
    # помеченных подряд, делает вывод не про них, а про платформу.
    all_demo = bool(rows) and all(is_demo(row) for row in rows)

    head = f"Нашёл по запросу «{search}»:" if search else "Свежие объявления:"
    if all_demo:
        head += (
            "\n\n🛠 Все вещи здесь демонстрационные: пилот в Кокшетау только "
            "набирает владельцев. Есть инструмент, который лежит без дела? "
            "Выложите — вашу вещь увидят первой: /сдать"
        )
    tail = (
        f"\n\nЗабронировать — в приложении: там календарь занятости и расчёт "
        f"стоимости.\n{APP_URL}"
    )
    await message.answer(
        head + "\n\n" + "\n\n".join(item_line(row, busy.get(row["id"])) for row in rows) + tail,
        parse_mode="HTML",
        disable_web_page_preview=True,
    )


# ── Свои вещи и пауза ─────────────────────────────────────────
#
# Зачем это в чате. Инструмент ломается не тогда, когда владелец сидит с
# телефоном в приложении, — он ломается на объекте. До сих пор в этот
# момент сделать было нечего: пауза жила только в «Моих вещах». Бронь
# тем временем оформляет кто-то ещё, и разбирать это придётся отменой
# уже подтверждённой сделки.
#
# Правил бот тут не знает: владельца проверяет item_set_status, а
# ограничение модератора — триггер items_verify_owner. Одно и то же на
# оба входа.


def my_item_line(row: dict) -> str:
    price = f"{row['daily_price']:,}".replace(",", " ")

    if row["moderated"]:
        state = "снято модератором"
    elif row["status"] == "hidden":
        state = "на паузе"
    else:
        state = "в каталоге"

    line = f"<b>{esc(row['title'])}</b>\n{price} ₸ / сутки · {state}"

    # Ориентир — не украшение строки, а ответ на «что у меня сейчас».
    # Без него кнопка ниже была бы вопросом без контекста: владелец не
    # помнит, писал он район или пропустил шаг, и нажал бы наугад.
    #
    # Отсутствие называется словами, а не пустотой. Пустое место читается
    # как «здесь ничего не бывает», а это поле как раз бывает — и на
    # витрине его отсутствие видит арендатор, решающий, ехать ли за вещью
    # через весь город.
    area = row.get("pickup_area")
    line += f"\n📍 {esc(area)}" if area else "\n📍 Ориентир не указан"

    # Причина показывается прямо здесь: в чате нет карточки объявления,
    # куда можно было бы отправить человека посмотреть, что исправлять.
    if row["moderated"] and row.get("moderated_why"):
        line += f"\n<i>{esc(row['moderated_why'])}</i>"

    return line


def item_keyboard(row: dict) -> InlineKeyboardMarkup | None:
    # У снятого модератором кнопки нет вовсе, а не кнопка с отказом:
    # нажатие всё равно упрётся в триггер, а кнопка, которая всегда
    # ошибается, хуже её отсутствия. Что делать, сказано строкой выше.
    if row["moderated"]:
        return None

    hidden = row["status"] == "hidden"
    label = "👁 Вернуть в каталог" if hidden else "⏸ Снять с публикации"
    action = "show" if hidden else "hide"

    # Подпись зависит от того, есть ли ориентир. «Изменить» на пустом поле
    # предлагает править то, чего нет, и владелец решает, что кнопка не про
    # него; «Добавить» на заполненном прячет правку. Разница в одном слове
    # стоит ровно того, ради чего кнопка появилась.
    pickup = "📍 Изменить ориентир" if row.get("pickup_area") else "📍 Добавить ориентир"

    return InlineKeyboardMarkup(
        inline_keyboard=[
            [InlineKeyboardButton(text=label, callback_data=f"i:{action}:{row['id']}")],
            [InlineKeyboardButton(text="💰 Изменить цену", callback_data=f"i:price:{row['id']}")],
            [InlineKeyboardButton(text=pickup, callback_data=f"i:pickup:{row['id']}")],
        ]
    )


def plural_ru(n: int, one: str, few: str, many: str) -> str:
    """
    Склонение существительного при числе — ТОЛЬКО слово, без числа.

    Это отличие от plural() в src/lib/format.ts, и оно важнее сходства:
    та возвращает «23 сделки» вместе с числом, эта — «сделки». Комментарий
    здесь до 05.09.2026 утверждал, что функции повторяют друг друга, и на
    этом попались: на трёх экранах появилось «23 23 сделки», причём один из
    трёх жил так задолго до правки.

    Разное поведение оставлено намеренно. В боте строки собираются
    f-строками, где число почти всегда уже стоит рядом по другой причине
    («ход по {n} {plural_ru(n, …)}»), а в приложении — JSX, где отдельное
    число легко забыть. Каждая версия удобна там, где живёт.

    Правило простое: здесь число пишете вы, там его пишет функция.
    """
    rest100 = n % 100
    if 11 <= rest100 <= 14:
        return many
    rest10 = n % 10
    if rest10 == 1:
        return one
    if 2 <= rest10 <= 4:
        return few
    return many


# ── Профиль ───────────────────────────────────────────────────
#
# Рейтинг и число сделок — первое, что спрашивает владелец, решая,
# продолжать ли сдавать. До сих пор ответ жил только на экране профиля, а
# бот — единственное место, куда владелец в пассивном режиме вообще
# заходит: сюда ему приходят уведомления.
#
# Телефона в ответе нет и быть не может: границу держит тип возврата
# bot_profile(), а не аккуратность этого файла.


async def start_price(query: CallbackQuery, state: FSMContext, item_id: str) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, query.from_user.id)
        if user is None:
            await ask_link_query(query)
            return

        try:
            rows = await rest_rpc(client, "bot_my_items", {"p_actor": user["id"]})
        except RentHubError as error:
            await query.answer(str(error), show_alert=True)
            return

    item = next((r for r in rows if r["id"] == item_id), None)
    if item is None:
        await query.answer("Объявление не найдено", show_alert=True)
        return

    await state.set_state(NewPrice.waiting)
    await state.update_data(item_id=item_id, title=item["title"])
    await query.answer()

    # Текущая цена показывается обязательно: человек меняет её относительно
    # той, что стоит сейчас, а держать её в голове он не обязан.
    await query.message.answer(
        f"Сейчас <b>{esc(item['title'])}</b> сдаётся за {money(item['daily_price'])} "
        f"в сутки.\n\n"
        "Напишите новую цену числом. Уже оформленные брони не изменятся — "
        "в них записана цена на момент заявки.\n\n"
        "Передумали — /отмена.",
        parse_mode="HTML",
    )


@dp.message(NewPrice.waiting, F.text)
async def on_new_price(message: Message, state: FSMContext) -> None:
    if (message.text or "").strip().startswith("/"):
        await message.answer("Идёт смена цены. Напишите число или /отмена.")
        return

    price = amount_or_none(message.text)
    if not price:
        await message.answer("Нужна сумма числом, например 3000.")
        return

    data = await state.get_data()

    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await state.clear()
            await ask_link(message)
            return

        try:
            await rest_rpc(
                client,
                "bot_set_item_price",
                {"p_actor": user["id"], "p_item_id": data["item_id"], "p_price": price},
            )
        except RentHubError as error:
            # Состояние не сбрасываем: «цена больше миллиона» — повод
            # написать другое число, а не начинать всё заново.
            await message.answer(str(error))
            return

    await state.clear()
    await message.answer(
        f"Новая цена: {money(price)} в сутки.\n"
        f"Ваш заработок: {money(round(price * 0.8))} — платформа удерживает 20%."
    )


# ── На всё остальное в этом состоянии отвечаем, а не молчим ───
#
# Молчащий бот в середине диалога читается как поломка: человек не знает,
# ждут от него чего-то или всё сломалось.


@dp.message(NewPrice.waiting)
async def on_price_wrong_input(message: Message) -> None:
    await message.answer("Здесь нужна новая цена числом. Или /отмена.")


# ── Ориентир: где забирать вещь ───────────────────────────────
#
# Шаг «где забирать» при публикации можно пропустить — кнопку предлагаем
# мы сами, — а пути назад в чате не было. Первое живое объявление
# платформы вышло на витрину без ориентира, рядом с восемью
# демонстрационными, у которых он есть.
#
# Правил бот здесь не знает: владельца проверяет item_set_pickup_area
# через assert_item_owner, длину — ограничение таблицы. Проверка длины
# ниже стоит не вместо них, а раньше: отказ базы после отправленного
# текста читается хуже, чем подсказка до.


async def start_pickup(query: CallbackQuery, state: FSMContext, item_id: str) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, query.from_user.id)
        if user is None:
            await ask_link_query(query)
            return

        try:
            rows = await rest_rpc(client, "bot_my_items", {"p_actor": user["id"]})
        except RentHubError as error:
            await query.answer(str(error), show_alert=True)
            return

    item = next((r for r in rows if r["id"] == item_id), None)
    if item is None:
        await query.answer("Объявление не найдено", show_alert=True)
        return

    await state.set_state(NewPickup.waiting)
    await state.update_data(item_id=item_id, title=item["title"])
    await query.answer()

    area = item.get("pickup_area")
    if area:
        head = f"Сейчас у «{esc(item['title'])}» указано: <b>{esc(area)}</b>."
    else:
        head = f"У «{esc(item['title'])}» ориентира нет."

    # Кнопка «убрать» показывается только тогда, когда есть что убирать.
    # Пустая кнопка на пустом поле — это выбор без разницы, и человек
    # тратит внимание, чтобы понять, что она ничего не делает.
    keyboard = None
    if area:
        keyboard = InlineKeyboardMarkup(
            inline_keyboard=[
                [InlineKeyboardButton(text="Убрать ориентир", callback_data=f"i:nopickup:{item_id}")]
            ]
        )

    await query.message.answer(
        head + "\n\n"
        "Напишите район или ориентир — «мкр. Васильковский», «возле "
        "вокзала». Точный адрес не нужен: его скажете тому, чью бронь "
        "подтвердите.\n\n"
        "Это видно в каталоге и помогает выбрать: вещь надо забрать и "
        "вернуть.\n\n"
        "Передумали — /отмена.",
        parse_mode="HTML",
        reply_markup=keyboard,
    )


@dp.message(NewPickup.waiting, F.text)
async def on_new_pickup(message: Message, state: FSMContext) -> None:
    if (message.text or "").strip().startswith("/"):
        await message.answer("Идёт правка ориентира. Напишите район или /отмена.")
        return

    area = (message.text or "").strip()

    # Границы те же, что в ограничении items_pickup_area_check и на шаге
    # публикации. Третьей копии чисел это не заводит: в базе они одни, а
    # здесь — та же вежливость, что и там.
    if len(area) < 2:
        await message.answer("Слишком коротко — напишите район или ориентир.")
        return
    if len(area) > 80:
        await message.answer("Слишком длинно. Хватит района или заметного ориентира.")
        return

    data = await state.get_data()

    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await state.clear()
            await ask_link(message)
            return

        try:
            await rest_rpc(
                client,
                "bot_set_item_pickup",
                {"p_actor": user["id"], "p_item_id": data["item_id"], "p_area": area},
            )
        except RentHubError as error:
            # Состояние не сбрасываем: отказ — повод написать другой текст,
            # а не проходить путь до кнопки заново.
            await message.answer(str(error))
            return

    await state.clear()
    await message.answer(
        f"Готово: забирать «{esc(data['title'])}» — {esc(area)}.\n"
        "Это увидят в каталоге.",
        parse_mode="HTML",
    )


@dp.message(NewPickup.waiting)
async def on_pickup_wrong_input(message: Message) -> None:
    await message.answer("Здесь нужен район или ориентир текстом. Или /отмена.")


@dp.message(F.text.in_({"/profile", "/профиль"}))
async def on_profile(message: Message) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await ask_link(message)
            return

        try:
            rows = await rest_rpc(client, "bot_profile", {"p_actor": user["id"]})
        except RentHubError as error:
            await message.answer(str(error))
            return

    if not rows:
        await message.answer("Профиль не найден. Попробуйте /start ещё раз.")
        return

    p = rows[0]

    # «Пока нет отзывов» вместо «0.0» — ноль здесь читается как плохая
    # оценка, хотя означает, что оценок ещё не было. То же правило, что в
    # ratingLabel() приложения.
    if p["ratings_count"]:
        rating = f"★ {float(p['rating']):.1f}".replace(".", ",")
        rating += f" · {p['ratings_count']} " + plural_ru(
            p["ratings_count"], "оценка", "оценки", "оценок"
        )
    else:
        rating = "Пока нет отзывов"

    lines = [
        f"<b>{esc(p['full_name'] or 'Без имени')}</b>",
        rating,
        f"Сделок завершено: {p['deals']}",
    ]

    if p["items_active"] or p["items_hidden"]:
        part = f"Объявлений в каталоге: {p['items_active']}"
        if p["items_hidden"]:
            part += f", скрыто: {p['items_hidden']}"
        lines.append(part)

    # Про подтверждённый номер пишем, только если он НЕ подтверждён: иначе
    # строка «номер подтверждён» висит у всех и ничего не сообщает.
    if not p["verified"]:
        lines.append("\n⚠️ Номер не подтверждён — сдавать и брать пока нельзя.")

    if p["passive_mode"]:
        lines.append(
            "\nПассивный режим включён: подтверждения и напоминания приходят сюда, "
            "следить за сделками самому не нужно."
        )

    await message.answer("\n".join(lines), parse_mode="HTML")


@dp.message(F.text.in_({"/items", "/вещи", "/мои"}))
async def on_my_items(message: Message) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await ask_link(message)
            return

        try:
            rows = await rest_rpc(client, "bot_my_items", {"p_actor": user["id"]})
        except RentHubError as error:
            await message.answer(str(error))
            return

    if not rows:
        await message.answer(
            "Вы пока ничего не сдаёте.\n\n"
            "Выложить вещь можно прямо здесь — /сдать."
        )
        return

    await message.answer(f"Ваши вещи · {len(rows)}")

    # Каждая вещь отдельным сообщением: кнопка относится к одной строке,
    # и общий список с кнопками внизу заставлял бы гадать, к чему они.
    for row in rows:
        await message.answer(
            my_item_line(row), parse_mode="HTML", reply_markup=item_keyboard(row)
        )


@dp.callback_query(F.data.startswith("i:"))
async def on_item_action(query: CallbackQuery, state: FSMContext) -> None:
    _, action, item_id = query.data.split(":", 2)

    if action == "price":
        await start_price(query, state, item_id)
        return

    if action == "pickup":
        await start_pickup(query, state, item_id)
        return

    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, query.from_user.id)
        if user is None:
            await ask_link_query(query)
            return

        # «Убрать ориентир» — та же функция, что и правка, с пустой
        # строкой: база читает её как «поле не заполнено». Отдельной
        # функции удаления нет намеренно — она была бы вторым местом, где
        # решают, чем пустой ориентир отличается от отсутствующего.
        if action == "nopickup":
            try:
                await rest_rpc(
                    client,
                    "bot_set_item_pickup",
                    {"p_actor": user["id"], "p_item_id": item_id, "p_area": ""},
                )
            except RentHubError as error:
                await query.answer(str(error), show_alert=True)
                return

            await state.clear()
            await query.answer("Убрал")
            await query.message.edit_reply_markup(reply_markup=None)
            await query.message.answer(
                "Ориентир убран. В каталоге объявление останется, но арендатор "
                "не увидит, куда ехать за вещью."
            )
            return

        status = "hidden" if action == "hide" else "active"

        try:
            await rest_rpc(
                client,
                "bot_set_item_status",
                {"p_actor": user["id"], "p_item_id": item_id, "p_status": status},
            )
        except RentHubError as error:
            await query.answer(str(error), show_alert=True)
            return

        # Клавиатура пересобирается тем же item_keyboard(), что рисовал её
        # в первый раз. До 05.09.2026 здесь стоял свой набор кнопок с
        # ОДНОЙ кнопкой в нём — и после паузы объявление теряло «Изменить
        # цену» до следующего /вещи. Кнопка, до которой нельзя
        # дотянуться, ничем не лучше отсутствующей, а вторая копия
        # правила «какие кнопки у объявления» разошлась с первой ровно в
        # тот день, когда кнопок стало три.
        #
        # Строка перечитывается, а не собирается из того, что мы помним:
        # подпись кнопки ориентира зависит от поля, которого у нас здесь
        # нет, а угаданная подпись — это та же копия правила, только тише.
        try:
            rows = await rest_rpc(client, "bot_my_items", {"p_actor": user["id"]})
        except RentHubError:
            rows = []

    await query.answer("Готово")

    row = next((r for r in rows if r["id"] == item_id), None)
    if row is not None:
        await query.message.edit_reply_markup(reply_markup=item_keyboard(row))
    await query.message.answer(
        "Вещь снята с публикации. Новых броней не будет; уже подтверждённые остаются."
        if action == "hide"
        else "Вещь снова в каталоге."
    )


@dp.message(F.text.in_({"/catalog", "/каталог"}))
async def on_catalog(message: Message) -> None:
    await show_catalog(message, None)


@dp.message(Command("find", "найти"))
async def on_find(message: Message) -> None:
    parts = (message.text or "").split(maxsplit=1)

    if len(parts) < 2 or not parts[1].strip():
        await message.answer("Напишите, что искать: /найти перфоратор")
        return

    await show_catalog(message, parts[1].strip())


# ── Претензия по порче ────────────────────────────────────────
#
# Единственный диалог в несколько шагов. Всё остальное бот делает одной
# кнопкой, и это не случайно: в чате каждый лишний шаг — это место, где
# человек отвлёкся и не вернулся. Здесь шагов два, потому что меньше не
# выходит: без фото претензию не примут, а сумму никто, кроме владельца,
# не назовёт.
#
# Проверяет всё open_damage_dispute: и что заявляет владелец, и что окно
# претензии не закрылось, и что фото есть. Бот только собирает.


async def start_damage(query: CallbackQuery, state: FSMContext, booking_id: str) -> None:
    await state.set_state(Damage.photos)
    await state.update_data(booking_id=booking_id, photos=[])
    await query.answer()

    # Фото «до» — первыми, до просьбы прислать «после».
    #
    # Текст ниже с самого начала обещал, что снимки «сверят с фото до», но
    # показать их было негде: в приложении они на экране сделки, в чате их
    # не было вовсе. Владелец решал, заявлять ли порчу, по памяти — а вещь
    # он видел неделю назад и мог помнить её лучше, чем она была.
    #
    # Цена ошибки несимметрична. Ложная претензия удерживает чужой депозит
    # и разбирается человеком; несделанная — стоит владельцу денег. Оба
    # исхода лучше решать, глядя на снимок, чем вспоминая.
    async with httpx.AsyncClient(timeout=20) as client:
        rows = await rest_get(
            client,
            "bookings",
            {
                "id": f"eq.{booking_id}",
                "select": "item:items(title,condition_photos)",
                "limit": "1",
            },
        )

    photos = ((rows[0].get("item") or {}) if rows else {}).get("condition_photos") or []

    if photos:
        try:
            # Медиагруппой, а не по одному: шесть отдельных сообщений
            # оттеснили бы просьбу прислать «после» за край экрана.
            await query.message.answer_media_group(
                [
                    InputMediaPhoto(
                        media=url,
                        caption="Фото «до» — как вещь выглядела при публикации"
                        if i == 0
                        else None,
                    )
                    for i, url in enumerate(photos[:6])
                ]
            )
        except Exception as error:  # noqa: BLE001
            # Снимок мог быть удалён владельцем — политика хранилища это
            # разрешает, и README разбирает это отдельным открытым вопросом.
            # Претензию это не отменяет: без фото «до» её разбирает
            # модератор, и карточка спора говорит ему, что сверять не с чем.
            log.warning("фото «до» не показать (%s): %s", booking_id, error)
            await query.message.answer(
                "Фото «до» показать не удалось — возможно, их удалили. "
                "Претензию это не отменяет: спор разберёт модератор."
            )

    await query.message.answer(
        "Пришлите фото повреждений — можно несколько подряд.\n\n"
        + ("Сверяйте с теми, что выше: спор разбирают по ним. "
           if photos
           else "Фото «до" + chr(0x00BB) + " у объявления нет, поэтому снимайте подробнее. ")
        + "Без снимков претензию не примут: спор без них — слово против слова.\n\n"
        "Передумали — /отмена."
    )


@dp.message(Damage.photos, F.photo)
async def on_damage_photo(message: Message, state: FSMContext) -> None:
    data = await state.get_data()
    photos = list(data.get("photos", []))

    if len(photos) >= 6:
        await message.answer("Шести снимков достаточно — нажмите «Фото всё».")
        return

    async with httpx.AsyncClient(timeout=60) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await state.clear()
            await ask_link(message)
            return

        # Берём самый крупный вариант: Telegram присылает лесенку размеров, а
        # спор разбирают по деталям — на превью царапину не видно.
        file = await message.bot.get_file(message.photo[-1].file_id)
        buffer = await message.bot.download_file(file.file_path)

        try:
            url = await upload_photo(client, user["id"], buffer.read())
        except RentHubError as error:
            await message.answer(str(error))
            return

    photos.append(url)
    await state.update_data(photos=photos)
    await message.answer(
        f"Принял, всего {len(photos)} фото.",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[[InlineKeyboardButton(text="✔️ Фото всё", callback_data="d:done")]]
        ),
    )


@dp.callback_query(F.data == "d:done", Damage.photos)
async def on_damage_done(query: CallbackQuery, state: FSMContext) -> None:
    data = await state.get_data()

    if not data.get("photos"):
        await query.answer("Сначала пришлите хотя бы одно фото", show_alert=True)
        return

    await state.set_state(Damage.amount)
    await query.answer()
    await query.message.edit_reply_markup(reply_markup=None)
    await query.message.answer(
        "Во сколько оцениваете ущерб? Напишите сумму в тенге, числом.\n\n"
        "Больше депозита удержать нельзя: назовёте больше — удержат депозит. "
        "Небольшие суммы закрываются автоматически, крупные смотрит модератор."
    )


@dp.message(Damage.amount, F.text)
async def on_damage_amount(message: Message, state: FSMContext) -> None:
    text = (message.text or "").strip()

    # Человек в середине диалога набрал команду — значит хотел выйти, а не
    # назвать сумму. Молча съесть «/deals» и ждать число значит запереть его.
    if text.startswith("/"):
        await message.answer("Сейчас идёт претензия. Закончите сумму или напишите /отмена.")
        return

    digits = re.sub(r"[^0-9]", "", text)
    if not digits:
        await message.answer("Нужна сумма числом, например 12000.")
        return

    data = await state.get_data()

    async with httpx.AsyncClient(timeout=30) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await state.clear()
            await ask_link(message)
            return

        try:
            await rest_rpc(
                client,
                "bot_open_damage_dispute",
                {
                    "p_actor": user["id"],
                    "p_booking_id": data["booking_id"],
                    "p_claim_amount": int(digits),
                    "p_photos": data["photos"],
                },
            )
        except RentHubError as error:
            await state.clear()
            await message.answer(str(error))
            return

    await state.clear()
    await message.answer(
        "Претензия подана. Дальше решает сумма: небольшие закрываются автоматически, "
        "крупные уходят модератору. Обе стороны получат уведомление, а фото видны "
        "в приложении на экране сделки."
    )


# ── Ответ не того вида в претензии ────────────────────────────
#
# Тот же случай, что в публикации, но дороже: претензия — это спор о
# деньгах. Человек прислал не то, бот промолчал, и претензия осталась
# неподанной — а окно на неё ограничено по времени.
#
# Регистрируются после основных: aiogram проверяет обработчики в порядке
# объявления, и поставленные выше перехватили бы правильные ответы.

@dp.message(Damage.photos)
async def on_damage_photos_wrong(message: Message) -> None:
    if (message.text or "").strip().startswith("/"):
        await message.answer("Идёт претензия. Пришлите фото или /отмена.")
        return
    await message.answer(
        "Здесь нужны снимки повреждений — пришлите фото. Именно с ними будут "
        "сверять состояние вещи, а текст этого не заменит."
    )


@dp.message(Damage.amount)
async def on_damage_amount_wrong(message: Message) -> None:
    await message.answer(
        "Осталась сумма ущерба — напишите её числом, например 8000. "
        "Фото уже приняты."
    )


# ── Доставка уведомлений ──────────────────────────────────────


async def deliver_pending(bot: Bot) -> None:
    """
    Одна волна доставки.

    Порядок «отправить → отметить» выбран сознательно: при падении между
    шагами человек получит уведомление дважды. Обратный порядок терял бы
    его молча, а повтор заметен и безобиден — в отличие от пропущенного
    напоминания о возврате.
    """
    async with httpx.AsyncClient(timeout=20) as client:
        pending = await rest_get(
            client,
            "notifications",
            {
                "sent_at": "is.null",
                "select": "id,title,body,user_id,booking_id,"
                "users!notifications_user_id_fkey(telegram_id),"
                "booking:bookings(id,status,owner_id,item:items(title))",
                "order": "created_at.asc",
                "limit": "50",
            },
        )

        for row in pending:
            chat_id = (row.get("users") or {}).get("telegram_id")

            if not chat_id:
                # Аккаунт не привязан — доставлять некуда. Отметку не ставим:
                # человек может привязать Telegram позже, и тогда всё, что
                # накопилось, придёт одной пачкой.
                continue

            text = f"<b>{esc(row['title'])}</b>"
            if row.get("body"):
                text += f"\n\n{esc(row['body'])}"

            # Кнопка прямо в уведомлении — то, ради чего бот вообще нужен
            # владельцу в пассивном режиме: «подтвердите бронь» без кнопки
            # означает «откройте приложение», то есть уведомление не
            # экономит ни одного шага.
            keyboard = None
            booking = row.get("booking")
            if booking:
                keyboard = action_keyboard(
                    booking["id"], booking["status"], row["user_id"] == booking["owner_id"]
                )

            try:
                await bot.send_message(
                    chat_id, text, parse_mode="HTML", reply_markup=keyboard
                )
            except TelegramForbiddenError:
                # Человек заблокировал бота или удалил чат. Это не сбой сети:
                # повторять бессмысленно, а мы повторяли — каждые пятнадцать
                # секунд, вечно, потому что отметку о доставке не ставили. За
                # неделю такой чат превращает очередь в свалку, и в ней тонет
                # то, что действительно не ушло.
                #
                # Привязка снимается: она и правда больше не работает. В
                # приложении профиль честно покажет «не подключено» и
                # предложит связать заново, а накопленные уведомления человек
                # увидит в ленте — они никуда не деваются, sent_at означает
                # только «ушло в чат».
                log.info("бот заблокирован, снимаю привязку: chat=%s", chat_id)
                await rest_patch(
                    client,
                    "users",
                    {"telegram_id": f"eq.{chat_id}"},
                    {"telegram_id": None, "telegram_username": None},
                )
                continue
            except Exception as error:  # noqa: BLE001 — причина пишется в лог
                # Всё остальное — сеть, таймаут, временный отказ Telegram.
                # Отметку не ставим намеренно: следующая волна повторит.
                log.warning("не доставлено %s: %s", row["id"], error)
                continue

            await rest_patch(client, "notifications", {"id": f"eq.{row['id']}"}, {"sent_at": "now()"})


async def heartbeat() -> None:
    """
    Отметка «я жив» — раз в цикл опроса.

    Зачем. `npm run health` считал доставку по очереди недоставленных
    уведомлений: старше десяти минут — тревога. Это ловит бота, умершего
    при живом потоке событий, и совсем не ловит умершего в тишине.

    Пилот на пять человек — это как раз тишина: сутки без единой брони
    обычны. Бот лежит, очередь пуста, health говорит «всё хорошо», и узнают
    об этом на первой же реальной сделке, уже после того как человек не
    получил подтверждения.

    Отметка переворачивает вопрос: не «есть ли невыполненная работа», а
    «когда о себе напомнил тот, кто её делает».

    Свои ошибки съедает молча. Бот существует, чтобы доставлять
    уведомления, и если отметка не записалась из-за сети — это повод для
    строки в журнале, а не для остановки доставки.
    """
    try:
        async with httpx.AsyncClient(timeout=10) as client:
            await client.post(
                f"{REST}/heartbeats",
                headers={**HEADERS, "Prefer": "resolution=merge-duplicates"},
                json={"name": "bot", "seen_at": "now()", "note": None},
            )
    except Exception as error:  # noqa: BLE001 — отметка не важнее доставки
        log.debug("отметка живости не записалась: %s", error)


async def notifier(bot: Bot) -> None:
    while True:
        try:
            await deliver_pending(bot)
        except Exception as error:  # noqa: BLE001 — цикл не должен умирать
            log.error("волна доставки упала: %s", error)

        # После доставки, а не до: отметка означает «цикл дошёл до конца»,
        # а не «процесс запустился». Первое полезнее — упавший в середине
        # цикл выглядел бы живым.
        await heartbeat()
        await asyncio.sleep(POLL_SECONDS)


# ── Последний рубеж: ни одно нажатие не остаётся без ответа ───
#
# Обработчики ловят RentHubError — отказ, который вернула база. Но есть
# второй класс сбоев, который они не ловят: сеть. Таймаут до Supabase,
# оборванное соединение, упавший DNS — всё это httpx.HTTPError, и до сих
# пор такое исключение уходило в лог aiogram, а человек не получал ничего.
#
# Молчание в ответ на нажатие читается как поломка приложения, причём без
# единой подсказки, что делать. Одна строка «попробуйте ещё раз» стоит
# дёшево и отвечает на главный вопрос: дело во мне или в них.


@dp.error()
async def on_any_error(event: ErrorEvent) -> None:
    log.exception("необработанная ошибка: %s", event.exception)

    text = (
        "Не получилось связаться с сервером. Попробуйте ещё раз через минуту — "
        "данные не потерялись."
    )

    update = event.update

    # Ответ сам может не пройти: у всплывающего окна к нажатию есть срок
    # около пятнадцати секунд, а сюда мы попадаем в том числе по таймауту в
    # двадцать. Поэтому окно и сообщение пробуются по очереди, и падение
    # ответа не должно ронять обработчик ошибок.
    if update.callback_query is not None:
        try:
            await update.callback_query.answer(text, show_alert=True)
            return
        except Exception:  # noqa: BLE001
            pass

        try:
            await update.callback_query.message.answer(text)
        except Exception:  # noqa: BLE001
            log.error("ответить на сбой не удалось")
        return

    if update.message is not None:
        try:
            await update.message.answer(text)
        except Exception:  # noqa: BLE001
            log.error("ответить на сбой не удалось")


# ── Последнее сообщение в файле: всё, что не разобрали выше ───
#
# Обработчик обязан стоять ПОСЛЕДНИМ: aiogram проверяет их в порядке
# объявления, и ловушка, поставленная раньше, съела бы команды и шаги
# диалогов.
#
# Зачем она нужна. Без неё бот на «не могу вернуть вещь, что делать»
# отвечал молчанием — обработчика на произвольный текст не было вовсе.
# Молчание читается как поломка, и человек в затруднении уходит вместе со
# сделкой, на которой висит депозит.


# Приглашение написать — одно на оба входа, кнопку и команду. Разойдись
# они, и человек, пришедший вторым путём, получил бы другие правила игры.
SUPPORT_PROMPT = (
    "Напишите, что случилось. Одним сообщением — его прочитает человек.\n\n"
    "Передумали — /отмена."
)


@dp.callback_query(F.data == "s:start")
async def on_support_start(query: CallbackQuery, state: FSMContext) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, query.from_user.id)

    if user is None:
        await ask_link_query(query)
        return

    await state.set_state(Support.waiting)
    await query.answer()
    await query.message.edit_reply_markup(reply_markup=None)
    await query.message.answer(SUPPORT_PROMPT)


# Та же дверь, но её видно.
#
# До 03.09.2026 написать организатору можно было ровно одним способом:
# отправить боту что-нибудь неизвестное и нажать кнопку под ответом «не
# понял». То есть возможность существовала, но открывалась по ошибке —
# человек, который сделал всё правильно, до неё не доходил.
#
# А искать он будет там, где ищут все: в меню рядом с полем ввода и в
# /help. В меню команды не было, в /help о поддержке не было ни слова —
# оба места отвечали «такого здесь нет». Дальше человек либо уходит, либо
# пишет организатору лично, если знает кому.
@dp.message(F.text.in_({"/support", "/поддержка"}))
async def on_support_command(message: Message, state: FSMContext) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)

    if user is None:
        # Сюда приходит человек с клиентского сайта: строка «Вопрос
        # организатору» в подвале ведёт на бота, и нажимает её как раз
        # тот, у кого аккаунта нет.
        #
        # Раньше он получал «Сначала свяжите Telegram» и упирался: /start
        # приводил к заявке на участие, а вопрос, ради которого он
        # пришёл, нигде не оставался. Обещание сайта — «напишите нам» —
        # выполнялось наполовину.
        #
        # Теперь путь назван целиком, и вопрос доезжает: после заявки
        # кнопка кладёт его в join_requests.note, то есть в ту же строку
        # очереди, где организатор видит номер и имя.
        await message.answer(
            "Пилот идёт по приглашениям, и аккаунта с этим чатом пока нет.\n\n"
            "Нажмите /start и поделитесь номером — это займёт одно нажатие. "
            "Сразу после этого можно будет написать вопрос: он уйдёт "
            "организатору вместе с заявкой."
        )
        return

    await state.set_state(Support.waiting)
    await message.answer(SUPPORT_PROMPT)


@dp.message(Support.waiting, F.text)
async def on_support_text(message: Message, state: FSMContext) -> None:
    if (message.text or "").strip().startswith("/"):
        await message.answer("Жду сообщение для организатора. Или /отмена.")
        return

    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await state.clear()
            await ask_link(message)
            return

        try:
            await rest_rpc(
                client,
                "submit_support_message",
                {"p_actor": user["id"], "p_text": message.text},
            )
        except RentHubError as error:
            # Состояние не сбрасываем: «напишите хотя бы пару слов» — повод
            # написать иначе, а не начинать заново.
            await message.answer(str(error))
            return

    await state.clear()
    await message.answer(
        "Передал. Ответ придёт сюда же — организатор пишет через того же бота.\n\n"
        "Пока можно посмотреть свои сделки: /сделки."
    )


@dp.message(Support.waiting)
async def on_support_wrong(message: Message) -> None:
    await message.answer("Здесь нужен текст сообщения. Или /отмена.")


@dp.message(F.text)
async def on_unknown(message: Message) -> None:
    await message.answer(
        "Не понял. Я знаю команды из меню рядом с полем ввода: сделки, "
        "каталог, поиск, мои вещи, профиль.\n\n"
        "Если это вопрос по сделке или что-то пошло не так — нажмите кнопку "
        "ниже, и следующее ваше сообщение уйдёт организатору. Ответ придёт "
        "сюда же.",
        reply_markup=InlineKeyboardMarkup(
            inline_keyboard=[[
                InlineKeyboardButton(text="✉️ Написать организатору", callback_data="s:start")
            ]]
        ),
    )


# Меню команд Telegram — та самая синяя кнопка рядом с полем ввода.
#
# Команд у бота семь, и до сих пор их знал только тот, кто дочитал /help.
# Это ровно то же, что кнопка без подписи: возможность есть, а увидеть её
# нельзя. Меню чинит это одним вызовом.
#
# Латиница здесь не выбор, а ограничение Telegram: в имени команды
# разрешены только строчные латинские буквы, цифры и подчёркивание.
# Русские алиасы (/сдать, /каталог, /найти) продолжают работать вводом —
# просто в меню их положить физически нельзя.
#
# /unlink в меню намеренно нет. Отвязка — редкое и неприятное действие
# рядом с ежедневными: в списке из шести пунктов промахнуться легко, а
# «отвязать» промахом читается как «бот сломался». В /help она осталась,
# и кто ищет — найдёт.
MENU = [
    BotCommand(command="deals", description="Мои сделки: что сдаю, что арендую"),
    BotCommand(command="catalog", description="Свежие объявления"),
    BotCommand(command="find", description="Поиск: /find перфоратор"),
    BotCommand(command="publish", description="Сдать свою вещь"),
    BotCommand(command="items", description="Мои объявления: пауза и публикация"),
    BotCommand(command="profile", description="Рейтинг, сделки, статус номера"),
    # Поддержка в меню, а не только кнопкой под «не понял». Человек, у
    # которого что-то пошло не так, ищет её здесь — и до 03.09.2026 не
    # находил: возможность открывалась только тому, кто отправил боту
    # что-нибудь неизвестное.
    BotCommand(command="support", description="Написать организатору"),
    BotCommand(command="help", description="Что я умею"),
    BotCommand(command="start", description="Связать Telegram с аккаунтом"),
]


async def main() -> None:
    bot = Bot(BOT_TOKEN)

    # Меню живёт на серверах Telegram, а не в коде: поставили один раз — и
    # оно на месте, даже пока бот лежит. Падение здесь не повод не
    # запускаться: без меню бот работает, просто команды приходится знать.
    try:
        await bot.set_my_commands(MENU, scope=BotCommandScopeAllPrivateChats())
    except Exception as error:  # noqa: BLE001
        log.warning("меню команд не обновилось: %s", error)

    asyncio.create_task(notifier(bot))
    log.info("бот запущен, опрос уведомлений раз в %s секунд", POLL_SECONDS)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
