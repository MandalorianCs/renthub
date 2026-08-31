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
from aiogram.filters import Command, CommandStart
from aiogram.fsm.context import FSMContext
from aiogram.fsm.state import State, StatesGroup
from aiogram.fsm.storage.memory import MemoryStorage
from aiogram.types import (
    CallbackQuery,
    InlineKeyboardButton,
    InlineKeyboardMarkup,
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

APP_URL = "https://mandaloriancs.github.io/renthub/app/"

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
)


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
    ("confirmed", False): (("📦 Забрал вещь", "picked_up"),),
    ("active", True): (("📥 Принял вещь обратно", "returned"),),
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
    "cancel": "Заявка отменена, даты снова свободны.",
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


@dp.message(CommandStart())
async def on_start(message: Message) -> None:
    await message.answer(
        "RentHUB — аренда инструмента у соседей.\n\n"
        "Нажмите кнопку ниже, чтобы связать Telegram с вашим аккаунтом. "
        "После этого сюда будут приходить уведомления по сделкам: "
        "подтверждения броней, напоминания о возврате, решения по спорам.\n\n"
        "Команда /deals покажет активные сделки, /help — всё остальное.",
        reply_markup=SHARE_KEYBOARD,
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
            await message.answer(
                f"Номер {phone} не найден среди участников пилота.\n\n"
                "Пилот идёт по приглашениям: напишите организатору, он заведёт "
                "аккаунт и выдаст пароль. После этого вернитесь сюда.",
                reply_markup=ReplyKeyboardRemove(),
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

# Подписи статусов повторяют src/lib/format.ts. Дублирование здесь
# осознанное и минимальное: переносить тексты интерфейса в базу ради
# одного списка — плохой размен, а расхождение заметно сразу и правится
# в двух местах. Правило противоположно тому, что в Postgres: там живут
# правила перехода, здесь — только их названия.
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
    """Тенге с разделителем разрядов — как formatTenge в приложении."""
    return f"{value or 0:,}".replace(",", " ") + " ₸"


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

    await state.clear()
    await message.answer(
        "Отменил, претензию не подал. Загруженные снимки остались в хранилище — "
        "они никому не показываются, пока претензии нет."
    )


@dp.message(F.text.in_({"/deals", "/сделки"}))
async def on_deals(message: Message) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        found = await rest_get(
            client,
            "users",
            {"telegram_id": f"eq.{message.from_user.id}", "select": "id,full_name", "limit": "1"},
        )

        if not found:
            await message.answer(
                "Сначала свяжите Telegram с аккаунтом — нажмите /start и поделитесь номером."
            )
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
                    "select": "id,status,start_date,end_date,rent_total,renter_total,"
                    "item:items(title)",
                    "order": "start_date.asc",
                    "limit": "20",
                },
            )
            for role in ("owner_id", "renter_id")
        ]

    if not as_owner and not as_renter:
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
            lines.append(f"• {item} — {status}")
            lines.append(f"  {row['start_date']} → {row['end_date']} · {amount}"
                         + contact_line(contacts.get(row["id"])))
        lines.append("")

    block("Сдаёте", as_owner, mine=True)
    block("Арендуете", as_renter, mine=False)

    lines.append("Подробности — в приложении:")
    lines.append("https://mandaloriancs.github.io/renthub/app/")

    await message.answer("\n".join(lines), parse_mode="HTML")


    # Отдельными сообщениями — только то, где ход за человеком. Кнопка под
    # каждой из двадцати сделок превратила бы чат в ленту, а владельца в
    # пассивном режиме дёргают ровно там, где без него сделка не сдвинется.
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
    if not move.get("yours"):
        return

    # Клавиатуры может не быть, и карточка всё равно нужна: у арендатора в
    # «active» ход за ним — вернуть вовремя, — но нажимать нечего. Молчание
    # здесь означало бы, что человек узнает о просрочке только из спора.
    keyboard = action_keyboard(row["id"], row["status"], is_owner)

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

    fn = RPC_BY_ACTION.get(action)

    if fn is None:
        await query.answer("Не знаю такого действия", show_alert=True)
        return

    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, query.from_user.id)
        if user is None:
            await query.answer("Сначала свяжите Telegram — /start", show_alert=True)
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
            await query.answer("Сначала свяжите Telegram — /start", show_alert=True)
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
        "/сдать — опубликовать свою вещь, не открывая приложение\n\n"
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
# Правила публикации бот не знает: верификацию, блокировку, длину названия
# и цену больше нуля проверяет create_item() вместе с триггерами таблицы.
# Здесь только сбор ответов и понятные вопросы.


def amount_or_none(text: str) -> int | None:
    digits = re.sub(r"[^0-9]", "", text or "")
    return int(digits) if digits else None


