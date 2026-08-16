/**
 * Объявление модулей-ассетов для TypeScript.
 *
 * Metro умеет импортировать шрифты и картинки как модули, но компилятор об
 * этом не знает. Expo генерирует такое объявление в expo-env.d.ts — файл
 * лежит в .gitignore и на чистой машине отсутствует, из-за чего `tsc` падает
 * у любого, кто клонировал репозиторий. Поэтому объявление своё и в git.
 *
 * Тип union не случаен: на нативных платформах Metro отдаёт числовой
 * идентификатор ресурса, в вебе — строку с URL. `FontSource` принимает оба.
 */

declare module '*.ttf' {
  const asset: string | number;
  export default asset;
}

declare module '*.otf' {
  const asset: string | number;
  export default asset;
}
