import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { ListSkeleton } from '../src/components/Skeleton';
import { Empty, ErrorState } from '../src/components/ui';
import { fetchNotifications, markNotificationsRead } from '../src/lib/api';
import { useAuth } from '../src/lib/auth';
import { humanizeError } from '../src/lib/supabase';
import { useRefresh } from '../src/lib/useRefresh';
import type { Notification } from '../src/lib/types';
import { colors, radius, spacing, typeface } from '../src/theme';

/**
 * Лента событий. Та же таблица notifications позже кормит Telegram-бота:
 * бот забирает записи с sent_at is null и рассылает их — логика уведомлений
 * не дублируется между приложением и ботом.
 */
export default function Notifications() {
  const { session } = useAuth();
  const router = useRouter();
  const [items, setItems] = useState<Notification[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // setLoading(false) стоял после await без finally: любая ошибка сети
  // оставляла экран с крутилкой навсегда, потому что до него не доходило.
  const load = useCallback(async () => {
    if (!session) return;
    try {
      setItems(await fetchNotifications(session.user.id));
      setError(null);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, [session]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    // Отмечаем прочитанными при выходе с экрана, а не при входе:
    // иначе непрочитанные исчезают до того, как их успели увидеть.
    return () => {
      if (session) markNotificationsRead(session.user.id).catch(() => {});
    };
  }, [session]);

  const { refreshing, onRefresh } = useRefresh(load);

  if (loading) return <ListSkeleton rows={5} />;
  if (error) return <ErrorState message={error} onRetry={load} />;

  return (
    <FlatList
      data={items}
      keyExtractor={(n) => n.id}
      contentContainerStyle={s.list}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
      ListEmptyComponent={
        <Empty icon="notifications-outline" title="Пока тихо" body="Здесь появятся события по вашим сделкам." />
      }
      renderItem={({ item }) => (
        <Pressable
          style={[s.row, !item.read_at && s.unread]}
          onPress={() => item.booking_id && router.push(`/booking/${item.booking_id}`)}
        >
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.title}>{item.title}</Text>
            {item.body ? <Text style={s.body}>{item.body}</Text> : null}
            <Text style={s.date}>{new Date(item.created_at).toLocaleString('ru-RU')}</Text>
          </View>
        </Pressable>
      )}
    />
  );
}

const s = StyleSheet.create({
  list: { padding: spacing.lg, gap: spacing.sm },
  row: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    padding: spacing.lg,
  },
  unread: { borderLeftWidth: 3, borderLeftColor: colors.accent },
  title: { fontSize: 15, fontFamily: typeface[700], color: colors.text },
  body: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 19 },
  date: { fontSize: 11, fontFamily: typeface[400], color: colors.textMuted },
});
