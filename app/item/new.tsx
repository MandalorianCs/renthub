import * as ImagePicker from 'expo-image-picker';
import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { Image, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { Badge, Button, Card, Field } from '../../src/components/ui';
import { createItem, fetchCategories, uploadPhoto } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';
import { formatTenge } from '../../src/lib/format';
import { COMMISSION_PCT } from '../../src/lib/pricing';
import { humanizeError } from '../../src/lib/supabase';
import type { Category } from '../../src/lib/types';
import { colors, radius, spacing } from '../../src/theme';

/** Экран 4: создание объявления. */
export default function NewItem() {
  const router = useRouter();
  const { session, isVerified } = useAuth();

  const [categories, setCategories] = useState<Category[]>([]);
  const [category, setCategory] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [dailyPrice, setDailyPrice] = useState('');
  const [deposit, setDeposit] = useState('');
  const [photos, setPhotos] = useState<string[]>([]);
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
  const problem = validateNewItem({ title, category, price, photoCount: photos.length });

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
      const urls = await Promise.all(
        result.assets.map((a) => uploadPhoto(session.user.id, a.uri)),
      );
      setPhotos((prev) => [...prev, ...urls].slice(0, 6));
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setUploading(false);
    }
  }

  async function submit() {
    if (!session || problem) return;
    setSubmitting(true);
    setError(null);
    try {
      const item = await createItem({
        ownerId: session.user.id,
        category: category!,
        title: title.trim(),
        description: description.trim(),
        dailyPrice: price,
        depositAmount: Number(deposit) || 0,
        photos,
      });
      router.replace(`/item/${item.id}`);
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <ScrollView contentContainerStyle={s.container}>
      {!isVerified ? (
        <Badge label="Подтвердите телефон, чтобы публиковать" fg={colors.warn} bg={colors.warnSoft} />
      ) : null}

      <Card>
        <Text style={s.sectionTitle}>Категория</Text>
        <View style={s.chips}>
          {categories.map((c) => (
            <Pressable
              key={c.slug}
              onPress={() => setCategory(c.slug)}
              style={[s.chip, category === c.slug && s.chipActive]}
            >
              <Text style={[s.chipText, category === c.slug && { color: colors.bg }]}>
                {c.title_ru}
              </Text>
            </Pressable>
          ))}
        </View>
      </Card>

      <Card>
        <Field
          label="Название"
          value={title}
          onChangeText={setTitle}
          placeholder="Перфоратор Bosch GBH 2-26"
          hint="Модель в названии — по ней ищут чаще всего"
        />
        <Field
          label="Описание"
          value={description}
          onChangeText={setDescription}
          placeholder="Что в комплекте, состояние, есть ли буры"
          multiline
        />
      </Card>

      <Card>
        <Field
          label="Цена за сутки, ₸"
          value={dailyPrice}
          onChangeText={setDailyPrice}
          keyboardType="number-pad"
          placeholder="2500"
        />
        <Field
          label="Депозит, ₸"
          value={deposit}
          onChangeText={setDeposit}
          keyboardType="number-pad"
          placeholder="15000"
          hint="Блокируется у арендатора и возвращается после проверки вещи"
        />

        {price > 0 ? (
          <Text style={s.note}>
            С каждых суток аренды вы получите {formatTenge(price - Math.round((price * COMMISSION_PCT) / 100))}{' '}
            — комиссия платформы {COMMISSION_PCT}%.
          </Text>
        ) : null}
      </Card>

      <Card>
        <Text style={s.sectionTitle}>Фото «до»</Text>
        <Text style={s.note}>
          Это доказательство состояния вещи на момент выдачи. При споре о порче фото
          «после» сверяются именно с ними — без них претензию нечем подкрепить.
        </Text>

        <View style={s.photos}>
          {photos.map((uri) => (
            <Pressable key={uri} onLongPress={() => setPhotos((p) => p.filter((x) => x !== uri))}>
              <Image source={{ uri }} style={s.photo} />
            </Pressable>
          ))}
          {photos.length < 6 ? (
            <Pressable style={[s.photo, s.photoAdd]} onPress={pickPhoto} disabled={uploading}>
              <Text style={s.photoAddText}>{uploading ? '…' : '+'}</Text>
            </Pressable>
          ) : null}
        </View>
      </Card>

      {problem ? <Text style={s.note}>{problem}</Text> : null}
      {error ? <Text style={s.error}>{error}</Text> : null}

      <Button
        title="Опубликовать"
        onPress={submit}
        loading={submitting}
        disabled={!isVerified || Boolean(problem)}
      />
    </ScrollView>
  );
}

/**
 * ┌─ РЕШЕНИЕ, КОТОРОГО НЕТ В ТЗ ─────────────────────────────────┐
 * │ Сколько фото требовать до публикации — это компромисс:       │
 * │  • требовать фото → меньше объявлений (а нехватка предложения │
 * │    и есть главная проблема запуска), но споры о порче         │
 * │    решаются по доказательствам;                               │
 * │  • не требовать → проще выложить вещь, но condition_photos    │
 * │    пустой, и сверять фото «после» будет не с чем.             │
 * │ Сейчас: минимум одно фото. Поменять — одна строка ниже.       │
 * └───────────────────────────────────────────────────────────────┘
 */
const MIN_PHOTOS = 1;

function validateNewItem(input: {
  title: string;
  category: string | null;
  price: number;
  photoCount: number;
}): string | null {
  if (input.title.trim().length < 3) return 'Название — минимум 3 символа';
  if (!input.category) return 'Выберите категорию';
  if (input.price <= 0) return 'Укажите цену за сутки';
  if (input.photoCount < MIN_PHOTOS) return `Добавьте минимум ${MIN_PHOTOS} фото состояния вещи`;
  return null;
}

const s = StyleSheet.create({
  container: { padding: spacing.lg, gap: spacing.lg, paddingBottom: spacing.xxl },
  sectionTitle: { fontSize: 16, fontWeight: '700', color: colors.text },
  note: { fontSize: 12, color: colors.textMuted, lineHeight: 18 },
  error: { fontSize: 14, color: colors.danger },
  chips: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  chip: {
    paddingHorizontal: spacing.md,
    paddingVertical: 8,
    borderRadius: radius.pill,
    borderWidth: 1,
    borderColor: colors.border,
  },
  chipActive: { backgroundColor: colors.text, borderColor: colors.text },
  chipText: { fontSize: 13, fontWeight: '600', color: colors.text },
  photos: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  photo: { width: 88, height: 88, borderRadius: radius.md, backgroundColor: colors.border },
  photoAdd: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.border, backgroundColor: colors.surface },
  photoAddText: { fontSize: 28, color: colors.textMuted },
});
