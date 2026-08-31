import { Image } from 'expo-image';
import { Ionicons } from '@expo/vector-icons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Switch,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { Calendar, toISO } from '../../src/components/Calendar';
import { PhotoViewer } from '../../src/components/PhotoViewer';
import { DetailSkeleton } from '../../src/components/Skeleton';
import { Badge, Button, Card, Empty, ErrorState, Row, tap } from '../../src/components/ui';
import { createBooking, fetchItem, fetchItemCalendar } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { formatDateRange, formatTenge, ratingLabel } from '../../src/lib/format';
import { calcPrice, countDays, INSURANCE_FEE } from '../../src/lib/pricing';
import { shareItem } from '../../src/lib/share';
import { humanizeError } from '../../src/lib/supabase';
import type { BusyRange, ItemWithOwner } from '../../src/lib/types';
import { colors, elevation, radius, spacing, typeface } from '../../src/theme';

/** Экран 3: карточка объявления + бронирование. */
export default function ItemScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session, isVerified } = useAuth();
  const { width } = useWindowDimensions();
  const galleryWidth = width - 32;

  const [item, setItem] = useState<ItemWithOwner | null>(null);
  const [busyDates, setBusyDates] = useState<BusyRange[]>([]);
  const [loading, setLoading] = useState(true);

  const [start, setStart] = useState<string | null>(null);
  const [end, setEnd] = useState<string | null>(null);
  const [insurance, setInsurance] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [photoIndex, setPhotoIndex] = useState(0);
  const [viewerAt, setViewerAt] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [shared, setShared] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const [found, calendar] = await Promise.all([fetchItem(id), fetchItemCalendar(id)]);
      setItem(found);
      setBusyDates(calendar);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    load();
  }, [load]);

  const days = useMemo(() => (start && end ? countDays(start, end) : 0), [start, end]);

  const price = useMemo(
    () =>
      item
        ? calcPrice({
            dailyPrice: item.daily_price,
            deposit: item.deposit_amount,
            days,
            insurance,
          })
        : null,
    [item, days, insurance],
  );

  if (loading) return <DetailSkeleton />;

  // Три разных исхода, и раньше два последних выглядели одинаково. «Не
  // найдено» на упавшем запросе — прямая ложь: объявление существует, это мы
  // до него не дошли. Человек в этом случае не повторяет попытку, а уходит,
  // решив, что вещь сняли с публикации.
  if (error && !item) return <ErrorState message={error} onRetry={load} />;
  if (!item) {
    return (
      <Empty
        title="Объявление не найдено"
        body="Владелец мог снять его с публикации или удалить. Посмотрите, что ещё сдают рядом."
        // Текст звал в каталог, а способа туда попасть не было: человек,
        // пришедший по ссылке из переписки, упирался в тупик. Здесь это
        // особенно обидно — он уже хотел арендовать.
        action={{ label: 'Открыть каталог', onPress: () => router.replace('/') }}
      />
    );
  }

  const isOwnItem = item.owner_id === session?.user.id;

  async function book() {
    if (!item || !session || !start || !end) return;
    setSubmitting(true);
    setError(null);
    try {
      const booking = await createBooking({
        itemId: item.id,
        renterId: session.user.id,
        startDate: start,
        endDate: end,
        insurance,
      });
      router.replace(`/booking/${booking.id}`);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <View style={{ flex: 1 }}>
    <ScrollView contentContainerStyle={s.container}>
      {item.condition_photos.length > 0 ? (
        <View style={s.galleryWrap}>
          <ScrollView
            horizontal
            pagingEnabled
            showsHorizontalScrollIndicator={false}
            onMomentumScrollEnd={(e) =>
              setPhotoIndex(Math.round(e.nativeEvent.contentOffset.x / galleryWidth))
            }
          >
            {item.condition_photos.map((uri, i) => (
              <Pressable key={uri} onPress={() => setViewerAt(i)}>
                <Image
                  source={uri}
                  style={{ width: galleryWidth, height: galleryWidth * 0.68 }}
                  contentFit="cover"
                  transition={220}
                />
              </Pressable>
            ))}
          </ScrollView>

          <View style={s.counter}>
            <Ionicons name="expand-outline" size={12} color={colors.onScrim} />
            <Text style={s.counterText}>
              {item.condition_photos.length > 1
                ? `${photoIndex + 1} / ${item.condition_photos.length}`
                : 'открыть'}
            </Text>
          </View>
        </View>
      ) : null}

      <View style={{ gap: spacing.sm }}>
        <View style={s.titleRow}>
          <Text style={[s.title, { flex: 1 }]}>{item.title}</Text>

          {/* Ссылка на объявление — способ распространения пилота.
              Владелец показывает вещь соседу, сосед пересылает знакомому;
              без готовой ссылки этот путь обрывается на «поищи в приложении». */}
          <Pressable
            style={({ pressed }) => [s.share, { opacity: pressed ? 0.6 : 1 }]}
            hitSlop={8}
            onPress={async () => {
              const result = await shareItem(item.id, item.title);
              // «Скопировано» без подтверждения читается как несработавшая
              // кнопка: на десктопе ничего видимого не происходит.
              if (result === 'copied') setShared(true);
            }}
          >
            <Ionicons name="share-outline" size={20} color={colors.text} />
          </Pressable>
        </View>
        {shared ? <Text style={s.sharedNote}>Ссылка скопирована</Text> : null}
        <Text style={s.price}>{formatTenge(item.daily_price)} / сутки</Text>
        {item.description ? <Text style={s.description}>{item.description}</Text> : null}
      </View>

      <Card>
        <Pressable
          style={({ pressed }) => [s.owner, tap({ pressed })]}
          onPress={() => router.push(`/owner/${item.owner_id}`)}
        >
          <View style={s.avatar}>
            <Text style={s.avatarText}>{initials(item.owner?.full_name)}</Text>
          </View>
          <View style={{ flex: 1 }}>
            <Text style={s.ownerName}>{item.owner?.full_name ?? 'Без имени'}</Text>
            <Text style={s.ownerMeta}>
              {ratingLabel(item.owner?.rating ?? null, item.owner?.ratings_count ?? 0)}
            </Text>
          </View>
          <Ionicons name="chevron-forward" size={18} color={colors.textMuted} />
        </Pressable>
        <Row left="Депозит (блокируется)" right={formatTenge(item.deposit_amount)} />
        {/* Ориентир, а не адрес: точное место арендатор узнаёт после
            подтверждения брони, как и телефон. До этого момента показывать
            двор владельца незачем — он ещё никому ничего не обещал. */}
        {item.pickup_area ? <Row left="Забирать" right={item.pickup_area} /> : null}
      </Card>

      {/* Календарь занятости показывается всегда, а не только когда есть
          брони: «свободно» и «неизвестно» обязаны выглядеть по-разному,
          иначе человек выбирает даты вслепую. */}
      <Card>
        <Text style={s.sectionTitle}>Занятость</Text>
        {busyDates.length > 0 ? (
          busyDates.map((b) => (
            <Row
              key={`${b.start_date}-${b.end_date}`}
              left={formatDateRange(b.start_date, b.end_date)}
              right="занято"
              muted
            />
          ))
        ) : (
          <View style={s.freeRow}>
            <View style={s.freeDot} />
            <Text style={s.freeText}>Свободно на любые даты</Text>
          </View>
        )}
      </Card>

      {isOwnItem ? (
        <Card>
          <Text style={s.sectionTitle}>Это ваше объявление</Text>
          <Text style={s.note}>Свою вещь забронировать нельзя.</Text>
          <Button
            title="Редактировать"
            variant="secondary"
            onPress={() => router.push(`/item/edit/${item.id}`)}
          />
        </Card>
      ) : (
        <Card>
          <Text style={s.sectionTitle}>Забронировать</Text>

          <View style={s.presets}>
            {[1, 3, 7, 14, 30].map((n) => (
              <Pressable
                key={n}
                style={[s.preset, days === n && s.presetActive]}
                onPress={() => {
                  setStart(todayISO());
                  setEnd(addDaysISO(todayISO(), n - 1));
                }}
              >
                <Text style={[s.presetText, days === n && { color: colors.onFill }]}>{n} дн.</Text>
              </Pressable>
            ))}
          </View>

          <Calendar
            busy={busyDates}
            start={start}
            end={end}
            onChange={(from, to) => {
              setStart(from);
              // Один выбранный день — это аренда на сутки, а не «интервал не задан».
              setEnd(to ?? from);
            }}
          />

          <Text style={s.selection}>
            {start && end
              ? `${formatDateRange(start, end)} · ${days} дн.`
              : 'Выберите дни в календаре'}
          </Text>

          <View style={s.switchRow}>
            <View style={{ flex: 1 }}>
              <Text style={s.switchLabel}>Страховая защита</Text>
              {/* Сумма из константы, а не текстом: рядом её же берёт calcPrice, и
                  написанное число разошлось бы с посчитанным при первой правке
                  тарифа — причём молча, потому что оба места выглядят верными. */}
              <Text style={s.note}>
                +{formatTenge(INSURANCE_FEE)} к сделке — покрытие мелких повреждений
              </Text>
            </View>
            <Switch
              value={insurance}
              onValueChange={setInsurance}
              trackColor={{ true: colors.accent, false: colors.border }}
            />
          </View>

          {price && days > 0 ? (
            <View style={s.breakdown}>
              <Row left={`Аренда ${formatTenge(item.daily_price)} × ${days} дн.`} right={formatTenge(price.rentTotal)} />
              {insurance ? <Row left="Страховой сбор" right={formatTenge(price.insuranceFee)} muted /> : null}
              <Row left="К оплате" right={formatTenge(price.renterTotal)} />
              <Row left="Депозит (блокируется)" right={formatTenge(price.deposit)} muted />
            </View>
          ) : null}

          {!isVerified ? (
            <Badge label="Подтвердите телефон, чтобы бронировать" fg={colors.warn} bg={colors.warnSoft} />
          ) : null}

          <Text style={s.note}>
            Деньги на этом этапе не списываются — MVP эмулирует денежный поток статусами.
          </Text>
        </Card>
      )}

      {error ? <Text style={s.error}>{error}</Text> : null}
    </ScrollView>

    {/* Закреплённая панель: цена и действие остаются на экране, пока
        человек листает описание и календарь. Иначе, докрутив вниз, он
        теряет из виду, сколько это стоит. */}
    {!isOwnItem ? (
      <View style={s.sticky}>
        <View style={{ flex: 1 }}>
          {price && days > 0 && start && end ? (
            <>
              <Text style={s.stickyTotal}>{formatTenge(price.renterTotal)}</Text>
              <Text style={s.stickyMeta}>
                {formatDateRange(start, end)} · {days} дн.
              </Text>
            </>
          ) : (
            <>
              <Text style={s.stickyTotal}>{formatTenge(item.daily_price)}</Text>
              <Text style={s.stickyMeta}>за сутки · выберите даты</Text>
            </>
          )}
        </View>
        <View style={{ minWidth: 150 }}>
          {session ? (
            <Button
              title="Забронировать"
              onPress={book}
              loading={submitting}
              disabled={!isVerified || days <= 0 || !start || !end}
            />
          ) : (
            // Вход просим в последний момент, а не на входе в приложение:
            // человек уже посмотрел вещь и знает, за чем идёт.
            <Button title="Войти и забронировать" onPress={() => router.push('/sign-in')} />
          )}
        </View>
      </View>
    ) : null}
      {viewerAt !== null ? (
        <PhotoViewer
          photos={item.condition_photos}
          startIndex={viewerAt}
          onClose={() => setViewerAt(null)}
        />
      ) : null}
    </View>
  );
}

