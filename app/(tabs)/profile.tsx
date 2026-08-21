import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Linking, Pressable, RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Badge, Button, Card, ErrorState, Field, Row, ScreenHead, tap } from '../../src/components/ui';
import { fetchMyBookings, fetchNotifications, updateProfile } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { BOOKING_STATUS, formatDateRange, ratingLabel } from '../../src/lib/format';
import { Ionicons } from '@expo/vector-icons';
import { ListSkeleton } from '../../src/components/Skeleton';
import { humanizeError, TELEGRAM_BOT, TELEGRAM_BOT_URL } from '../../src/lib/supabase';
import { useRefresh } from '../../src/lib/useRefresh';
import type { BookingWithItem } from '../../src/lib/types';
import { colors, radius, spacing, typeface } from '../../src/theme';

/** Экран 6: профиль — рейтинг, история сделок, настройки. */
export default function Profile() {
  const { session, profile, profileError, isVerified, signOut, refreshProfile } = useAuth();
  const router = useRouter();

  const [history, setHistory] = useState<BookingWithItem[]>([]);
  const [unread, setUnread] = useState(0);
  const [name, setName] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const [bookings, notifications] = await Promise.all([
        fetchMyBookings(session.user.id),
        fetchNotifications(session.user.id),
      ]);
      setHistory(bookings.filter((b) => b.status === 'completed'));
      setUnread(notifications.filter((n) => !n.read_at).length);
    } catch (e) {
      setError(humanizeError(e));
    }
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      load();
      setName(profile?.full_name ?? '');
    }, [load, profile?.full_name]),
  );

  const { refreshing, onRefresh } = useRefresh(load);

  // Профиля нет по двум причинам, и выглядеть они обязаны по-разному.
  // Сбой — отказ с кнопкой повтора. Отсутствие строки сразу после регистрации
  // (триггер on_auth_user_created ещё не отработал) — заглушка: данные
  // действительно едут, и через секунду появятся сами.
  if (!profile) {
    if (profileError) return <ErrorState message={profileError} onRetry={refreshProfile} />;
    return <ListSkeleton rows={3} />;
  }

  return (
    <ScrollView
      contentContainerStyle={s.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      <ScreenHead title="Профиль" sub="Рейтинг, история сделок и настройки" bleed />

      <Card>
        <View style={s.head}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initials(profile.full_name)}</Text>
          </View>
          <View style={{ flex: 1, gap: 3 }}>
            <Text style={s.name}>{profile.full_name || 'Без имени'}</Text>
            <View style={s.ratingRow}>
              <Ionicons name="star" size={13} color={colors.warn} />
              <Text style={s.rating}>{ratingLabel(profile.rating, profile.ratings_count)}</Text>
            </View>
            <Text style={s.phone}>{profile.phone}</Text>
          </View>
        </View>

        {isVerified ? (
          <Badge label="Телефон подтверждён" fg={colors.green} bg={colors.greenSoft} />
        ) : (
          <Badge label="Телефон не подтверждён" fg={colors.warn} bg={colors.warnSoft} />
        )}
      </Card>

      <Card>
        <Field label="Имя" value={name} onChangeText={setName} placeholder="Как к вам обращаться" />
        <Button
          title="Сохранить"
          loading={saving}
          onPress={async () => {
            setSaving(true);
            try {
              await updateProfile(profile.id, { full_name: name.trim() });
              await refreshProfile();
            } catch (e) {
              setError(humanizeError(e));
            } finally {
              setSaving(false);
            }
          }}
        />
      </Card>

      <Card>
        <View style={s.switchRow}>
          <View style={{ flex: 1 }}>
            <Text style={s.switchLabel}>Пассивный режим</Text>
            <Text style={s.note}>
              Платформа сама следит за сроками и присылает готовый итог. Выключите, если
              хотите управлять сделками вручную и видеть подробный трекинг.
            </Text>
          </View>
          <Switch
            value={profile.passive_mode}
            trackColor={{ true: colors.accent, false: colors.border }}
            onValueChange={async (value) => {
              // Без обработки ошибка здесь превращалась в необработанное
              // отклонение промиса: переключатель отскакивал назад молча.
              try {
                await updateProfile(profile.id, { passive_mode: value });
                await refreshProfile();
              } catch (e) {
                setError(humanizeError(e));
              }
            }}
          />
        </View>
      </Card>

      <Card>
        <Text style={s.sectionTitle}>Уведомления в Telegram</Text>
        {profile.telegram_id ? (
          <>
            <Badge label="Подключено" fg={colors.green} bg={colors.greenSoft} />
            <Text style={s.note}>
              Подтверждения броней, напоминания о возврате и решения по спорам приходят
              в Telegram{profile.telegram_username ? ` — на @${profile.telegram_username}` : ''}.
              Отключить можно командой /unlink в самом боте.
            </Text>
          </>
        ) : (
          <>
            <Text style={s.note}>
              Бот пришлёт подтверждение брони и напомнит о возврате, чтобы не пришлось
              открывать приложение. Telegram не может написать первым — поэтому первый
              шаг за вами: откройте бота и нажмите «Поделиться номером».
            </Text>
            <Button
              title={`Открыть @${TELEGRAM_BOT}`}
              variant="secondary"
              onPress={() => Linking.openURL(TELEGRAM_BOT_URL)}
            />
          </>
        )}
      </Card>

      <Card>
        <Pressable
          style={({ pressed }) => [s.linkRow, tap({ pressed })]}
          onPress={() => router.push('/notifications')}
        >
          <Ionicons name="notifications-outline" size={20} color={colors.text} />
          <Text style={s.linkTitle}>Уведомления</Text>
          {unread > 0 ? (
            <View style={s.counter}>
              <Text style={s.counterText}>{unread}</Text>
            </View>
          ) : (
            <Text style={s.note}>нет новых</Text>
          )}
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </Pressable>
      </Card>

      <Card>
        <Text style={s.sectionTitle}>История сделок</Text>
        {history.length === 0 ? (
          <Text style={s.note}>Завершённых сделок пока нет.</Text>
        ) : (
          history.map((b) => (
            <Row
              key={b.id}
              left={b.item?.title ?? '—'}
              right={`${formatDateRange(b.start_date, b.end_date)} · ${BOOKING_STATUS[b.status].label}`}
              muted
            />
          ))
        )}
      </Card>

      {error ? (
        <View style={s.errorBox}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.danger} />
          <Text style={s.error}>{error}</Text>
        </View>
      ) : null}

      <Button title="Выйти" variant="ghost" onPress={signOut} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  avatar: {
    width: 60, height: 60, borderRadius: 30,
    backgroundColor: colors.accentSoft,
    alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { fontSize: 20, fontFamily: typeface[800], color: colors.accent },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  linkRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  linkTitle: { flex: 1, fontSize: 15, fontFamily: typeface[700], color: colors.text },
  counter: {
    minWidth: 22, height: 22, borderRadius: 11, paddingHorizontal: 6,
    backgroundColor: colors.accent,
    alignItems: 'center', justifyContent: 'center',
  },
  counterText: { fontSize: 12, fontFamily: typeface[800], color: colors.onFill },
  errorBox: {
    flexDirection: 'row', alignItems: 'center', gap: spacing.sm,
    backgroundColor: colors.dangerSoft, borderRadius: radius.md, padding: spacing.md,
  },
  name: { fontSize: 22, fontFamily: typeface[800], color: colors.text },
  phone: { fontSize: 14, fontFamily: typeface[400], color: colors.textMuted },
  rating: { fontSize: 15, fontFamily: typeface[600], color: colors.text },
  sectionTitle: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  note: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 18 },
  error: { fontSize: 14, fontFamily: typeface[400], color: colors.danger },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { fontSize: 15, fontFamily: typeface[700], color: colors.text },
});

/** Инициалы для аватара — те же правила, что в профиле владельца. */
function initials(name?: string | null): string {
  if (!name) return '—';
  const parts = name.trim().split(' ').filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '—';
}
