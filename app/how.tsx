import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { BookingTimeline } from '../src/components/BookingTimeline';
import { Button, Card, Row } from '../src/components/ui';
import { BOOKING_STATUS, DEPOSIT_STATUS, formatTenge } from '../src/lib/format';
import { nextMove } from '../src/lib/nextMove';
import { COMMISSION_PCT, calcPrice } from '../src/lib/pricing';
import type { BookingStatus, DepositStatus } from '../src/lib/types';
import { colors, radius, spacing, typeface } from '../src/theme';

/**
 * Как проходит сделка — разбор пути без входа.
 *
 * ── Зачем экран вообще ───────────────────────────────────────
 *
 * Открытым остаётся только каталог: витрина, карточка вещи, карточка
 * владельца. Всё остальное — сделка, уведомления, свои вещи — за входом,
 * и это правильно, там чужие деньги и чужие телефоны.
 *
 * Побочный эффект оказался тяжелее, чем выглядел. Человек, пришедший по
 * ссылке — судья, инвестор, будущий владелец инструмента, — видит девять
 * карточек и упирается в форму входа на первом же интересном шаге.
 * Продукт у нас именно в сделке: статусы, депозит, сроки, чей сейчас ход.
 * Ровно этого гость и не видел. Вывод он делал единственно возможный —
 * «каталог и есть весь проект».
 *
 * ── Почему это не макет ──────────────────────────────────────
 *
 * Соблазн был нарисовать красивые скриншоты. Отказались: нарисованное
 * расходится с продуктом на первой же правке, и показывать жюри картинку
 * вместо работающего — ровно то, в чём стартапы обычно и ловят.
 *
 * Здесь ни одной новой строки про сделку не написано. Шкала этапов — тот
 * же компонент, что на экране сделки. Тексты «чей ход» приходят из
 * shared/next-move.json — файла, который читает и Telegram-бот. Суммы
 * считает calcPrice() — та самая функция, чей результат сверяется с
 * Postgres командой npm run check:price. Меняется одно: статус подставляет
 * не база, а палец гостя.
 *
 * Отсюда и польза за пределами показа: если завтра кто-то поменяет текст
 * этапа, экран поменяется сам. Расходиться ему не с чем.
 *
 * ── Про честность чисел ──────────────────────────────────────
 *
 * Пример — не выдумка «для красоты»: перфоратор Bosch GBH 2-26 лежит в
 * каталоге по 3 500 ₸ за сутки с депозитом 20 000 ₸, и трое суток по
 * этой цене — та же средняя сделка, на которой построена юнит-экономика
 * в деке. Одно число в двух местах лучше двух разных.
 */

/** Пример берём с настоящего объявления пилота, а не придумываем. */
const EXAMPLE = {
  title: 'Перфоратор Bosch GBH 2-26',
  dailyPrice: 3_500,
  deposit: 20_000,
  days: 3,
};

const PRICE = calcPrice({
  dailyPrice: EXAMPLE.dailyPrice,
  deposit: EXAMPLE.deposit,
  days: EXAMPLE.days,
  insurance: false,
});

/**
 * Что происходит с депозитом на каждом статусе.
 *
 * Таблица повторяет то, что делают миграции, и повторяет намеренно: гость
 * не может прочитать базу, а угадывать ему нечего. Источник для каждой
 * строки — update в supabase/migrations:
 *
 *   held      начальное значение (bookings_before_insert);
 *   released  booking_complete() без компенсации и — с 07.09.2026 —
 *             триггер release_deposit_on_cancel() при отмене;
 *   claimed   open_damage_dispute() и невозврат.
 */
const DEPOSIT_AT: Record<BookingStatus, DepositStatus> = {
  pending: 'held',
  confirmed: 'held',
  active: 'held',
  returned: 'held',
  completed: 'released',
  cancelled: 'released',
  disputed: 'claimed',
};

/**
 * Что должно случиться с деньгами — словами, на каждом статусе.
 *
 * Строки намеренно несут числа, а не пересказывают шкалу и панели сторон.
 * Первая версия делала ровно это, и на «Споре» одна и та же фраза стояла
 * на экране трижды: в блоке схода с пути, здесь и в обеих панелях. Место
 * заняло, а гость не узнал ничего нового.
 *
 * Порог 15 000 ₸ — не выдумка для текста: `dispute_auto_threshold` в
 * app_settings, заведён первой же миграцией схемы.
 */
