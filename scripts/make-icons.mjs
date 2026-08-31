#!/usr/bin/env node
// Заглушка вместо иконок Expo.
//
//   npm run icons
//
// Пересобирает assets/*.png и landing/assets/og.png из того же знака, что
// лежит в landing/assets/favicon.svg: кремовая подложка, буква «R» шрифтом
// Manrope ExtraBold и терракотовая точка из логотипа «RentHUB.».
//
// Зачем скрипт, а не восемь файлов в репозитории. Знак временный: у проекта
// нет логотипа, и когда он появится, всё это надо будет переделать. Один
// генератор переделывается правкой трёх констант, восемь бинарников —
// перерисовкой каждого, и они разъедутся по оттенкам.
//
// Растеризует Python с Pillow: cairosvg и sharp в проекте нет, ставить их
// ради разовой картинки дороже, чем нарисовать примитивами. Буква берётся
// настоящим Manrope из node_modules — тем же файлом, который грузит
// приложение, поэтому знак совпадает с логотипом, а не похож на него.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

const PY = `
import sys
from PIL import Image, ImageDraw, ImageFont

ROOT = sys.argv[1]
FONT = ROOT + "/node_modules/@expo-google-fonts/manrope/800ExtraBold/Manrope_800ExtraBold.ttf"

CREAM   = (250, 247, 242, 255)   # bg
INK     = (26, 25, 23, 255)      # text
TERRA   = (194, 96, 60, 255)     # accent
BORDER  = (231, 224, 214, 255)   # border

def draw_mark(size, bg, ink, terra, scale=0.62, border=False):
    """Знак на холсте size x size. scale - доля холста под букву."""
    im = Image.new("RGBA", (size, size), bg)
    d = ImageDraw.Draw(im)

    if border:
        w = max(2, size // 32)
        r = size // 4.6
        d.rounded_rectangle([w/2, w/2, size-w/2, size-w/2], radius=r,
                            outline=BORDER, width=w)

    # Буква рисуется по реальным границам глифа, а не по метрикам шрифта:
    # у Manrope есть верхний и нижний свес, и центрирование по строке
    # уводит букву вниз. anchor="mm" тут не спасает по той же причине.
    fs = int(size * scale)
    font = ImageFont.truetype(FONT, fs)
    box = d.textbbox((0, 0), "R", font=font)
    gw, gh = box[2] - box[0], box[3] - box[1]

    # Точка стоит справа от буквы, как в логотипе «RentHUB.». Её диаметр и
    # зазор заданы долей кегля, чтобы знак не разъезжался при смене размера.
    dot_r = fs * 0.115
    gap = fs * 0.10
    total_w = gw + gap + dot_r * 2

    x = (size - total_w) / 2 - box[0]
    y = (size - gh) / 2 - box[1]
    d.text((x, y), "R", font=font, fill=ink)

    cx = x + box[0] + gw + gap + dot_r
    cy = y + box[1] + gh - dot_r
    d.ellipse([cx - dot_r, cy - dot_r, cx + dot_r, cy + dot_r], fill=terra)
    return im

out = []

# iOS и веб: квадрат заливается целиком, без скруглений и прозрачных
# пикселей - маску накладывает сама система (док Expo про app icon).
icon = draw_mark(1024, CREAM, INK, TERRA, scale=0.58).convert("RGB")
icon.save(ROOT + "/assets/icon.png"); out.append("assets/icon.png 1024 RGB")

fav = draw_mark(48, CREAM, INK, TERRA, scale=0.62, border=True)
fav.save(ROOT + "/assets/favicon.png"); out.append("assets/favicon.png 48")

# Android adaptive: передний план обрезается по кругу, и гарантированно
# видна только центральная зона (66/108 холста). Поэтому знак здесь мельче,
# а фон вынесен отдельным слоем - его размеры обязаны совпадать.
fg = draw_mark(512, (0, 0, 0, 0), INK, TERRA, scale=0.34)
fg.save(ROOT + "/assets/android-icon-foreground.png"); out.append("android-icon-foreground.png 512")

bg = Image.new("RGBA", (512, 512), CREAM)
bg.save(ROOT + "/assets/android-icon-background.png"); out.append("android-icon-background.png 512")

# Монохром: Android 13+ перекрашивает его под обои, поэтому цвет здесь не
# смысловой - важен силуэт. Точка тем же тоном, иначе она пропадёт.
mono = draw_mark(432, (0, 0, 0, 0), INK, INK, scale=0.34)
mono.save(ROOT + "/assets/android-icon-monochrome.png"); out.append("android-icon-monochrome.png 432")

# Фавикон сайта в PNG рядом с SVG. Вектор понимают не все: Safari до 16,
# часть агрегаторов и превью в мессенджерах берут PNG. Без него на вкладке
# у части людей остаётся пустой лист.
site_fav = draw_mark(32, CREAM, INK, TERRA, scale=0.62)
site_fav.save(ROOT + "/landing/assets/favicon-32.png")
out.append("landing/assets/favicon-32.png 32")

# apple-touch-icon: то, что iOS ставит на домашний экран. Без него берётся
# скриншот страницы - для ярлыка это нечитаемо. Заливка обязательна:
# прозрачность iOS не поддерживает и подставляет чёрный.
touch = draw_mark(180, CREAM, INK, TERRA, scale=0.58)
touch.save(ROOT + "/landing/assets/apple-touch-icon.png")
out.append("landing/assets/apple-touch-icon.png 180")

# Карточка ссылки: og:image. 1200x630 - размер, который берут Telegram,
# WhatsApp и соцсети; без неё ссылка выглядит голой строкой.
OG_W, OG_H = 1200, 630
PAD = 96
og = Image.new("RGB", (OG_W, OG_H), CREAM[:3])
d = ImageDraw.Draw(og)

mark_size = 260
mark = draw_mark(mark_size, (0, 0, 0, 0), INK, TERRA, scale=0.70)
text_x = PAD + mark_size + 64

MEDIUM = ROOT + "/node_modules/@expo-google-fonts/manrope/500Medium/Manrope_500Medium.ttf"

def fit(text, path, start, max_w):
    """Кегль, при котором строка влезает в max_w.

    Подбором, а не на глаз: первая версия этой карточки обрезала вторую
    строку по правому краю, и заметить это можно было только посмотрев
    на картинку. Дешевле спросить у шрифта, чем полагаться на глазомер.
    """
    size = start
    while size > 20:
        f = ImageFont.truetype(path, size)
        if d.textlength(text, font=f) <= max_w:
            return f
        size -= 2
    return ImageFont.truetype(path, 20)

title = "RentHUB."
sub1 = "Аренда инструмента у соседей"
sub2 = "Кокшетау · депозит, проверка и рейтинг"
avail = OG_W - text_x - PAD

f_title = fit(title, FONT, 92, avail)
f_sub = fit(sub2, MEDIUM, 38, avail)

# Блок текста и знак центрируются вместе: считаем высоту блока и ставим
# его по середине холста, иначе снизу остаётся пустая полоса.
gap1, gap2 = 26, 14
h_title = f_title.getbbox(title)[3] - f_title.getbbox(title)[1]
h_sub = f_sub.getbbox(sub1)[3] - f_sub.getbbox(sub1)[1]
block_h = h_title + gap1 + h_sub + gap2 + h_sub
top = (OG_H - block_h) / 2

og.paste(mark, (PAD, int((OG_H - mark_size) / 2)), mark)

y = top - f_title.getbbox(title)[1]
d.text((text_x, y), title, font=f_title, fill=INK)
y = top + h_title + gap1 - f_sub.getbbox(sub1)[1]
d.text((text_x, y), sub1, font=f_sub, fill=(110, 103, 94))
y += h_sub + gap2
d.text((text_x, y), sub2, font=f_sub, fill=(110, 103, 94))

og.save(ROOT + "/landing/assets/og.png")
out.append("landing/assets/og.png %dx%d" % (OG_W, OG_H))

for line in out:
    print("  " + line)
`;

console.log('Собираю знак из Manrope ExtraBold…');
execFileSync('python', ['-c', PY, ROOT], { stdio: 'inherit', cwd: ROOT });
console.log('\nГотово. Иконки пересобраны из одного знака.');
