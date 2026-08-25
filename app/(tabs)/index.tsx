import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Link, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FlatList,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  useWindowDimensions,
  View,
} from 'react-native';
import { CatalogSkeleton } from '../../src/components/Skeleton';
import { Empty, ErrorState, ScreenHead, tap } from '../../src/components/ui';
import type { CatalogSort } from '../../src/lib/api';
import { fetchCatalog, fetchCategories, fetchFavoriteIds, toggleFavorite } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { formatTenge, plural, ratingLabel } from '../../src/lib/format';
import { humanizeError } from '../../src/lib/supabase';
import type { Category, ItemWithOwner } from '../../src/lib/types';
import { useRefresh } from '../../src/lib/useRefresh';
import { colors, elevation, radius, spacing, typeface } from '../../src/theme';

/**
 * Экран 2: каталог.
 *
 * Витрина, а не список записей: решение принимают по фото и цене, поэтому
 * они и занимают карточку. Название — вторым слоем, доверие (рейтинг и
 * число сделок) — третьим, депозит — последним: он важен уже после выбора.
 *
 * Управление свёрнуто. Поиск и категории видны всегда, сортировка и цена
 * прячутся под «Фильтры»: иначе четыре этажа контролов съедают первый
 * экран целиком, и товара на нём не остаётся.
 */

const SORTS: { key: CatalogSort; label: string }[] = [
  { key: 'new', label: 'Новые' },
  { key: 'price_asc', label: 'Сначала дешёвые' },
  { key: 'price_desc', label: 'Сначала дорогие' },
];

export default function Catalog() {
  const router = useRouter();
  const { session } = useAuth();
  const { width } = useWindowDimensions();

  // Телефон — две колонки, планшет — три, широкий веб — четыре.
  const columns = width < 560 ? 2 : width < 940 ? 3 : 4;

  const [categories, setCategories] = useState<Category[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [items, setItems] = useState<ItemWithOwner[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [sort, setSort] = useState<CatalogSort>('new');
  const [maxPrice, setMaxPrice] = useState('');
  const [showFilters, setShowFilters] = useState(false);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [onlyFavorites, setOnlyFavorites] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      setItems(
        await fetchCatalog({
          category: active,
          search,
          sort,
          maxPrice: Number(maxPrice) || null,
          onlyIds: onlyFavorites ? favorites : null,
        }),
      );
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, [active, search, sort, maxPrice, onlyFavorites, favorites]);

  const { refreshing, onRefresh } = useRefresh(load);

  useEffect(() => {
    fetchCategories().then(setCategories).catch(() => setCategories([]));
  }, []);

  useEffect(() => {
    if (!session) return;
    fetchFavoriteIds(session.user.id).then(setFavorites).catch(() => setFavorites([]));
  }, [session]);

  useEffect(() => {
    // Задержка вместо запроса на каждую букву: иначе каталог дёргается
    // на каждом нажатии клавиши.
    const t = setTimeout(load, search ? 300 : 0);
    return () => clearTimeout(t);
  }, [load, search]);

  // Переключаем сразу в состоянии, не дожидаясь ответа: сердечко, которое
  // «думает» полсекунды, воспринимается как несработавшее нажатие.
  const flipFavorite = useCallback(
    async (itemId: string) => {
      // Без входа сердечко ведёт на вход, а не молчит: молчащая кнопка
      // читается как поломка.
      if (!session) {
        router.push('/sign-in');
        return;
      }
      const on = !favorites.includes(itemId);
      setFavorites((prev) => (on ? [...prev, itemId] : prev.filter((x) => x !== itemId)));
      try {
        await toggleFavorite(session.user.id, itemId, on);
      } catch {
        setFavorites((prev) => (on ? prev.filter((x) => x !== itemId) : [...prev, itemId]));
      }
    },
    [session, favorites],
  );

  const activeFilters = useMemo(
    () => (sort !== 'new' ? 1 : 0) + (maxPrice ? 1 : 0) + (onlyFavorites ? 1 : 0),
    [sort, maxPrice, onlyFavorites],
  );

  return (
    <View style={s.screen}>
      {/* ── Кто мы, где и поиск — одним блоком ────────────── */}
      <ScreenHead
        title="Инструмент рядом"
        sub="Берут на день, а не покупают за 90 000 ₸"
        tone="warm"
      >
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
      </ScreenHead>

      {/* ── Категории ─────────────────────────────────────── */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.chipsRow}
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

      {/* ── Сколько нашли + вход в фильтры ────────────────── */}
      <View style={s.bar}>
        <Text style={s.count}>
          {loading ? ' ' : items.length > 0 ? plural(items.length, 'объявление', 'объявления', 'объявлений') : ''}
        </Text>
        <Pressable style={s.filterBtn} onPress={() => setShowFilters((v) => !v)} hitSlop={6}>
          <Ionicons name="options-outline" size={16} color={colors.text} />
          <Text style={s.filterBtnText}>Фильтры</Text>
          {activeFilters > 0 ? (
            <View style={s.badge}>
              <Text style={s.badgeText}>{activeFilters}</Text>
            </View>
          ) : null}
        </Pressable>
      </View>

      {showFilters ? (
        <View style={s.panel}>
          <ScrollView
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.chipsRow}
        contentContainerStyle={s.chips}
      >
            {SORTS.map((o) => (
              <Chip
                key={o.key}
                label={o.label}
                selected={sort === o.key}
                onPress={() => setSort(o.key)}
              />
            ))}
          </ScrollView>

          <View style={s.panelRow}>
            <View style={s.priceWrap}>
              <Text style={s.priceLabel}>до</Text>
              <TextInput
                value={maxPrice}
                onChangeText={setMaxPrice}
                placeholder="цена"
                placeholderTextColor={colors.textMuted}
                keyboardType="number-pad"
                style={s.priceInput}
              />
              <Text style={s.priceLabel}>₸ / сутки</Text>
            </View>

            {session ? (
              <Chip
                label={onlyFavorites ? '♥ Избранное' : '♡ Избранное'}
                selected={onlyFavorites}
                onPress={() => setOnlyFavorites((v) => !v)}
              />
            ) : null}
          </View>
        </View>
      ) : null}

      {/* ── Витрина ───────────────────────────────────────── */}
      {loading ? (
        <CatalogSkeleton columns={columns} />
      ) : error ? (
        <ErrorState message={error} onRetry={load} />
      ) : (
        <FlatList
          // numColumns нельзя менять на лету — список не перестроится.
          // Смена key заставляет React пересоздать его при повороте
          // экрана или изменении ширины окна в вебе.
          key={`cols-${columns}`}
          numColumns={columns}
          data={items}
          keyExtractor={(i) => i.id}
          contentContainerStyle={s.list}
          columnWrapperStyle={s.column}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
          }
          ListEmptyComponent={
            <Empty
              action={
                onlyFavorites || search
                  ? undefined
                  : { label: 'Выложить свой инструмент', onPress: () => router.push('/item/new') }
              }
              icon={onlyFavorites ? 'heart-outline' : 'cube-outline'}
              title={onlyFavorites ? 'В избранном пусто' : search ? 'Ничего не нашлось' : 'Пока пусто'}
              body={
                onlyFavorites
                  ? 'Нажмите сердечко на объявлении — оно появится здесь.'
                  : search
                    ? 'Попробуйте другое слово или уберите фильтр по категории.'
                    : 'В этой категории ещё нет объявлений. Можно стать первым — выложите свой инструмент.'
              }
            />
          }
          renderItem={({ item }) => (
            <ItemCard
              item={item}
              favorite={favorites.includes(item.id)}
              onPress={() => router.push(`/item/${item.id}`)}
              onFavorite={() => flipFavorite(item.id)}
            />
          )}
        />
      )}

      <Link href="/item/new" asChild>
        <Pressable style={s.fab}>
          <Ionicons name="add" size={20} color={colors.onFill} />
          <Text style={s.fabText}>Сдать вещь</Text>
        </Pressable>
      </Link>
    </View>
  );
}