const MONEY_AT: Record<BookingStatus, string> = {
  pending: `Аренда ещё не начислена — начисление идёт при закрытии. За сделкой закреплён депозит ${formatTenge(PRICE.deposit)}.`,
  confirmed: `Сумма зафиксирована и дальше не меняется: ${formatTenge(PRICE.rentTotal)} за трое суток, сколько бы ни стоило объявление завтра.`,
  active: `Срок аренды идёт. Просрочка не добавляет к ${formatTenge(PRICE.rentTotal)} ни тенге — она открывает спор о невозврате, и там речь уже о депозите.`,
  returned: `Деньги ещё не разошлись: у владельца есть срок заявить о повреждениях. Промолчит — сделка закроется сама.`,
  completed: `Депозит отпущен целиком. Владельцу — ${formatTenge(PRICE.ownerPayoutTotal)}, платформе — ${formatTenge(PRICE.platformFee)}.`,
  cancelled: `Не начислено ничего: ни ${formatTenge(PRICE.platformFee)} платформе, ни ${formatTenge(PRICE.ownerPayoutTotal)} владельцу. Депозит отпущен, даты снова свободны.`,
  // Порог написан числом и теми же словами, что на экране сделки, а не
  // выражением: его сверяет с базой `npm run check:price`, и сверяет по
  // тексту файла. Формула `formatTenge(15_000)` прочиталась бы проверкой
  // как отсутствие подписи, и третья копия числа осталась бы без присмотра
  // — ровно то, от чего эта проверка и заведена.
  disputed: `Из депозита ${formatTenge(PRICE.deposit)} удержится только доказанный ущерб, остальное вернётся. До 15 000 ₸ решается автоматически, выше — модератором.`,
};

/** Пять этапов пути и два схода с него — ровно как в базе. */
const PATH: BookingStatus[] = ['pending', 'confirmed', 'active', 'returned', 'completed'];
const OFF_ROAD: BookingStatus[] = ['cancelled', 'disputed'];

export default function HowItWorks() {
  const router = useRouter();
  const [status, setStatus] = useState<BookingStatus>('pending');

  const owner = nextMove({ status }, true);
  const renter = nextMove({ status }, false);
  const deposit = DEPOSIT_STATUS[DEPOSIT_AT[status]];

  return (
    <ScrollView contentContainerStyle={s.page}>
      <View style={s.intro}>
        <Text style={s.h1}>От заявки до закрытия</Text>
        <Text style={s.lead}>
          Нажмите этап — экран покажет, чей сейчас ход, что видит каждая сторона
          и что происходит с деньгами. Аккаунт не нужен.
        </Text>
      </View>

      {/* Оговорка стоит до разбора, а не после.
          Сказать «деньги не двигаются» в конце — значит дать человеку
          сначала поверить в платежи, а потом отнять. Сказать сразу —
          значит объяснить, что именно проверяет пилот. */}
      <View style={s.honest}>
        <Ionicons name="information-circle-outline" size={18} color={colors.textMuted} />
        <Text style={s.honestText}>
          На пилоте деньги не двигаются: сделки живут статусами, расчёт стороны
          ведут между собой. Проверяем петлю «выложил → нашли → забронировали →
          вернули», а не гладкость платежей. Эквайринг — следующий этап.
        </Text>
      </View>

      <Card style={s.deal}>
        <Text style={s.dealTitle}>{EXAMPLE.title}</Text>
        <Text style={s.dealSub}>
          Трое суток по {formatTenge(EXAMPLE.dailyPrice)} — объявление из каталога, та же
          средняя сделка, на которой построена экономика проекта
        </Text>
        <View style={s.rows}>
          <Row left="Аренда" right={formatTenge(PRICE.rentTotal)} />
          <Row left={`Комиссия платформы, ${COMMISSION_PCT}%`} right={formatTenge(PRICE.platformFee)} muted />
          <Row left="Владельцу" right={formatTenge(PRICE.ownerPayoutTotal)} />
          <Row left="Депозит" right={formatTenge(PRICE.deposit)} muted />
        </View>
      </Card>

      {/* Этапы — кнопки, а не подписи под картинкой. Разбор, который можно
          потрогать, запоминается лучше, чем разбор, который можно
          прочитать; а на защите он ещё и экономит слова. */}
      <View style={s.picker}>
        <Text style={s.pickerLabel}>Этап сделки</Text>
        <View style={s.chips}>
          {PATH.map((value) => (
            <Chip
              key={value}
              label={BOOKING_STATUS[value].label}
              active={value === status}
              onPress={() => setStatus(value)}
            />
          ))}
        </View>

        {/* Отмена и спор отделены не для красоты: это не этапы пути, а сход
            с него, и на шкале они выглядят иначе — так же, как в базе. */}
        <Text style={s.pickerLabel}>Если пошло не так</Text>
        <View style={s.chips}>
          {OFF_ROAD.map((value) => (
            <Chip
              key={value}
              label={BOOKING_STATUS[value].label}
              active={value === status}
              danger
              onPress={() => setStatus(value)}
            />
          ))}
        </View>
      </View>

      <Card>
        <BookingTimeline status={status} />
        <View style={s.badges}>
          <View style={[s.badge, { backgroundColor: BOOKING_STATUS[status].bg }]}>
            <Text style={[s.badgeText, { color: BOOKING_STATUS[status].fg }]}>
              {BOOKING_STATUS[status].label}
            </Text>
          </View>
          <View style={[s.badge, { backgroundColor: deposit.bg }]}>
            <Text style={[s.badgeText, { color: deposit.fg }]}>{deposit.label}</Text>
          </View>
        </View>
        <Text style={s.money}>{MONEY_AT[status]}</Text>
      </Card>

      {/* Обе стороны рядом, а не по очереди.
          В живом приложении человек видит только свою половину — и это
          верно. Но именно на разборе важно другое: платформа в каждый
          момент говорит ОБОИМ, чего от них ждут. Рядом это видно за
          секунду, по очереди — не видно вовсе. */}
      <View style={s.sides}>
        <Side who="Владелец" move={owner} />
        <Side who="Арендатор" move={renter} />
      </View>

      <View style={s.source}>
        <Ionicons name="git-branch-outline" size={16} color={colors.textMuted} />
        <Text style={s.sourceText}>
          Тексты выше — не подписи к макету. Их читает и Telegram-бот из общего
          файла, а суммы считает та же функция, чей результат сверяется с базой
          командой <Text style={s.mono}>npm run check:price</Text>.
        </Text>
      </View>

      <View style={s.cta}>
        <Button title="Открыть каталог" onPress={() => router.replace('/')} />
        <Button
          title="Войти и попробовать"
          variant="ghost"
          onPress={() => router.push('/sign-in')}
        />
      </View>
    </ScrollView>
  );
}

