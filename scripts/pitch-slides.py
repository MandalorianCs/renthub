#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
Дека двумя файлами: PDF для судей и PPTX для проектора.

    npm run pitch:pdf     только PDF
    npm run pitch:pptx    только PPTX
    npm run pitch:deck    оба сразу — так быстрее, слайды снимаются один раз

Оба файла собираются из одних и тех же снимков landing/pitch.html. Это и
есть главное решение этого скрипта, и оно стоило одной переделки.

Как было. PDF печатался браузером напрямую (--print-to-pdf), PPTX
собирался из снимков. Файлы расходились: печать раскладывает страницу по
СВОЕЙ ширине, а не по ширине окна, поэтому в PDF сетки схлопывались в две
колонки, подгон масштаба промахивался мимо настоящей высоты, и текст
наезжал на текст. Проверено 06.09.2026 постранично: на слайде
юнит-экономики верхняя метка и нижняя строка таблицы уходили за край
листа. Глеб сказал прямо: «pdf кривые, херово видно».

Как стало. Снимок — единственный способ увидеть слайд до сборки, и он же
единственный источник для обоих файлов. Что снято, то и в PDF, и в PPTX:
разойтись нечему.

Чем платим. Текст в PDF растровый — не выделяется и не ищется. Для
раздатки на защите это приемлемо: её открывают и смотрят. Взамен получаем
то, чего векторная печать не давала ни разу за три подхода, — гарантию,
что страница выглядит ровно так, как слайд на экране.

