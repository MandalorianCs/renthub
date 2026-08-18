import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useLocalSearchParams } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { BookingTimeline } from '../../src/components/BookingTimeline';
import { ListSkeleton } from '../../src/components/Skeleton';
import { Badge, Button, Card, Empty, ErrorState, Field, Row } from '../../src/components/ui';
import {
  cancelBooking,
  completeBooking,
  confirmBooking,
  fetchBooking,
  fetchBookingReviews,
  fetchDisputes,
  fetchItem,
  markPickedUp,
  markReturned,
  openDamageDispute,
  submitReview,
  uploadPhoto,
} from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import {
  BOOKING_STATUS,
  DEPOSIT_STATUS,
  formatDateRange,
  formatDateTime,
  formatTenge,
} from '../../src/lib/format';
import { nextMove } from '../../src/lib/nextMove';
import { humanizeError } from '../../src/lib/supabase';
import type { BookingWithItem, Dispute, ItemWithOwner, Review } from '../../src/lib/types';
import { colors, radius, spacing, typeface } from '../../src/theme';

/**
 * Экран сделки. Один экран для обеих сторон: что можно сделать,
 * решает не роль в интерфейсе, а статус + кто ты в этой сделке.
 * Каждая кнопка вызывает RPC, которая перепроверяет то же самое в базе —
 * скрытая кнопка это подсказка, а не защита.
 */
