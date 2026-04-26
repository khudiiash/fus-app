/**
 * Seed data for FUSAPP
 * Run from the admin panel's "Seed Data" button (admin only).
 */

export const SEED_ITEMS = [
  // ── Skins ──────────────────────────────────────────────────────────────────
  // skinUrl: admin adds real Minecraft skin texture URL via the shop panel
  // skinId:  fallback for Canvas-generated color skin if no URL is set
  {
    name: 'Sigma',
    category: 'skin', rarity: 'rare', price: 300,
    skinId: 'sigma', skinUrl: null,
    description: 'Мовчазний. Холодний. Sigma grindset активовано.',
  },
  {
    name: 'Brainrot',
    category: 'skin', rarity: 'epic', price: 600,
    skinId: 'brainrot', skinUrl: null,
    description: 'Bombardiro Crocodilo в твоїх венах. Tralalero Tralala.',
  },
  {
    name: 'Ohio Cursed',
    category: 'skin', rarity: 'epic', price: 600,
    skinId: 'ohio', skinUrl: null,
    description: 'Only in Ohio. Перетворись на кінцевого боса.',
  },
  {
    name: 'Rizz Lord',
    category: 'skin', rarity: 'legendary', price: 1200,
    skinId: 'rizz', skinUrl: null, isLimited: true,
    description: 'Unspoken rizz. W rizz. Абсолютний харизматик.',
  },
  {
    name: 'NPC',
    category: 'skin', rarity: 'common', price: 100,
    skinId: 'npc', skinUrl: null,
    description: 'Я NPC. У мене немає вільної волі. Патрулюю місто.',
  },
  {
    name: 'Brat',
    category: 'skin', rarity: 'rare', price: 300,
    skinId: 'brat', skinUrl: null,
    description: 'Brat summer. Brat fall. Brat everything.',
  },
  {
    name: 'Chill Guy',
    category: 'skin', rarity: 'rare', price: 300,
    skinId: 'chillguy', skinUrl: null,
    description: 'Він просто chill guy. Не хвилюється ні про що.',
  },
  {
    name: 'Skibidi',
    category: 'skin', rarity: 'epic', price: 600,
    skinId: 'skibidi', skinUrl: null,
    description: 'Skibidi dop dop dop yes yes. Ти — cameraman.',
  },
  {
    name: 'Galaxy Mind',
    category: 'skin', rarity: 'rare', price: 300,
    skinId: 'galaxy', skinUrl: null,
    description: 'Думаєш на 5 кроків вперед. Big brain.',
  },
  {
    name: 'Fire Spirit',
    category: 'skin', rarity: 'common', price: 100,
    skinId: 'fire', skinUrl: null,
    description: 'Literally on fire. No cap.',
  },

  // ── Accessories ────────────────────────────────────────────────────────────
  {
    name: 'Bombardiro',
    category: 'accessory', rarity: 'legendary', price: 1200, emoji: '🐊',
    isLimited: false,
    description: 'Bombardiro Crocodilo! Літаючий крокодил-бомба з Italian Brainrot.',
  },
  {
    name: 'Tralalero Shark',
    category: 'accessory', rarity: 'epic', price: 600, emoji: '🦈',
    description: 'Tralalero Tralala! Акула в кросівках Nike. W rizz.',
  },
  {
    name: 'Sigma Glasses',
    category: 'accessory', rarity: 'rare', price: 300, emoji: '🕶️',
    description: 'Sigma sunglasses. Носиш і нічого не пояснюєш.',
  },
  {
    name: 'W Badge',
    category: 'accessory', rarity: 'common', price: 80, emoji: '✅',
    description: 'Просто W. Завжди W. No L in sight.',
  },
  {
    name: 'Skibidi Toilet',
    category: 'accessory', rarity: 'rare', price: 300, emoji: '🚽',
    description: 'Tiny skibidi toilet на твоєму аватарі. Iconic.',
  },
  {
    name: 'Chill Dog',
    category: 'accessory', rarity: 'common', price: 100, emoji: '🐶',
    description: 'Chill Guy собачка. Не хвилюється. Ти теж не хвилюйся.',
  },
  {
    name: 'Fanum Tax',
    category: 'accessory', rarity: 'rare', price: 300, emoji: '💸',
    description: 'Fanum tax уже зібрано. Щось взяли з тарілки.',
  },
  {
    name: 'No Cap',
    category: 'accessory', rarity: 'common', price: 80, emoji: '🧢',
    description: 'No cap fr fr. Перекреслена кепка — знак правди.',
  },
  {
    name: 'Gyatt Crown',
    category: 'accessory', rarity: 'epic', price: 600, emoji: '👑',
    description: 'GYATT. Корона для справжнього slay king/queen.',
  },
  {
    name: 'NPC Tag',
    category: 'accessory', rarity: 'common', price: 80, emoji: '🤖',
    description: 'NPC #4728. Ходиш по одному маршруту щодня.',
  },
  {
    name: 'Cooked',
    category: 'accessory', rarity: 'rare', price: 300, emoji: '🍳',
    description: 'Bro is cooked. Буквально смажений. GGs.',
  },
  {
    name: 'Ohio Spiral',
    category: 'accessory', rarity: 'rare', price: 300, emoji: '🌀',
    description: 'Ohio curse спіраль. Лише в Ohio.',
  },
  {
    name: 'Big L',
    category: 'accessory', rarity: 'common', price: 50, emoji: '💀',
    description: 'L bozo. Skull emoji означає все що треба.',
  },
  {
    name: 'Mewing',
    category: 'accessory', rarity: 'rare', price: 300, emoji: '😤',
    description: 'Mewing активовано. Jawline +100. Looksmax розпочато.',
  },
  {
    name: 'Rizz God',
    category: 'accessory', rarity: 'legendary', price: 1200, emoji: '💫',
    isLimited: true,
    description: 'Rizz so unspoken він сам себе говорить. Легендарний.',
  },
  {
    name: 'Cappuccino',
    category: 'accessory', rarity: 'epic', price: 600, emoji: '☕',
    description: 'Cappuccino Assassino. Italian Brainrot кава-вбивця.',
  },
  {
    name: 'Brat Mode',
    category: 'accessory', rarity: 'rare', price: 300, emoji: '💚',
    description: 'Brat mode: ON. Charli XCX approved.',
  },
  {
    name: 'Goofy Ahh',
    category: 'accessory', rarity: 'common', price: 80, emoji: '🃏',
    description: 'Goofy ahh moment. The joker did not have to go this hard.',
  },
  {
    name: 'Delulu',
    category: 'accessory', rarity: 'rare', price: 300, emoji: '🦋',
    description: 'Delulu is the solulu. Маніфест у процесі.',
  },

  // ── Mystery boxes ───────────────────────────────────────────────────────────
  // See MYSTERY_BOX_SEEDS below for the idempotent (upsert) catalog used by the
  // admin-panel "Generate mystery boxes" button — same rows, but keyed by
  // {@code mbSeedKey} so repeated presses never duplicate items.
  ...[
    {
      mbSeedKey: 'mb:common', name: 'Звичайна коробка',
      category: 'mystery_box', rarity: 'common', price: 80,
      description: 'Невеликий сюрприз: трохи монет і шанс випадкового предмета зі звичайних/рідкісних.',
      stock: null, isLimited: false,
    },
    {
      mbSeedKey: 'mb:rare', name: 'Рідкісна коробка',
      category: 'mystery_box', rarity: 'rare', price: 300,
      description: 'Більше монет та шанс на рідкісні й епічні предмети.',
      stock: null, isLimited: false,
    },
    {
      mbSeedKey: 'mb:epic', name: 'Епічна коробка',
      category: 'mystery_box', rarity: 'epic', price: 700,
      description: 'Для полювальників за «епіком»: жирний шанс на епічні скіни та аксесуари.',
      stock: null, isLimited: false,
    },
    {
      mbSeedKey: 'mb:legendary', name: 'Легендарна коробка',
      category: 'mystery_box', rarity: 'legendary', price: 1500,
      description: 'Шанс на легендарний скін, аксесуар або рідкісну кімнату. W rizz.',
      stock: null, isLimited: false,
    },
  ],
]

