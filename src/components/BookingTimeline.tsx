import { Ionicons } from '@expo/vector-icons';
import { StyleSheet, Text, View } from 'react-native';
import type { BookingStatus } from '../lib/types';
import { colors, radius, spacing, typeface } from '../theme';

/**
 * Шкала этапов сделки.
 *
 * До неё экран показывал два бейджа — «активна» и «депозит удержан», — и по
 * ним нельзя было понять ни сколько пройдено, ни сколько осталось. Между тем
 * сделка проходит фиксированный путь, и человеку важнее всего именно
 * положение на нём: заплатил ли я уже, вернул ли, чего ждать дальше.
 *
 * Порядок этапов повторяет переходы статусов из базы, а не выдуман для
 * красоты: pending → confirmed → active → returned → completed.
 */

const STEPS: { status: BookingStatus; label: string }[] = [
  { status: 'pending', label: 'Заявка' },
  { status: 'confirmed', label: 'Подтверждена' },
  { status: 'active', label: 'У арендатора' },
  { status: 'returned', label: 'Вернули' },
  { status: 'completed', label: 'Закрыта' },
];

export function BookingTimeline({ status }: { status: BookingStatus }) {
  // Спор и отмена — не этапы пути, а сход с него. Рисовать их шкалой
  // значит утверждать, что дальше будет следующий шаг, а его не будет.
  if (status === 'cancelled' || status === 'disputed') {
    const cancelled = status === 'cancelled';
    return (
      <View
        style={[
          s.offRoad,
          {
            backgroundColor: cancelled ? colors.bg : colors.dangerSoft,
            borderColor: cancelled ? colors.border : colors.danger,
          },
        ]}
      >
        <Ionicons
          name={cancelled ? 'close-circle-outline' : 'alert-circle-outline'}
          size={20}
          color={cancelled ? colors.textMuted : colors.danger}
        />
        <View style={{ flex: 1 }}>
          <Text style={[s.offRoadTitle, { color: cancelled ? colors.textMuted : colors.danger }]}>
            {cancelled ? 'Сделка отменена' : 'Идёт разбор спора'}
          </Text>
          <Text style={s.offRoadNote}>
            {cancelled
              ? 'Даты освободились, деньги и депозит не удерживаются.'
              : 'Депозит удержан до решения. Обе стороны видят одни и те же доказательства.'}
          </Text>
        </View>
      </View>
    );
  }

  const current = STEPS.findIndex((x) => x.status === status);

  return (
    <View style={s.wrap}>
      {STEPS.map((step, i) => {
        const done = i < current;
        const now = i === current;

        return (
          <View key={step.status} style={s.step}>
            <View style={s.railRow}>
              {/* Отрезки слева и справа от точки, а не сплошная линия под
                  всеми: так крайние этапы не тянут «хвост» в пустоту. */}
              <View style={[s.rail, { backgroundColor: i === 0 ? 'transparent' : done || now ? colors.accent : colors.border }]} />
              <View style={[s.dot, done && s.dotDone, now && s.dotNow]}>
                {done ? <Ionicons name="checkmark" size={11} color="#FFFFFF" /> : null}
              </View>
              <View style={[s.rail, { backgroundColor: i === STEPS.length - 1 ? 'transparent' : done ? colors.accent : colors.border }]} />
            </View>
            <Text style={[s.label, (done || now) && s.labelActive, now && s.labelNow]} numberOfLines={2}>
              {step.label}
            </Text>
          </View>
        );
      })}
    </View>
  );
}

const s = StyleSheet.create({
  wrap: { flexDirection: 'row', alignItems: 'flex-start' },
  step: { flex: 1, alignItems: 'center', gap: spacing.xs },
  railRow: { flexDirection: 'row', alignItems: 'center', width: '100%' },
  rail: { flex: 1, height: 2 },
  dot: {
    width: 18,
    height: 18,
    borderRadius: 9,
    backgroundColor: colors.surface,
    borderWidth: 2,
    borderColor: colors.border,
    alignItems: 'center',
    justifyContent: 'center',
  },
  dotDone: { backgroundColor: colors.accent, borderColor: colors.accent },
  dotNow: {
    backgroundColor: colors.surface,
    borderColor: colors.accent,
    // Текущий этап крупнее пройденных: глаз находит «где я» без чтения.
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 3,
  },
  label: { fontSize: 10, fontFamily: typeface[500], color: colors.textMuted, textAlign: 'center' },
  labelActive: { color: colors.text },
  labelNow: { fontFamily: typeface[800], color: colors.accent },

  offRoad: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
  },
  offRoadTitle: { fontSize: 15, fontFamily: typeface[700] },
  offRoadNote: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 18, marginTop: 2 },
});
