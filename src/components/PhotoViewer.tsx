import { Ionicons } from '@expo/vector-icons';
import { Image } from 'expo-image';
import { useState } from 'react';
import {
  Modal,
  Pressable,
  ScrollView,
  StatusBar,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from 'react-native';
import { colors, radius, spacing, typeface } from '../theme';

/**
 * Полноэкранный просмотр фото объявления.
 *
 * Написан вручную намеренно. Готовые просмотрщики из npm тянут за собой
 * reanimated и gesture-handler ради пинч-зума, а здесь фото служат
 * доказательством состояния вещи — их нужно рассмотреть, а не крутить.
 * Листание и крупный размер эту задачу закрывают, зависимостей не добавляя.
 *
 * Отдельная причина: подходящее имя в npm занято посторонним пакетом
 * 2010 года, и подбирать замену дольше, чем написать нужное.
 */
export function PhotoViewer({
  photos,
  startIndex,
  onClose,
}: {
  photos: string[];
  startIndex: number;
  onClose: () => void;
}) {
  const { width, height } = useWindowDimensions();
  const [index, setIndex] = useState(startIndex);

  return (
    <Modal visible animationType="fade" transparent onRequestClose={onClose}>
      <StatusBar barStyle="light-content" />
      <View style={s.backdrop}>
        <ScrollView
          horizontal
          pagingEnabled
          showsHorizontalScrollIndicator={false}
          contentOffset={{ x: startIndex * width, y: 0 }}
          onMomentumScrollEnd={(e) =>
            setIndex(Math.round(e.nativeEvent.contentOffset.x / width))
          }
        >
          {photos.map((uri) => (
            <View key={uri} style={{ width, height, justifyContent: 'center' }}>
              <Image
                source={uri}
                style={{ width, height: height * 0.72 }}
                contentFit="contain"
                transition={160}
              />
            </View>
          ))}
        </ScrollView>

        <Pressable
          style={s.close}
          onPress={onClose}
          hitSlop={10}
          accessibilityRole="button"
          accessibilityLabel="Закрыть просмотр"
        >
          <Ionicons name="close" size={22} color={colors.onScrim} />
        </Pressable>

        {photos.length > 1 ? (
          <View style={s.counter}>
            <Text style={s.counterText}>
              {index + 1} / {photos.length}
            </Text>
          </View>
        ) : null}
      </View>
    </Modal>
  );
}

const s = StyleSheet.create({
  // Не чистый чёрный: на фоне кремового интерфейса он выглядит дырой.
  backdrop: { flex: 1, backgroundColor: 'rgba(16,15,14,0.96)' },
  close: {
    position: 'absolute',
    top: spacing.xxl,
    right: spacing.lg,
    width: 40,
    height: 40,
    borderRadius: 20,
    backgroundColor: 'rgba(255,255,255,0.16)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  counter: {
    position: 'absolute',
    bottom: spacing.xxl,
    alignSelf: 'center',
    paddingHorizontal: spacing.md,
    paddingVertical: 6,
    borderRadius: radius.pill,
    backgroundColor: 'rgba(255,255,255,0.16)',
  },
  counterText: { fontSize: 13, fontFamily: typeface[700], color: colors.onScrim },
});
