import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { FlatList, Linking, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { ListSkeleton } from '../src/components/Skeleton';
import { Empty, ErrorState } from '../src/components/ui';
import Ionicons from '@expo/vector-icons/Ionicons';
import { fetchNotifications, markNotificationsRead } from '../src/lib/api';
import { useAuth } from '../src/lib/auth';
import { formatDateTime } from '../src/lib/format';
import { humanizeError, TELEGRAM_BOT, TELEGRAM_BOT_URL } from '../src/lib/supabase';
import { useRefresh } from '../src/lib/useRefresh';
import type { Notification } from '../src/lib/types';
import { colors, radius, spacing, typeface } from '../src/theme';

/**
 * Вид события по типу.
 *
 * Раньше все уведомления выглядели одинаково: напоминание о возврате и
 * блокировка аккаунта отличались только текстом, который ещё надо прочитать.
 * Значок и цвет дают понять важность боковым зрением — а список читают
 * именно так.
 *
 * Типы приходят из базы строками, поэтому здесь запасной вариант, а не
 * исчерпывающий разбор: новый тип уведомления не должен ломать экран.
 */
type Look = { icon: keyof typeof Ionicons.glyphMap; color: string };

/**
 * Список составлен по тому, что база действительно создаёт (см. notify_user
 * в миграции trust_score и функции модератора), а не по догадкам о названиях.
 * Первая версия угадывала по подстрокам — и `return_due_today` с
 * `deposit_released` проваливались в общий колокольчик, то есть напоминание
 * о возврате выглядело как «что-то произошло».
 */
const LOOKS: Record<string, Look> = {
  // Заявка и её отмена — то, что владелец в пассивном режиме получает чаще
  // всего, и до сих пор они падали в серый значок «прочее». Первая ждёт
  // его хода, поэтому warn: в DESIGN.md этот цвет и означает ожидание.
  // Отмена — textMuted, тем же цветом, что статус cancelled в BOOKING_STATUS:
  // одно событие не должно говорить разное в списке и на экране сделки.
  booking_requested: { icon: 'calendar-number-outline', color: colors.warn },
  booking_cancelled: { icon: 'close-circle-outline', color: colors.textMuted },
  booking_confirmed: { icon: 'calendar-outline', color: colors.green },
  item_picked_up: { icon: 'arrow-forward-circle-outline', color: colors.accent },
  item_returned: { icon: 'arrow-back-circle-outline', color: colors.green },
  return_due_today: { icon: 'time-outline', color: colors.warn },
  deposit_released: { icon: 'cash-outline', color: colors.green },
  payout_released: { icon: 'cash-outline', color: colors.green },
  dispute_non_return: { icon: 'alert-circle-outline', color: colors.danger },
  dispute_auto_resolved: { icon: 'shield-checkmark-outline', color: colors.warn },
  dispute_manual_review: { icon: 'shield-outline', color: colors.danger },
  blocked: { icon: 'lock-closed-outline', color: colors.danger },
  unblocked: { icon: 'lock-open-outline', color: colors.green },
  item_hidden: { icon: 'eye-off-outline', color: colors.warn },
  // Пара к item_hidden, как unblocked к blocked: снятие ограничения —
  // хорошая новость, и зелёный здесь несёт смысл, а не украшает.
  item_restored: { icon: 'eye-outline', color: colors.green },
  // Первое, что человек видит в приложении: заявку одобрили.
  invite_ready: { icon: 'key-outline', color: colors.green },
  moderator_message: { icon: 'chatbubble-ellipses-outline', color: colors.accent },
  connection_test: { icon: 'wifi-outline', color: colors.textMuted },
};

function look(type: string): Look {
  // Запасной вариант обязателен: новый тип уведомления появится в базе
  // раньше, чем в этом файле, и экран не должен из-за этого ломаться.
  return LOOKS[type] ?? { icon: 'notifications-outline', color: colors.textMuted };
}

/**
 * Лента событий. Та же таблица notifications позже кормит Telegram-бота:
 * бот забирает записи с sent_at is null и рассылает их — логика уведомлений
 * не дублируется между приложением и ботом.
 */
export default function Notifications() {
  const { session, profile } = useAuth();
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
      /* Кто не привязал Telegram, узнаёт о событии, только открыв это
         место. Он об этом не знает: экран выглядит как лента, а не как
         единственный канал — и «подтвердите бронь» человек прочитает
         через день, когда откроет приложение сам.

         На 04.09.2026 привязка была у одного живого участника из пяти, то
         есть почти вся доставка сводилась к этому экрану. Здесь и место сказать:
         не в профиле, куда заходят раз в месяц, а там, где человек видит
         пропущенное. */
      ListHeaderComponent={
        profile && !profile.telegram_id ? (
          <View style={s.linkTg}>
            <Ionicons name="paper-plane-outline" size={20} color={colors.accent} />
            <View style={{ flex: 1, gap: 6 }}>
              <Text style={s.linkTgTitle}>Это единственное место, куда приходят уведомления</Text>
              <Text style={s.linkTgBody}>
                Подтверждение брони, напоминание о возврате и решение по спору сейчас
                ждут вас здесь — и вы узнаёте о них, только открыв приложение.
                Подключите Telegram, и они будут приходить сразу.
              </Text>
              <Pressable
                style={({ pressed }) => [s.linkTgBtn, pressed && { opacity: 0.85 }]}
                onPress={() => Linking.openURL(TELEGRAM_BOT_URL)}
              >
                <Text style={s.linkTgBtnText}>Открыть @{TELEGRAM_BOT}</Text>
              </Pressable>
            </View>
          </View>
        ) : null
      }
      renderItem={({ item }) => {
        const view = look(item.type);
        const target = item.booking_id;

        const content = (
          <>
            <Ionicons name={view.icon} size={20} color={view.color} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={s.title}>{item.title}</Text>
              {item.body ? <Text style={s.body}>{item.body}</Text> : null}
              <Text style={s.date}>{formatDateTime(item.created_at)}</Text>
            </View>
            {target ? (
              <Ionicons name="chevron-forward" size={16} color={colors.textMuted} />
            ) : null}
          </>
        );

        // Уведомление без сделки — сообщение модератора, блокировка,
        // проверка связи — никуда не ведёт. Раньше оно всё равно было
        // нажимаемым и на нажатие не отвечало ничем: молчащая кнопка.
        // Теперь строка просто не нажимается, и стрелки у неё нет.
        return target ? (
          <Pressable
            style={({ pressed }) => [s.row, !item.read_at && s.unread, { opacity: pressed ? 0.7 : 1 }]}
            onPress={() => router.push(`/booking/${target}`)}
          >
            {content}
          </Pressable>
        ) : (
          <View style={[s.row, !item.read_at && s.unread]}>{content}</View>
        );
      }}
    />
  );
}

const s = StyleSheet.create({
  list: { padding: spacing.lg, gap: spacing.sm },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.lg,
    padding: spacing.lg,
  },
  unread: { borderLeftWidth: 3, borderLeftColor: colors.accent },
  linkTg: {
    flexDirection: 'row',
    gap: spacing.md,
    padding: spacing.lg,
    marginBottom: spacing.md,
    borderRadius: radius.lg,
    backgroundColor: colors.accentSoft,
  },
  linkTgTitle: { fontSize: 15, fontFamily: typeface[700], color: colors.text },
  linkTgBody: { fontSize: 14, lineHeight: 20, fontFamily: typeface[400], color: colors.textMuted },
  linkTgBtn: {
    alignSelf: 'flex-start',
    marginTop: spacing.xs,
    paddingVertical: 9,
    paddingHorizontal: spacing.lg,
    borderRadius: radius.pill,
    backgroundColor: colors.accent,
  },
  linkTgBtnText: { fontSize: 14, fontFamily: typeface[700], color: colors.onFill },
  title: { fontSize: 15, fontFamily: typeface[700], color: colors.text },
  body: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 19 },
  date: { fontSize: 11, fontFamily: typeface[400], color: colors.textMuted },
});