/**
 * Stable, idempotent mystery-box catalog.
 * Used by {@link seedMysteryBoxes} so the admin can click the "Generate boxes"
 * button any number of times without creating duplicate items — rows are matched
 * by {@code mbSeedKey} (category+rarity).
 */
export const MYSTERY_BOX_SEEDS = SEED_ITEMS.filter(
  (i) => i && i.category === 'mystery_box' && i.mbSeedKey,
)

export const SEED_ACHIEVEMENTS = [
  // Coin achievements
  { name: 'Перша монета',    icon: '🪙', rarity: 'common',    condition: { type: 'coins', threshold: 1 },    rewardCoins: 5,   rewardXp: 10,  description: 'Зароби свою першу монету' },
  { name: 'Збирач монет',    icon: '💰', rarity: 'common',    condition: { type: 'coins', threshold: 100 },  rewardCoins: 10,  rewardXp: 25,  description: 'Зароби 100 монет' },
  { name: 'Товстосум',       icon: '💸', rarity: 'rare',      condition: { type: 'coins', threshold: 500 },  rewardCoins: 25,  rewardXp: 50,  description: 'Зароби 500 монет' },
  { name: 'W Rizz',          icon: '✨', rarity: 'epic',      condition: { type: 'coins', threshold: 1000 }, rewardCoins: 50,  rewardXp: 100, description: 'Зароби 1 000 монет. Fr fr no cap.' },
  { name: 'Sigma Grindset',  icon: '😐', rarity: 'legendary', condition: { type: 'coins', threshold: 5000 }, rewardCoins: 200, rewardXp: 500, description: 'Зароби 5 000 монет. Hustle never stops.' },

  // Level achievements
  { name: 'Новачок',         icon: '🌱', rarity: 'common',    condition: { type: 'level', threshold: 5 },   rewardCoins: 20,  rewardXp: 0,   description: 'Досягни рівня 5' },
  { name: 'NPC evolved',     icon: '🤖', rarity: 'rare',      condition: { type: 'level', threshold: 10 },  rewardCoins: 50,  rewardXp: 0,   description: 'Рівень 10. Вже не просто NPC.' },
  { name: 'Ohio Boss',       icon: '🌀', rarity: 'epic',      condition: { type: 'level', threshold: 20 },  rewardCoins: 100, rewardXp: 0,   description: 'Рівень 20. Only in Ohio.' },
  { name: 'Bombardiro',      icon: '🐊', rarity: 'legendary', condition: { type: 'level', threshold: 50 },  rewardCoins: 500, rewardXp: 0,   description: 'Рівень 50. Bombardiro Crocodilo підтверджує.' },

  // Streak achievements
  { name: 'У ритмі',         icon: '🔥', rarity: 'common',    condition: { type: 'streak', threshold: 3 },  rewardCoins: 15,  rewardXp: 30,  description: '3 дні входу поспіль' },
  { name: 'Тижневий Sigma',  icon: '😤', rarity: 'rare',      condition: { type: 'streak', threshold: 7 },  rewardCoins: 35,  rewardXp: 70,  description: '7 днів. Sigma week grindset.' },
  { name: 'Chill Streak',    icon: '🐶', rarity: 'epic',      condition: { type: 'streak', threshold: 14 }, rewardCoins: 75,  rewardXp: 150, description: '14 днів. Chill guy не пропускає.' },
  { name: 'Rizz Streak',     icon: '✨', rarity: 'legendary', condition: { type: 'streak', threshold: 30 }, rewardCoins: 200, rewardXp: 400, description: '30 днів. Unspoken rizz streak.' },
]

