import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { Empty, Loader } from '../src/components/ui';
import { fetchNotifications, markNotificationsRead } from '../src/lib/api';
import { useAuth } from '../src/lib/auth';
import type { Notification } from '../src/lib/types';
import { colors, radius, spacing } from '../src/theme';

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

  const load = useCallback(async () => {
    if (!session) return;
    setItems(await fetchNotifications(session.user.id));
    setLoading(false);
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

  if (loading) return <Loader />;

  return (
    <FlatList
      data={items}
      keyExtractor={(n) => n.id}
      contentContainerStyle={s.list}
      refreshControl={<RefreshControl refreshing={false} onRefresh={load} />}
      ListEmptyComponent={<Empty title="Пока тихо" body="Здесь появятся события по вашим сделкам." />}
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
  title: { fontSize: 15, fontWeight: '700', color: colors.text },
  body: { fontSize: 13, color: colors.textMuted, lineHeight: 19 },
  date: { fontSize: 11, color: colors.textMuted },
});
