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
"""

import ast
import io
import sys
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

if not clashes:
    print(f"✓ bot.py: переопределений верхнего уровня нет ({len(where)} имён)")
    sys.exit(0)

print("✗ В bot.py имя определено дважды — победит последнее:\n")
for name, lines in sorted(clashes.items()):
    print(f"  {name} — строки {', '.join(map(str, lines))}")
print("\nПереименуйте позднее определение: молчаливое перекрытие ломает")
print("вызовы, которые рассчитывали на первое.")
sys.exit(1)
