#!/usr/bin/env node
/**
 * Генератор dev-фикстур локаций для Stage 1 (промпт 1.4).
 *
 * ЗАЧЕМ: bootstrap'у dev-сессии нужны валидные LocationDefinition, чтобы состояние мира
 * имело реальную структуру с первого дня. Это НЕ конвертация мира v1 — она делается в
 * промпте 2.x (tools/inspect-v1-rooms.mjs уже проверяет исходники, 62 из 77 событий
 * требуют поправок K1–K16). Здесь — три комнаты-заглушки с origin='v3-fixture',
 * повторяющие ТОПОЛОГИЮ настоящих (floor0_airlock → floor-1_lobby → floor-1_reception),
 * чтобы переходы и описания в Stage 1 были осмысленными.
 *
 * Идентификаторы детерминированы: uuid5-подобный из sha256(slug). Поэтому повторный запуск
 * генератора даёт байт-в-байт тот же файл, а сидинг БД идемпотентен.
 *
 * Запуск: npm run gen:fixtures
 * Проверка: файл парсится LocationDefinitionSchema (тест tests/integration/persistence.test.ts).
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'tools', 'fixtures', 'locations.stage1.json');
const REMAP_OUT = join(ROOT, 'tools', 'fixtures', 'remap.stage1.json');

/** Детерминированный UUID v4-подобный из строки (стабильность между запусками и машинами). */
function stableUuid(seed) {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32);
  const chars = hex.split('');
  chars[12] = '4'; // version 4
  chars[16] = '8'; // variant 10xx
  const h = chars.join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

const locationId = (slug) => stableUuid(`loc:${slug}`);
const objectId = (slug, name) => stableUuid(`obj:${slug}:${name}`);

/** Фабрика объекта локации (контракт LocationObjectSchema). */
function obj(slug, name, description, { interactive = true, takeable = false } = {}) {
  return {
    objectId: objectId(slug, name),
    name,
    description,
    interactive,
    takeable,
    itemMeta: null,
    source: 'derived',
  };
}

const SLUGS = {
  airlock: 'floor0_airlock',
  lobby: 'floor-1_lobby',
  reception: 'floor-1_reception',
};

