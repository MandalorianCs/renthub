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
import json
import logging
import os
import re
import sys

# Консоль Windows по умолчанию не в UTF-8, и Python выводит в неё русский
# текст с заменами вида ✗ вместо символов. Одна строка снимает весь
# класс проблемы: сообщения бота читаются одинаково в PowerShell и в логах.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    sys.stderr.reconfigure(encoding="utf-8", errors="replace")

import httpx
from aiogram import Bot, Dispatcher, F
from aiogram.filters import CommandStart
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

dp = Dispatcher()


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
    ("returned", True): (("✅ Всё в порядке, закрыть", "complete"),),
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

    lines: list[str] = []

    def block(title: str, rows: list[dict], mine: bool) -> None:
        if not rows:
            return
        lines.append(f"<b>{title}</b>")
        for row in rows:
            item = (row.get("item") or {}).get("title") or "объявление удалено"
            status = STATUS_LABEL.get(row["status"], row["status"])
            # Владельцу показываем его выручку, арендатору — что он платит:
            # одна и та же сделка выглядит по-разному с двух сторон, и общая
            # сумма запутала бы обоих.
            amount = money(row.get("rent_total") if mine else row.get("renter_total"))
            lines.append(f"• {item} — {status}")
            lines.append(f"  {row['start_date']} → {row['end_date']} · {amount}")
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

    item = (row.get("item") or {}).get("title") or "объявление удалено"
    text = f"<b>{move['title']}</b>\n{item}\n\n{move['body']}"
    await send(text, parse_mode="HTML", reply_markup=keyboard)


# ── Нажатия ───────────────────────────────────────────────────


@dp.callback_query(F.data.startswith("a:"))
async def on_action(query: CallbackQuery) -> None:
    _, action, booking_id = query.data.split(":", 2)
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
        "/deals — активные сделки: что сдаёте и что арендуете\n"
        "/unlink — отвязать Telegram\n\n"
        "Уведомления о бронях, возвратах и спорах приходят сюда сами, "
        "и то, что зависит от вас, можно сделать кнопкой прямо в чате: "
        "подтвердить бронь, отметить получение и возврат, закрыть сделку, "
        "отменить заявку, поставить оценку.\n\n"
        "Витрина, публикация объявлений и споры с фото — в приложении: "
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

            text = f"<b>{row['title']}</b>"
            if row.get("body"):
                text += f"\n\n{row['body']}"

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