import { addDoc, collection, getDocs, deleteDoc, updateDoc, doc } from 'firebase/firestore'
import { db } from './config'
import { getSubjectIcon } from '@/composables/useSubjectIcon'
import { uploadShopGlb, uploadSkinTextureFile } from '@/firebase/shopAssetStorage'
import {
  ALL_TOOL_MESH_NAMES,
  defaultBlockWorldToolDoc,
  parseToolMeshBaseName,
} from '@/lib/blockWorldToolCatalog'

const PRICE_BY_RARITY = { common: 100, rare: 300, epic: 600, legendary: 1200 }

function glbFilenameToDisplayName(filename) {
  let base = filename.replace(/\.glb$/i, '')
  for (const p of ['room', 'accessory', 'acc']) {
    base = base.replace(new RegExp(`^${p}_?`, 'i'), '')
  }
  return base.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
}

function rarityFromFilename(filename) {
  const rarities = ['common', 'rare', 'epic', 'legendary']
  let h = 0
  for (let i = 0; i < filename.length; i++) h = ((h << 5) - h) + filename.charCodeAt(i) | 0
  return rarities[Math.abs(h) % 4]
}

/**
 * Upsert shop items from HTTPS URLs (typically Firebase Storage after upload).
 * @param {{ filename: string, url: string }[]} assets
 * @param {'room' | 'accessory' | 'pet'} category
 * @param {string} description
 */
async function upsertGlbShopItemsFromUrls(assets, category, description) {
  const snap = await getDocs(collection(db, 'items'))
  const existingDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  const byName = new Map(existingDocs.map(d => [d.name?.trim().toLowerCase(), d]))

  const toAdd = []
  const toUpdate = []

  for (const { filename, url } of assets) {
    const name = glbFilenameToDisplayName(filename)
    const key = name.trim().toLowerCase()
    const rarity = rarityFromFilename(filename)
    const found = byName.get(key)

    if (!found) {
      toAdd.push({ name, url, rarity })
    } else if (found.category !== category) {
      // Same display name, different category — do not touch
      continue
    } else if (url && found.modelData !== url) {
      toUpdate.push({ id: found.id, modelData: url })
    }
  }

  await Promise.all([
    ...toAdd.map(({ name, url, rarity }) =>
      addDoc(collection(db, 'items'), {
        name,
        description,
        category,
        rarity,
        price: PRICE_BY_RARITY[rarity],
        modelData: url,
        skinUrl: null,
        skinId: null,
        isLimited: false,
        stock: null,
        active: true,
        brightnessMultiplier: category === 'room' ? 1.0 : null,
        createdAt: new Date(),
      })
    ),
    ...toUpdate.map(({ id, modelData }) =>
      updateDoc(doc(db, 'items', id), { modelData })
    ),
  ])

  const skipped = assets.length - toAdd.length - toUpdate.length
  return { added: toAdd.length, updated: toUpdate.length, skipped }
}

/**
 * Upload each .glb to Storage, then upsert Firestore items (admin import).
 * @param {File[] | FileList} files
 * @param {'room' | 'accessory' | 'pet'} category
 */
export async function seedGlbShopItemsFromFiles(files, category) {
  const description =
    category === 'room'
      ? 'Інтер\'єр для персональної кімнати учня з колекції FUSAPP.'
      : category === 'pet'
        ? 'Улюбленець для кімнати учня з колекції FUSAPP.'
        : 'Аксесуар для аватара з колекції FUSAPP.'
  const list = Array.from(files || []).filter((f) => /\.glb$/i.test(f.name))
  if (!list.length) return { added: 0, updated: 0, skipped: 0 }

  const assets = []
  for (const file of list) {
    if (category === 'room' && /^room_default\.glb$/i.test(file.name)) continue
    const url = await uploadShopGlb(category, file.name, file)
    assets.push({ filename: file.name, url })
  }
  return upsertGlbShopItemsFromUrls(assets, category, description)
}

/** @deprecated Use seedGlbShopItemsFromFiles + file picker (no bundled assets). */
export async function seedRoomsFromAssets() {
  return { added: 0, updated: 0, skipped: 0 }
}

/** @deprecated Use seedGlbShopItemsFromFiles + file picker. */
export async function seedAccessoriesFromAssets() {
  return { added: 0, updated: 0, skipped: 0 }
}

/** @deprecated Use seedRoomsAndAccessoriesFromFileLists. */
export async function seedRoomsAndAccessoriesFromAssets() {
  return {
    rooms: { added: 0, updated: 0, skipped: 0 },
    accessories: { added: 0, updated: 0, skipped: 0 },
  }
}

