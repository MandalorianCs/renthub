import { Ionicons } from '@expo/vector-icons';
import React from 'react';
import {
  ActivityIndicator,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  type TextInputProps,
  View,
} from 'react-native';
import { colors, elevation, radius, spacing, typeface } from '../theme';

export function Button({
  title,
  onPress,
  variant = 'primary',
  disabled,
  loading,
}: {
  title: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'danger' | 'ghost';
  disabled?: boolean;
  loading?: boolean;
}) {
  const palette = {
    primary: { bg: colors.accent, fg: colors.onFill },
    secondary: { bg: colors.greenSoft, fg: colors.green },
    danger: { bg: colors.dangerSoft, fg: colors.danger },
    ghost: { bg: 'transparent', fg: colors.textMuted },
  }[variant];

  const blocked = disabled || loading;

  return (
    <Pressable
      onPress={onPress}
      disabled={blocked}
      style={({ pressed }) => [
        s.button,
        { backgroundColor: palette.bg, opacity: blocked ? 0.5 : pressed ? 0.85 : 1 },
        variant === 'ghost' && { borderWidth: 1, borderColor: colors.border },
      ]}
    >
      {loading ? (
        <ActivityIndicator color={palette.fg} />
      ) : (
        <Text style={[s.buttonText, { color: palette.fg }]}>{title}</Text>
      )}
    </Pressable>
  );
}

/**
 * Отклик на нажатие для карточек и строк списка.
 *
 * У кнопки он был с самого начала, у карточек — нет, и это заметно именно на
 * телефоне: палец закрывает то место, куда нажал, и без реакции человек не
 * знает, сработало ли. На медленной сети между нажатием и переходом проходит
 * заметное время, и второе нажатие «на всякий случай» открывает экран дважды.
 *
 * Масштаб взят мелкий (1%) намеренно: карточка должна отозваться, а не
 * прыгнуть. Прыжок читается как ошибка вёрстки, а не как отклик.
 */
export function tap({ pressed }: { pressed: boolean }) {
  return { opacity: pressed ? 0.72 : 1, transform: [{ scale: pressed ? 0.99 : 1 }] };
}

export function Badge({ label, fg, bg }: { label: string; fg: string; bg: string }) {
  return (
    <View style={[s.badge, { backgroundColor: bg }]}>
      <Text style={[s.badgeText, { color: fg }]}>{label}</Text>
    </View>
  );
}

export function Card({ children, style }: { children: React.ReactNode; style?: object }) {
  return <View style={[s.card, style]}>{children}</View>;
}

export function Field({
  label,
  hint,
  ...props
}: TextInputProps & { label: string; hint?: string }) {
  return (
    <View style={{ gap: spacing.xs }}>
      <Text style={s.label}>{label}</Text>
      <TextInput
        placeholderTextColor={colors.textMuted}
        {...props}
        style={[s.input, props.multiline && { height: 96, textAlignVertical: 'top' }]}
      />
      {hint ? <Text style={s.hint}>{hint}</Text> : null}
    </View>
  );
}

export function Row({ left, right, muted }: { left: string; right: string; muted?: boolean }) {
  return (
    <View style={s.row}>
      <Text style={[s.rowLeft, muted && { color: colors.textMuted }]}>{left}</Text>
      <Text style={[s.rowRight, muted && { color: colors.textMuted, fontFamily: typeface[400] }]}>{right}</Text>
    </View>
  );
}

/**
 * Шапка экрана: крупное имя того, куда человек попал.
 *
 * Раньше каждый экран начинался сразу содержимым — списком, полем, карточкой.
 * Формально это честно, фактически человек каждый раз заново соображал, где
 * он: вкладки внизу подписаны в 11 пунктов, и это единственное, что отвечало
 * на вопрос.
 *
 * Тон — не украшение, а смысл. `warm` (терракота) стоит на витрине, `money`
 * (зелёный) — там, где речь о деньгах владельца; оба цвета означают в
 * продукте ровно это. `plain` — везде, где заливка ничего бы не добавила.
 */