/**
 * Карточка витрины. Порядок сверху вниз повторяет порядок принятия решения:
 * фото → цена → что это → кому доверяем → сколько блокируется.
 */
function ItemCard({
  item,
  favorite,
  onPress,
  onFavorite,
}: {
  item: ItemWithOwner;
  favorite: boolean;
  onPress: () => void;
  onFavorite: () => void;
}) {
  const photo = item.condition_photos[0];

  return (
    <Pressable style={({ pressed }) => [s.card, tap({ pressed })]} onPress={onPress}>
      <View style={s.photoWrap}>
        {photo ? (
          <Image
            source={photo}
            style={s.photo}
            contentFit="cover"
            transition={220}
            // Без этого при прокрутке сетки на месте нового фото на миг
            // остаётся предыдущее: FlatList переиспользует вью.
            recyclingKey={item.id}
          />
        ) : (
          <View style={[s.photo, s.photoEmpty]}>
            <Ionicons name="image-outline" size={26} color={colors.textMuted} />
          </View>
        )}

        {item.condition_photos.length > 1 ? (
          <View style={s.photoCount}>
            <Ionicons name="images-outline" size={11} color={colors.onScrim} />
            <Text style={s.photoCountText}>{item.condition_photos.length}</Text>
          </View>
        ) : null}

        <Pressable style={s.heart} onPress={onFavorite} hitSlop={8}>
          <Ionicons
            name={favorite ? 'heart' : 'heart-outline'}
            size={17}
            color={favorite ? colors.accent : colors.text}
          />
        </Pressable>
      </View>

      <View style={s.body}>
        <Text style={s.price}>
          {formatTenge(item.daily_price)}
          <Text style={s.perDay}> / сутки</Text>
        </Text>

        <Text style={s.title} numberOfLines={2}>
          {item.title}
        </Text>

        <View style={s.trust}>
          <Ionicons name="star" size={12} color={colors.warn} />
          <Text style={s.trustText}>
            {ratingLabel(item.owner?.rating ?? null, item.owner?.ratings_count ?? 0)}
          </Text>
        </View>

        <Text style={s.deposit}>депозит {formatTenge(item.deposit_amount)}</Text>
      </View>
    </Pressable>
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
      <Text style={[s.chipText, selected && { color: colors.onFill }]}>{label}</Text>
    </Pressable>
  );
}

