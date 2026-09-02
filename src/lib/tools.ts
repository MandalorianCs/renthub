import data from '../../shared/tools.json';

/**
 * Подсказки для названия объявления.
 *
 * Зачем это вообще. Название — единственное поле, по которому вещь потом
 * ищут, и владелец пишет его один раз, глядя на инструмент. «Перфоратор» без
 * марки и «Bosch» без вида одинаково плохо находятся: первый теряется среди
 * двух десятков таких же, второй не отвечает на вопрос, что это.
 *
 * Подсказка не заполняет поле за человека — она показывает, из чего обычно
 * состоит хорошее название, и даёт начать не с пустой строки. Точный индекс
 * модели он допишет сам: только он видит шильдик.
 *
 * Список лежит в shared/tools.json, потому что его читает ещё и бот. Один
 * справочник на оба входа — иначе в чате и на экране предлагались бы разные
 * вещи, и одна и та же витрина выглядела бы собранной из двух разных.
 */

type Suggestion = { text: string; key: string };

type Category = {
  example: string;
  types: string[];
  popular: string[];
  /**
   * Марки, которые делают именно это.
   *
   * Общий список подходит электроинструменту, но лестниц Makita не бывает,
   * а перфораторов Karcher — тем более. Пара «вид + марка» собирается
   * перебором, и без этого поля перебор порождал бы правдоподобное враньё,
   * которое владелец подставит в объявление не задумываясь.
   */
  brands?: string[];
  /**
   * Марки на каждый вид отдельно — когда категория разнородная.
   *
   * «Прочий инструмент» держит рядом генератор, сварочник, мойку и
   * снегоуборщик. Один список на всю категорию давал «Сварочный аппарат
   * Karcher»: Karcher делает мойки, а не сварочники.
   */
  typeBrands?: Record<string, string[]>;
};

const CATEGORIES = data.categories as Record<string, Category>;
const BRANDS: string[] = data.brands;
const ALIASES = data.brandAliases as Record<string, string[]>;

/**
 * Нормализация для поиска.
 *
 * Кроме регистра и «ё», знаки препинания превращаются в пробелы. Иначе
 * «болгарка» не находит «УШМ (болгарка)»: слово стоит сразу после скобки, а
 * не после пробела. То же с «SDS-Plus» и «GBH 2-26» — дефис внутри модели не
 * должен требовать точного попадания.
 */
function fold(s: string): string {
  return s
    .toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

/** Пример для placeholder: свой у каждой категории. */
export function exampleFor(slug: string | null): string {
  if (!slug) return 'Перфоратор Bosch GBH 2-26';
  return CATEGORIES[slug]?.example ?? 'Перфоратор Bosch GBH 2-26';
}

/**
 * Всё, что можно предложить для категории.
 *
 * Порядок не случаен: сначала конкретные модели, которые действительно
 * встречаются, потом виды инструмента, потом пары «вид + марка». Человек,
 * листающий список сверху, идёт от самого точного к самому общему.
 *
 * Пары собираются, а не перечисляются руками: восемь категорий на три
 * десятка марок — это больше двух тысяч строк, которые невозможно держать
 * в порядке. Строка «Перфоратор Bosch» — шаблон названия, а не утверждение,
 * что такая модель существует.
 */
function allFor(slug: string): Suggestion[] {
  const cat = CATEGORIES[slug];
  if (!cat) return [];

  const out: Suggestion[] = [];
  const seen = new Set<string>();

  function add(text: string, brand?: string) {
    if (seen.has(text)) return;
    seen.add(text);

    // Ключ поиска шире показываемой строки: «бош» должно находить Bosch.
    // Латиница на телефоне требует переключить раскладку, и ради подсказки
    // этого никто делать не станет — значит марку набирают кириллицей.
    const extra = brand ? (ALIASES[brand] ?? []) : [];
    out.push({ text, key: fold([text, ...extra].join(' ')) });
  }

  for (const text of cat.popular) {
    // У готовой модели марку ищем в самой строке: «Перфоратор Bosch GBH 2-26»
    // должен находиться по «бош» так же, как «Перфоратор Bosch».
    add(text, BRANDS.find((b) => text.includes(b)));
  }

  for (const type of cat.types) add(type);
  for (const type of cat.types) {
    const brands = cat.typeBrands?.[type] ?? cat.brands ?? BRANDS;
    for (const brand of brands) add(`${type} ${brand}`, brand);
  }

  return out;
}

/**
 * Подсказки под запрос.
 *
 * Совпадение с начала строки идёт выше совпадения в середине: набравший
 * «бош» ждёт увидеть Bosch первым, а не «Отбойный молоток Bosch» после
 * десятка других. Пустой запрос — это не «ничего не найдено», а «человек
 * ещё не начал»: тогда показываем то, с чего чаще всего начинают.
 */
export function suggestTitles(slug: string | null, query: string, limit = 8): string[] {
  if (!slug) return [];

  const all = allFor(slug);
  const q = fold(query);

  if (!q) return all.slice(0, limit).map((x) => x.text);

  const starts: string[] = [];
  const inside: string[] = [];

  for (const item of all) {
    if (item.key.startsWith(q)) starts.push(item.text);
    // Начало слова, а не любое вхождение: «ель» не должно приводить к
    // «Дрель», иначе список наполняется случайными совпадениями.
    else if (item.key.includes(` ${q}`)) inside.push(item.text);
    if (starts.length >= limit) break;
  }

  return [...starts, ...inside].slice(0, limit);
}
