#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Опечатки в том, что видят судьи.

    npm run check:spell

Зачем. Опечатка на слайде — единственная ошибка, которую замечают все и
сразу, включая тех, кто не разбирается ни в базе, ни в экономике. Она
дешевле любой другой в исправлении и дороже любой другой в цене: на
слайде про «правила, которые невозможно обойти» она читается как «а
проверяли ли они остальное».

Что проверяем. Текст из готового PDF — буквально то, что увидит человек.
Не разметку: в pitch.html полторы тысячи строк комментариев и CSS, и
проверять их значит утонуть в «transform», «tile» и «var». Пробовали —
двести замечаний, из них ноль настоящих.

Чем проверяем. Яндекс.Спеллер: открытый API без ключа, знает русскую
морфологию. Ответ — список слов с вариантами замены.

Словарь ниже — то, что спеллер не знает, а мы знаем: названия, термины
экономики и инструмент. Каждое слово в нём добавлено руками после того,
как проверка на него пожаловалась.
"""

import io
import json
import sys
import urllib.parse
import urllib.request
from pathlib import Path

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
PDF = ROOT / "landing" / "RentHUB-pitch.pdf"

API = "https://speller.yandex.net/services/spellservice.json/checkText"

# Слова, которых спеллер не знает, а мы знаем.
#
# Список ведётся руками: автоматическое пополнение превратило бы проверку
# в согласие с любой опечаткой, которую однажды пропустили.
KNOWN = {
    # Название и продукт
    "renthub", "кокшетау", "васильковский", "терриконовой", "инк",
    # Технологии
    "supabase", "postgres", "postgresql", "telegram", "github", "kaspi",
    "expo", "mvp", "sms", "rls", "api", "json", "sql", "pay",
    # Экономика
    "ltv", "cac", "arpu", "arppu", "cogs", "cpa", "unit", "payback",
    "take", "rate", "gp", "ua", "c1", "cm", "юнит", "юнита", "юните",
    "маркетплейс", "маркетплейса", "маркетплейсы", "красинского",
    # Инструмент
    "перфоратор", "перфоратора", "перфораторы", "виброплита", "виброплиту",
    "шуруповёрт", "шуруповёрты", "шуруповёрта", "ушм", "лобзик", "лобзика",
    "штроборез", "плиткорез", "бетономешалка", "бетономешалки", "отбойник",
    "отбойники", "стремянка", "стремянки", "мойка", "гбх", "gst", "gbh",
    "bosch", "makita", "metabo", "dewalt", "интерскол",
    # Прочее
    "офлайн", "скринридер", "скринридера", "хронометраж", "деке", "деки",
    "дека", "декой", "питч", "питча", "питче", "бэкенд", "бэкенде",
    "триггеры", "триггерами", "эскроу", "эквайринг", "тенге",
    # Спеллер предлагает «Телеграмм» с двумя «м» — это старая норма;
    # современные словари и сам мессенджер пишут «Телеграм».
    "телеграм", "телеграм-бот",
    # Слова, на которые спеллер жалуется без причины.
    "точки",
}


def visible_text() -> str:
    """Текст из PDF — ровно то, что увидит человек."""
    try:
        import fitz
    except ImportError:
        print("\n✗ Нет PyMuPDF. Поставьте: pip install pymupdf\n")
        raise SystemExit(1)

    if not PDF.exists():
        print("\n✗ Нет landing/RentHUB-pitch.pdf — соберите: npm run pitch:pdf\n")
        raise SystemExit(1)

    doc = fitz.open(str(PDF))
    text = "\n".join(doc[i].get_text() for i in range(doc.page_count))
    doc.close()
    return text


def check(chunk: str) -> list[dict]:
    """Один запрос к спеллеру. Пустой ответ означает «ошибок нет»."""
    # options=2 — не жаловаться на слова с большой буквы посреди строки:
    # у нас так пишутся названия и заголовки слайдов.
    # POST, а не GET: текст слайдов не помещается в адресную строку —
    # первый же запрос вернул 414 «Request uri too large».
    data = urllib.parse.urlencode(
        {"text": chunk, "lang": "ru", "options": 2 + 512}
    ).encode("utf-8")

    request = urllib.request.Request(API, data=data)
    with urllib.request.urlopen(request, timeout=30) as response:
        return json.loads(response.read().decode("utf-8"))


def main() -> int:
    text = visible_text()

    print("\n── Опечатки в деке ──")
    print(f"  проверяю {len(text)} символов из готового PDF")

    found: dict[str, list[str]] = {}

    # Спеллер принимает около десяти тысяч символов за раз; режем по
    # строкам, чтобы не рвать слова пополам.
    chunk = ""
    chunks = []

    for line in text.split("\n"):
        if len(chunk) + len(line) > 4000:
            chunks.append(chunk)
            chunk = ""
        chunk += line + "\n"

    if chunk.strip():
        chunks.append(chunk)

    for part in chunks:
        try:
            for hit in check(part):
                word = hit.get("word", "")
                if word.lower() in KNOWN:
                    continue
                # Слова из цифр и латиницы спеллер иногда принимает за
                # русские: «GST 700» превращается в предложение заменить.
                if not any("а" <= c.lower() <= "я" or c.lower() == "ё" for c in word):
                    continue
                found.setdefault(word, hit.get("s", []))
        except Exception as error:  # noqa: BLE001 — сеть не повод ронять сборку
            print(f"  ! спеллер не ответил ({error}) — проверка пропущена")
            return 0

    if not found:
        print("  ok  опечаток не найдено")
        print("\n✓ Судья не найдёт ошибки раньше нас.\n")
        return 0

    print(f"\n  ??  подозрительных слов: {len(found)}\n")
    for word, hints in sorted(found.items()):
        variants = ", ".join(hints[:3]) if hints else "вариантов нет"
        print(f"  {word:24} → {variants}")

    print("\n  Если слово написано верно — добавьте его в KNOWN в этом файле.")
    print("  Список ведётся руками: автоматическое пополнение согласилось бы")
    print("  с любой опечаткой, которую однажды пропустили.\n")
    return 1


if __name__ == "__main__":
    sys.exit(main())
