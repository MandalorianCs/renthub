import type { Ionicons } from '@expo/vector-icons';

/**
 * Значок категории — для мест, где нет фотографии.
 *
 * Зачем. Витрина пилота наполовину состоит из объявлений без фото: владелец
 * публикует вещь из чата бота, где снимок не обязателен, и добавляет его
 * позже. На месте снимка стояла одна и та же иконка «картинка» — она
 * сообщает ровно то, чего человек и так не видит, и четыре карточки подряд
 * с ней выглядят как сломанная витрина.
 *
 * Значок категории отвечает на другой вопрос — не «фото нет», а «что это».
 * Виброплиту от лазерного уровня в списке различают до чтения названия, и
 * пустая карточка перестаёт быть пустой.
 *
 * Почему Ionicons, а не свои рисунки. Набор уже в сборке — им набраны все
 * значки приложения; свои SVG добавили бы к весу ради восьми картинок,
 * которые видит только тот, кто ещё не загрузил фото. Точного перфоратора
 * в наборе нет, и это честный размен: узнаваемость группы важнее точности
 * силуэта.
 *
 * Ключи — те же slug'и, что в shared/tools.json и в таблице categories.
 * Незнакомая категория (появится новая — а появится она в базе раньше, чем
 * здесь) получает общий значок инструмента, а не пустоту.
 */

type IconName = keyof typeof Ionicons.glyphMap;

const BY_CATEGORY: Record<string, IconName> = {
  rotary_hammers: 'hammer-outline',
  grinders: 'disc-outline',
  concrete: 'cube-outline',
  scaffolding: 'layers-outline',
  drills: 'build-outline',
  saws: 'cut-outline',
  measuring: 'speedometer-outline',
  other_tools: 'construct-outline',
};

export function categoryIcon(category?: string | null): IconName {
  return (category && BY_CATEGORY[category]) || 'construct-outline';
}
