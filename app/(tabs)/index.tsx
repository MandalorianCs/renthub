import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { Link, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Animated,
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
import { Empty, ErrorState, ScreenHead, SignedInNote, tap } from '../../src/components/ui';
import { categoryIcon } from '../../src/lib/category-icon';
import type { CatalogSort } from '../../src/lib/api';
import { fetchCatalog, fetchCategories, fetchFavoriteIds, toggleFavorite } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { formatTenge, plural, ratingLabel } from '../../src/lib/format';
import { isDemoOwner } from '../../src/lib/demo';
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
  const { session, linkedIn, dismissLinkedIn } = useAuth();
  const { width } = useWindowDimensions();

  // Телефон — две колонки, планшет — три, широкий веб — четыре.
  const columns = width < 560 ? 2 : width < 940 ? 3 : 4;

  /**
   * Ссылка задаёт, с чего открыть витрину: ?category=drills, ?q=перфоратор.
   *
   * Нужно это не для красоты адреса. Реклама ведёт на конкретный запрос —
   * человек, кликнувший «аренда перфоратора», должен увидеть перфораторы, а
   * не весь каталог и поле поиска. Каждый лишний шаг между объявлением и
   * товаром — это ушедшие люди.
   *
   * Значения только начальные: дальше экран живёт своим состоянием, и
   * адрес за ним не тянется. Синхронизировать в обе стороны значило бы
   * переписывать историю браузера на каждое нажатие фильтра — кнопка
   * «назад» перестала бы возвращать на предыдущую страницу.
   */
  const params = useLocalSearchParams<{ category?: string; q?: string; item?: string }>();

  // Ссылка на объявление приходит сюда, а не на /item/<id>.
  //
  // Причина внешняя: сайт лежит на GitHub Pages, а тот отдаёт файлы. Пути
  // вида /app/item/<uuid> файлами не являются, и сервер отвечает 404 —
  // страницу спасает 404.html, копия приложения, поэтому человек ничего не
  // замечает. Замечают краулеры: на 404 превью обычно не строится, и
  // ссылка, ради которой в карточку добавляли og-теги, приходит в чат
  // голым адресом.
  //
  // Адрес /app/?item=<uuid> существует физически и отвечает 200. Здесь мы
  // читаем параметр и открываем карточку — для человека переход незаметен,
  // а для мессенджера ссылка выглядит живой.
  //
  // replace, а не push: иначе «назад» вернёт на пустой каталог с тем же
  // параметром, и человек попадёт в петлю.
  useEffect(() => {
    if (params.item) router.replace(`/item/${params.item}`);
  }, [params.item, router]);

  const [categories, setCategories] = useState<Category[]>([]);
  const [active, setActive] = useState<string | null>(params.category ?? null);
  const [search, setSearch] = useState(params.q ?? '');
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

  /** Снять всё разом: по одному фильтры пришлось бы искать и выключать. */
  const resetFilters = useCallback(() => {
    setSearch('');
    setActive(null);
    setMaxPrice('');
    setOnlyFavorites(false);
    setSort('new');
  }, []);

  /**
   * Кнопка «Сдать вещь» уходит вниз, пока листают вниз, и возвращается на
   * движение вверх.
   *
   * Она висит поверх витрины и накрывает угол карточки вместе с сердечком.
   * Мириться с этим не обязательно: тот, кто листает каталог вниз, ищет
   * вещь в аренду — сдавать он не собирается, и в этот момент кнопка
   * мешает ровно тому, зачем человек пришёл. Движение вверх означает
   * обратное: он вернулся к управлению, и кнопка нужна снова.
   *
   * Порог в 12 точек — против дрожания: без него кнопка мигала бы на
   * каждом микродвижении пальца.
   */
  /**
   * Ряд категорий подкручивается к выбранной, если её задала ссылка.
   *
   * Без этого переход по рекламной ссылке выглядит поломкой: витрина
   * отфильтрована, а выбранная плашка уехала за правый край, и человек
   * видит «1 объявление» при, на его взгляд, невыбранном фильтре. Первое
   * объяснение, которое приходит в голову, — «здесь ничего нет».
   *
   * Только для категории из адреса: когда человек нажимает плашку сам, он
   * её видит, и уводить ряд под пальцем незачем.
   */
  const chipsRef = useRef<ScrollView>(null);
  const chipX = useRef<Record<string, number>>({});
  const chipsWidth = useRef(0);
  const chipsAligned = useRef(!params.category);

  /**
   * Выравнивание срабатывает по выполнению двух условий, а не по одному
   * событию. Порядок, в котором приходят onLayout плашек и
   * onContentSizeChange ряда, не гарантирован — обе прошлые попытки
   * упирались именно в это: прокрутка на 909 точек при ширине содержимого
   * 375 упирается в границу, то есть в ноль, и «выровнено» отмечалось
   * впустую.
   *
   * Теперь функция зовётся из обоих мест и ничего не делает, пока ряд не
   * стал шире того места, куда надо встать. Ждать по таймеру не нужно:
   * условие проверяемое, а не вероятностное.
   */
  const alignChips = useCallback(() => {
    if (chipsAligned.current || !active) return;

    const x = chipX.current[active];
    if (x === undefined) return;

    const target = Math.max(0, x - 16);
    if (chipsWidth.current <= target) return;

    chipsAligned.current = true;
    chipsRef.current?.scrollTo({ x: target, animated: false });
  }, [active]);

  const fabHidden = useRef(new Animated.Value(0)).current;
  const lastY = useRef(0);
  const hiddenNow = useRef(false);

  const onScroll = useCallback(
    (e: { nativeEvent: { contentOffset: { y: number } } }) => {
      const y = e.nativeEvent.contentOffset.y;
      const dy = y - lastY.current;
      if (Math.abs(dy) < 12) return;
      lastY.current = y;

      // У самого верха кнопка обязана быть на месте: там её и ищут.
      const hide = dy > 0 && y > 80;
      if (hide === hiddenNow.current) return;
      hiddenNow.current = hide;

      Animated.timing(fabHidden, {
        toValue: hide ? 1 : 0,
        duration: 180,
        useNativeDriver: true,
      }).start();
    },
    [fabHidden],
  );

  useEffect(() => {
    fetchCategories()
      .then((rows) => {
        setCategories(rows);

        // Категория из адреса проверяется по справочнику. Ссылку в рекламе
        // пишет человек, а не приложение: опечатка или переименованная
        // категория дала бы пустую витрину, где ничего не найдено и
        // непонятно почему. Лучше показать всё, чем ничего.
        setActive((cur) => (cur && !rows.some((r) => r.slug === cur) ? null : cur));
      })
      .catch(() => setCategories([]));
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

  /**
   * Что сейчас сужает выдачу — один список на два разных ответа.
   *
   * Вопросов действительно два, и путать их нельзя. Бейдж на кнопке
   * «Фильтры» отвечает «что спрятано в свёрнутой панели»: поиск и категорию
   * человек видит сам, а сортировку и цену — нет, и без значка он не узнает,
   * что они включены. Пустой экран отвечает на другое: «почему ничего нет»,
   * и там нужно назвать всё, включая видимое.
   *
   * Раньше на это отвечали два независимых выражения. Они и разошлись:
   * счётчик на кнопке не считал категорию и поиск, а пустой экран не знал
   * про цену и советовал «попробуйте другое слово» тому, у кого слова не
   * было. Теперь список один, а отличаются они признаком «видно и так».
   */
  const narrowing = useMemo(() => {
    const all: { label: string; visible: boolean }[] = [];
    if (search.trim()) all.push({ label: `поиск «${search.trim()}»`, visible: true });
    if (active) all.push({ label: 'категория', visible: true });
    // Сумма через formatTenge, как все остальные на этом экране: maxPrice —
    // строка из поля ввода, и в шаблоне она печаталась как есть. Пустой
    // каталог объяснял причину словами «цена до 15000 ₸», а карточки
    // рядом показывали «3 500 ₸» — два числа по разным правилам в одном
    // экране читаются как недоделка, ровно то, о чём предупреждает
    // докстрока formatRating.
    if (Number(maxPrice) > 0)
      all.push({ label: `цена до ${formatTenge(Number(maxPrice))}`, visible: false });
    if (onlyFavorites) all.push({ label: 'только избранное', visible: false });
    if (sort !== 'new') all.push({ label: 'сортировка', visible: false });
    return all;
  }, [search, active, maxPrice, onlyFavorites, sort]);

  // На кнопке — только то, чего не видно на экране: значок над «Фильтрами»
  // нужен, чтобы человек не искал причину там, где её не видно.
  const activeFilters = narrowing.filter((f) => !f.visible).length;

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
            placeholder="Перфоратор, леса, Васильковский…"
            placeholderTextColor={colors.textMuted}
            style={s.searchInput}
          />
          {search.length > 0 ? (
            <Pressable
              onPress={() => setSearch('')}
              hitSlop={10}
              accessibilityRole="button"
              accessibilityLabel="Очистить поиск"
            >
              <Ionicons name="close-circle" size={18} color={colors.textMuted} />
            </Pressable>
          ) : null}
        </View>
      </ScreenHead>

      {/* ── Категории ─────────────────────────────────────── */}
      <ScrollView
        ref={chipsRef}
        horizontal
        showsHorizontalScrollIndicator={false}
        style={s.chipsRow}
        contentContainerStyle={s.chips}
        onContentSizeChange={(w) => {
          chipsWidth.current = w;
          alignChips();
        }}
      >
        <Chip label="Все" selected={active === null} onPress={() => setActive(null)} />
        {categories.map((c) => (
          <View
            key={c.slug}
            onLayout={(e) => {
              chipX.current[c.slug] = e.nativeEvent.layout.x;
              alignChips();
            }}
          >
            <Chip
              label={c.title_ru}
              selected={active === c.slug}
              onPress={() => setActive(active === c.slug ? null : c.slug)}
            />
          </View>
        ))}
      </ScrollView>

      {/* Витрина, где нет ни одной живой вещи.
          Значок «ДЕМО» на карточке честен, но объясняет только карточку.
          Человек с рекламы видит восемь таких подряд и делает вывод не про
          карточки, а про платформу: тут ничего нет и делать нечего.

          Ему нужно сказать то, чего значок не говорит: пилот сейчас
          набирает владельцев, и он может стать одним из них. Это и есть
          то, ради чего его сюда привели.

          Условие строгое — ни одной живой. Пока живые есть, полоса не
          нужна: демо среди настоящих читается как демо. */}
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
          // Шапка списка, а не экрана.
          //
          // 05.09.2026 на телефоне 375×812 всё это стояло НАД списком и
          // потому не прокручивалось: заголовок, поиск, категории и полоса
          // «витрина для показа» занимали около 490 точек, и на карточки
          // оставалось полтора ряда. Полосу я добавил накануне, глядя на
          // широкий экран, и объяснение витрины стоило человеку самой
          // витрины.
          //
          // Здесь они уезжают вверх при первом же движении пальца: прочитал
          // — и дальше смотришь вещи.
          ListHeaderComponent={
            <>
              {linkedIn ? <SignedInNote onClose={dismissLinkedIn} /> : null}

              {/* Полоса про демо — см. её же объяснение выше по файлу.
                  Условие строгое: ни одной живой вещи. */}
              {items.length > 0 && items.every((i) => isDemoOwner(i.owner?.full_name)) ? (
                <View style={s.allDemo}>
                  <Ionicons name="construct-outline" size={20} color={colors.accent} />
                  <View style={{ flex: 1, gap: 4 }}>
                    <Text style={s.allDemoTitle}>Пока это витрина для показа</Text>
                    <Text style={s.allDemoBody}>
                      Все вещи здесь демонстрационные: пилот в Кокшетау только набирает
                      владельцев. Есть инструмент, который лежит без дела? Выложите — вашу
                      вещь увидят первой.
                    </Text>
                  </View>
                </View>
              ) : null}
            </>
          }
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.accent} />
          }
          ListEmptyComponent={
            <Empty
              // Кнопка зависит от причины пустоты. Пусто из-за фильтров —
              // снять фильтры; пусто по-настоящему — выложить своё. Одна
              // кнопка на оба случая звала бы публиковать того, кто просто
              // задал слишком низкую цену.
              action={
                narrowing.length > 0
                  ? { label: 'Сбросить фильтры', onPress: resetFilters }
                  : { label: 'Выложить свой инструмент', onPress: () => router.push('/item/new') }
              }
              icon={
                onlyFavorites ? 'heart-outline' : narrowing.length > 0 ? 'search-outline' : 'cube-outline'
              }
              title={
                onlyFavorites && narrowing.length === 1
                  ? 'В избранном пусто'
                  : narrowing.length > 0
                    ? 'Ничего не нашлось'
                    : 'Пока пусто'
              }
              body={
                onlyFavorites && narrowing.length === 1
                  ? 'Нажмите сердечко на объявлении — оно появится здесь.'
                  : narrowing.length > 0
                    ? `Сейчас включено: ${narrowing.map((f) => f.label).join(', ')}. Возможно, дело в этом.`
                    : 'В этой категории ещё нет объявлений. Можно стать первым — выложите свой инструмент.'
              }
            />
          }
          renderItem={({ item, index }) => (
            <ItemCard
              item={item}
              favorite={favorites.includes(item.id)}
              href={`/item/${item.id}`}
              onFavorite={() => flipFavorite(item.id)}
              // Первый экран — четыре карточки: их фотографии и есть тот
              // «самый крупный элемент», по которому браузер меряет
              // скорость открытия. Остальные грузятся в обычном порядке,
              // иначе приоритет теряет смысл.
              priority={index < 4}
            />
          )}
          onScroll={onScroll}
          scrollEventThrottle={32}
        />
      )}

      <Animated.View
        style={[
          s.fabWrap,
          {
            opacity: fabHidden.interpolate({ inputRange: [0, 1], outputRange: [1, 0] }),
            transform: [
              {
                translateY: fabHidden.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, 96],
                }),
              },
            ],
          },
        ]}
        // Спрятанную кнопку читалка не предлагает: иначе она называет
        // действие, которого на экране в этот момент нет.
        pointerEvents="box-none"
      >
        <Link href="/item/new" asChild>
          <Pressable style={s.fab} accessibilityRole="button" accessibilityLabel="Сдать вещь">
            <Ionicons name="add" size={20} color={colors.onFill} />
            <Text style={s.fabText}>Сдать вещь</Text>
          </Pressable>
        </Link>
      </Animated.View>
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
  href,
  onFavorite,
  priority = false,
}: {
  item: ItemWithOwner;
  favorite: boolean;
  href: string;
  onFavorite: () => void;
  priority?: boolean;
}) {
  const photo = item.condition_photos[0];

  /**
   * Карточка — настоящая ссылка, а не обработчик нажатия.
   *
   * На вебе Link отдаёт <a href>, и это меняет три вещи разом: объявление
   * открывается в новой вкладке средней кнопкой, его адрес копируется правой
   * кнопкой, и его видит поисковик. Витрина, которая растёт репостами, без
   * этого теряет ровно те переходы, ради которых она и делается.
   *
   * На телефоне поведение прежнее: Link с asChild передаёт нажатие тому же
   * Pressable, и router.push отрабатывает как раньше.
   */
  return (
    <Link href={href as Parameters<typeof Link>[0]['href']} asChild>
      <Pressable style={({ pressed }) => [s.card, tap({ pressed })]}>
      <View style={s.photoWrap}>
        {photo ? (
          <Image
            source={photo}
            style={s.photo}
            contentFit="cover"
            transition={220}
            // Подпись для скринридера и для тега alt на вебе. Без неё
            // витрина читается как «изображение, изображение, 4 000 ₸».
            alt={`Фото: ${item.title}`}
            // Первые карточки грузятся первыми: на вебе именно они —
            // самый крупный элемент экрана, и Lighthouse мерил по ним
            // 8,3 секунды, пока они ждали своей очереди.
            priority={priority ? 'high' : 'normal'}
            // Без этого при прокрутке сетки на месте нового фото на миг
            // остаётся предыдущее: FlatList переиспользует вью.
            recyclingKey={item.id}
          />
        ) : (
          <View style={[s.photo, s.photoEmpty]}>
            <Ionicons name={categoryIcon(item.category)} size={30} color={colors.textMuted} />
          </View>
        )}

        {item.condition_photos.length > 1 ? (
          <View style={s.photoCount}>
            <Ionicons name="images-outline" size={11} color={colors.onScrim} />
            <Text style={s.photoCountText}>{item.condition_photos.length}</Text>
          </View>
        ) : null}

        {/* Пометка стоит на фото, а не под названием: решение принимают по
            фото и цене, и узнать, что вещь демонстрационная, человек должен
            там же, где решает, — а не после нажатия «Забронировать».

            Цвет нейтральный, не терракота: это не действие и не выбор, а
            подпись к тому, что человек видит. Терракота значит «сюда
            нажимать» — см. DESIGN.md. */}
        {isDemoOwner(item.owner?.full_name) ? (
          <View style={s.demoTag}>
            <Text style={s.demoTagText}>ДЕМО</Text>
          </View>
        ) : null}

        {/* Всплытие останавливается вручную: карточка теперь настоящая
            ссылка, и на вебе нажатие на сердечко дошло бы до <a> и открыло
            объявление. Человек хотел отложить вещь, а не уйти с витрины. */}
        <Pressable
          style={s.heart}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={favorite ? 'Убрать из отложенных' : 'Отложить'}
          onPress={(event) => {
            event.stopPropagation();
            event.preventDefault();
            onFavorite();
          }}
        >
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

        {/* Где забирать — второй вопрос после цены: вещь надо привезти и
            вернуть, и «через дорогу» против «через весь город» меняет
            решение сильнее, чем двести тенге. Строки нет, когда владелец
            ориентир не указал: выдумывать «Кокшетау» вместо него значило бы
            занять место ничем. */}
        {item.pickup_area ? (
          <View style={s.trust}>
            <Ionicons name="location-outline" size={12} color={colors.textMuted} />
            <Text style={s.trustText} numberOfLines={1}>
              {item.pickup_area}
            </Text>
          </View>
        ) : null}

        <Text style={s.deposit}>депозит {formatTenge(item.deposit_amount)}</Text>
        </View>
      </Pressable>
    </Link>
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
  allDemo: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'flex-start',
    // Горизонтальный отступ теперь даёт сам список (contentContainerStyle),
    // и повторять его здесь значило бы сдвинуть полосу внутрь на двойное
    // поле.
    marginBottom: spacing.md,
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.accentSoft,
  },
  allDemoTitle: { fontSize: 14, fontFamily: typeface[700], color: colors.text },
  allDemoBody: { fontSize: 13, lineHeight: 19, fontFamily: typeface[400], color: colors.textMuted },

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
  /* Подложка та же, что у счётчика фото двумя правилами выше: обе метки
     лежат на чужом фоне — на снимке, — и должны читаться одинаково при
     любом снимке. Значение записано числом, а не токеном, по той же
     причине, что и там: своего токена под затемнение поверх фотографии
     в теме нет. */
  demoTag: {
    position: 'absolute',
    left: spacing.sm,
    top: spacing.sm,
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(26,25,23,0.62)',
  },
  demoTagText: {
    fontSize: 10,
    fontFamily: typeface[800],
    color: colors.onScrim,
    letterSpacing: 0.6,
  },
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

  fabWrap: {
    position: 'absolute',
    right: spacing.lg,
    bottom: spacing.lg,
  },
  fab: {
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