/** Import rooms + accessories from two multi-file picks (uploads to Storage). */
export async function seedRoomsAndAccessoriesFromFileLists(roomFiles, accessoryFiles) {
  const rooms = roomFiles?.length
    ? await seedGlbShopItemsFromFiles(roomFiles, 'room')
    : { added: 0, updated: 0, skipped: 0 }
  const accessories = accessoryFiles?.length
    ? await seedGlbShopItemsFromFiles(accessoryFiles, 'accessory')
    : { added: 0, updated: 0, skipped: 0 }
  return { rooms, accessories }
}

// ── Skin pack ─────────────────────────────────────────────────────────────────
const SEED_SKINS = [
  { name: 'Artorias',        file: 'Artorias3078.png',      rarity: 'legendary', description: 'Легендарний лицар прірви. Його броня — темрява, а меч — відчай.' },
  { name: 'Beanz4life',      file: 'Beanz4life23.png',       rarity: 'common',    description: 'Квасоля — це не просто їжа, це спосіб життя.' },
  { name: 'Black Sadness',   file: 'BlackSadness.png',       rarity: 'rare',      description: 'Коли у плейлисті тільки lo-fi і дощ за вікном. Вічний сум у чорному.' },
  { name: 'Black Suit Lady', file: 'BlackSuitLady.png',      rarity: 'epic',      description: 'Стильна, холодна, невловима. Не запитуй, чим вона займається.' },
  { name: 'Darling',         file: 'darlingwww.png',         rarity: 'rare',      description: 'Милий знадвору, небезпечний зсередини. Дарлінг у мережі.' },
  { name: 'Dr. Mario',       file: 'DrMariosyt.png',         rarity: 'epic',      description: 'Він лікує не хвороби, а вороже здоров\'я. Доктор прийняв виклик.' },
  { name: 'F1umble',         file: 'F1umble.png',            rarity: 'common',    description: 'Падає, але встає. Завжди. F1umble — це про наполегливість.' },
  { name: 'Fanclub NFT',     file: 'FanclubNFT.png',         rarity: 'rare',      description: 'Цифровий колекціонер. Власник рідкісних пікселів і великих амбіцій.' },
  { name: 'Fr0ttingnoises',  file: 'Fr0ttingnoises.png',     rarity: 'common',    description: 'Ніхто не знає, звідки ці звуки. Але всі озираються.' },
  { name: 'Frown Player',    file: 'FROWN_PLAYER.png',       rarity: 'rare',      description: 'Завжди незадоволений. Навіть перемога не приносить посмішки.' },
  { name: 'Im So Sad',       file: 'im_so_sad.png',          rarity: 'common',    description: 'Сум — це не слабкість, це естетика. Весь в почуттях.' },
  { name: 'Jared',           file: 'Jared.png',              rarity: 'common',    description: 'Просто Джаред. Той, якого всі знають, але ніхто не розуміє.' },
  { name: 'Minion',          file: 'Minion.png',             rarity: 'epic',      description: 'Банан! Бело! Папая! Найвідданіший міньйон у всьому FUSAPP.' },
  { name: 'Mr. Bear',        file: 'MrBear.png',             rarity: 'rare',      description: 'Ведмідь у людському вигляді. Тихий, але потужний. Не злий.' },
  { name: 'Mr. Hidden',      file: 'MrHidden.png',           rarity: 'epic',      description: 'Його майже не видно. Він є скрізь і ніде. Справжній майстер тіні.' },
  { name: 'Mr. Mono',        file: 'MrMono.png',             rarity: 'rare',      description: 'Монохромний стиль — це не обмеження, це вибір. Контраст як характер.' },
  { name: 'nwvv',            file: 'nwvv.png',               rarity: 'common',    description: 'Нікого не запитуй, як читається це ім\'я. Він і сам не знає.' },
  { name: 'Pizza Cat',       file: 'PizaCatWallis.png',      rarity: 'legendary', description: 'Кіт із піцою — це не просто скін, це заява. Найсмачніший персонаж.' },
  { name: 'Ramageddon',      file: 'Ramageddon12.png',       rarity: 'epic',      description: 'Армагедон в одній особі. Хаос — його стихія, перемога — звичка.' },
  { name: 'RAWR Melissa',    file: 'RAWRmelissa.png',         rarity: 'rare',      description: 'RAWR! Мелісса злякає кого завгодно. Не заважай їй за ПК.' },
  { name: 'Shark',           file: 'SharkInho.png',          rarity: 'epic',      description: 'Акула у грі. Безжальний хижак цифрових морів. Ти його жертва.' },
  { name: 'Sir Kiwi Tea',    file: 'SirKiwiTea.png',         rarity: 'legendary', description: 'Благородний лицар ківі та чаю. Ввічливий, але смертоносний.' },
  { name: 'Snow Emo',        file: 'SnowEmo.png',            rarity: 'rare',      description: 'Холодний сніг, темні думки, чорний одяг. Сніговий емо.' },
  { name: 'Snow Killer',     file: 'SnowKiller.png',         rarity: 'epic',      description: 'Під кожною сніжинкою — небезпека. Цей скін знає, де ти.' },
  { name: 'Spoody',          file: 'Spoody.png',             rarity: 'rare',      description: 'Трохи моторошно, трохи мило. Спуді не злякає, але здивує.' },
  { name: 'Swqlt',           file: 'Swqlt.png',              rarity: 'common',    description: 'Тихий, але присутній. Swqlt завжди там, де його не чекають.' },
  { name: 'Thee Sadness',    file: 'TheeSadness.png',        rarity: 'rare',      description: 'Абсолютний сум. Не просто sad, а THEE Sadness. Рівень — максимум.' },
  { name: 'Therealmonem',    file: 'therealmonem.png',       rarity: 'common',    description: 'Справжній. Без фільтрів, без масок. Therealmonem — це автентичність.' },
  { name: 'Atom 442',        file: 'UnevenerAtom442.png',    rarity: 'epic',      description: 'Нерівний атом 442 — квантова аномалія у вигляді скіна.' },
  { name: 'Verdel',          file: 'Verdel.png',             rarity: 'rare',      description: 'Зелений, свіжий, непередбачуваний. Верде — це природа у бою.' },
  { name: 'Wiwiyiv',         file: 'Wiwiyiv.png',            rarity: 'common',    description: 'Загадкове ім\'я, загадкова особистість. Вівійів дивиться на тебе.' },
  { name: 'Zoltron',         file: 'Zoltron96.png',          rarity: 'legendary', description: 'Зачинений у 96-му, відроджений зараз. Залтрон — кіборг-легенда.' },
]

