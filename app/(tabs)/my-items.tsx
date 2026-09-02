import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { SummarySkeleton } from '../../src/components/Skeleton';
import { Badge, Button, Card, Empty, ErrorState, Row, ScreenHead, tap } from '../../src/components/ui';
import {
  fetchMyItems,
  fetchNotifications,
  fetchOwnerBookings,
  fetchPayouts,
  markNotificationsRead,
  setItemStatus,
} from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { BOOKING_STATUS, formatDate, formatDateRange, formatTenge } from '../../src/lib/format';
import { shareItem } from '../../src/lib/share';
import { humanizeError } from '../../src/lib/supabase';
import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useRefresh } from '../../src/lib/useRefresh';
import type { BookingWithItem, Item, Notification, Payout } from '../../src/lib/types';
import { colors, radius, spacing, typeface } from '../../src/theme';

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
  // Какая ссылка скопирована: галочка на одной строке, а не на всех.
  const [copied, setCopied] = useState<string | null>(null);

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

  const { refreshing, onRefresh } = useRefresh(load);

  if (loading) return <SummarySkeleton />;

  // Сбой при первой загрузке нельзя показывать пустым экраном: «пока ничего
  // не сдаёте» и «мы не смогли посмотреть» — разные сообщения, и владелец,
  // увидевший первое вместо второго, решит, что платформа потеряла его вещи.
  // Когда данные уже на экране, упавшее обновление показывается строкой внизу:
  // подменять показанное ошибкой хуже, чем оставить чуть устаревшее.
  if (error && items.length === 0 && payouts.length === 0) {
    return <ErrorState message={error} onRetry={load} />;
  }

  return (
    <ScrollView
      contentContainerStyle={s.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      <ScreenHead
        title="Мои вещи"
        sub="Что произошло, пока вас не было"
        tone="money"
        bleed
      />

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

      {/* Владелец приходит сюда ради одного числа. Если оно не находится
          взглядом за полсекунды, экран не выполняет свою задачу. */}
      <Card>
        <View style={s.moneyHero}>
          <Text style={s.moneyLabel}>Начислено</Text>
          <Text style={s.moneyValue}>{formatTenge(earned)}</Text>
          {pending > 0 ? (
            <Text style={s.moneyPending}>
              и ещё {formatTenge(pending)} ждут закрытия сделок
            </Text>
          ) : null}
        </View>

        {compensation > 0 ? (
          <Row left="Из них компенсации ущерба" right={formatTenge(compensation)} muted />
        ) : null}

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
              <Pressable
                key={b.id}
                style={({ pressed }) => [s.actionRow, tap({ pressed })]}
                onPress={() => router.push(`/booking/${b.id}`)}
              >
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
            action={{ label: 'Сдать вещь', onPress: () => router.push('/item/new') }}
          />
        ) : (
          items.map((item) => {
            const activeBooking = bookings.find(
              (b) => b.item_id === item.id && ['pending', 'confirmed', 'active'].includes(b.status),
            );
            return (
              <Pressable
                key={item.id}
                style={({ pressed }) => [s.itemRow, tap({ pressed })]}
                onPress={() => router.push(`/item/${item.id}`)}
              >
                {item.condition_photos[0] ? (
                  <Image
                    source={item.condition_photos[0]}
                    style={[s.thumb, item.status === 'hidden' && { opacity: 0.45 }]}
                    contentFit="cover"
                    transition={180}
                  />
                ) : (
                  <View style={[s.thumb, s.thumbEmpty]}>
                    <Ionicons name="image-outline" size={18} color={colors.textMuted} />
                  </View>
                )}

                <View style={{ flex: 1, gap: 2 }}>
                  <Text style={s.actionTitle} numberOfLines={1}>{item.title}</Text>
                  <Text style={s.note}>{formatTenge(item.daily_price)} / сутки</Text>
                  <View style={s.stateRow}>
                    <View
                      style={[
                        s.stateDot,
                        { backgroundColor: activeBooking ? colors.accent : colors.green },
                      ]}
                    />
                    <Text style={s.stateText}>
                      {activeBooking
                        ? `занято до ${formatDate(activeBooking.end_date)}`
                        : 'свободно'}
                    </Text>
                  </View>

                  {/* Причина показывается здесь, а не только в уведомлении:
                      уведомление пролистывается и теряется, а объявление
                      лежит скрытым дальше, и владелец должен видеть, что
                      именно исправить. */}
                  {item.moderated_at ? (
                    <Text style={s.moderated} numberOfLines={2}>
                      {item.moderated_reason ?? 'Решение модератора RentHUB.'}
                      {' Исправьте объявление — модератор снимет ограничение.'}
                    </Text>
                  ) : null}
                </View>
                {item.moderated_at ? (
                  <Badge label="Снято" fg={colors.danger} bg={colors.dangerSoft} />
                ) : item.status === 'hidden' ? (
                  <Badge label="Скрыто" fg={colors.textMuted} bg={colors.border} />
                ) : null}

                {/* Действия владельца прямо в списке: раньше править было
                    нельзя вообще, а снять с публикации — только через базу. */}
                {/* Поделиться — способ, которым пилот и растёт: владелец
                    показывает вещь соседу и отправляет ссылку. Без неё
                    остаётся «найди в приложении», а это обрыв пути. */}
                <Pressable
                  hitSlop={8}
                  style={s.iconBtn}
                  accessibilityRole="button"
                  accessibilityLabel={
                    copied === item.id ? 'Ссылка скопирована' : 'Поделиться объявлением'
                  }
                  onPress={async () => {
                    const result = await shareItem(item.id, item.title);
                    if (result === 'copied') setCopied(item.id);
                  }}
                >
                  <Ionicons
                    name={copied === item.id ? 'checkmark' : 'share-outline'}
                    size={18}
                    color={copied === item.id ? colors.green : colors.textMuted}
                  />
                </Pressable>

                <Pressable
                  hitSlop={8}
                  style={s.iconBtn}
                  accessibilityRole="button"
                  accessibilityLabel="Изменить объявление"
                  onPress={() => router.push(`/item/edit/${item.id}`)}
                >
                  <Ionicons name="create-outline" size={18} color={colors.textMuted} />
                </Pressable>
                {/* Пока стоит ограничение модератора, кнопки нет вовсе —
                    вместо замка, который ничего не делает. Нажатие всё
                    равно упёрлось бы в отказ базы, а кнопка, отвечающая
                    ошибкой, хуже её отсутствия: она обещает действие,
                    которого нет. Что делать дальше, сказано текстом выше. */}
                {item.moderated_at ? (
                  <View
                    style={s.iconBtn}
                    accessibilityRole="image"
                    accessibilityLabel="Снято модератором"
                  >
                    <Ionicons name="lock-closed-outline" size={18} color={colors.danger} />
                  </View>
                ) : (
                  <Pressable
                    hitSlop={8}
                    style={s.iconBtn}
                    accessibilityRole="button"
                    accessibilityLabel={
                      item.status === 'hidden' ? 'Вернуть в каталог' : 'Снять с публикации'
                    }
                    onPress={async () => {
                      try {
                        await setItemStatus(item.id, item.status === 'hidden' ? 'active' : 'hidden');
                        await load();
                      } catch (e) {
                        setError(humanizeError(e));
                      }
                    }}
                  >
                    <Ionicons
                      name={item.status === 'hidden' ? 'eye-outline' : 'eye-off-outline'}
                      size={18}
                      color={colors.textMuted}
                    />
                  </Pressable>
                )}
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
  sectionTitle: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  headerRow: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' },
  link: { fontSize: 14, fontFamily: typeface[700], color: colors.accent },
  iconBtn: { padding: spacing.xs },
  moneyHero: { alignItems: 'center', gap: 2, paddingVertical: spacing.sm },
  moneyLabel: {
    fontSize: 12,
    fontFamily: typeface[700],
    color: colors.textMuted,
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  moneyValue: { fontSize: 44, fontFamily: typeface[800], color: colors.green, letterSpacing: -1.4 },
  moneyPending: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, textAlign: 'center' },
  thumb: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: colors.border },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  stateRow: { flexDirection: 'row', alignItems: 'center', gap: 5, marginTop: 1 },
  stateDot: { width: 6, height: 6, borderRadius: 3 },
  moderated: {
    fontSize: 12,
    fontFamily: typeface[400],
    color: colors.danger,
    lineHeight: 16,
  },
  stateText: { fontSize: 12, fontFamily: typeface[600], color: colors.textMuted },
  note: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 18 },
  error: { fontSize: 14, fontFamily: typeface[400], color: colors.danger },
  newsRow: { gap: 2, borderLeftWidth: 3, borderLeftColor: colors.green, paddingLeft: spacing.md },
  newsTitle: { fontSize: 14, fontFamily: typeface[700], color: colors.text },
  newsBody: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted },
  newsDate: { fontSize: 11, fontFamily: typeface[400], color: colors.textMuted },
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
    paddingVertical: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  actionTitle: { fontSize: 15, fontFamily: typeface[600], color: colors.text },
  radius: { borderRadius: radius.md },
});