export default function BookingScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { session } = useAuth();

  const [booking, setBooking] = useState<BookingWithItem | null>(null);
  const [item, setItem] = useState<ItemWithOwner | null>(null);
  const [disputes, setDisputes] = useState<Dispute[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const b = await fetchBooking(id);
      setBooking(b);
      if (b) {
        const [i, d, r] = await Promise.all([
          fetchItem(b.item_id),
          fetchDisputes(b.id),
          fetchBookingReviews(b.id),
        ]);
        setItem(i);
        setDisputes(d);
        setReviews(r);
      }
      setError(null);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  async function act(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
      await load();
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(false);
    }
  }

  if (loading) return <ListSkeleton rows={3} />;
  if (error && !booking) return <ErrorState message={error} onRetry={load} />;
  if (!booking) return <Empty icon="document-outline" title="Сделка не найдена" />;

  const me = session?.user.id;
  const isOwner = booking.owner_id === me;
  const isRenter = booking.renter_id === me;
  const status = BOOKING_STATUS[booking.status];
  const deposit = DEPOSIT_STATUS[booking.deposit_status];
  const alreadyReviewed = reviews.some((r) => r.from_user_id === me);
  const move = nextMove(booking, isOwner);

  // Какой срок сейчас важен. Их всего два, и одновременно не бывает:
  // до возврата — grace period, после — окно на претензию по порче.
  const deadline =
    booking.status === 'active' && booking.grace_period_ends_at
      ? {
          at: booking.grace_period_ends_at,
          color: colors.warn,
          title: 'Вернуть до',
          body:
            'Если вещь не вернуть к этому времени, система сама откроет спор ' +
            'о невозврате и удержит депозит. Время местное.',
        }
      : booking.status === 'returned' && booking.damage_claim_ends_at
        ? {
            at: booking.damage_claim_ends_at,
            color: colors.green,
            title: isOwner ? 'Заявить о порче можно до' : 'Депозит вернётся до',
            body: isOwner
              ? 'После этого времени сделка закроется сама, и претензию подать будет нельзя.'
              : 'Если владелец не заявит о повреждениях, сделка закроется сама и депозит вернётся.',
          }
        : null;

  return (
    <ScrollView contentContainerStyle={s.container}>
      <View style={{ gap: spacing.sm }}>
        <Text style={s.title}>{booking.item?.title ?? 'Объявление удалено'}</Text>
        <View style={s.badges}>
          <Badge label={status.label} fg={status.fg} bg={status.bg} />
          <Badge label={deposit.label} fg={deposit.fg} bg={deposit.bg} />
        </View>
      </View>

      <Card>
        <BookingTimeline status={booking.status} />
      </Card>

      {/* Главный вопрос на этом экране — «чего от меня хотят». Он должен
          быть написан словами, а не выведен человеком из статуса. */}
      <View style={[s.move, move.yours ? s.moveYours : s.moveWaiting]}>
        <Ionicons
          name={move.icon}
          size={22}
          color={move.yours ? colors.accent : colors.textMuted}
        />
        <View style={{ flex: 1, gap: 3 }}>
          <Text style={[s.moveTitle, move.yours && { color: colors.accent }]}>{move.title}</Text>
          <Text style={s.moveBody}>{move.body}</Text>
        </View>
      </View>

      <Card>
        <Row left="Период" right={formatDateRange(booking.start_date, booking.end_date)} />
        <Row left="Дней" right={String(booking.days)} muted />
        <Row left={`Аренда ${formatTenge(booking.daily_price_snapshot)} × ${booking.days}`} right={formatTenge(booking.rent_total)} />
        {booking.insurance_selected ? (
          <Row left="Страховой сбор" right={formatTenge(booking.insurance_fee)} muted />
        ) : null}
        <Row left="Депозит" right={formatTenge(booking.deposit_snapshot)} muted />
        {isRenter ? <Row left="Итого к оплате" right={formatTenge(booking.renter_total)} /> : null}
        {isOwner ? (
          <>
            <Row left="Комиссия платформы" right={`− ${formatTenge(booking.platform_fee)}`} muted />
            <Row left="Вам начислится" right={formatTenge(booking.owner_payout_total)} />
          </>
        ) : null}
      </Card>

      {/* Срок показывается обеим сторонам и в обоих статусах, где он есть.
          Раньше окно претензии было видно только из кода: арендатор не знал,
          когда вернётся депозит, а владелец — сколько у него осталось. */}
      {deadline ? (
        <Card>
          <View style={s.deadlineRow}>
            <Ionicons name="time-outline" size={20} color={deadline.color} />
            <View style={{ flex: 1, gap: 2 }}>
              <Text style={[s.deadlineTitle, { color: deadline.color }]}>{deadline.title}</Text>
              <Text style={s.deadlineWhen}>{formatDateTime(deadline.at)}</Text>
            </View>
          </View>
          <Text style={s.note}>{deadline.body}</Text>
        </Card>
      ) : null}

      {disputes.length > 0 ? (
        <Card style={{ borderColor: colors.danger }}>
          <Text style={s.sectionTitle}>Споры</Text>
          {disputes.map((d) => (
            <View key={d.id} style={{ gap: spacing.xs }}>
              <Row
                left={d.type === 'damage' ? 'Порча вещи' : 'Невозврат'}
                right={resolutionLabel(d.resolution_status)}
              />
              {d.claim_amount > 0 ? (
                <Row left="Заявлено" right={formatTenge(d.claim_amount)} muted />
              ) : null}
              {d.resolved_at ? (
                <Row left="Удержано из депозита" right={formatTenge(d.payout_amount)} muted />
              ) : null}
              {d.resolution_note ? <Text style={s.note}>{d.resolution_note}</Text> : null}
              {d.evidence_photos.length > 0 ? (
                <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ flexGrow: 0 }}
                  contentContainerStyle={{ alignItems: 'center' }}
                >
                  {d.evidence_photos.map((uri) => (
                    <Image key={uri} source={uri} style={s.evidence} contentFit="cover" transition={180} />
                  ))}
                </ScrollView>
              ) : null}
            </View>
          ))}
        </Card>
      ) : null}

      {/* ── Действия ────────────────────────────────────────── */}

      {isOwner && booking.status === 'pending' ? (
        <Button title="Подтвердить бронь" loading={busy} onPress={() => act(() => confirmBooking(booking.id))} />
      ) : null}

      {isRenter && booking.status === 'pending' ? (
        <Button title="Отменить заявку" variant="ghost" loading={busy} onPress={() => act(() => cancelBooking(booking.id))} />
      ) : null}

      {isRenter && booking.status === 'confirmed' ? (
        <Button title="Я забрал вещь" loading={busy} onPress={() => act(() => markPickedUp(booking.id))} />
      ) : null}

      {isOwner && (booking.status === 'active' || booking.status === 'disputed') ? (
        <Button title="Вещь вернули" loading={busy} onPress={() => act(() => markReturned(booking.id))} />
      ) : null}

      {isOwner && booking.status === 'returned' ? (
        <>
          <Button
            title="Всё в порядке — закрыть сделку"
            loading={busy}
            onPress={() => act(() => completeBooking(booking.id))}
          />
          <DamageClaim
            deposit={booking.deposit_snapshot}
            beforePhotos={item?.condition_photos ?? []}
            userId={me!}
            onSubmit={(input) => act(() => openDamageDispute({ bookingId: booking.id, ...input }))}
          />
        </>
      ) : null}

      {booking.status === 'completed' && !alreadyReviewed && (isOwner || isRenter) ? (
        <ReviewForm
          onSubmit={(rating, comment) =>
            act(() =>
              submitReview({
                bookingId: booking.id,
                fromUserId: me!,
                toUserId: isOwner ? booking.renter_id : booking.owner_id,
                rating,
                comment,
              }),
            )
          }
        />
      ) : null}

      {error ? <Text style={s.error}>{error}</Text> : null}
    </ScrollView>
  );
}