// Canonical list of all school subjects
const SEED_SUBJECTS = [
  'Алгебра',
  'Англійська мова',
  'Англійська мова група 1',
  'Англійська мова група 2',
  'Англійська мова (додаткова)',
  'Біологія',
  'Біологія і екологія',
  'Всесвітня історія',
  'Всесвітня історія. Історія України (інтегрований курс)',
  'Вступ до історії',
  'Вступ до історії України',
  'Вступ до історії України та громадянської освіти',
  'Географія',
  'Геометрія',
  'Година з класним керівником',
  'Година куратора',
  'Година психолога',
  'Громадянська освіта',
  'Додаткова година',
  'Емоційний інтелект',
  'Зарубіжна література',
  'Захист України',
  'Іноземна мова (англійська мова)',
  'Інтегрований курс "Дизайн та технології, STEM, Інформатика"',
  'Інтегрований курс "Здоров\'я, безпека та добробут"',
  'Інтегрований курс "Пізнаємо природу"',
  'Інтегрований курс STEM',
  'Інформатика',
  'Історія',
  'Історія. Інтегрований курс',
  'Історія та сьогодення',
  'Історія України',
  'Історія України. Всесвітня історія',
  'Кураторська година',
  'Літературне читання',
  'Малювання',
  'Математика',
  'Математика (алгебра)',
  'Математика (геометрія)',
  'Мистецтво',
  'Музика',
  'Музичне мистецтво',
  'Навчання грамоти',
  'Німецька мова',
  'Образотворче мистецтво',
  'Основи здоров\'я і життєдіяльності',
  'Основи правознавства',
  'Пізнаємо природу',
  'Польська культура',
  'Польська мова',
  'Польська мова (додаткова)',
  'Правознавство',
  'Суспільствознавство',
  'Технології',
  'Технології та дизайн',
  'Трудове навчання',
  'Українська література',
  'Українська мова',
  'Фізика',
  'Фізика і астрономія',
  'Фізична культура',
  'Хімія',
  'Читання',
  'Я досліджую світ',
  'ЯДС',
  'ЯДС STEM',
  'Edukacja obywatelska',
  'Historia i teraźniejszość',
  'WOS',
]

/**
 * Предметні значки для магазину: збіг за назвою предмета з колекції `subjects`.
 * Один запис = один товар на перший знайдений предмет із matchNames.
 */
/**
 * Per-subject badge: buyable **only with coins earned from that subject** (100 coins).
 * Gate enforced in {@link ../firebase/collections.js `purchaseItem`}. Shown in shop / admin.
 */
export const SUBJECT_BADGE_DESCRIPTION =
  'Цей бейдж дає право на підвищення оцінки з цього предмету. Можна придбати лише за монети зароблені з цього предмету.'
export const SUBJECT_BADGE_PRICE = 100
export const SUBJECT_BADGE_COIN_KIND = 'subject_earned'

const BADGE_DESCRIPTION = SUBJECT_BADGE_DESCRIPTION