const s = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.bg },

  searchWrap: { paddingHorizontal: spacing.lg, paddingBottom: spacing.md },
  search: {
    marginTop: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.surface,
    borderWidth: 0,
    ...elevation.card,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.lg,
    paddingVertical: 13,
  },
  searchInput: { flex: 1, fontSize: 15, fontFamily: typeface[400], color: colors.text, outlineStyle: 'none' } as object,

  // react-native-web разворачивает горизонтальный ScrollView в flex-элемент
  // и растягивает его по высоте родителя, а вместе с ним и чипсы — на телефоне
  // этого не происходит, там он подгоняется под содержимое. Поэтому высоту
  // фиксируем явно, а alignItems не даёт кнопкам тянуться вертикально.
  chipsRow: { flexGrow: 0, flexShrink: 0, marginTop: spacing.lg },
  chips: { paddingHorizontal: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  chip: {
    paddingHorizontal: 15,
    paddingVertical: 9,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipText: { fontSize: 13.5, fontFamily: typeface[600], color: colors.text },

  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
  },
  count: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted },
  filterBtn: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    paddingVertical: 6,
    paddingHorizontal: spacing.md,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  filterBtnText: { fontSize: 13, fontFamily: typeface[700], color: colors.text },
  badge: {
    minWidth: 18,
    height: 18,
    borderRadius: 9,
    paddingHorizontal: 4,
    backgroundColor: colors.accent,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badgeText: { fontSize: 11, fontFamily: typeface[800], color: colors.onFill },

  panel: { paddingTop: spacing.md, gap: spacing.md },
  panelRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    flexWrap: 'wrap',
  },
  priceWrap: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  priceLabel: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted },
  priceInput: {
    minWidth: 78,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: radius.md,
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    fontSize: 14,
    color: colors.text,
    outlineStyle: 'none',
  } as object,

  list: { padding: spacing.lg, gap: spacing.md, paddingBottom: 110 },
  column: { gap: spacing.md },

  card: {
    flex: 1,
    backgroundColor: colors.surface,
    borderRadius: radius.xl,
    borderWidth: 1,
    borderColor: 'rgba(26,25,23,0.06)',
    padding: 5,
    overflow: 'hidden',
    ...elevation.card,
  },
  photoWrap: {
    width: '100%',
    aspectRatio: 4 / 3,
    backgroundColor: colors.border,
    borderRadius: 17,
    overflow: 'hidden',
  },
  photo: { width: '100%', height: '100%' },
  photoEmpty: { alignItems: 'center', justifyContent: 'center', backgroundColor: colors.accentSoft },
  photoCount: {
    position: 'absolute',
    left: spacing.sm,
    bottom: spacing.sm,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 3,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(26,25,23,0.62)',
  },
  photoCountText: { fontSize: 11, fontFamily: typeface[700], color: colors.onScrim },
  heart: {
    position: 'absolute',
    top: spacing.sm,
    right: spacing.sm,
    width: 30,
    height: 30,
    borderRadius: 15,
    backgroundColor: 'rgba(255,255,255,0.94)',
    alignItems: 'center',
    justifyContent: 'center',
    ...elevation.card,
  },

  body: { paddingHorizontal: 9, paddingTop: 10, paddingBottom: 6, gap: 4 },
  price: { fontSize: 21, fontFamily: typeface[800], color: colors.text, letterSpacing: -0.7 },
  perDay: { fontSize: 12, fontFamily: typeface[600], color: colors.textMuted },
  title: { fontSize: 14, fontFamily: typeface[500], color: colors.text, lineHeight: 19 },
  trust: { flexDirection: 'row', alignItems: 'center', gap: 4, marginTop: 2 },
  trustText: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },
  deposit: { fontSize: 11, fontFamily: typeface[400], color: colors.textMuted },

  fab: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.xs,
    backgroundColor: colors.accent,
    paddingLeft: spacing.md,
    paddingRight: spacing.lg,
    paddingVertical: 13,
    borderRadius: radius.pill,
    ...elevation.raised,
  },
  fabText: { color: colors.onFill, fontFamily: typeface[800], fontSize: 15 },
});