@dp.message(F.text.in_({"/publish", "/сдать"}))
async def on_publish(message: Message, state: FSMContext) -> None:
    async with httpx.AsyncClient(timeout=20) as client:
        user = await user_by_telegram(client, message.from_user.id)
        if user is None:
            await message.answer("Сначала свяжите Telegram — /start")
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
    await state.update_data(category=query.data.split(":", 1)[1])
    await state.set_state(NewItem.title)
    await query.answer()
    await query.message.edit_reply_markup(reply_markup=None)
    await query.message.answer(
        "Название — коротко и узнаваемо: «Перфоратор Bosch GBH 2-26».\n\n"
        "По нему ищут, поэтому марка и модель работают лучше, чем «хороший инструмент»."
    )


@dp.message(NewItem.title, F.text)
async def on_item_title(message: Message, state: FSMContext) -> None:
    title = (message.text or "").strip()

    if title.startswith("/"):
        await message.answer("Идёт публикация. Напишите название или /отмена.")
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
            await message.answer("Сначала свяжите Telegram — /start")
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
            await query.answer("Сначала свяжите Telegram — /start", show_alert=True)
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

    await state.clear()
    await query.answer("Опубликовано")
    await query.message.edit_reply_markup(reply_markup=None)
    await query.message.answer(
        f"Готово, объявление на витрине.\n{APP_URL}#/item/{item_id}\n\n"
        "Когда его забронируют, я напишу — подтвердить можно будет кнопкой отсюда."
    )


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
CONTACT_STATUSES = ("confirmed", "active", "returned", "disputed")


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


def item_line(row: dict) -> str:
    owner = row.get("owner") or {}
    rating = owner.get("rating")
    # Оценку показываем только когда она есть. «0.0» рядом с новым владельцем
    # читается как «плохой», хотя верно «его ещё не оценивали».
    mark = f" · ★ {rating}" if rating else ""
    # Где забирать — то же, что показывает карточка каталога в приложении.
    # Пустое поле строкой не занимаем: у части вещей ориентира нет, и
    # выдуманное «Кокшетау» вместо него ничего не сообщает.
    area = f"\n  📍 {esc(row['pickup_area'])}" if row.get("pickup_area") else ""
    return (
        f"• <b>{esc(row['title'])}</b> — {money(row.get('daily_price'))} / сутки\n"
        f"  депозит {money(row.get('deposit_amount'))}{mark}{area}\n"
        f"  {APP_URL}#/item/{row['id']}"
    )


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
        params["or"] = (
            f"(title.ilike.*{clean}*,description.ilike.*{clean}*,"
            f"pickup_area.ilike.*{clean}*)"
        )

    async with httpx.AsyncClient(timeout=20) as client:
        rows = await rest_get(client, "items", params)

    if not rows:
        await message.answer(
            "Ничего не нашлось.\n\n"
            "Витрина пилота — только Кокшетау и только инструмент. "
            f"Посмотреть целиком: {APP_URL}"
        )
        return

    head = f"Нашёл по запросу «{search}»:" if search else "Свежие объявления:"
    tail = (
        f"\n\nЗабронировать — в приложении: там календарь занятости и расчёт "
        f"стоимости.\n{APP_URL}"
    )
    await message.answer(
        head + "\n\n" + "\n\n".join(item_line(row) for row in rows) + tail,
        parse_mode="HTML",
        disable_web_page_preview=True,
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
    await query.message.answer(
        "Пришлите фото повреждений — можно несколько подряд.\n\n"
        "Их сверят с фото «до», снятыми при публикации. Без снимков претензию "
        "не примут: спор без них — слово против слова.\n\n"
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
            await message.answer("Сначала свяжите Telegram — /start")
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
            await message.answer("Сначала свяжите Telegram — /start")
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
            except Exception as error:  # noqa: BLE001 — причина пишется в лог
                log.warning("не доставлено %s: %s", row["id"], error)
                continue

            await rest_patch(client, "notifications", {"id": f"eq.{row['id']}"}, {"sent_at": "now()"})


async def notifier(bot: Bot) -> None:
    while True:
        try:
            await deliver_pending(bot)
        except Exception as error:  # noqa: BLE001 — цикл не должен умирать
            log.error("волна доставки упала: %s", error)
        await asyncio.sleep(POLL_SECONDS)


async def main() -> None:
    bot = Bot(BOT_TOKEN)
    asyncio.create_task(notifier(bot))
    log.info("бот запущен, опрос уведомлений раз в %s секунд", POLL_SECONDS)
    await dp.start_polling(bot)


if __name__ == "__main__":
    asyncio.run(main())
