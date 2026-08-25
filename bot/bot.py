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

Он не двигает статусы сделок. Переходы живут в RPC Postgres и опираются на
auth.uid(); у сервисного ключа такого идентификатора нет. Управление из
Telegram появится, когда бот научится получать пользовательский токен, —
иначе правила пришлось бы дублировать, и они разъехались бы (см. README,
раздел про Trust Score).
"""

import asyncio
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

    lines.append("Подробности и действия — в приложении:")
    lines.append("https://mandaloriancs.github.io/renthub/app/")

    await message.answer("\n".join(lines), parse_mode="HTML")


@dp.message(F.text.in_({"/help", "/помощь"}))
async def on_help(message: Message) -> None:
    await message.answer(
        "Что я умею:\n\n"
        "/start — связать Telegram с аккаунтом\n"
        "/deals — активные сделки: что сдаёте и что арендуете\n"
        "/unlink — отвязать Telegram\n\n"
        "Уведомления о бронях, возвратах и спорах приходят сюда сами."
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
                "select": "id,title,body,users!notifications_user_id_fkey(telegram_id)",
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

            try:
                await bot.send_message(chat_id, text, parse_mode="HTML")
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
