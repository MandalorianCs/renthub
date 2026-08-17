import { useRouter } from 'expo-router';
import { ItemForm } from '../../src/components/ItemForm';
import { createItem } from '../../src/lib/api';
import { useAuth } from '../../src/lib/auth';

/** Экран 4: создание объявления. Вся форма — в общем компоненте. */
export default function NewItem() {
  const router = useRouter();
  const { session } = useAuth();

  return (
    <ItemForm
      submitLabel="Опубликовать"
      onSubmit={async (values) => {
        if (!session) return;
        const item = await createItem({ ownerId: session.user.id, ...values });
        router.replace(`/item/${item.id}`);
      }}
    />
  );
}
