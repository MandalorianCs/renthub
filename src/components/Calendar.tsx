import Ionicons from '@expo/vector-icons/Ionicons';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import { eachDay, todayISO, toISO } from '../lib/dates';
import type { BusyRange } from '../lib/types';
import { colors, radius, spacing, typeface } from '../theme';

// toISO нужен и карточке вещи — она импортирует его отсюда с самого
// начала. Отдаём дальше, а не переписываем чужой импорт: сама функция
// теперь живёт в src/lib/dates.ts вместе с остальным разбором суток.
export { toISO };

/**
 * Выбор интервала аренды.
 *
 * Раньше даты вводились текстом в формате ГГГГ-ММ-ДД — человек должен был
 * угадать формат и при этом не знал, какие дни заняты. Календарь решает обе
 * задачи сразу: занятое физически нельзя нажать, а формат вводить не нужно.
 *
 * Занятые дни приходят из item_busy_dates() — той самой функции, которая
 * показывает занятость постороннему, не раскрывая чужие сделки.
 */

const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
const MONTHS = [
  'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
  'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
];

/**
 * Разворачиваем интервалы в множество занятых дней.
 *
 * Раньше цикл разбирал границы через `new Date(r.start_date)` — то есть
 * как полночь UTC, — а сравнивал с местными сутками. Западнее Гринвича
 * календарь гасил не тот день: свободный выглядел занятым, а занятый
 * оставался нажимаемым до отказа базы. Разбор теперь в eachDay().
 */
function busyDaySet(ranges: BusyRange[]): Set<string> {
  const set = new Set<string>();
  for (const r of ranges) {
    for (const day of eachDay(r.start_date, r.end_date)) set.add(day);
  }
  return set;
}

export function Calendar({
  busy,
  start,
  end,
  onChange,
}: {
  busy: BusyRange[];
  start: string | null;
  end: string | null;
  onChange: (start: string | null, end: string | null) => void;
}) {
  const today = useMemo(() => todayISO(), []);
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });

  const busyDays = useMemo(() => busyDaySet(busy), [busy]);

  const cells = useMemo(() => {
    const first = new Date(month.getFullYear(), month.getMonth(), 1);
    const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
    // getDay(): 0 — воскресенье. В России неделя начинается с понедельника.
    const lead = (first.getDay() + 6) % 7;

    const out: (string | null)[] = Array(lead).fill(null);
    for (let d = 1; d <= daysInMonth; d++) {
      out.push(toISO(new Date(month.getFullYear(), month.getMonth(), d)));
    }
    return out;
  }, [month]);

  /**
   * Интервал нельзя протянуть сквозь занятый день: база всё равно откажет
   * ограничением bookings_no_overlap, и лучше не дать выбрать, чем показать
   * ошибку после нажатия «Забронировать».
   */
  function rangeIsClear(from: string, to: string): boolean {
    return eachDay(from, to).every((day) => !busyDays.has(day));
  }

  function press(iso: string) {
    // Первое нажатие — начало. Второе — конец, если интервал чист.
    // Нажатие раньше начала переносит начало, а не создаёт обратный диапазон.
    if (!start || (start && end)) {
      onChange(iso, null);
      return;
    }
    if (iso < start) {
      onChange(iso, null);
      return;
    }
    if (!rangeIsClear(start, iso)) {
      onChange(iso, null);
      return;
    }
    onChange(start, iso);
  }

  const monthLabel = `${MONTHS[month.getMonth()]} ${month.getFullYear()}`;
  const canGoBack = month > new Date(new Date().getFullYear(), new Date().getMonth(), 1);

  return (
    <View style={s.wrap}>
      <View style={s.header}>
        <Pressable
          onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}
          disabled={!canGoBack}
          hitSlop={8}
          style={s.nav}
          accessibilityRole="button"
          accessibilityLabel="Предыдущий месяц"
        >
          <Ionicons
            name="chevron-back"
            size={20}
            color={canGoBack ? colors.text : colors.border}
          />
        </Pressable>
        <Text style={s.month}>{monthLabel}</Text>
        <Pressable
          onPress={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}
          hitSlop={8}
          style={s.nav}
          accessibilityRole="button"
          accessibilityLabel="Следующий месяц"
        >
          <Ionicons name="chevron-forward" size={20} color={colors.text} />
        </Pressable>
      </View>

      <View style={s.grid}>
        {WEEKDAYS.map((w) => (
          <Text key={w} style={s.weekday}>
            {w}
          </Text>
        ))}

        {cells.map((iso, i) => {
          if (!iso) return <View key={`gap-${i}`} style={s.cell} />;

          const isPast = iso < today;
          const isBusy = busyDays.has(iso);
          const disabled = isPast || isBusy;

          const isStart = iso === start;
          const isEnd = iso === end;
          const inRange = Boolean(start && end && iso > start && iso < end);
          const edge = isStart || isEnd;

          return (
            <Pressable
              key={iso}
              disabled={disabled}
              onPress={() => press(iso)}
              style={[s.cell, inRange && s.inRange, edge && s.edge]}
            >
              <Text
                style={[
                  s.day,
                  disabled && s.dayDisabled,
                  isBusy && s.dayBusy,
                  inRange && s.dayInRange,
                  edge && s.dayEdge,
                ]}
              >
                {Number(iso.slice(8, 10))}
              </Text>
            </Pressable>
          );
        })}
      </View>

      <View style={s.legend}>
        <View style={s.legendItem}>
          <View style={[s.dot, { backgroundColor: colors.accent }]} />
          <Text style={s.legendText}>выбрано</Text>
        </View>
        <View style={s.legendItem}>
          <View style={[s.dot, { backgroundColor: colors.dangerSoft, borderColor: colors.danger, borderWidth: 1 }]} />
          <Text style={s.legendText}>занято</Text>
        </View>
      </View>
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { gap: spacing.md },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  nav: { padding: spacing.xs },
  month: { fontSize: 15, fontFamily: typeface[800], color: colors.text, textTransform: 'capitalize' },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
  weekday: {
    width: `${100 / 7}%`,
    textAlign: 'center',
    fontSize: 11,
    fontFamily: typeface[700],
    color: colors.textMuted,
    paddingBottom: spacing.sm,
  },
  cell: {
    width: `${100 / 7}%`,
    aspectRatio: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  inRange: { backgroundColor: colors.accentSoft },
  edge: { backgroundColor: colors.accent, borderRadius: radius.md },
  day: { fontSize: 14, fontFamily: typeface[600], color: colors.text },
  dayDisabled: { color: colors.border },
  dayBusy: { color: colors.danger, textDecorationLine: 'line-through' },
  dayInRange: { color: colors.accentInk },
  dayEdge: { color: colors.onFill, fontFamily: typeface[800] },
  legend: { flexDirection: 'row', gap: spacing.lg },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },
});
