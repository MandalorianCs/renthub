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
import { colors, radius, spacing } from '../theme';

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
    primary: { bg: colors.accent, fg: '#FFFFFF' },
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
      <Text style={[s.rowRight, muted && { color: colors.textMuted, fontWeight: '400' }]}>{right}</Text>
    </View>
  );
}

export function Empty({ title, body }: { title: string; body?: string }) {
  return (
    <View style={s.empty}>
      <Text style={s.emptyTitle}>{title}</Text>
      {body ? <Text style={s.emptyBody}>{body}</Text> : null}
    </View>
  );
}

export function Loader() {
  return (
    <View style={s.empty}>
      <ActivityIndicator color={colors.accent} />
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
  buttonText: { fontSize: 15, fontWeight: '700' },
  badge: {
    paddingHorizontal: spacing.md,
    paddingVertical: 5,
    borderRadius: radius.pill,
    alignSelf: 'flex-start',
  },
  badgeText: { fontSize: 12, fontWeight: '700' },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  label: { fontSize: 12, fontWeight: '700', color: colors.textMuted, textTransform: 'uppercase' },
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
  hint: { fontSize: 12, color: colors.textMuted },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: spacing.md },
  rowLeft: { fontSize: 14, color: colors.text, flexShrink: 1 },
  rowRight: { fontSize: 14, color: colors.text, fontWeight: '700' },
  empty: { padding: spacing.xxl, alignItems: 'center', gap: spacing.sm },
  emptyTitle: { fontSize: 16, fontWeight: '700', color: colors.text, textAlign: 'center' },
  emptyBody: { fontSize: 14, color: colors.textMuted, textAlign: 'center', lineHeight: 20 },
});
