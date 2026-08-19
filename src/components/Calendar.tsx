import { Ionicons } from '@expo/vector-icons';
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import type { BusyRange } from '../lib/types';
import { colors, radius, spacing, typeface } from '../theme';

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

/** Дата без времени в ISO — единственный формат, которым оперирует календарь. */
export function toISO(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * Разворачиваем интервалы в множество занятых дней. Границы включительно:
 * аренда «с 1 по 3» занимает и первое, и третье число — ровно так же, как
 * считает дни триггер в базе.
 */
function busyDaySet(ranges: BusyRange[]): Set<string> {
  const set = new Set<string>();
  for (const r of ranges) {
    const cursor = new Date(r.start_date);
    const last = new Date(r.end_date);
    while (cursor <= last) {
      set.add(toISO(cursor));
      cursor.setDate(cursor.getDate() + 1);
    }
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
  const today = useMemo(() => toISO(new Date()), []);
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
    const cursor = new Date(from);
    const last = new Date(to);
    while (cursor <= last) {
      if (busyDays.has(toISO(cursor))) return false;
      cursor.setDate(cursor.getDate() + 1);
    }
    return true;
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
  dayInRange: { color: colors.accent },
  dayEdge: { color: colors.onFill, fontFamily: typeface[800] },
  legend: { flexDirection: 'row', gap: spacing.lg },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.xs },
  dot: { width: 10, height: 10, borderRadius: 5 },
  legendText: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },
});
