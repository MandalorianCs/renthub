import { useEffect, useRef } from 'react';
import { Animated, StyleSheet, View, type ViewStyle } from 'react-native';
import { colors, radius, spacing } from '../theme';

/**
 * Заглушки на время загрузки вместо крутилки.
 *
 * Разница не косметическая. Крутилка сообщает «что-то происходит» и ничего
 * больше — экран остаётся пустым, и ожидание кажется длиннее, чем оно есть.
 * Скелетон показывает будущую структуру: человек уже видит, что придут
 * карточки в две колонки, и подсознательно считает загрузку начавшейся.
 *
 * Написано на встроенном Animated, без reanimated: одна интерполяция
 * прозрачности не стоит новой зависимости и нативной пересборки.
 */

function Shimmer({ style }: { style?: ViewStyle | ViewStyle[] }) {
  const pulse = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1, duration: 800, useNativeDriver: true }),
        Animated.timing(pulse, { toValue: 0, duration: 800, useNativeDriver: true }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [pulse]);

  // Диапазон намеренно узкий: мигание раздражает сильнее, чем помогает.
  const opacity = pulse.interpolate({ inputRange: [0, 1], outputRange: [0.45, 0.85] });

  return <Animated.View style={[s.block, style, { opacity }]} />;
}

/** Сетка карточек каталога — повторяет реальную раскладку витрины. */
export function CatalogSkeleton({ columns }: { columns: number }) {
  const rows = 3;
  return (
    <View style={s.grid}>
      {Array.from({ length: columns * rows }).map((_, i) => (
        <View key={i} style={[s.card, { width: `${100 / columns}%` }]}>
          <Shimmer style={s.photo} />
          <Shimmer style={s.linePrice} />
          <Shimmer style={s.lineTitle} />
          <Shimmer style={s.lineMeta} />
        </View>
      ))}
    </View>
  );
}

/** Список строк — для «Моих аренд» и профиля владельца. */
export function ListSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <View style={{ padding: spacing.lg, gap: spacing.md }}>
      {Array.from({ length: rows }).map((_, i) => (
        <View key={i} style={s.row}>
          <Shimmer style={s.rowThumb} />
          <View style={{ flex: 1, gap: spacing.sm }}>
            <Shimmer style={s.lineTitle} />
            <Shimmer style={s.lineMeta} />
          </View>
        </View>
      ))}
    </View>
  );
}

const s = StyleSheet.create({
  block: { backgroundColor: colors.border, borderRadius: radius.sm },

  grid: { flexDirection: 'row', flexWrap: 'wrap', padding: spacing.lg / 2 },
  card: { padding: spacing.lg / 2, gap: spacing.sm },
  photo: { width: '100%', aspectRatio: 4 / 3, borderRadius: radius.lg },
  linePrice: { width: '55%', height: 16 },
  lineTitle: { width: '85%', height: 12 },
  lineMeta: { width: '40%', height: 10 },

  row: {
    flexDirection: 'row',
    gap: spacing.md,
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.lg,
    borderWidth: 1,
    borderColor: colors.border,
    padding: spacing.md,
  },
  rowThumb: { width: 56, height: 56, borderRadius: radius.md },
});