const locations = [
  {
    locationId: locationId(SLUGS.airlock),
    sessionId: null,
    templateSlug: SLUGS.airlock,
    name: 'Шлюз',
    description:
      'Тесный тамбур с двумя дверями: наружная ведёт на поверхность, внутренняя — вниз, к этажу минус первому. ' +
      'Лампа над внутренней дверью мигает в такт чьему-то дыханию.',
    atmosphere: 'Холодный металл, запах озона, гул вентиляции.',
    objects: [
      obj(SLUGS.airlock, 'Наружная дверь', 'Массивная дверь с ручным запором. Запор не до конца освобождён.'),
      obj(SLUGS.airlock, 'Панель шлюза', 'Панель управления циклом шлюзования. Индикатор цикла горит красным.', {
        interactive: true,
      }),
      obj(SLUGS.airlock, 'Брелок доступа', 'Пластиковый брелок с трещиной. На обороте выцарапана цифра 4.', {
        takeable: true,
      }),
    ],
    exits: [
      {
        kind: 'LOCATION',
        toLocationId: locationId(SLUGS.lobby),
        label: 'Лестница на этаж −1',
        description: 'Узкий лестничный пролёт уходит вниз, в темноту.',
        oneWay: false,
        hidden: false,
        via: 'stairs',
        locked: false,
        lock: { type: null, keyRequired: null, requiresFlag: null, reason: null },
      },
      {
        kind: 'DESCRIPTIVE',
        toLocationId: null,
        label: 'Наружная дверь',
        description: 'Ведёт на поверхность. Запор не до конца освобождён.',
        oneWay: true,
        hidden: false,
        via: 'hatch',
        locked: true,
        lock: {
          type: 'condition',
          keyRequired: null,
          requiresFlag: 'floor0_airlock.hatch_unlocked',
          reason: 'Запор не освобождён',
        },
      },
    ],
    hazards: [{ kind: 'DARKNESS', requiresLight: true }],
    registeredEventIds: [],
    narrativeNotes:
      'Стартовая точка. Группа приходит в себя здесь; наружная дверь закрыта до выполнения условия шлюза. ' +
      'Фикстура Stage 1 — топология соответствует v1, содержимое упрощено.',
    aiGuidance: null,
    gmSecret: null,
    tags: ['start', 'floor0'],
    meta: {
      floor: 0,
      indexOnFloor: 0,
      floorName: 'Этаж 0',
      batch: 0,
      origin: 'v3-fixture',
      atmosphereParts: null,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    locationId: locationId(SLUGS.lobby),
    sessionId: null,
    templateSlug: SLUGS.lobby,
    name: 'Холл',
    description:
      'Просторный холл этажа минус один. Стойка с выцветшей табличкой, ряды кресел, из которых убрали мягкую часть. ' +
      'На стене — часы, которые идут.',
    atmosphere: 'Пыль в лучах аварийного освещения, скрип кресел, тиканье.',
    objects: [
      obj(SLUGS.lobby, 'Часы на стене', 'Круглые часы с треснувшим стеклом. Идут, хотя питания нет.'),
      obj(SLUGS.lobby, 'Кресла', 'Ряд кресел без обивки. Под одним что-то блеснуло.'),
      obj(SLUGS.lobby, 'Жетон', 'Металлический жетон с номером и логотипом учреждения.', { takeable: true }),
    ],
    exits: [
      {
        kind: 'LOCATION',
        toLocationId: locationId(SLUGS.airlock),
        label: 'Лестница наверх',
        description: 'Пролёт, ведущий к шлюзу.',
        oneWay: false,
        hidden: false,
        via: 'stairs',
        locked: false,
        lock: { type: null, keyRequired: null, requiresFlag: null, reason: null },
      },
      {
        kind: 'LOCATION',
        toLocationId: locationId(SLUGS.reception),
        label: 'Дверь в регистратуру',
        description: 'Дверь с матовым стеклом и надписью «Регистратура».',
        oneWay: false,
        hidden: false,
        via: 'door',
        locked: false,
        lock: { type: null, keyRequired: null, requiresFlag: null, reason: null },
      },
    ],
    hazards: [],
    registeredEventIds: [],
    narrativeNotes:
      'Узел первого этажа: отсюда видны оба направления. Часы — намеренная аномалия для проверки inspect_object. ' +
      'Фикстура Stage 1.',
    aiGuidance: null,
    gmSecret: null,
    tags: ['hub', 'floor-1'],
    meta: {
      floor: -1,
      indexOnFloor: 0,
      floorName: 'Этаж −1',
      batch: 0,
      origin: 'v3-fixture',
      atmosphereParts: null,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
  {
    locationId: locationId(SLUGS.reception),
    sessionId: null,
    templateSlug: SLUGS.reception,
    name: 'Регистратура',
    description:
      'Кабинет регистратуры: стойка, ящики с карточками, телефон с обрезанным проводом. ' +
      'На стойке — журнал посещений, открытый на вчерашней дате.',
    atmosphere: 'Запах бумаги и дезинфектанта, тишина, которую слышно.',
    objects: [
      obj(SLUGS.reception, 'Журнал посещений', 'Журнал открыт на последней записи. Дата — вчерашняя.'),
      obj(SLUGS.reception, 'Ящик с карточками', 'Каталожный ящик. Часть карточек вынута, часть помечена красным.'),
      obj(SLUGS.reception, 'Ключ от кабинета', 'Тяжёлый ключ с биркой «−1/каб.3».', { takeable: true }),
    ],
    exits: [
      {
        kind: 'LOCATION',
        toLocationId: locationId(SLUGS.lobby),
        label: 'Дверь в холл',
        description: 'Дверь с матовым стеклом, ведущая обратно в холл.',
        oneWay: false,
        hidden: false,
        via: 'door',
        locked: false,
        lock: { type: null, keyRequired: null, requiresFlag: null, reason: null },
      },
    ],
    hazards: [],
    registeredEventIds: [],
    narrativeNotes:
      'Комната с «документальными» уликами: журнал и карточки дают знания (GRANT_KNOWLEDGE), а не предметы. ' +
      'Фикстура Stage 1.',
    aiGuidance: null,
    gmSecret: null,
    tags: ['evidence', 'floor-1'],
    meta: {
      floor: -1,
      indexOnFloor: 1,
      floorName: 'Этаж −1',
      batch: 0,
      origin: 'v3-fixture',
      atmosphereParts: null,
    },
    updatedAt: '2026-01-01T00:00:00.000Z',
  },
];

const pack = {
  $comment: 'Dev-фикстуры Stage 1 (промпт 1.4). НЕ конвертация мира v1 — она в промпте 2.x.',
  packId: 'stage1-dev',
  version: '0.1.0',
  generatedBy: 'tools/gen-location-fixtures.mjs',
  startLocationId: locationId(SLUGS.airlock),
  locations,
};

/**
 * Remap slug → UUID (промпт 1.6, D221; образец — remap из instantiateWorldPack,
 * аудит §8.7): таблица соответствия детерминированных идентификаторов фикстур
 * их slug'ам. В 1.7 отсюда берётся eventId для ScriptedAI, в Stage 2 — шаблон
 * формата remap для настоящей инстанциации world-pack.
 */
const remap = {
  $comment: 'Сгенерировано tools/gen-location-fixtures.mjs; не редактировать вручную.',
  packId: pack.packId,
  version: pack.version,
  startLocationId: pack.startLocationId,
  locations: Object.fromEntries(locations.map((l) => [l.templateSlug, l.locationId])),
  objects: Object.fromEntries(
    locations.flatMap((l) => l.objects.map((o) => [`${l.templateSlug}/${o.name}`, o.objectId])),
  ),
  events: {},
};

mkdirSync(dirname(OUT), { recursive: true });
// Форматирование prettier (корневой devDependency): повторный `npm run gen:fixtures`
// обязан давать lint-clean файл без ручного `prettier --write` (D204: файл коммитится).
const pretty = async (value) => {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  try {
    const { format } = await import('prettier');
    return await format(text, { parser: 'json' });
  } catch {
    return text; // без prettier (например, в CI без dev-зависимостей) — валидный JSON
  }
};
writeFileSync(OUT, await pretty(pack), 'utf8');
writeFileSync(REMAP_OUT, await pretty(remap), 'utf8');
process.stdout.write(
  `записано ${OUT}\n  локаций: ${locations.length}\n  объектов: ${locations.reduce((n, l) => n + l.objects.length, 0)}\n` +
    `  выходов: ${locations.reduce((n, l) => n + l.exits.length, 0)}\n  старт: ${pack.startLocationId}\n` +
    `записано ${REMAP_OUT} (slug → UUID)\n`,
);