function Chip({
  label,
  active,
  danger,
  onPress,
}: {
  label: string;
  active: boolean;
  danger?: boolean;
  onPress: () => void;
}) {
  const fill = danger ? colors.danger : colors.accent;
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      style={({ pressed }) => [
        s.chip,
        active && { backgroundColor: fill, borderColor: fill },
        pressed && { opacity: 0.7 },
      ]}
    >
      <Text style={[s.chipText, active && { color: colors.onFill }]}>{label}</Text>
    </Pressable>
  );
}

function Side({ who, move }: { who: string; move: ReturnType<typeof nextMove> }) {
  return (
    <View style={[s.side, move.yours && s.sideYours]}>
      <View style={s.sideHead}>
        <Ionicons
          name={move.icon}
          size={18}
          color={move.yours ? colors.accent : colors.textMuted}
        />
        <Text style={s.sideWho}>{who}</Text>
        {/* Слово вместо цвета: «ход за вами» нельзя передать одной заливкой
            тому, кто её не различает, и нельзя прочитать вслух. */}
        <Text style={[s.sideTag, move.yours && { color: colors.accent }]}>
          {move.yours ? 'его ход' : 'ждёт'}
        </Text>
      </View>
      <Text style={s.sideTitle}>{move.title}</Text>
      <Text style={s.sideBody}>{move.body}</Text>
    </View>
  );
}

const s = StyleSheet.create({
  page: { padding: spacing.lg, gap: spacing.lg, maxWidth: 720, width: '100%', alignSelf: 'center' },

  intro: { gap: spacing.sm },
  h1: { fontSize: 30, fontFamily: typeface[800], color: colors.text, letterSpacing: -0.8 },
  lead: { fontSize: 15, lineHeight: 22, fontFamily: typeface[400], color: colors.textMuted },

  honest: {
    flexDirection: 'row',
    gap: spacing.sm,
    alignItems: 'flex-start',
    padding: spacing.md,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  honestText: { flex: 1, fontSize: 13, lineHeight: 19, fontFamily: typeface[400], color: colors.textMuted },

  deal: { gap: spacing.xs },
  dealTitle: { fontSize: 17, fontFamily: typeface[700], color: colors.text },
  dealSub: { fontSize: 13, fontFamily: typeface[400], color: colors.textMuted },
  rows: { marginTop: spacing.sm },

  picker: { gap: spacing.sm },
  pickerLabel: { fontSize: 13, fontFamily: typeface[600], color: colors.textMuted },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs },
  chip: {
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  chipText: { fontSize: 13, fontFamily: typeface[600], color: colors.text },

  badges: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.md },
  badge: { paddingHorizontal: 10, paddingVertical: 5, borderRadius: radius.pill },
  badgeText: { fontSize: 12, fontFamily: typeface[700] },
  money: { marginTop: spacing.md, fontSize: 14, lineHeight: 21, fontFamily: typeface[400], color: colors.text },

  sides: { gap: spacing.md },
  side: {
    gap: 4,
    padding: spacing.md,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.surface,
  },
  sideYours: { borderColor: colors.accent, backgroundColor: colors.accentSoft },
  sideHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  sideWho: { flex: 1, fontSize: 13, fontFamily: typeface[700], color: colors.textMuted },
  sideTag: { fontSize: 12, fontFamily: typeface[600], color: colors.textMuted },
  sideTitle: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  sideBody: { fontSize: 14, lineHeight: 20, fontFamily: typeface[400], color: colors.textMuted },

  source: { flexDirection: 'row', gap: spacing.sm, alignItems: 'flex-start' },
  sourceText: { flex: 1, fontSize: 12, lineHeight: 18, fontFamily: typeface[400], color: colors.textMuted },
  mono: { fontFamily: typeface[600], color: colors.text },

  cta: { gap: spacing.sm, marginTop: spacing.sm, marginBottom: spacing.xl },
});
