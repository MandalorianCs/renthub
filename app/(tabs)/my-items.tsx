import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Badge, Button, Card, Empty, Loader, Row } from '../../src/components/ui';
import {
  fetchMyItems,
  fetchNotifications,
  fetchOwnerBookings,
  fetchPayouts,
  markNotificationsRead,
} from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { BOOKING_STATUS, formatDate, formatDateRange, formatTenge } from '../../src/lib/format';
import { humanizeError } from '../../src/lib/supabase';
import type { BookingWithItem, Item, Notification, Payout } from '../../src/lib/types';
import { colors, radius, spacing } from '../../src/theme';

/**
 * Экран 5б: «Мои вещи» — сторона владельца.
 *
 * Устроен под пассивный режим: владелец не должен ничего отслеживать
 * вручную. Первым делом он видит готовый итог — «вот что произошло, пока
 * вас не было» — и только ниже объявления и календарь. Действия
 * запрашиваются только тогда, когда без владельца сделку не сдвинуть
 * (подтвердить бронь, принять вещь).
 */
export default function MyItems() {
  const { session } = useAuth();
  const router = useRouter();

  const [items, setItems] = useState<Item[]>([]);
  const [bookings, setBookings] = useState<BookingWithItem[]>([]);
  const [payouts, setPayouts] = useState<Payout[]>([]);
  const [news, setNews] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      const [i, b, p, n] = await Promise.all([
        fetchMyItems(session.user.id),
        fetchOwnerBookings(session.user.id),
        fetchPayouts(session.user.id),
        fetchNotifications(session.user.id),
      ]);
      setItems(i);
      setBookings(b);
      setPayouts(p);
      setNews(n.filter((x) => !x.read_at));
      setError(null);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  const earned = useMemo(
    () => payouts.filter((p) => p.status === 'released').reduce((sum, p) => sum + p.amount, 0),
    [payouts],
  );

  const pending = useMemo(
    () => payouts.filter((p) => p.status === 'scheduled').reduce((sum, p) => sum + p.amount, 0),
    [payouts],
  );

  // Компенсации показываются отдельной строкой, а не растворяются в общей
  // сумме: «начислено 15 000» невозможно объяснить, если владельцу нужно
  // лезть в спор, чтобы понять, откуда взялась часть денег.
  const compensation = useMemo(
    () =>
      payouts
        .filter((p) => p.kind === 'damage_compensation' && p.status === 'released')
        .reduce((sum, p) => sum + p.amount, 0),
    [payouts],
  );

  // Единственное, что действительно требует владельца: подтвердить заявку
  // и принять вернувшуюся вещь. Всё остальное система делает сама.
  const needsAction = bookings.filter((b) => b.status === 'pending' || b.status === 'active');

  if (loading) return <Loader />;

  return (
    <ScrollView
      contentContainerStyle={s.container}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
    >
      {news.length > 0 ? (
        <Card style={{ backgroundColor: colors.greenSoft, borderColor: colors.greenSoft }}>
          <Text style={s.sectionTitle}>Пока вас не было</Text>
          {news.slice(0, 5).map((n) => (
            <View key={n.id} style={s.newsRow}>
              <Text style={s.newsTitle}>{n.title}</Text>
              {n.body ? <Text style={s.newsBody}>{n.body}</Text> : null}
              <Text style={s.newsDate}>{formatDate(n.created_at)}</Text>
            </View>
          ))}
          <Button
            title="Понятно"
            variant="secondary"
            onPress={async () => {
              if (!session) return;
              await markNotificationsRead(session.user.id);
              setNews([]);
            }}
          />
        </Card>
      ) : null}

      <Card>
        <Text style={s.sectionTitle}>Деньги</Text>
        <Row left="Начислено" right={formatTenge(earned)} />
        {compensation > 0 ? (
          <Row left="из них компенсации ущерба" right={formatTenge(compensation)} muted />
        ) : null}
        <Row left="Ожидает закрытия сделок" right={formatTenge(pending)} muted />
        <Text style={s.note}>
          В MVP деньги не двигаются по-настоящему — это эмуляция денежного потока статусами.
        </Text>
      </Card>

      {needsAction.length > 0 ? (
        <Card>
          <Text style={s.sectionTitle}>Требует вашего решения</Text>
          {needsAction.map((b) => {
            const status = BOOKING_STATUS[b.status];
            return (
              <Pressable key={b.id} style={s.actionRow} onPress={() => router.push(`/booking/${b.id}`)}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.actionTitle}>{b.item?.title ?? '—'}</Text>
                  <Text style={s.note}>{formatDateRange(b.start_date, b.end_date)}</Text>
                </View>
                <Badge label={status.label} fg={status.fg} bg={status.bg} />
              </Pressable>
            );
          })}
        </Card>
      ) : null}

      <Card>
        <View style={s.headerRow}>
          <Text style={s.sectionTitle}>Мои объявления</Text>
          <Pressable onPress={() => router.push('/item/new')}>
            <Text style={s.link}>+ Добавить</Text>
          </Pressable>
        </View>

        {items.length === 0 ? (
          <Empty
            title="Пока ничего не сдаёте"
            body="Выложите инструмент, который лежит без дела — объявление занимает пару минут."
          />
        ) : (
          items.map((item) => {
            const activeBooking = bookings.find(
              (b) => b.item_id === item.id && ['pending', 'confirmed', 'active'].includes(b.status),
            );
            return (
              <Pressable key={item.id} style={s.itemRow} onPress={() => router.push(`/item/${item.id}`)}>
                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.actionTitle}>{item.title}</Text>
                  <Text style={s.note}>
                    {formatTenge(item.daily_price)} / сутки
                    {activeBooking
                      ? ` · занято до ${formatDate(activeBooking.end_date)}`
                      : ' · свободно'}
                  </Text>
                </View>
                {item.status === 'hidden' ? (
                  <Badge label="Скрыто" fg={colors.textMuted} bg={colors.border} />
                ) : null}
              </Pressable>
            );
          })
        )}
      </Card>

      {error ? <Text style={s.error}>{error}</Text> : null}
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { fontSize: 14, fontWeight: '700', color: colors.accent },
  note: { fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  error: { fontSize: 14, color: colors.danger },
  newsRow: { gap: 2, borderLeftWidth: 3, borderLeftColor: colors.green, paddingLeft: spacing.md },
  newsTitle: { fontSize: 14, fontWeight: '700', color: colors.text },
  newsBody: { fontSize: 13, color: colors.textMuted },
  newsDate: { fontSize: 11, color: colors.textMuted },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingVertical: spacing.sm,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionTitle: { fontSize: 15, fontWeight: '600', color: colors.text },
  radius: { borderRadius: radius.md },
});
