import { Link, useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import {
  FlatList,
  Image,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Empty, ErrorState, Loader } from '../../src/components/ui';
import { fetchCatalog, fetchCategories } from '../../src/lib/api';
import { formatTenge, ratingLabel } from '../../src/lib/format';
import { humanizeError } from '../../src/lib/supabase';
import { useRefresh } from '../../src/lib/useRefresh';
import type { Category, ItemWithOwner } from '../../src/lib/types';
import { colors, elevation, radius, spacing } from '../../src/theme';

/** Экран 2: каталог — поиск и фильтр по категории. */
export default function Catalog() {
  const router = useRouter();
  const [categories, setCategories] = useState<Category[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ItemWithOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(await fetchCatalog({ category: active, search }));
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, [active, search]);

  const { refreshing, onRefresh } = useRefresh(load);

  useEffect(() => {
    fetchCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    // Небольшая задержка вместо запроса на каждую букву: иначе каталог
    // дёргается на каждом нажатии клавиши.
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  return (
    <View style={s.screen}>
      <View style={s.searchWrap}>
        <View style={s.search}>
          <Ionicons name="search" size={18} color={colors.textMuted} />
          <TextInput
            value={search}
            onChangeText={setSearch}
            placeholder="Перфоратор, бетономешалка, леса…"
            placeholderTextColor={colors.textMuted}
            style={s.searchInput}
          />
          {search.length > 0 ? (
            <Pressable onPress={() => setSearch('')} hitSlop={10}>
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        contentContainerStyle={s.chips}
      >
        <Chip label="Все" selected={active === null} onPress={() => setActive(null)} />
        {categories.map((c) => (
          <Chip
            key={c.slug}
            label={c.title_ru}
            selected={active === c.slug}
            onPress={() => setActive(active === c.slug ? null : c.slug)}
          />
        ))}
      </ScrollView>

      {loading ? (
        <Loader />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <FlatList
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={s.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
          }
          ListEmptyComponent={
            <Empty
              icon="cube-outline"
              title={search ? 'Ничего не нашлось' : 'Пока пусто'}
              body={
                search
                  ? 'Попробуйте другое слово или уберите фильтр по категории.'
                  : 'В этой категории ещё нет объявлений. Можно стать первым — выложите свой инструмент.'
              }
            />
          }
          renderItem={({ item }) => (
            <Pressable onPress={() => router.push(`/item/${item.id}`)} style={s.card}>
              {item.condition_photos[0] ? (
                <Image source={{ uri: item.condition_photos[0] }} style={s.photo} />
              ) : (
                <View style={[s.photo, s.photoEmpty]}>
                  <Text style={s.photoEmptyText}>нет фото</Text>
                </View>
              )}
              <View style={s.cardBody}>
                <Text style={s.title} numberOfLines={2}>
                  {item.title}
                </Text>
                <Text style={s.price}>{formatTenge(item.daily_price)} / сутки</Text>
                <Text style={s.meta}>
                  Депозит {formatTenge(item.deposit_amount)} · ★{' '}
                  {ratingLabel(item.owner?.rating ?? null, item.owner?.ratings_count ?? 0)}
                </Text>
              </View>
            </Pressable>
          )}
        />
      )}

      <Link href="/item/new" asChild>
        <Pressable style={s.fab}>
          <Text style={s.fabText}>+ Сдать вещь</Text>
        </Pressable>
      </Link>
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={[s.chip, selected && { backgroundColor: colors.accent, borderColor: colors.accent }]}
    >
      <Text style={[s.chipText, selected && { color: '#FFFFFF' }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },
  searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  search: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 12,
  },
  searchInput: { flex: 1, fontSize: 15, color: colors.text, outlineStyle: 'none' } as object,
  chips: { paddingHorizontal: spacing.lg, gap: spacing.sm, paddingBottom: spacing.md },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.text },
  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: 96 },
  card: {
    flexDirection: 'row',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
    ...elevation.card,
  },
  photo: { width: 88, height: 88, borderRadius: radius.md, backgroundColor: colors.border },
  photoEmpty: { alignItems: 'center', justifyContent: 'center' },
  photoEmptyText: { fontSize: 11, color: colors.textMuted },
  cardBody: { flex: 1, gap: spacing.xs, justifyContent: 'center' },
  title: { fontSize: 16, fontWeight: '700', color: colors.text },
  price: { fontSize: 15, fontWeight: '800', color: colors.accent },
  meta: { fontSize: 12, color: colors.textMuted },
  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    backgroundColor: colors.accent,
    paddingHorizontal: spacing.xl,
    paddingVertical: 14,
    borderRadius: radius.pill,
    ...elevation.raised,
  },
  fabText: { color: '#FFFFFF', fontWeight: '800', fontSize: 15 },
});
