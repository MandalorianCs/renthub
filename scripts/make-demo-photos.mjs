#!/usr/bin/env node
// Заглушки для демонстрационной витрины.
//
//   npm run demo:photos     нарисовать восемь картинок в demo-photos/
//   npm run demo:fill       разложить их по объявлениям
//
// Зачем вообще картинки-заглушки. Пустой каталог на питче выглядит как
// неработающий продукт, даже когда работает всё: витрина без товара
// остаётся витриной без товара. Но и стоковый снимок инструмента виден
// сразу — студийный свет сообщает «настоящего здесь нет».
//
// Поэтому третий вариант: карточка в бренде, которая не притворяется
// фотографией. Она честно говорит «здесь будет фото владельца», и на
// показе это читается как незаполненное поле, а не как обман. Заменить —
// положить в demo-photos/ настоящие снимки и перезапустить demo:fill;
// скрипт берёт из папки всё, что найдёт.
//
// Порядок файлов важен: demo-listings раздаёт их инструментам по порядку
// сортировки, поэтому имена начинаются с номера.

import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Список повторяет TOOLS в demo-listings.mjs по порядку. Разойдутся —
// на карточке окажется чужое имя, и это заметит только тот, кто читает
// подпись, то есть никто.
const TOOLS = [
  ['01-perforator', 'Перфоратор', 'Bosch GBH 2-26'],
  ['02-ushm', 'УШМ', 'Makita 125 мм'],
  ['03-betonomeshalka', 'Бетономешалка', '140 литров'],
  ['04-lesa', 'Строительные леса', '4 секции'],
  ['05-shurupovert', 'Шуруповёрт', 'DeWalt 18V'],
  ['06-pila', 'Дисковая пила', 'Metabo 190 мм'],
  ['07-uroven', 'Лазерный уровень', '360 градусов'],
  ['08-vibroplita', 'Виброплита', '90 кг'],
];

const PY = `
import sys, json
from PIL import Image, ImageDraw, ImageFont

ROOT, TOOLS = sys.argv[1], json.loads(sys.argv[2])
FONTS = ROOT + "/node_modules/@expo-google-fonts/manrope/"
BOLD, MEDIUM = FONTS + "800ExtraBold/Manrope_800ExtraBold.ttf", FONTS + "500Medium/Manrope_500Medium.ttf"

CREAM, INK, TERRA, MUTED = (250,247,242), (26,25,23), (194,96,60), (140,133,122)
W, H = 1200, 900   # 4:3 — соотношение, в котором каталог показывает фото

def fit(d, text, path, start, max_w):
    size = start
    while size > 22:
        f = ImageFont.truetype(path, size)
        if d.textlength(text, font=f) <= max_w:
            return f
        size -= 2
    return ImageFont.truetype(path, 22)

for slug, name, spec in TOOLS:
    im = Image.new("RGB", (W, H), CREAM)
    d = ImageDraw.Draw(im)

    # Рамка вместо заливки: карточка читается как незаполненное место, а не
    # как готовая картинка. Штриховая — тем же приёмом, каким в интерфейсах
    # показывают «сюда можно положить».
    pad, dash = 56, 26
    for x in range(pad, W - pad, dash * 2):
        d.line([(x, pad), (min(x + dash, W - pad), pad)], fill=(226,219,208), width=3)
        d.line([(x, H - pad), (min(x + dash, W - pad), H - pad)], fill=(226,219,208), width=3)
    for y in range(pad, H - pad, dash * 2):
        d.line([(pad, y), (pad, min(y + dash, H - pad))], fill=(226,219,208), width=3)
        d.line([(W - pad, y), (W - pad, min(y + dash, H - pad))], fill=(226,219,208), width=3)

    avail = W - pad * 2 - 80
    f_name = fit(d, name, BOLD, 96, avail)
    f_spec = fit(d, spec, MEDIUM, 44, avail)
    f_note = ImageFont.truetype(MEDIUM, 30)
    note = "фото добавит владелец"

    bn = f_name.getbbox(name); bs = f_spec.getbbox(spec); bnote = f_note.getbbox(note)
    hn, hs, hnote = bn[3]-bn[1], bs[3]-bs[1], bnote[3]-bnote[1]
    gap1, gap2 = 28, 64
    total = hn + gap1 + hs + gap2 + hnote
    top = (H - total) / 2

    d.text(((W - d.textlength(name, font=f_name)) / 2, top - bn[1]), name, font=f_name, fill=INK)
    y = top + hn + gap1
    d.text(((W - d.textlength(spec, font=f_spec)) / 2, y - bs[1]), spec, font=f_spec, fill=MUTED)
    y += hs + gap2
    d.text(((W - d.textlength(note, font=f_note)) / 2, y - bnote[1]), note, font=f_note, fill=MUTED)

    # Точка из логотипа — единственный акцент: карточка принадлежит бренду,
    # но не выдаёт себя за снимок.
    d.ellipse([W/2 - 7, y + hnote + 34, W/2 + 7, y + hnote + 48], fill=TERRA)

    im.save(f"{ROOT}/demo-photos/{slug}.png")
    print("  demo-photos/" + slug + ".png")
`;

console.log('Рисую восемь заглушек для витрины…');
execFileSync('python', ['-c', PY, ROOT, JSON.stringify(TOOLS)], { stdio: 'inherit', cwd: ROOT });
console.log('\nГотово. Разложить по объявлениям: npm run demo:fill');
