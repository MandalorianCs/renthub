#!/usr/bin/env node
// Демонстрационные объявления для показа продукта.
//
//   npm run demo:fill      создать объявления из фото в demo-photos/
//   npm run demo:clear     удалить все демонстрационные объявления
//
// Зачем. Пустой каталог на питче выглядит как неработающий продукт, даже
// если работает всё. Ни один редизайн этого не лечит: витрина без товара
// остаётся витриной без товара.
//
// Фото берутся из папки demo-photos/ — ваши, снятые на телефон, а не
// стоковые. Стоковый инструмент в каталоге про Кокшетау виден сразу:
// студийный свет и ощущение, что настоящего здесь нет. Снимок из гаража
// работает наоборот.
//
// Скрипт проходит настоящий путь загрузки: файл уходит в Storage в папку
// владельца, через ту же политику item_photos_write, что и у обычного
// пользователя. Сломанная загрузка обнаружится здесь, а не у первого
// живого владельца.

import { createClient } from '@supabase/supabase-js';
import { missingSecretMessage, readEnvFile, readSecret } from './env.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PHOTOS_DIR = join(ROOT, 'demo-photos');

// Владелец демонстрационных объявлений. Отдельный аккаунт, чтобы удаление
// было безопасным: чистим по владельцу, а не по подстроке в названии.
const DEMO_PHONE = '+77000000009';
const DEMO_NAME = 'Демо-витрина RentHUB';

const TOOLS = [
  { title: 'Перфоратор Bosch GBH 2-26', category: 'rotary_hammers', price: 3500, deposit: 20000,
    description: 'С кейсом и тремя бурами. Есть режим долбления. Проверен, работает без нареканий.' },
  { title: 'УШМ Makita 125 мм', category: 'grinders', price: 2000, deposit: 12000,
    description: 'Болгарка с регулировкой оборотов. В комплекте два отрезных диска и защитный кожух.' },
  { title: 'Бетономешалка 140 л', category: 'concrete', price: 6000, deposit: 30000,
    description: 'Для стяжки и кладки. Самовывоз, помещается в багажник универсала.' },
  { title: 'Строительные леса, 4 секции', category: 'scaffolding', price: 5000, deposit: 30000,
    description: 'Высота до 6 метров. Настилы и колёса в комплекте.' },
  { title: 'Шуруповёрт DeWalt 18V', category: 'drills', price: 1500, deposit: 10000,
    description: 'Два аккумулятора и зарядка. Набор бит на 30 предметов.' },
  { title: 'Дисковая пила Metabo', category: 'saws', price: 2500, deposit: 15000,
    description: 'Диск 190 мм, направляющая шина. Для распила доски и фанеры.' },
  { title: 'Лазерный уровень 360°', category: 'measuring', price: 2000, deposit: 15000,
    description: 'Самовыравнивающийся, со штативом. Хватает на комнату целиком.' },
  { title: 'Виброплита 90 кг', category: 'concrete', price: 8000, deposit: 40000,
    description: 'Для трамбовки грунта и укладки брусчатки. Бензиновая, заправлена.' },
];

// ── Ключи ─────────────────────────────────────────────────────


const url = process.env.SUPABASE_URL ?? readEnvFile('EXPO_PUBLIC_SUPABASE_URL');
const secret = readSecret();
const city = readEnvFile('EXPO_PUBLIC_PILOT_CITY') ?? 'kokshetau';
const mode = process.argv[2] === 'clear' ? 'clear' : 'fill';

if (!url || url.includes('xxxxxxxxxxxx')) {
  console.error('✗ Не найден адрес проекта. Заполните EXPO_PUBLIC_SUPABASE_URL в .env');
  process.exit(1);
}

if (!secret) {
  console.error(missingSecretMessage('npm run demo:fill'));
  process.exit(1);
}

const admin = createClient(url, secret, {
  auth: { persistSession: false, autoRefreshToken: false },
});

// ── Демо-владелец ─────────────────────────────────────────────