Числа деки по-прежнему проверяет npm run check:pitch по разметке
landing/pitch.html, а не по этим файлам.
"""

import hashlib
import io
import re
import subprocess
import sys
import tempfile
import time
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from threading import Thread

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

ROOT = Path(__file__).resolve().parent.parent
LANDING = ROOT / "landing"
DECK = LANDING / "pitch.html"
OUT_PDF = LANDING / "RentHUB-pitch.pdf"
OUT_PPTX = LANDING / "RentHUB-pitch.pptx"
PORT = 8901

# Кадр 16:9. Снимаем вдвое крупнее слайда (1920×1080 против 960×540
# читаемых), чтобы на проекторе и при печати на бумагу не рассыпалось.
SHOT_W, SHOT_H = 1920, 1080

# Страница PDF — тот же кадр в точках PostScript: 13.333 × 7.5 дюйма,
# стандартный слайд 16:9. Совпадает с размером слайда PPTX, то есть оба
# файла показывают судьям буквально одно и то же.
PAGE_W, PAGE_H = 960.0, 540.0

BROWSERS = [
    r"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    r"C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    r"C:/Program Files/Google/Chrome/Application/chrome.exe",
    r"C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
]


def find_browser():
    for path in BROWSERS:
        if Path(path).exists():
            return path
    return None


def serve():
    """Локальный сервер вместо file://.

    Из file:// Chromium не берёт часть шрифтов и SVG — слайд снимается в
    системном шрифте, и заметно это только в готовом файле, то есть
    поздно.
    """

    class Handler(SimpleHTTPRequestHandler):
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(LANDING), **kwargs)

        def log_message(self, *args):
            pass

    server = HTTPServer(("127.0.0.1", PORT), Handler)
    Thread(target=server.serve_forever, daemon=True).start()
    return server


def deck_fingerprint():
    """Отпечаток деки — тот же, что считает scripts/deck.mjs.

    Переводы строк нормализуются: локально файл лежит с CRLF, в
    репозитории с LF, и хеш сырого файла расходился на каждом прогоне CI.
    Проверка, которая падает всегда, учит не читать её вывод.
    """
    text = DECK.read_text(encoding="utf-8").replace("\r\n", "\n")
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def shoot(browser, tmp, n):
    """Снимок одного слайда. Возвращает путь к PNG."""
    shot = Path(tmp) / f"slide-{n:02d}.png"

    subprocess.run(
        [
            browser,
            "--headless=new",
            "--disable-gpu",
            # Свой профиль обязателен: без него запуск не создаёт процесс,
            # а передаёт команду уже открытому браузеру — и снимок не
            # появляется вовсе. На машине, где Edge открыт всегда, это
            # выглядит как «скрипт сломался», хотя сломан не он.
            f"--user-data-dir={Path(tempfile.gettempdir()) / 'renthub-deck-shots'}",
            "--hide-scrollbars",
            f"--window-size={SHOT_W},{SHOT_H}",
            f"--screenshot={shot}",
            # Странице нужно досчитать вёрстку и подгон масштаба. Меньше
            # четырёх секунд — и в кадр попадает слайд до подгона.
            "--virtual-time-budget=6000",
            f"http://127.0.0.1:{PORT}/pitch.html?slide={n}",
        ],
        capture_output=True,
        timeout=90,
    )

    # Chromium иногда возвращает управление раньше, чем допишет файл.
    for _ in range(20):
        if shot.exists() and shot.stat().st_size > 0:
            break
        time.sleep(0.3)

    return shot if shot.exists() else None


def build_pdf(shots):
    try:
        import fitz  # PyMuPDF
    except ImportError:
        print("\n✗ Нет PyMuPDF. Поставьте: pip install pymupdf\n")
        return False

    doc = fitz.open()
    for _, path in shots:
        page = doc.new_page(width=PAGE_W, height=PAGE_H)
        page.insert_image(fitz.Rect(0, 0, PAGE_W, PAGE_H), filename=str(path))

    # deflate жмёт плоские заливки деки вдвое; без него файл уходил за
    # двадцать мегабайт и не пролезал в мессенджер.
    doc.save(str(OUT_PDF), deflate=True, garbage=3)
    doc.close()

    # Отпечаток исходника рядом с файлом: по нему npm run check:pitch
    # понимает, не отстала ли раздатка от деки. Сравнение по времени
    # файлов не работает — git времени не хранит.
    Path(str(OUT_PDF) + ".sha").write_text(f"{deck_fingerprint()}\n", encoding="utf-8")
    return True


def build_pptx(shots):
    try:
        from pptx import Presentation
        from pptx.util import Inches
    except ImportError:
        print("\n✗ Нет python-pptx. Поставьте: pip install python-pptx\n")
        return False

    deck = Presentation()
    deck.slide_width = Inches(13.333)
    deck.slide_height = Inches(7.5)
    blank = deck.slide_layouts[6]

    for _, path in shots:
        slide = deck.slides.add_slide(blank)
        slide.shapes.add_picture(
            str(path), 0, 0, width=deck.slide_width, height=deck.slide_height
        )

    deck.save(str(OUT_PPTX))

    # Отпечаток рядом с файлом — тот же приём, что у PDF: иначе
    # презентация устаревает молча, а замечают это на защите.
    Path(str(OUT_PPTX) + ".sha").write_text(f"{deck_fingerprint()}\n", encoding="utf-8")
    return True


def main(argv):
    want_pdf = "--pdf" in argv or not ("--pdf" in argv or "--pptx" in argv)
    want_pptx = "--pptx" in argv or not ("--pdf" in argv or "--pptx" in argv)

    browser = find_browser()
    if not browser:
        print("\n✗ Не нашёл Chrome или Edge — снимать слайды нечем.")
        for p in BROWSERS:
            print(f"    {p}")
        return 1

    total = len(re.findall(r"<section", DECK.read_text(encoding="utf-8")))
    if total < 5:
        print(f"\n✗ В деке найдено {total} секций — образец сломан.\n")
        return 1

    server = serve()
    try:
        with tempfile.TemporaryDirectory() as tmp:
            shots = []
            for n in range(1, total + 1):
                shot = shoot(browser, tmp, n)
                if not shot:
                    print(f"\n✗ Слайд {n} не снялся.\n")
                    return 1
                shots.append((n, shot))
                print(f"  снят слайд {n:2d} — {round(shot.stat().st_size / 1024)} КБ")

            if want_pdf and not build_pdf(shots):
                return 1
            if want_pptx and not build_pptx(shots):
                return 1
    finally:
        server.shutdown()

    print()
    if want_pdf:
        print(f"✓ Раздатка: landing/{OUT_PDF.name} — {total} страниц, "
              f"{round(OUT_PDF.stat().st_size / 1024)} КБ")
    if want_pptx:
        print(f"✓ Презентация: landing/{OUT_PPTX.name} — {total} слайдов, "
              f"{round(OUT_PPTX.stat().st_size / 1024)} КБ")

    print("\n  Оба файла — снимки landing/pitch.html: текст в них не правится.")
    print("  Числа сверяет npm run check:pitch по разметке той же страницы.\n")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
