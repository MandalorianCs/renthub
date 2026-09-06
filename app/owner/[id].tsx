import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { ProfileSkeleton } from '../../src/components/Skeleton';
import { Card, Empty, ErrorState, tap } from '../../src/components/ui';
import {
  fetchDealsCount,
  fetchOwnerItems,
  fetchPublicProfile,
  fetchReviewsAbout,
} from '../../src/lib/api';
import { categoryIcon } from '../../src/lib/category-icon';
import { formatDate, formatRating, formatTenge, plural } from '../../src/lib/format';
import { humanizeError } from '../../src/lib/supabase';
import type { Item, PublicProfile, ReviewWithAuthor } from '../../src/lib/types';
import { useRefresh } from '../../src/lib/useRefresh';
import { colors, radius, spacing, typeface } from '../../src/theme';

/**
 * Публичный профиль владельца.
 *
 * Существует ради одного решения: отдать ли незнакомцу вещь за 90 000 ₸
 * или взять её у него. Поэтому самое крупное здесь — оценка: по ней и
 * решают. Цифре без объяснения не верят, и рядом с ней лежит то, из чего
 * она сложилась: сколько отзывов, что в них написано, что человек сдаёт.
 *
 * Рядом с оценкой стоит число закрытых сделок, а не только отзывов:
 * отзыв оставляют не после каждой сделки, и человек с двадцатью арендами
 * выглядел бы как человек с тремя. Брони закрыты политикой
 * bookings_read_participants, поэтому счётчик приходит через
 * user_deals_count() — узкую функцию, отдающую одно число.
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
  const [deals, setDeals] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [p, i, r, d] = await Promise.all([
        fetchPublicProfile(id),
        fetchOwnerItems(id),
        fetchReviewsAbout(id),
        // Счётчик — единственное здесь, чей сбой не должен ронять экран:
        // профиль без него читается, а без имени и отзывов — нет. Ноль при
        // сбое не врёт, потому что ноль мы просто не показываем.
        fetchDealsCount(id).catch(() => 0),
      ]);
      setProfile(p);
      setItems(i);
      setReviews(r);
      setDeals(d);
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

  if (loading) return <ProfileSkeleton />;
  if (error) return <ErrorState message={error} onRetry={load} />;
  if (!profile) {
    return (
      <Empty
        icon="person-outline"
        title="Профиль не найден"
        body="Возможно, владелец удалил аккаунт, или ссылка старая. Объявления этого человека тогда тоже сняты с публикации."
        action={{ label: 'В каталог', onPress: () => router.replace('/') }}
      />
    );
  }

  const rated = profile.rating !== null && profile.ratings_count > 0;

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
            {/* «На платформе с …» — дешёвый, но честный сигнал: аккаунт,
                заведённый вчера, и аккаунт годовой давности внушают разное. */}
            <Text style={s.since}>На платформе с {formatDate(profile.created_at)}</Text>
          </View>
        </View>

        {/* Оценка — то, ради чего сюда заходят, и потому самое крупное на
            экране. Раньше крупнее всего было имя: узнать, к кому попал,
            помогало, а решить «доверять или нет» — нет. */}
        {rated ? (
          <View style={s.ratingBlock}>
            <Text style={s.ratingValue}>{formatRating(profile.rating!)}</Text>
            <View style={{ gap: spacing.xs }}>
              <Stars value={profile.rating!} size={16} />
              <Text style={s.ratingCount}>
                {plural(profile.ratings_count, 'отзыв', 'отзыва', 'отзывов')}
                {deals > 0 ? ` · ${plural(deals, 'сделка', 'сделки', 'сделок')}` : ''}
              </Text>
            </View>
          </View>
        ) : (
          /* Нулём оценку не рисуем: ноль читается как «плохой», а верно
             «ещё не оценивали». Разные вещи — и выглядеть должны по-разному. */
          <View style={s.ratingNoneBlock}>
            <Text style={s.ratingNone}>Оценок пока нет</Text>
            <Text style={s.note}>
              {deals > 0
                ? `Уже закрыто: ${plural(deals, 'сделка', 'сделки', 'сделок')} — но оценку ни одна сторона не оставила. Её ставят по желанию, и молчание здесь не отзыв.`
                : 'Оценку ставят только стороны закрытой сделки, поэтому у новых участников её не бывает. Это не признак плохого владельца — это признак нового.'}
            </Text>
          </View>
        )}
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
                <Stars value={r.rating} size={12} />
              </View>
              {r.comment ? <Text style={s.reviewText}>{r.comment}</Text> : null}
              <Text style={s.reviewDate}>{formatDate(r.created_at)}</Text>
            </View>
          ))
        )}
      </Card>

      <Card>
        <Text style={s.section}>
          {items.length > 0 ? `Сдаёт ${plural(items.length, 'вещь', 'вещи', 'вещей')}` : 'Объявления'}
        </Text>
        {items.length === 0 ? (
          <Text style={s.note}>
            Сейчас нет активных объявлений. Владелец мог снять их на время — вещь,
            уехавшую в аренду, из каталога не убирают, так что дело не в занятости.
          </Text>
        ) : (
          items.map((item) => (
            <Pressable
              key={item.id}
              style={({ pressed }) => [s.itemRow, tap({ pressed })]}
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
                  <Ionicons name={categoryIcon(item.category)} size={20} color={colors.textMuted} />
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

/**
 * Пять звёзд по оценке. Дробная округляется — половинок в шрифте иконок нет,
 * а рисовать «4,8» четырьмя звёздами честнее, чем пятью: точное число стоит
 * рядом цифрой, и звёзды здесь только показывают порядок величины.
 */
function Stars({ value, size }: { value: number; size: number }) {
  const filled = Math.round(value);
  return (
    <View style={s.stars}>
      {[1, 2, 3, 4, 5].map((n) => (
        <Ionicons
          key={n}
          name={n <= filled ? 'star' : 'star-outline'}
          size={size}
          color={n <= filled ? colors.warn : colors.border}
        />
      ))}
    </View>
  );
}

function initials(name?: string | null): string {
  if (!name) return '—';
  const parts = name.trim().split(' ').filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '—';
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
  name: { fontSize: 17, fontFamily: typeface[700], color: colors.text },
  since: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },

  ratingBlock: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.lg,
  },
  // Кегль и отрицательный трекинг — как у суммы заработка в «Моих вещах»:
  // это тоже число, ради которого открыли экран.
  ratingValue: { fontSize: 40, fontFamily: typeface[800], color: colors.text, letterSpacing: -1.2 },
  ratingCount: { fontSize: 13, fontFamily: typeface[600], color: colors.textMuted },
  ratingNoneBlock: {
    gap: spacing.xs,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    paddingTop: spacing.lg,
  },
  ratingNone: { fontSize: 17, fontFamily: typeface[700], color: colors.textMuted },

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
  // Цена — не действие и не выбор, поэтому не терракотовая. В каталоге то же
  // самое число стоит цветом текста; разный цвет у одной цены на соседних
  // экранах читается как разный смысл.
  itemPrice: { fontSize: 13, fontFamily: typeface[800], color: colors.text },
});