export function ScreenHead({
  title,
  sub,
  tone = 'plain',
  bleed,
  children,
}: {
  title: string;
  sub?: string;
  tone?: 'plain' | 'warm' | 'money';
  /**
   * Гасит боковой отступ родителя, чтобы залитая шапка дошла до краёв экрана.
   *
   * Нужен там, где шапка лежит внутри прокручиваемого контейнера с общим
   * отступом: убрать отступ у контейнера нельзя — к краям прилипнут карточки,
   * а заливка, не доходящая до края, выглядит незакрашенной полосой, а не
   * накладкой.
   */
  bleed?: boolean;
  children?: React.ReactNode;
}) {
  const tinted = tone !== 'plain';
  return (
    <View
      style={[
        s.head,
        bleed && { marginHorizontal: -spacing.lg },
        tinted && s.headTinted,
        tone === 'warm' && { backgroundColor: colors.accentSoft },
        tone === 'money' && { backgroundColor: colors.greenSoft },
      ]}
    >
      <Text style={s.headTitle}>{title}</Text>
      {sub ? <Text style={s.headSub}>{sub}</Text> : null}
      {children}
    </View>
  );
}

export function Empty({
  title,
  body,
  icon = 'cube-outline',
  action,
}: {
  title: string;
  body?: string;
  icon?: keyof typeof Ionicons.glyphMap;
  /**
   * Выход из пустоты.
   *
   * Пустой экран — единственное место, где у человека есть внимание и нечем
   * его занять. Объяснить, почему пусто, — половина дела; вторая половина —
   * дать то единственное действие, которое эту пустоту закрывает. Без него
   * экран остаётся тупиком, из которого выходят кнопкой «назад».
   */
  action?: { label: string; onPress: () => void };
}) {
  return (
    <View style={s.empty}>
      <View style={s.emptyIcon}>
        <Ionicons name={icon} size={30} color={colors.accent} />
      </View>
      <Text style={s.emptyTitle}>{title}</Text>
      {body ? <Text style={s.emptyBody}>{body}</Text> : null}
      {action ? (
        <View style={{ marginTop: spacing.md, alignSelf: 'stretch', maxWidth: 280 }}>
          <Button title={action.label} onPress={action.onPress} />
        </View>
      ) : null}
    </View>
  );
}

/**
 * Сбой — это не пустота. Пустой каталог означает «объявлений пока нет»,
 * а ошибка сети означает «мы не смогли посмотреть». Показывать их одинаково
 * значит врать пользователю о состоянии системы.
 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <View style={s.empty}>
      <View style={[s.emptyIcon, { backgroundColor: colors.dangerSoft }]}>
        <Ionicons name="alert-circle-outline" size={26} color={colors.danger} />
      </View>
      <Text style={s.emptyTitle}>Не удалось загрузить</Text>
      <Text style={s.emptyBody}>{message}</Text>
      {onRetry ? (
        <View style={{ marginTop: spacing.sm }}>
          <Button title="Попробовать снова" variant="ghost" onPress={onRetry} />
        </View>
      ) : null}
    </View>
  );
}


const s = StyleSheet.create({
  button: {
    paddingVertical: 14,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 48,
  },
  buttonText: { fontSize: 15, fontFamily: typeface[700] },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 12, fontFamily: typeface[700] },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
    ...elevation.card,
  },
  label: { fontSize: 12, fontFamily: typeface[700], color: colors.textMuted, textTransform: 'uppercase' },
  input: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
    fontSize: 15,
    color: colors.text,
  },
  hint: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md },
  rowLeft: { fontSize: 14, fontFamily: typeface[400], color: colors.text, flexShrink: 1 },
  rowRight: { fontSize: 14, color: colors.text, fontFamily: typeface[700] },
  head: { paddingHorizontal: spacing.lg, paddingTop: spacing.md, paddingBottom: spacing.lg },
  // Крупное скругление снизу превращает шапку в накладку на содержимое.
  // Без него залитый блок упирается в края и читается как ещё одна секция.
  headTinted: { borderBottomLeftRadius: 28, borderBottomRightRadius: 28 },
  headTitle: { fontSize: 32, fontFamily: typeface[800], color: colors.text, letterSpacing: -1.1 },
  headSub: { fontSize: 14, fontFamily: typeface[500], color: colors.textMuted, marginTop: 4 },

  empty: { padding: spacing.xxl, alignItems: 'center', gap: spacing.sm },
  emptyIcon: {
    width: 76,
    height: 76,
    borderRadius: radius.pill,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
    marginBottom: spacing.sm,
  },
  // Пустой экран целиком состоит из этого блока, и мелкий заголовок в 16
  // пунктов посреди белого поля читается как обрывок, а не как сообщение.
  emptyTitle: { fontSize: 20, fontFamily: typeface[800], color: colors.text, textAlign: 'center', letterSpacing: -0.4 },
  emptyBody: { fontSize: 14, fontFamily: typeface[400], color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
