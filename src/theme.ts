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
} as const;

export const spacing = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24, xxl: 32 } as const;

/**
 * Тень задаётся токеном, а не по месту: карточка объявления и карточка сделки
 * должны лежать на одной высоте, иначе интерфейс выглядит собранным из кусков.
 *
 * shadow* работает на iOS и в вебе (react-native-web переводит их в box-shadow),
 * elevation — на Android. Нужны оба набора, одного мало.
 */
export const elevation = {
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
} as const;

export const radius = { sm: 8, md: 12, lg: 16, pill: 999 } as const;

export const font = {
  h1: { fontSize: 28, fontWeight: '800' },
  h2: { fontSize: 20, fontWeight: '700' },
  body: { fontSize: 15, fontWeight: '400' },
  small: { fontSize: 13, fontWeight: '400' },
  label: { fontSize: 12, fontWeight: '600' },
} as const;