async function ensureDemoOwner() {
  const digits = (s) => (s ?? '').replace(/\D/g, '');
  const { data: list } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const existing = list?.users.find((u) => digits(u.phone) === digits(DEMO_PHONE));

  if (existing) return existing.id;

  const { data, error } = await admin.auth.admin.createUser({
    phone: DEMO_PHONE,
    phone_confirm: true,
    user_metadata: { full_name: DEMO_NAME },
  });
  if (error) throw new Error(`не удалось создать демо-владельца: ${error.message}`);
  return data.user.id;
}

// ── Очистка ───────────────────────────────────────────────────

if (mode === 'clear') {
  const ownerId = await ensureDemoOwner();

  // Объявления с бронями удалить нельзя — на них ссылается bookings с
  // on delete restrict. Это не помеха, а защита: удалять вещь, по которой
  // идёт сделка, нельзя ни демо-скриптом, ни как-либо ещё.
  const { data: items } = await admin.from('items').select('id').eq('owner_id', ownerId);
  const { error } = await admin.from('items').delete().eq('owner_id', ownerId);

  if (error) {
    console.error(`✗ ${error.message}`);
    console.error('\n  Скорее всего по какому-то объявлению есть бронь. Закройте сделку сначала.');
    process.exit(1);
  }

  console.log(`\n✓ Удалено демонстрационных объявлений: ${items?.length ?? 0}\n`);
  process.exit(0);
}

// ── Заполнение ────────────────────────────────────────────────

if (!existsSync(PHOTOS_DIR)) {
  console.error(`
✗ Нет папки demo-photos/

  Создайте её в корне проекта и положите туда фотографии инструмента —
  свои, снятые на телефон. Стоковые снимки в каталоге видно сразу.

  Форматы: jpg, jpeg, png, webp. Хватит 6–8 штук.
`);
  process.exit(1);
}

const files = readdirSync(PHOTOS_DIR).filter((f) =>
  ['.jpg', '.jpeg', '.png', '.webp'].includes(extname(f).toLowerCase()),
);

if (files.length === 0) {
  console.error(`✗ В demo-photos/ нет изображений (jpg, jpeg, png, webp)`);
  process.exit(1);
}

const ownerId = await ensureDemoOwner();
console.log(`\nДемо-владелец готов. Фотографий найдено: ${files.length}\n`);

const mime = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };
const uploaded = [];

for (const file of files) {
  const ext = extname(file).toLowerCase();
  // Путь <user_id>/<файл> — ровно то, что проверяет политика item_photos_write.
  const path = `${ownerId}/demo-${Date.now()}-${file.replace(/\s+/g, '-')}`;

  const { error } = await admin.storage
    .from('item-photos')
    .upload(path, readFileSync(join(PHOTOS_DIR, file)), {
      contentType: mime[ext] ?? 'image/jpeg',
      upsert: false,
    });

  if (error) {
    console.error(`  ✗ ${file}: ${error.message}`);
    continue;
  }

  uploaded.push(admin.storage.from('item-photos').getPublicUrl(path).data.publicUrl);
  console.log(`  ↑ ${file}`);
}

if (uploaded.length === 0) {
  console.error('\n✗ Ни одно фото не загрузилось — объявления создавать не из чего');
  process.exit(1);
}

console.log('');

let created = 0;
for (let i = 0; i < TOOLS.length; i++) {
  const tool = TOOLS[i];
  // Фото распределяются по кругу: объявлений больше, чем снимков — и это
  // нормально для демонстрации, лишь бы каждое было с картинкой.
  const photos = [uploaded[i % uploaded.length]];
  if (uploaded.length > TOOLS.length) photos.push(uploaded[(i + 1) % uploaded.length]);

  const { error } = await admin.from('items').insert({
    owner_id: ownerId,
    category: tool.category,
    title: tool.title,
    description: tool.description,
    daily_price: tool.price,
    deposit_amount: tool.deposit,
    condition_photos: photos,
    city,
  });

  if (error) {
    console.error(`  ✗ ${tool.title}: ${error.message}`);
    continue;
  }

  console.log(`  + ${tool.title} — ${tool.price} ₸/сутки`);
  created++;
}

console.log(`
✓ Создано объявлений: ${created}. Город: ${city}.

Каталог: https://mandaloriancs.github.io/renthub/app/

Убрать всё одной командой:
  npm run demo:clear

Это демонстрационные данные под отдельным владельцем — реальные
объявления живых людей они не затронут.
`);
