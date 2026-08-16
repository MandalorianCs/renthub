import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Switch, Text, View } from 'react-native';
import { Badge, Button, Card, Field, Loader, Row } from '../../src/components/ui';
import { fetchMyBookings, fetchNotifications, updateProfile } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { BOOKING_STATUS, formatDateRange, ratingLabel } from '../../src/lib/format';
import { humanizeError } from '../../src/lib/supabase';
import { useRefresh } from '../../src/lib/useRefresh';
import type { BookingWithItem } from '../../src/lib/types';
import { colors, spacing, typeface } from '../../src/theme';

/** Экран 6: профиль — рейтинг, история сделок, настройки. */
export default function Profile() {
  const { session, profile, isVerified, signOut, refreshProfile } = useAuth();
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

  if (!profile) return <Loader />;

  return (
    <ScrollView
      contentContainerStyle={s.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      <Card>
        <Text style={s.name}>{profile.full_name || 'Без имени'}</Text>
        <Text style={s.phone}>{profile.phone}</Text>
        <Text style={s.rating}>★ {ratingLabel(profile.rating, profile.ratings_count)}</Text>
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
        <Row left="Уведомления" right={unread > 0 ? `${unread} новых` : 'нет новых'} muted />
        <Button title="Открыть уведомления" variant="secondary" onPress={() => router.push('/notifications')} />
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

      {error ? <Text style={s.error}>{error}</Text> : null}

      <Button title="Выйти" variant="ghost" onPress={signOut} />
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  name: { fontSize: 22, fontFamily: typeface[800], color: colors.text },
  phone: { fontSize: 14, fontFamily: typeface[400], color: colors.textMuted },
  rating: { fontSize: 15, fontFamily: typeface[600], color: colors.text },
  sectionTitle: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  note: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 18 },
  error: { fontSize: 14, fontFamily: typeface[400], color: colors.danger },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { fontSize: 15, fontFamily: typeface[700], color: colors.text },
});
