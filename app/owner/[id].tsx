import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ListSkeleton } from '../../src/components/Skeleton';
import { Card, Empty, ErrorState } from '../../src/components/ui';
import { fetchOwnerItems, fetchPublicProfile, fetchReviewsAbout } from '../../src/lib/api';
import { formatDate, formatTenge, ratingLabel } from '../../src/lib/format';
import { humanizeError } from '../../src/lib/supabase';
import type { Item, PublicProfile, ReviewWithAuthor } from '../../src/lib/types';
import { useRefresh } from '../../src/lib/useRefresh';
import { colors, elevation, radius, spacing, typeface } from '../../src/theme';

/**
 * Публичный профиль владельца.
 *
 * Существует ради одного решения: отдать ли незнакомцу вещь за 90 000 ₸
 * или взять её у него. Рейтинг «4,8» сам по себе этого решения не
 * поддерживает — цифре без объяснения не верят. Поэтому здесь рядом
 * лежат три вещи: сколько сделок, что писали люди, и что ещё он сдаёт.
 *
 * Телефона нет: анониму он закрыт грантом на колонки, а участнику сделки
 * до подтверждения брони он не нужен.
 */
export default function OwnerProfile() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();

  const [profile, setProfile] = useState<PublicProfile | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [reviews, setReviews] = useState<ReviewWithAuthor[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, i, r] = await Promise.all([
        fetchPublicProfile(id),
        fetchOwnerItems(id),
        fetchReviewsAbout(id),
      ]);
      setProfile(p);
      setItems(i);
      setReviews(r);
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

  const { refreshing, onRefresh } = useRefresh(load);

  if (loading) return <ListSkeleton rows={3} />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!profile) return <Empty icon="person-outline" title="Профиль не найден" />;

  return (
    <ScrollView
      contentContainerStyle={s.container}
      refreshControl={
        <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
      }
    >
      <Card>
        <View style={s.head}>
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initials(profile.full_name)}</Text>
          </View>
          <View style={{ flex: 1, gap: 2 }}>
            <Text style={s.name}>{profile.full_name ?? 'Без имени'}</Text>
            <View style={s.ratingRow}>
              <Ionicons name="star" size={13} color={colors.warn} />
              <Text style={s.ratingText}>
                {ratingLabel(profile.rating, profile.ratings_count)}
              </Text>
            </View>
            {/* «На платформе с …» — дешёвый, но честный сигнал: аккаунт,
                заведённый вчера, и аккаунт годовой давности внушают разное. */}
            <Text style={s.since}>На платформе с {formatDate(profile.created_at)}</Text>
          </View>
        </View>
      </Card>

      <Card>
        <Text style={s.section}>Отзывы</Text>
        {reviews.length === 0 ? (
          <Text style={s.note}>
            Отзывов пока нет. Они появляются только после закрытой сделки — оставить
            их заранее или из мести нельзя.
          </Text>
        ) : (
          reviews.map((r) => (
            <View key={r.id} style={s.review}>
              <View style={s.reviewHead}>
                <Text style={s.reviewAuthor}>{r.author?.full_name ?? 'Участник сделки'}</Text>
                <View style={s.stars}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <Ionicons
                      key={n}
                      name={n <= r.rating ? 'star' : 'star-outline'}
                      size={12}
                      color={n <= r.rating ? colors.warn : colors.border}
                    />
                  ))}
                </View>
              </View>
              {r.comment ? <Text style={s.reviewText}>{r.comment}</Text> : null}
              <Text style={s.reviewDate}>{formatDate(r.created_at)}</Text>
            </View>
          ))
        )}
      </Card>

      <Card>
        <Text style={s.section}>
          {items.length > 0 ? `Сдаёт ещё ${items.length} ${plural(items.length)}` : 'Объявления'}
        </Text>
        {items.length === 0 ? (
          <Text style={s.note}>Сейчас нет активных объявлений.</Text>
        ) : (
          items.map((item) => (
            <Pressable
              key={item.id}
              style={s.itemRow}
              onPress={() => router.push(`/item/${item.id}`)}
            >
              {item.condition_photos[0] ? (
                <Image
                  source={item.condition_photos[0]}
                  style={s.thumb}
                  contentFit="cover"
                  transition={180}
                />
              ) : (
                <View style={[s.thumb, s.thumbEmpty]}>
                  <Ionicons name="image-outline" size={18} color={colors.textMuted} />
                </View>
              )}
              <View style={{ flex: 1, gap: 2 }}>
                <Text style={s.itemTitle} numberOfLines={1}>
                  {item.title}
                </Text>
                <Text style={s.itemPrice}>{formatTenge(item.daily_price)} / сутки</Text>
              </View>
              <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
            </Pressable>
          ))
        )}
      </Card>
    </ScrollView>
  );
}

function initials(name?: string | null): string {
  if (!name) return '—';
  const parts = name.trim().split(' ').filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '—';
}

function plural(n: number): string {
  const mod10 = n % 10;
  const mod100 = n % 100;
  if (mod10 === 1 && mod100 !== 11) return 'вещь';
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'вещи';
  return 'вещей';
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  head: { flexDirection: 'row', alignItems: 'center', gap: spacing.lg },
  avatar: {
    width: 60,
    height: 60,
    borderRadius: 30,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 20, fontFamily: typeface[800], color: colors.accent },
  name: { fontSize: 20, fontFamily: typeface[800], color: colors.text },
  ratingRow: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  ratingText: { fontSize: 14, fontFamily: typeface[600], color: colors.text },
  since: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },

  section: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  note: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 19 },

  review: {
    gap: 4,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  reviewHead: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.sm },
  reviewAuthor: { fontSize: 14, fontFamily: typeface[700], color: colors.text },
  stars: { flexDirection: 'row', gap: 1 },
  reviewText: { fontSize: 14, fontFamily: typeface[400], color: colors.text, lineHeight: 20 },
  reviewDate: { fontSize: 11, fontFamily: typeface[400], color: colors.textMuted },

  itemRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingTop: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
  },
  thumb: { width: 52, height: 52, borderRadius: radius.md, backgroundColor: colors.border },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  itemTitle: { fontSize: 14, fontFamily: typeface[600], color: colors.text },
  itemPrice: { fontSize: 13, fontFamily: typeface[800], color: colors.accent },
});
