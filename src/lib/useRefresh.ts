import { useCallback, useState } from 'react';

/**
 * Потянуть-обновить с честным индикатором.
 *
 * Во всех четырёх списках приложения в RefreshControl стояло
 * `refreshing={false}` константой. Данные при этом действительно
 * перезагружались, но спиннер не появлялся ни на мгновение — человек тянул
 * список, ничего не происходило, и он тянул снова. Жест выглядел сломанным,
 * хотя работал.
 *
 * Хук вместо четырёх копий состояния: если завтра понадобится, например,
 * гасить повторные вызовы во время загрузки, это правится в одном месте.
 */
export function useRefresh(load: () => Promise<unknown>) {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(async () => {
    setRefreshing(true);
    try {
      await load();
    } finally {
      setRefreshing(false);
    }
  }, [load]);

  return { refreshing, onRefresh };
}