export const SUBJECT_BADGE_DEFS = [
  /** spriteIndex = кадр у src/assets/subjects.png (див. BADGE_SPRITE_LABELS). */
  { matchNames: ['Математика', 'Математика (алгебра)', 'Математика (геометрія)', 'Геометрія', 'Алгебра'], name: 'Значок математики', emoji: '🔢', spriteIndex: 4, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Фізика', 'Фізика і астрономія'], name: 'Значок фізики', emoji: '⚛️', spriteIndex: 5, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Хімія'], name: 'Значок хімії', emoji: '🧪', spriteIndex: 6, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Інформатика', 'Інтегрований курс STEM', 'Інтегрований курс "Дизайн та технології, STEM, Інформатика"'], name: 'Значок інформатики', emoji: '💻', spriteIndex: 11, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Українська мова', 'Українська література', 'Літературне читання', 'Читання'], name: 'Значок української', emoji: '📘', spriteIndex: 12, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Німецька мова'], name: 'Значок німецької', emoji: '🥨', spriteIndex: 17, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Англійська мова', 'Англійська мова група 1', 'Англійська мова група 2', 'Іноземна мова (англійська мова)', 'Англійська мова (додаткова)'], name: 'Значок англійської', emoji: '📕', spriteIndex: 16, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Біологія', 'Біологія і екологія'], name: 'Значок біології', emoji: '🧬', spriteIndex: 8, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Пізнаємо природу', 'Інтегрований курс "Пізнаємо природу"'], name: 'Значок природознавства', emoji: '🌳', spriteIndex: 10, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Географія'], name: 'Значок географії', emoji: '🌍', spriteIndex: 1, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Історія України', 'Історія', 'Всесвітня історія', 'Всесвітня історія. Історія України (інтегрований курс)', 'Історія. Інтегрований курс'], name: 'Значок історії', emoji: '🏛️', spriteIndex: 0, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Зарубіжна література'], name: 'Значок зарубіжної літератури', emoji: '📚', spriteIndex: 14, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Мистецтво', 'Образотворче мистецтво', 'Малювання'], name: 'Значок образотворчого мистецтва', emoji: '🎨', spriteIndex: 19, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Музика', 'Музичне мистецтво'], name: 'Значок музики', emoji: '🎵', spriteIndex: 21, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Фізична культура'], name: 'Значок фізкультури', emoji: '⚽', spriteIndex: 22, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Правознавство', 'Основи правознавства'], name: 'Значок правознавства', emoji: '⚖️', spriteIndex: 2, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Суспільствознавство'], name: 'Значок суспільствознавства', emoji: '👥', spriteIndex: 3, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Польська мова', 'Польська мова (додаткова)', 'Польська культура'], name: 'Значок польської мови', emoji: '🇵🇱', spriteIndex: 18, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['Основи здоров\'я і життєдіяльності'], name: 'Значок основ здоров’я', emoji: '❤️', spriteIndex: 23, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
  { matchNames: ['ЯДС', 'ЯДС STEM'], name: 'Значок захисту України', emoji: '🛡️', spriteIndex: 24, description: BADGE_DESCRIPTION, price: SUBJECT_BADGE_PRICE },
]

export async function seedSubjectBadges() {
  const itemsSnap = await getDocs(collection(db, 'items'))
  await Promise.all(
    itemsSnap.docs.filter((d) => d.data().category === 'subject_badge').map((d) => deleteDoc(d.ref)),
  )

  const subSnap = await getDocs(collection(db, 'subjects'))
  const byNameLower = new Map()
  for (const d of subSnap.docs) {
    const n = d.data().name?.trim().toLowerCase()
    if (n) byNameLower.set(n, { id: d.id, name: d.data().name })
  }

  let added = 0
  for (const def of SUBJECT_BADGE_DEFS) {
    let subj = null
    for (const n of def.matchNames) {
      const k = n.trim().toLowerCase()
      if (byNameLower.has(k)) {
        subj = byNameLower.get(k)
        break
      }
    }
    if (!subj) continue
    await addDoc(collection(db, 'items'), {
      name: def.name,
      description: def.description,
      category: 'subject_badge',
      rarity: 'legendary',
      price: def.price ?? SUBJECT_BADGE_PRICE,
      /**
       * {@code coinKind} = 'subject_earned' makes {@link purchaseItem} bill the badge against
       * coins earned from this subject only. Omitted / 'coins' = normal wallet.
       */
      coinKind: SUBJECT_BADGE_COIN_KIND,
      subjectId: subj.id,
      subjectName: subj.name,
      badgeEmoji: def.emoji,
      badgeSpriteIndex: typeof def.spriteIndex === 'number' ? def.spriteIndex : null,
      active: true,
      stock: null,
      isLimited: false,
      createdAt: new Date(),
    })
    added++
  }
  return { added, skipped: SUBJECT_BADGE_DEFS.length - added }
}

export async function seedShopItems() {
  const snap = await getDocs(collection(db, 'items'))
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)))

  const results = await Promise.all(
    SEED_ITEMS.map(item => addDoc(collection(db, 'items'), {
      ...item,
      skinUrl:   item.skinUrl   ?? null,
      isLimited: item.isLimited || false,
      season:    item.season    || null,
      createdAt: new Date(),
    }))
  )
  return results.length
}

export async function seedAchievements() {
  const snap = await getDocs(collection(db, 'achievements'))
  await Promise.all(snap.docs.map(d => deleteDoc(d.ref)))

  const results = await Promise.all(
    SEED_ACHIEVEMENTS.map(ach => addDoc(collection(db, 'achievements'), ach))
  )
  return results.length
}

export async function seedSubjects() {
  const snap = await getDocs(collection(db, 'subjects'))
  const existing = new Set(snap.docs.map(d => d.data().name?.trim().toLowerCase()))

  const toAdd = SEED_SUBJECTS.filter(name => !existing.has(name.trim().toLowerCase()))

  await Promise.all(
    toAdd.map(name =>
      addDoc(collection(db, 'subjects'), {
        name,
        icon: getSubjectIcon(name),
        createdAt: new Date(),
      })
    )
  )
  return { added: toAdd.length, skipped: SEED_SUBJECTS.length - toAdd.length }
}

/**
 * Upload PNG skins to Storage and upsert shop items (admin file picker).
 * Matches files to SEED_SKINS by exact file name (case-sensitive as in list).
 * @param {File[] | FileList} files
 */
