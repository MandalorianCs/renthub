import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Badge, Empty, Loader } from '../../src/components/ui';
import { fetchMyBookings } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { BOOKING_STATUS, DEPOSIT_STATUS, formatDateRange, formatTenge } from '../../src/lib/format';
import { humanizeError } from '../../src/lib/supabase';
import type { BookingWithItem } from '../../src/lib/types';
import { colors, radius, spacing } from '../../src/theme';

/** Экран 5а: мои бронирования (сторона арендатора). */
export default function MyBookings() {
  const { session } = useAuth();
  const router = useRouter();
  const [bookings, setBookings] = useState<BookingWithItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!session) return;
    try {
      setBookings(await fetchMyBookings(session.user.id));
      setError(null);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  // Статус мог измениться на другой стороне сделки, пока экран был закрыт.
  useFocusEffect(
    useCallback(() => {
      load();
    }, [load]),
  );

  if (loading) return <Loader />;

  return (
    <FlatList
      data={bookings}
      keyExtractor={(b) => b.id}
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
      ListEmptyComponent={
        <Empty
          title={error ?? 'Пока нет аренд'}
          body={error ? undefined : 'Найдите инструмент в каталоге и забронируйте — сделка появится здесь.'}
        />
      }
      renderItem={({ item }) => {
        const status = BOOKING_STATUS[item.status];
        const deposit = DEPOSIT_STATUS[item.deposit_status];
        return (
          <Pressable style={s.card} onPress={() => router.push(`/booking/${item.id}`)}>
            <View style={s.cardHeader}>
              <Text style={s.title} numberOfLines={1}>
                {item.item?.title ?? 'Объявление удалено'}
              </Text>
              <Badge label={status.label} fg={status.fg} bg={status.bg} />
            </View>
            <Text style={s.meta}>{formatDateRange(item.start_date, item.end_date)} · {item.days} дн.</Text>
            <View style={s.footer}>
              <Text style={s.amount}>{formatTenge(item.renter_total)}</Text>
              <Text style={[s.depositNote, { color: deposit.fg }]}>{deposit.label}</Text>
            </View>
          </Pressable>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  list: { padding: spacing.lg, gap: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
    gap: spacing.sm,
  },
  cardHeader: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  title: { flex: 1, fontSize: 16, fontWeight: '700', color: colors.text },
  meta: { fontSize: 13, color: colors.textMuted },
  footer: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  amount: { fontSize: 16, fontWeight: '800', color: colors.text },
  depositNote: { fontSize: 12, fontWeight: '600' },
});
