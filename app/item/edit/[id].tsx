import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { ItemForm } from '../../../src/components/ItemForm';
import { ListSkeleton } from '../../../src/components/Skeleton';
import { Empty, ErrorState } from '../../../src/components/ui';
import { fetchItem, updateItem } from '../../../src/lib/api';
import { useAuth } from '../../../src/lib/auth';
import { humanizeError } from '../../../src/lib/supabase';
import type { ItemWithOwner } from '../../../src/lib/types';

/**
 * Правка объявления.
 *
 * До неё владелец, ошибившийся в цене, мог только снять объявление и
 * создать заново — потеряв фото, описание и накопленные просмотры. Для
 * пилота, где каждое объявление на счету, это дорого.
 *
 * Менять цену безопасно: в брони лежит снимок цены на момент
 * бронирования, и уже подтверждённые сделки не пересчитываются задним
 * числом. Именно ради этого снимок в схеме и заведён.
 */
export default function EditItem() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const { session } = useAuth();

  const [item, setItem] = useState<ItemWithOwner | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    fetchItem(id)
      .then(setItem)
      .catch((e) => setError(humanizeError(e)))
      .finally(() => setLoading(false));
  }, [id]);

  if (loading) return <ListSkeleton rows={3} />;
  if (error) return <ErrorState message={error} />;
  if (!item) return <Empty icon="cube-outline" title="Объявление не найдено" />;

  // Кнопка сюда ведёт только у владельца, но экран открывается и по прямой
  // ссылке — поэтому проверяем здесь тоже. Настоящая защита всё равно в базе:
  // политика items_update_own пропускает только своего.
  // Гостю говорим про вход, а не про чужое: он не знает, чьё это
  // объявление, и «чужое» звучит как обвинение вместо подсказки.
  if (!session) {
    return (
      <Empty
        icon="lock-closed-outline"
        title="Войдите, чтобы править объявление"
        body="Менять объявление может только его владелец."
        action={{ label: 'Войти', onPress: () => router.push('/sign-in') }}
      />
    );
  }

  if (item.owner_id !== session.user.id) {
    return <Empty icon="lock-closed-outline" title="Это чужое объявление" />;
  }

  return (
    <ItemForm
      submitLabel="Сохранить"
      initial={{
        category: item.category,
        title: item.title,
        description: item.description ?? '',
        dailyPrice: item.daily_price,
        depositAmount: item.deposit_amount,
        photos: item.condition_photos,
        pickupArea: item.pickup_area ?? '',
      }}
      onSubmit={async (values) => {
        await updateItem(item.id, values);
        router.replace(`/item/${item.id}`);
      }}
    />
  );
}