export async function seedSkinsFromFiles(files) {
  const list = Array.from(files || []).filter((f) => /\.png$/i.test(f.name))
  if (!list.length) return { added: 0, updated: 0, skipped: 0 }

  const urlByFile = {}
  for (const file of list) {
    urlByFile[file.name] = await uploadSkinTextureFile(file.name, file)
  }

  const snap = await getDocs(collection(db, 'items'))
  const existingDocs = snap.docs.map(d => ({ id: d.id, ...d.data() }))
  const byName = new Map(existingDocs.map(d => [d.name?.trim().toLowerCase(), d]))

  const toAdd = []
  const toUpdate = []

  for (const s of SEED_SKINS) {
    const newUrl = urlByFile[s.file] ?? null
    if (!newUrl) continue
    const found = byName.get(s.name.trim().toLowerCase())

    if (!found) {
      toAdd.push({ ...s, skinUrl: newUrl })
    } else if (found.skinUrl !== newUrl) {
      toUpdate.push({ id: found.id, skinUrl: newUrl })
    }
  }

  await Promise.all([
    ...toAdd.map((s) =>
      addDoc(collection(db, 'items'), {
        name: s.name,
        description: s.description,
        category: 'skin',
        rarity: s.rarity,
        price: { common: 100, rare: 300, epic: 600, legendary: 1200 }[s.rarity],
        skinUrl: s.skinUrl,
        skinId: null,
        isLimited: false,
        stock: null,
        active: true,
        createdAt: new Date(),
      }),
    ),
    ...toUpdate.map(({ id, skinUrl }) => updateDoc(doc(db, 'items', id), { skinUrl })),
  ])

  const notInCatalog = list.filter((f) => !SEED_SKINS.some((s) => s.file === f.name)).length
  return {
    added: toAdd.length,
    updated: toUpdate.length,
    notInCatalog,
    uploaded: list.length,
  }
}

/** @deprecated Use seedSkinsFromFiles with a multi-file PNG picker. */
export async function seedSkins() {
  return { added: 0, updated: 0, skipped: 0, uploaded: 0 }
}

const BW_TIER_SHOP = {
  Wooden: { price: 0, rarity: 'common' },
  Stone: { price: 18, rarity: 'common' },
  Iron: { price: 55, rarity: 'rare' },
  Golden: { price: 140, rarity: 'epic' },
  Diamond: { price: 320, rarity: 'epic' },
  Netherite: { price: 520, rarity: 'legendary' },
}

function blockWorldToolShopLabel(meshName) {
  return meshName.replace(/_/g, ' ')
}

function buildBlockWorldToolShopRows() {
  return ALL_TOOL_MESH_NAMES.filter((name) => name !== 'Iron_Pickaxe').map((meshName) => {
    const p = parseToolMeshBaseName(meshName)
    const tr = p ? BW_TIER_SHOP[p.tier] : { price: 50, rarity: 'rare' }
    return {
      bwSeedKey: `fus_bw_tool_${meshName}`,
      name: blockWorldToolShopLabel(meshName),
      description: `Інструмент для спільного світу (${meshName.replace(/_/g, ' ')}).`,
      category: 'block_world',
      rarity: tr.rarity,
      price: tr.price,
      blockWorld: defaultBlockWorldToolDoc(meshName),
    }
  })
}

/**
 * Shared voxel world goods (`category: block_world`, `blockWorld` meta).
 * Synced by {@link seedBlockWorldShopItems} (add + update by stable `bwSeedKey`).
 */
export const BLOCK_WORLD_SHOP_ITEM_SEEDS = [
  {
    bwSeedKey: 'fus_bw_pick',
    name: 'Кайло',
    description:
      'Швидше ламає блоки. У спільному світі можна завдавати урон іншим гравцям (як у стандартного кайла).',
    category: 'block_world',
    rarity: 'common',
    price: 0,
    blockWorld: defaultBlockWorldToolDoc('Iron_Pickaxe'),
  },
  {
    bwSeedKey: 'fus_bw_block_grass',
    name: 'Трава',
    description: 'Блок для будівництва у спільному світі.',
    category: 'block_world',
    rarity: 'common',
    price: 0,
    blockWorld: { kind: 'block', blockType: 0 },
  },
  {
    bwSeedKey: 'fus_bw_block_sand',
    name: 'Пісок',
    description: 'Пісчаний блок для будівництва.',
    category: 'block_world',
    rarity: 'common',
    price: 6,
    blockWorld: { kind: 'block', blockType: 1 },
  },
  {
    bwSeedKey: 'fus_bw_block_leaf',
    name: 'Листя',
    description: 'Зелений декоративний блок.',
    category: 'block_world',
    rarity: 'common',
    price: 8,
    blockWorld: { kind: 'block', blockType: 3 },
  },
  {
    bwSeedKey: 'fus_bw_block_dirt',
    name: 'Земля',
    description: 'Звичайний ґрунт для будівництва.',
    category: 'block_world',
    rarity: 'common',
    price: 5,
    blockWorld: { kind: 'block', blockType: 4 },
  },
  {
    bwSeedKey: 'fus_bw_block_stone',
    name: 'Камінь',
    description: 'Міцний будівельний блок.',
    category: 'block_world',
    rarity: 'common',
    price: 15,
    blockWorld: { kind: 'block', blockType: 5 },
  },
  {
    bwSeedKey: 'fus_bw_block_coal',
    name: 'Вугільна руда',
    description: 'Темний декоративний блок.',
    category: 'block_world',
    rarity: 'common',
    price: 14,
    blockWorld: { kind: 'block', blockType: 6 },
  },
  {
    bwSeedKey: 'fus_bw_block_wood',
    name: 'Деревина',
    description: 'Блок дерева для будівництва.',
    category: 'block_world',
    rarity: 'common',
    price: 10,
    blockWorld: { kind: 'block', blockType: 7 },
  },
  {
    bwSeedKey: 'fus_bw_block_tree',
    name: 'Колода',
    description: 'Текстура стовбура дерева.',
    category: 'block_world',
    rarity: 'common',
    price: 12,
    blockWorld: { kind: 'block', blockType: 2 },
  },
  {
    bwSeedKey: 'fus_bw_block_glass',
    name: 'Скло',
    description: 'Прозорий будівельний блок.',
    category: 'block_world',
    rarity: 'rare',
    price: 40,
    blockWorld: { kind: 'block', blockType: 10 },
  },
  {
    bwSeedKey: 'fus_bw_block_quartz',
    name: 'Кварц',
    description: 'Світлий декоративний блок.',
    category: 'block_world',
    rarity: 'rare',
    price: 55,
    blockWorld: { kind: 'block', blockType: 9 },
  },
  {
    bwSeedKey: 'fus_bw_block_diamond',
    name: 'Алмазний блок',
    description: 'Дуже міцний декоративний блок.',
    category: 'block_world',
    rarity: 'epic',
    price: 200,
    blockWorld: { kind: 'block', blockType: 8 },
  },
  {
    /**
     * Indestructible — shop-exclusive, obsidian look (engine id 21). Cannot be broken;
     * see {@link BlockIndestructible} / red tint in world.
     */
    bwSeedKey: 'fus_bw_block_indestructible',
    name: 'Незламний обсидіан',
    description:
      'Виглядає як обсидіан, неможливо зламати жодним інструментом. Купується лише в магазині. Золоту руду (у світі) добувай кайлом — з неї падають монети.',
    category: 'block_world',
    rarity: 'legendary',
    price: 500,
    blockWorld: { kind: 'block', blockType: 13 },
  },
  ...buildBlockWorldToolShopRows(),
]

