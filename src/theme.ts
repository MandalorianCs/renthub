import { Platform } from 'react-native';

/**
 * Палитра взята из брендинга RentHUB (деки и лендинга): светлая тема,
 * кремовый фон, приглушённая терракота как акцент, тёмно-зелёный —
 * для «всё в порядке» состояний.
 */
export const colors = {
  bg: '#FAF7F2',
  surface: '#FFFFFF',
  border: '#E7E0D6',
  text: '#1A1917',
  textMuted: '#6E675E',
  accent: '#C2603C', // терракота — основное действие
  accentSoft: '#F6E7E0',
  green: '#2F5D50', // подтверждено / деньги начислены
  greenSoft: '#E3EDE9',
  warn: '#B8860B', // ожидание, срок подходит
  warnSoft: '#F6EEDA',
  danger: '#A33A2A', // спор, просрочка
  dangerSoft: '#F7E3DF',

  /**
   * Белый на плотной заливке — терракоте, зелёном, красном, чернильном.
   *
   * Это роль, а не цвет. Записанный по месту `#FFFFFF` неотличим от
   * `surface`, хотя означает противоположное: там это фон карточки, здесь —
   * текст поверх фона. Разведены, чтобы правка одного не задевала второе.
   */
  onFill: '#FFFFFF',

  /**
   * Белый поверх затемнения — счётчик фото на снимке, просмотрщик.
   *
   * Отдельно от `onFill` потому, что подложка здесь чужая: под ней
   * фотография, а не наш цвет. В тёмной теме `onFill` может поменяться,
   * а этот — нет, снимок останется снимком.
   */
  onScrim: '#FFFFFF',
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * Тень задаётся токеном, а не по месту: карточка объявления и карточка сделки
 * должны лежать на одной высоте, иначе интерфейс выглядит собранным из кусков.
 *
 * Платформ теперь три, а не две. `shadow*` — язык iOS, `elevation` — Android,
 * а react-native-web раньше переводил `shadow*` в `box-shadow` сам, но объявил
 * это устаревшим и пишет предупреждение в консоль на каждый экран. Поэтому
 * вебу отдаётся готовый `boxShadow`, остальным — прежние наборы.
 *
 * Значения подобраны так, чтобы совпадать визуально: 0 6px 16px при
 * непрозрачности 6% — это ровно то, что react-native-web собирал из
 * shadowOffset, shadowRadius и shadowOpacity.
 */
const native = {
  card: {
    shadowColor: '#1A1917',
    shadowOffset: { width: 0, height: 6 },
    shadowOpacity: 0.06,
    shadowRadius: 16,
    elevation: 2,
  },
  raised: {
    shadowColor: '#1A1917',
    shadowOffset: { width: 0, height: 10 },
    shadowOpacity: 0.14,
    shadowRadius: 22,
    elevation: 6,
  },
};

const web = {
  card: { boxShadow: '0 6px 16px rgba(26, 25, 23, 0.06)' },
  raised: { boxShadow: '0 10px 22px rgba(26, 25, 23, 0.14)' },
};

export const elevation = Platform.OS === 'web' ? web : native;

// xl — для карточек, которые человек воспринимает как предмет: витрина
// каталога, карточка объявления. Мелкое скругление на большой плоскости
// читается как прямоугольник со срезанными углами, а не как объект.
export const radius = { sm: 8, md: 12, lg: 16, xl: 22, pill: 999 } as const;

/**
 * Начертания Manrope — тот же шрифт, что на лендинге, чтобы сайт и
 * приложение читались как один продукт.
 *
 * Важно: со своим шрифтом `fontWeight` работать перестаёт. На Android он
 * просто игнорируется, на iOS и в вебе рисуется синтетическая жирность —
 * кривая и разная на разных платформах. Поэтому вес выбирается именем
 * файла, а не числом: fontFamily: typeface[700] вместо fontWeight: '700'.
 */
export const typeface = {
  400: 'Manrope_400Regular',
  500: 'Manrope_500Medium',
  600: 'Manrope_600SemiBold',
  700: 'Manrope_700Bold',
  800: 'Manrope_800ExtraBold',
} as const;

export const font = {
  h1: { fontSize: 28, fontFamily: typeface[800] },
  h2: { fontSize: 20, fontFamily: typeface[700] },
  body: { fontSize: 15, fontFamily: typeface[400] },
  small: { fontSize: 13, fontFamily: typeface[400] },
  label: { fontSize: 12, fontFamily: typeface[600] },
} as const;
