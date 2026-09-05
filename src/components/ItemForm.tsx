import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import * as ImagePicker from 'expo-image-picker';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { LayoutChangeEvent } from 'react-native';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { fetchCategories, uploadPhoto } from '../lib/api';
import { Field } from './ui';
import { useAuth } from '../lib/auth';
import { formatTenge } from '../lib/format';
import { COMMISSION_PCT, MAX_DAILY_PRICE } from '../lib/pricing';
import { humanizeError } from '../lib/supabase';
import type { Category } from '../lib/types';
import { exampleFor, suggestTitles } from '../lib/tools';
import { colors, radius, spacing, typeface } from '../theme';

/**
 * Форма объявления — общая для создания и редактирования.
 *
 * Выделена в компонент не ради экономии строк, а чтобы правила не разошлись.
 * Минимум фото, подсказка про комиссию, требования к названию — всё это
 * должно вести себя одинаково; две копии формы расходятся на первой же
 * правке, и владелец получает объявление, которое можно создать, но нельзя
 * сохранить после редактирования.
 */

export type ItemFormValues = {
  category: string;
  title: string;
  description: string;
  dailyPrice: number;
  depositAmount: number;
  photos: string[];
  pickupArea: string;
};

/**
 * ┌─ РЕШЕНИЕ, КОТОРОГО НЕТ В ТЗ ─────────────────────────────────┐
 * │ Сколько фото требовать — это компромисс:                     │
 * │  • требовать → меньше объявлений (а нехватка предложения и    │
 * │    есть главная проблема запуска), но споры о порче решаются  │
 * │    по доказательствам;                                        │
 * │  • не требовать → проще выложить, но condition_photos пуст,   │
 * │    и сверять фото «после» будет не с чем.                     │
 * │ Сейчас: минимум одно фото.                                    │
 * └───────────────────────────────────────────────────────────────┘
 */
const MIN_PHOTOS = 1;

function validate(v: {
  title: string;
  category: string | null;
  price: number;
  photoCount: number;
}): string | null {
  if (v.title.trim().length < 3) return 'Название — минимум 3 символа';
  if (!v.category) return 'Выберите категорию';
  if (v.price <= 0) return 'Укажите цену за сутки';
  // Верхняя граница — не про дорогие вещи, а про лишний ноль: с ним
  // объявление не бронируют, и владелец узнаёт об этом тишиной. То же
  // правило в базе (assert_item_price), здесь — чтобы сказать до
  // отправки, а не после собранных фото.
  if (v.price > MAX_DAILY_PRICE)
    return 'Цена за сутки больше миллиона — проверьте, нет ли лишнего нуля';
  if (v.photoCount < MIN_PHOTOS) return `Добавьте минимум ${MIN_PHOTOS} фото состояния вещи`;
  return null;
}