/** Претензия по порче: без фото «после» база откажет (RENTHUB_NO_EVIDENCE). */
function DamageClaim({
  deposit,
  beforePhotos,
  userId,
  onSubmit,
}: {
  deposit: number;
  beforePhotos: string[];
  userId: string;
  onSubmit: (input: { claimAmount: number; photos: string[]; description?: string }) => void;
}) {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
  const [uploading, setUploading] = useState(false);

  if (!open) {
    return <Button title="Заявить о повреждении" variant="danger" onPress={() => setOpen(true)} />;
  }

  return (
    <Card style={{ borderColor: colors.danger }}>
      <Text style={s.sectionTitle}>Претензия по состоянию вещи</Text>

      {beforePhotos.length > 0 ? (
        <>
          <Text style={s.note}>Фото «до» — с ними будут сверяться ваши новые снимки:</Text>
          <ScrollView
                  horizontal
                  showsHorizontalScrollIndicator={false}
                  style={{ flexGrow: 0 }}
                  contentContainerStyle={{ alignItems: 'center' }}
                >
            {beforePhotos.map((uri) => (
              <Image key={uri} source={uri} style={s.evidence} contentFit="cover" transition={180} />
            ))}
          </ScrollView>
        </>
      ) : null}

      <Field
        label="Сумма ущерба, ₸"
        value={amount}
        onChangeText={setAmount}
        keyboardType="number-pad"
        hint={`Не больше депозита — ${formatTenge(deposit)}. До 15 000 ₸ решается автоматически, выше — модератором.`}
      />
      <Field label="Что повреждено" value={description} onChangeText={setDescription} multiline />

      <View style={s.photos}>
        {photos.map((uri) => (
          <Image key={uri} source={uri} style={s.evidence} contentFit="cover" transition={180} />
        ))}
        <Pressable
          style={[s.evidence, s.photoAdd]}
          disabled={uploading}
          onPress={async () => {
            const result = await ImagePicker.launchImageLibraryAsync({
              mediaTypes: ['images'],
              quality: 0.7,
              allowsMultipleSelection: true,
            });
            if (result.canceled) return;
            setUploading(true);
            try {
              const urls = await Promise.all(result.assets.map((a) => uploadPhoto(userId, a.uri)));
              setPhotos((prev) => [...prev, ...urls]);
            } finally {
              setUploading(false);
            }
          }}
        >
          <Text style={s.photoAddText}>{uploading ? '…' : '+'}</Text>
        </Pressable>
      </View>

      <Button
        title="Отправить претензию"
        variant="danger"
        disabled={photos.length === 0 || !Number(amount)}
        onPress={() =>
          onSubmit({ claimAmount: Number(amount), photos, description: description || undefined })
        }
      />
      <Button title="Отмена" variant="ghost" onPress={() => setOpen(false)} />
    </Card>
  );
}

function ReviewForm({ onSubmit }: { onSubmit: (rating: number, comment?: string) => void }) {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState('');

  return (
    <Card>
      <Text style={s.sectionTitle}>Оцените другую сторону</Text>
      <View style={s.stars}>
        {[1, 2, 3, 4, 5].map((n) => (
          <Pressable key={n} onPress={() => setRating(n)}>
            <Text style={[s.star, n <= rating && { color: colors.accent }]}>★</Text>
          </Pressable>
        ))}
      </View>
      <Field label="Комментарий" value={comment} onChangeText={setComment} multiline />
      <Button
        title="Отправить отзыв"
        disabled={rating === 0}
        onPress={() => onSubmit(rating, comment || undefined)}
      />
    </Card>
  );
}

function resolutionLabel(status: Dispute['resolution_status']): string {
  return {
    auto_resolved: 'Решено автоматически',
    manual_review: 'На рассмотрении',
    resolved: 'Закрыт',
  }[status];
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  title: { fontSize: 22, fontFamily: typeface[800], color: colors.text },
  badges: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  move: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
    padding: spacing.lg,
    borderRadius: radius.lg,
    borderWidth: 1,
  },
  moveYours: { backgroundColor: colors.accentSoft, borderColor: colors.accent },
  moveWaiting: { backgroundColor: colors.surface, borderColor: colors.border },
  moveTitle: { fontSize: 16, fontFamily: typeface[800], color: colors.text },
  moveBody: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 19 },
  deadlineRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  deadlineTitle: { fontSize: 13, fontFamily: typeface[700] },
  deadlineWhen: { fontSize: 17, fontFamily: typeface[800], color: colors.text },
  sectionTitle: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  note: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 18 },
  error: { fontSize: 14, fontFamily: typeface[400], color: colors.danger },
  evidence: { width: 72, height: 72, borderRadius: radius.sm, marginRight: spacing.sm, backgroundColor: colors.border },
  photos: { flexDirection: 'row', flexWrap: 'wrap' },
  photoAdd: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  photoAddText: { fontSize: 24, fontFamily: typeface[400], color: colors.textMuted },
  stars: { flexDirection: 'row', gap: spacing.sm },
  star: { fontSize: 32, fontFamily: typeface[400], color: colors.border },
});
