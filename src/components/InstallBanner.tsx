import { useEffect, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing, typeface } from '../theme';

/**
 * Предложение поставить приложение на телефон.
 *
 * Зачем. Ссылку на RentHUB присылают в чате — так владелец в Кокшетау и
 * попадает в каталог. Дальше он либо закрывает вкладку, либо ставит иконку
 * на экран; второе случается, только если предложить.
 *
 * Браузер умеет предлагать сам, но делает это незаметно: значок в адресной
 * строке на десктопе и ничего на части телефонов. Поэтому ловим момент,
 * когда он готов, и показываем понятную кнопку в том месте, где человек уже
 * смотрит, — над каталогом.
 *
 * Показывается не всегда, и это правильно:
 *   • только на вебе — в собранном приложении ставить нечего;
 *   • только если браузер сказал, что готов (событие beforeinstallprompt);
 *   • один раз: закрыл — больше не спрашиваем.
 *
 * Отказ запоминается в localStorage, а не в состоянии: иначе баннер
 * вернётся на следующем экране и превратится в назойливость, от которой
 * закрывают всю вкладку.
 */

const DISMISSED = 'renthub.install.dismissed';

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

export function InstallBanner() {
  const [event, setEvent] = useState<InstallEvent | null>(null);

  useEffect(() => {
    if (Platform.OS !== 'web') return;

    const globalWindow = globalThis as unknown as Window & typeof globalThis;
    if (!globalWindow?.addEventListener) return;

    // Уже отказывался — не предлагаем снова.
    try {
      if (globalWindow.localStorage?.getItem(DISMISSED)) return;
    } catch {
      // Приватное окно или запрет хранилища: не повод прятать баннер, но и
      // не повод падать.
    }

    const onPrompt = (raw: Event) => {
      // Отменяем показ браузерного значка: мы покажем своё предложение —
      // в понятном месте и своими словами.
      raw.preventDefault();
      setEvent(raw as InstallEvent);
    };

    globalWindow.addEventListener('beforeinstallprompt', onPrompt);
    return () => globalWindow.removeEventListener('beforeinstallprompt', onPrompt);
  }, []);

  if (!event) return null;

  const close = () => {
    try {
      (globalThis as unknown as Window).localStorage?.setItem(DISMISSED, '1');
    } catch {
      // См. выше: хранилище может быть недоступно.
    }
    setEvent(null);
  };

  return (
    <View style={s.box}>
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={s.title}>Поставить на телефон</Text>
        <Text style={s.body}>
          Иконка на экране, открывается без браузера. Магазин не нужен.
        </Text>
      </View>

      <Pressable
        style={s.install}
        onPress={async () => {
          await event.prompt();
          // Что бы человек ни выбрал, второй раз это окно не покажется:
          // браузер выдаёт событие однократно.
          setEvent(null);
        }}
      >
        <Text style={s.installText}>Поставить</Text>
      </Pressable>

      <Pressable onPress={close} hitSlop={10} accessibilityLabel="Скрыть предложение">
        <Text style={s.close}>×</Text>
      </Pressable>
    </View>
  );
}

const s = StyleSheet.create({
  box: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    padding: spacing.md,
    marginBottom: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.greenSoft,
  },
  title: { fontSize: 14, fontFamily: typeface[700], color: colors.green },
  body: { fontSize: 13, lineHeight: 18, fontFamily: typeface[400], color: colors.green, opacity: 0.9 },
  install: {
    paddingHorizontal: 14,
    paddingVertical: 8,
    borderRadius: radius.pill,
    backgroundColor: colors.green,
  },
  installText: { fontSize: 13, fontFamily: typeface[700], color: colors.onFill },
  close: { fontSize: 20, fontFamily: typeface[600], color: colors.green, opacity: 0.6 },
});