export function ItemForm({
  initial,
  submitLabel,
  onSubmit,
}: {
  initial?: Partial<ItemFormValues>;
  submitLabel: string;
  onSubmit: (values: ItemFormValues) => Promise<void>;
}) {
  const { session, isVerified } = useAuth();

  // Прокрутка к полю, в которое встали.
  //
  // Измерено 05.09.2026 на живом Android: клавиатура открывается поверх
  // формы, экран не двигается, и владелец печатает название и цену
  // вслепую. Данные при этом доходят — но человек этого не видит и не
  // знает, попал ли он в нужное поле.
  //
  // automaticallyAdjustKeyboardInsets, поставленный первой попыткой,
  // здесь не помогает: это свойство iOS, на Android оно молча ничего не
  // делает. Проверено на устройстве — ровно тот случай, когда правка
  // выглядит сделанной, потому что типы её приняли.
  //
  // Работает так: каждая карточка запоминает свою высоту в потоке
  // (onLayout), а поле при фокусе просит прокрутить к началу своей
  // карточки. Задержка нужна, чтобы клавиатура успела занять место —
  // иначе прокрутка считается по старой высоте экрана.
  const scroll = useRef<ScrollView>(null);
  const spots = useRef<Record<string, number>>({});

  const remember = (key: string) => (e: LayoutChangeEvent) => {
    spots.current[key] = e.nativeEvent.layout.y;
  };

  const focusOn = (key: string) => () => {
    const y = spots.current[key];
    if (y == null) return;
    // 24 сверху — чтобы над полем осталась его подпись: поле без подписи
    // на экране заставляет вспоминать, что в него вводят.
    setTimeout(() => scroll.current?.scrollTo({ y: Math.max(0, y - 24), animated: true }), 180);
  };

  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<string | null>(initial?.category ?? null);
  const [title, setTitle] = useState(initial?.title ?? '');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [dailyPrice, setDailyPrice] = useState(
    initial?.dailyPrice ? String(initial.dailyPrice) : '',
  );
  const [deposit, setDeposit] = useState(
    initial?.depositAmount ? String(initial.depositAmount) : '',
  );
  const [photos, setPhotos] = useState<string[]>(initial?.photos ?? []);
  const [pickupArea, setPickupArea] = useState(initial?.pickupArea ?? '');
  const [uploading, setUploading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchCategories().then((c) => {
      setCategories(c);
      setCategory((prev) => prev ?? c[0]?.slug ?? null);
    });
  }, []);

  const price = Number(dailyPrice) || 0;
  /**
   * Подсказки показываются, пока поле в фокусе, и гаснут после выбора.
   *
   * Держать их всегда нельзя: выбравший подсказку человек продолжает
   * дописывать индекс модели, и список, живущий под пальцем, перекрывает
   * то, что он печатает. Гасить сразу после первого символа тоже нельзя —
   * подсказки нужнее всего как раз в середине набора.
   */
  const [titleFocused, setTitleFocused] = useState(false);

  const suggestions = useMemo(
    () => (titleFocused ? suggestTitles(category, title) : []),
    [titleFocused, category, title],
  );

  const problem = validate({ title, category, price, photoCount: photos.length });

  async function pickPhoto() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      allowsMultipleSelection: true,
      selectionLimit: 6 - photos.length,
    });
    if (result.canceled || !session) return;

    setUploading(true);
    setError(null);
    try {
      const urls = await Promise.all(result.assets.map((a) => uploadPhoto(session.user.id, a.uri)));
      setPhotos((prev) => [...prev, ...urls].slice(0, 6));
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setUploading(false);
    }
  }

  return (
    /*
      Клавиатура не должна закрывать поле, в которое печатают.

      Измерено 05.09.2026 на живом Android: при вводе в «Описание» экран
      не прокручивался, поле уходило под клавиатуру, и владелец печатал
      вслепую. На вебе этого не увидеть — там клавиатура не перекрывает
      страницу, а публикация вещи это главное действие владельца.

      automaticallyAdjustKeyboardInsets добавляет ScrollView отступ ровно
      на высоту клавиатуры, keyboardShouldPersistTaps="handled" сохраняет
      нажатие на кнопку, когда клавиатура открыта: без него первый тап
      только прячет клавиатуру, и человек нажимает «Опубликовать» дважды,
      считая, что кнопка не работает.
    */
    <ScrollView
      ref={scroll}
      contentContainerStyle={s.container}
      // «handled» сохраняет нажатие на кнопку, когда клавиатура открыта:
      // без него первый тап только прячет клавиатуру, и человек жмёт
      // «Опубликовать» дважды, считая, что кнопка не работает.
      keyboardShouldPersistTaps="handled"
      keyboardDismissMode="on-drag"
    >
      {!isVerified ? (
        <View style={s.problem}>
          <Ionicons name="alert-circle-outline" size={18} color={colors.warn} />
          <Text style={s.problemText}>Подтвердите телефон, чтобы публиковать</Text>
        </View>
      ) : null}

      <View style={s.card}>
        <Text style={s.sectionTitle}>Категория</Text>
        <View style={s.chips}>
          {categories.map((c) => (
            <Pressable
              key={c.slug}
              onPress={() => setCategory(c.slug)}
              style={[s.chip, category === c.slug && s.chipActive]}
            >
              <Text style={[s.chipText, category === c.slug && { color: colors.onFill }]}>
                {c.title_ru}
              </Text>
            </Pressable>
          ))}
        </View>
      </View>

      <View style={s.card} onLayout={remember('text')}>
        <Field
          label="Название"
          value={title}
          onChangeText={setTitle}
          // Два дела на одном фокусе: показать подсказки названий и
          // поднять форму над клавиатурой. Второе нужно всем полям, а
          // первое — только этому, поэтому они и стоят рядом, а не
          // разъезжаются по двум обработчикам.
          onFocus={() => {
            setTitleFocused(true);
            focusOn('text')();
          }}
          // Задержка перед скрытием: без неё нажатие на подсказку не
          // успевает сработать — список исчезает раньше, чем палец до него
          // доходит, и кнопка выглядит неработающей.
          onBlur={() => setTimeout(() => setTitleFocused(false), 150)}
          placeholder={exampleFor(category)}
          hint={
            category
              ? 'Модель в названии — по ней ищут чаще всего'
              : 'Выберите категорию выше — покажем подсказки'
          }
        />

        {suggestions.length > 0 ? (
          <View style={s.suggests}>
            {suggestions.map((text: string) => (
              <Pressable
                key={text}
                onPress={() => {
                  setTitle(text);
                  setTitleFocused(false);
                }}
                style={({ pressed }) => [s.suggest, pressed && { opacity: 0.6 }]}
                accessibilityRole="button"
                accessibilityLabel={`Подставить название: ${text}`}
              >
                <Text style={s.suggestText} numberOfLines={1}>{text}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        <Field
          onFocus={focusOn('text')}
          label="Описание"
          value={description}
          onChangeText={setDescription}
          placeholder="Что в комплекте, состояние, есть ли буры"
          multiline
        />
        {/* Где забирать — рядом с описанием, а не в конце формы: это часть
            того, что человек решает про вещь, а не деталь оформления.
            Необязательное: у части владельцев вещь лежит там, где ориентира
            нет, и требовать его значило бы не пустить их в витрину. */}
        <Field
          onFocus={focusOn('text')}
          label="Где забирать"
          value={pickupArea}
          onChangeText={setPickupArea}
          placeholder="мкр. Васильковский или «возле вокзала»"
          maxLength={80}
          hint="Район или ориентир. Точный адрес не нужен — его скажете после брони"
        />
      </View>

      <View style={s.card} onLayout={remember('money')}>
        <Field
          onFocus={focusOn('money')}
          label="Цена за сутки, ₸"
          value={dailyPrice}
          onChangeText={setDailyPrice}
          keyboardType="number-pad"
          placeholder="2500"
          // Цена — то место, где владелец застревает: боится продешевить и
          // боится отпугнуть. Обе боязни снимает одна правда — решение не
          // окончательное. Уже оформленные брони при этом не дешевеют и не
          // дорожают: в bookings лежит daily_price_snapshot, снятый в момент
          // заявки, и это ровно то, что здесь обещано словами.
          hint="Можно изменить в любой момент — новая цена заработает со следующей брони"
        />
        <Field
          onFocus={focusOn('money')}
          label="Депозит, ₸"
          value={deposit}
          onChangeText={setDeposit}
          keyboardType="number-pad"
          placeholder="15000"
          hint="Блокируется у арендатора и возвращается после проверки. Обычно это цена ремонта, а не цена вещи"
        />

        {price > 0 ? (
          <View style={s.payout}>
            <Text style={s.payoutLabel}>Вы получите за сутки</Text>
            <Text style={s.payoutValue}>
              {formatTenge(price - Math.round((price * COMMISSION_PCT) / 100))}
            </Text>
            <Text style={s.payoutNote}>комиссия платформы {COMMISSION_PCT}%</Text>
            <Text style={s.payoutDays}>
              за трое суток —{' '}
              {formatTenge((price - Math.round((price * COMMISSION_PCT) / 100)) * 3)}
            </Text>
          </View>
        ) : null}
      </View>

      <View style={s.card}>
        <Text style={s.sectionTitle}>Фото «до»</Text>
        <Text style={s.note}>
          Это доказательство состояния вещи на момент выдачи. При споре о порче фото
          «после» сверяются именно с ними — без них претензию нечем подкрепить.
        </Text>

        <View style={s.photos}>
          {photos.map((uri) => (
            <View key={uri}>
              <Image source={uri} style={s.photo} contentFit="cover" transition={180} />
              <Pressable
                style={s.photoRemove}
                hitSlop={8}
                onPress={() => setPhotos((p) => p.filter((x) => x !== uri))}
                accessibilityRole="button"
                accessibilityLabel="Удалить фото"
              >
                <Ionicons name="close" size={14} color={colors.onFill} />
              </Pressable>
            </View>
          ))}
          {photos.length < 6 ? (
            <Pressable
              style={[s.photo, s.photoAdd]}
              onPress={pickPhoto}
              disabled={uploading}
              accessibilityRole="button"
              accessibilityLabel={uploading ? 'Фото загружается' : 'Добавить фото'}
            >
              <Ionicons
                name={uploading ? 'hourglass-outline' : 'add'}
                size={24}
                color={colors.textMuted}
              />
            </Pressable>
          ) : null}
        </View>
      </View>

      {problem ? (
        <View style={s.problem}>
          <Ionicons name="information-circle-outline" size={18} color={colors.warn} />
          <Text style={s.problemText}>{problem}</Text>
        </View>
      ) : null}
      {error ? <Text style={s.error}>{error}</Text> : null}

      <Pressable
        style={[s.submit, (!isVerified || Boolean(problem) || submitting) && s.submitOff]}
        disabled={!isVerified || Boolean(problem) || submitting}
        onPress={async () => {
          if (!category) return;
          setSubmitting(true);
          setError(null);
          try {
            await onSubmit({
              category,
              title: title.trim(),
              description: description.trim(),
              dailyPrice: price,
              depositAmount: Number(deposit) || 0,
              photos,
              pickupArea: pickupArea.trim(),
            });
          } catch (e) {
            setError(humanizeError(e));
          } finally {
            setSubmitting(false);
          }
        }}
      >
        <Text style={s.submitText}>{submitting ? 'Сохраняю…' : submitLabel}</Text>
      </Pressable>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.lg,
    gap: spacing.md,
  },
  sectionTitle: { fontSize: 16, fontFamily: typeface[700], color: colors.text },
  note: { fontSize: 12, fontFamily: typeface[400], color: colors.textMuted, lineHeight: 18 },
  error: { fontSize: 14, fontFamily: typeface[400], color: colors.danger },

  suggests: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 6,
    marginTop: -spacing.xs,
  },
  suggest: {
    paddingHorizontal: 10,
    paddingVertical: 6,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
    maxWidth: '100%',
  },
  suggestText: { fontSize: 13, fontFamily: typeface[500], color: colors.text },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.accent, borderColor: colors.accent },
  chipText: { fontSize: 13, fontFamily: typeface[600], color: colors.text },

  // Доход владельца — то, ради чего он здесь. Показываем цифрой, а не строкой
  // мелким шрифтом среди подсказок.
  payout: {
    backgroundColor: colors.greenSoft,
    borderRadius: radius.lg,
    padding: spacing.xl,
    alignItems: 'center',
    gap: 3,
  },
  payoutLabel: {
    fontSize: 11,
    fontFamily: typeface[700],
    color: colors.green,
    letterSpacing: 1.1,
    textTransform: 'uppercase',
  },
  payoutValue: { fontSize: 38, fontFamily: typeface[800], color: colors.green, letterSpacing: -1.2 },
  payoutNote: { fontSize: 11, fontFamily: typeface[400], color: colors.green, opacity: 0.8 },
  payoutDays: {
    fontSize: 13,
    fontFamily: typeface[600],
    color: colors.green,
    opacity: 0.9,
    marginTop: 4,
  },

  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  photo: { width: 88, height: 88, borderRadius: radius.md, backgroundColor: colors.border },
  photoAdd: {
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.bg,
  },
  photoRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 24,
    height: 24,
    borderRadius: 12,
    backgroundColor: colors.text,
    alignItems: 'center',
    justifyContent: 'center',
  },

  problem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    backgroundColor: colors.warnSoft,
    borderRadius: radius.md,
    padding: spacing.md,
  },
  problemText: { flex: 1, fontSize: 13, fontFamily: typeface[600], color: colors.warn },

  submit: {
    backgroundColor: colors.accent,
    borderRadius: radius.md,
    paddingVertical: 15,
    alignItems: 'center',
  },
  submitOff: { opacity: 0.5 },
  submitText: { fontSize: 15, fontFamily: typeface[700], color: colors.onFill },
});