/** Инициалы для аватара: два символа читаются лучше, чем один. */
function initials(name?: string | null): string {
  if (!name) return '—';
  const parts = name.trim().split(' ').filter(Boolean);
  return parts.slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || '—';
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

function addDaysISO(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().slice(0, 10);
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: 120 },
  galleryWrap: { borderRadius: radius.xl, overflow: 'hidden', backgroundColor: colors.border },
  counter: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    position: 'absolute',
    right: spacing.md,
    bottom: spacing.md,
    paddingHorizontal: 10,
    paddingVertical: 4,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(26,25,23,0.62)',
  },
  counterText: { fontSize: 12, fontFamily: typeface[700], color: colors.onScrim },
  owner: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  avatar: {
    width: 44,
    height: 44,
    borderRadius: 22,
    backgroundColor: colors.accentSoft,
    alignItems: 'center',
    justifyContent: 'center',
  },
  avatarText: { fontSize: 15, fontFamily: typeface[800], color: colors.accent },
  ownerName: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  ownerMeta: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted },
  sticky: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    paddingHorizontal: spacing.lg,
    paddingTop: spacing.md,
    paddingBottom: spacing.lg,
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.border,
    ...elevation.raised,
  },
  stickyTotal: { fontSize: 26, fontFamily: typeface[800], color: colors.text, letterSpacing: -0.8 },
  stickyMeta: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted },
  photo: { width: 240, height: 180, borderRadius: radius.lg, marginRight: spacing.md, backgroundColor: colors.border },
  titleRow: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md },
  share: { padding: 4 },
  sharedNote: { fontSize: 13, fontFamily: typeface[600], color: colors.green },
  title: { fontSize: 21, fontFamily: typeface[700], color: colors.text, letterSpacing: -0.4 },
  price: { fontSize: 30, fontFamily: typeface[800], color: colors.accent, letterSpacing: -0.9 },
  description: { fontSize: 15, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 22 },
  sectionTitle: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  note: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 18 },
  presets: { flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' },
  preset: {
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  presetActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  presetText: { fontSize: 13, fontFamily: typeface[600], color: colors.text },
  switchRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md },
  switchLabel: { fontSize: 15, fontFamily: typeface[600], color: colors.text },
  breakdown: { gap: spacing.sm, borderTopWidth: 1, borderTopColor: colors.border, paddingTop: spacing.md },
  error: { color: colors.danger, fontSize: 14, fontFamily: typeface[400] },
  selection: { fontSize: 14, fontFamily: typeface[700], color: colors.text, textAlign: 'center' },
  freeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  freeDot: { width: 8, height: 8, borderRadius: 4, backgroundColor: colors.green },
  freeText: { fontSize: 14, color: colors.green, fontFamily: typeface[600] },
});