/**
 * Adds missing `block_world` shop rows and **updates** existing ones with the same `bwSeedKey`
 * (name, description, price, rarity, `blockWorld`) so catalog changes / new atlas ship after re-seed.
 */
export async function seedBlockWorldShopItems() {
  const snap = await getDocs(collection(db, 'items'))
  const refByBwKey = new Map()
  for (const d of snap.docs) {
    const k = d.data().bwSeedKey
    if (k) refByBwKey.set(k, d.ref)
  }
  let added = 0
  let updated = 0
  for (const row of BLOCK_WORLD_SHOP_ITEM_SEEDS) {
    const existing = refByBwKey.get(row.bwSeedKey)
    if (existing) {
      await updateDoc(existing, {
        name: row.name,
        description: row.description,
        category: row.category,
        rarity: row.rarity,
        price: row.price,
        blockWorld: row.blockWorld,
        bwSeedKey: row.bwSeedKey,
        skinUrl: null,
        skinId: null,
        isLimited: false,
        stock: null,
        active: true,
      })
      updated++
    } else {
      await addDoc(collection(db, 'items'), {
        ...row,
        skinUrl: null,
        skinId: null,
        isLimited: false,
        stock: null,
        active: true,
        createdAt: new Date(),
      })
      added++
    }
  }
  return { added, updated, total: BLOCK_WORLD_SHOP_ITEM_SEEDS.length }
}

/**
 * Idempotent upsert for the mystery-box catalog.
 * Matches existing Firestore rows by {@code mbSeedKey} (falls back to legacy
 * category+rarity rows without a key so pre-keyed data still gets promoted
 * instead of duplicated). Missing rows are inserted. Returns running totals
 * mirroring {@link seedBlockWorldShopItems} for consistent admin toasts.
 */
export async function seedMysteryBoxes() {
  const snap = await getDocs(collection(db, 'items'))
  const byKey = new Map()
  /** Legacy keyless rows (pre-mbSeedKey era) — promote on first seed. */
  const byCatRarity = new Map()
  for (const d of snap.docs) {
    const data = d.data() || {}
    if (data.mbSeedKey) {
      byKey.set(data.mbSeedKey, d.ref)
    } else if (data.category === 'mystery_box') {
      byCatRarity.set(`${data.category}:${data.rarity || 'common'}`, d.ref)
    }
  }
  let added = 0
  let updated = 0
  for (const row of MYSTERY_BOX_SEEDS) {
    const existing =
      byKey.get(row.mbSeedKey) ||
      byCatRarity.get(`${row.category}:${row.rarity}`)
    const payload = {
      name: row.name,
      description: row.description,
      category: row.category,
      rarity: row.rarity,
      price: row.price,
      mbSeedKey: row.mbSeedKey,
      stock: row.stock ?? null,
      isLimited: !!row.isLimited,
      active: true,
    }
    if (existing) {
      await updateDoc(existing, payload)
      updated++
    } else {
      await addDoc(collection(db, 'items'), { ...payload, createdAt: new Date() })
      added++
    }
  }
  return { added, updated, total: MYSTERY_BOX_SEEDS.length }
}

export async function runFullSeed() {
  const itemsBase = await seedShopItems()
  const [{ added: bwAdded }, achs] = await Promise.all([
    seedBlockWorldShopItems(),
    seedAchievements(),
  ])
  return { items: itemsBase + bwAdded, achievements: achs }
}
