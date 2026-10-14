#!/usr/bin/env node
/**
 * tools/inspect-v1-rooms.mjs — анализ исходных данных мира (v1, schema_version 2.0)
 * и их соответствия моделям v3 (LocationDefinition / WorldEvent / DSL).
 *
 * Зачем: контент получен от заказчика (D158) ДО того, как написаны контракты (промпт 1.2)
 * и конвертер world-pack (промпт 2.3). Этот инструмент — единственная автоматическая
 * проверка реальных данных; он же станет основой валидатора конвертера.
 *
 * Запуск:
 *   node tools/inspect-v1-rooms.mjs           # отчёт
 *   node tools/inspect-v1-rooms.mjs --json    # машинный вывод (для CI)
 *
 * Код возврата: 1 при наличии ошибок уровня ERROR (данные непригодны к конвертации),
 * 0 — если есть только предупреждения.
 *
 * Без зависимостей: намеренно не использует zod/@mnemosin/contracts, чтобы работать
 * до промпта 1.2 и в CI без установки пакетов.
 */

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = resolve(ROOT, 'content/source-v1');
const ROOMS = join(SRC, 'rooms');
const AS_JSON = process.argv.includes('--json');

/** Ограничения v3-контрактов, с которыми сверяются реальные данные. */
const V3_LIMITS = {
  exitLabelMax: 60, // ExitSchema.label — v3 §II.8
  locationNameMax: 80,
  locationDescriptionMax: 2000,
  atmosphereMax: 1000, // v3 §II.8 давал 500; поднято поправкой K8 (Регистратура — 564)
  objectNameMax: 80,
  hazardItemMax: 200,
  flagKeyPattern: /^[a-zA-Z0-9_.:-]{1,80}$/, // см. CONTENT_MAPPING §3, поправка K5
};

/** Что покрывает DSL v3 (§III.4) и как маппятся типы v1 (см. docs/CONTENT_MAPPING.md §2). */
const TRIGGER_MAP = {
  enter_room: { v3: 'ENTER_ROOM', status: 'ok', note: 'first_time → условие FIRST_TIME{scope:LOCATION,entityId}' },
  interact: { v3: 'OBJECT_USED', status: 'ok', note: 'intent=USE' },
  inspect_object: { v3: null, status: 'gap', note: 'в v3 нет триггера осмотра — нужен OBJECT_INSPECTED (K1)' },
  attempt_interaction: {
    v3: null,
    status: 'gap',
    note: 'нужен ATTEMPT_INTERACTION (K2, D184): в данных два имени поля (targets/object_ids), пустой список допустим, interaction_types — словарь контента (force, bruteforce, shout, hack, call_elevator, return_to_surface)',
  },
  compound_player_action: {
    v3: null,
    status: 'gap',
    note: 'в v3 нет составного триггера по нескольким действиям — нужен COMPOUND_ACTION + распознавание (K3)',
  },
  object_changed: {
    v3: null,
    status: 'gap',
    note: 'в v3 нет триггера изменения состояния объекта — нужен OBJECT_CHANGED (K14)',
  },
  object_unlocked: {
    v3: null,
    status: 'gap',
    note: 'в v3 нет триггера отпирания — нужен OBJECT_UNLOCKED (K14)',
  },
  take_item: {
    v3: null,
    status: 'gap',
    note: 'в v3 нет триггера взятия предмета (предметы вне Core, K12) — нужен ITEM_TAKEN (K14)',
  },
  turn_committed: { v3: 'TURN_COMMITTED', status: 'ok', note: '' },
  flag_set: { v3: 'FLAG_SET', status: 'ok', note: '' },
  manual: { v3: 'MANUAL', status: 'ok', note: '' },
};

const CONDITION_MAP = {
  state_is: { v3: 'EQ', status: 'ok', note: 'путь v1 локальный → требуется namespace (K5)' },
  has_flag: { v3: 'HAS_FLAG', status: 'ok', note: '' },
  and: { v3: 'AND', status: 'ok', note: '' },
  or: { v3: 'OR', status: 'ok', note: '' },
  not: { v3: 'NOT', status: 'ok', note: '' },
  player_knows: { v3: 'PLAYER_KNOWS', status: 'ok', note: '' },
  first_time: { v3: 'FIRST_TIME', status: 'ok', note: '' },
};

const EFFECT_MAP = {
  set_flag: { v3: 'SET_FLAG', status: 'ok', note: '' },
  narrative_marker: { v3: 'EMIT_NARRATIVE', status: 'ok', note: 'visibility=PUBLIC' },
  move_group: {
    v3: 'TELEPORT',
    status: 'partial',
    note: 'v3 требует playerIds, в v1 перемещается вся группа — нужен TELEPORT_ALL или подстановка группы (K4)',
  },
  change_object_state: { v3: 'CHANGE_OBJECT_STATE', status: 'ok', note: '' },
  grant_knowledge: { v3: 'GRANT_KNOWLEDGE', status: 'ok', note: '' },
  request_media: { v3: 'REQUEST_MEDIA', status: 'ok', note: '' },
  reach_ending: { v3: 'REACH_ENDING', status: 'ok', note: '' },
  reveal_object: {
    v3: null,
    status: 'gap',
    note: 'в v3 нет эффекта раскрытия объекта (visible false→true) — нужен REVEAL_OBJECT (K15)',
  },
  give_item: { v3: null, status: 'gap', note: 'предметы вне Core (K12) — нужен GIVE_ITEM (K15)' },
};

// Подписи выходов — в tools/lib/exit-label.mjs (общий модуль с contract-тестом).
export { deriveExitLabel, toAccusative, VIA_LABEL } from './lib/exit-label.mjs';
import { deriveExitLabel } from './lib/exit-label.mjs';

const REQUIRED_ROOM_FIELDS = [
  'schema_version',
  'room_id',
  'floor',
  'title',
  'role',
  'exits',
  'atmosphere',
  'base_description',
  'objects',
  'items',
  'lore',
  'hazards',
  'actors',
  'state',
  'events',
  'ai_guidance',
  'meta',
];

const report = { generatedAt: new Date().toISOString(), source: SRC, errors: [], warnings: [], notes: [], stats: {} };
const error = (where, code, message) => report.errors.push({ where, code, message });
const warn = (where, code, message) => report.warnings.push({ where, code, message });
const note = (where, code, message) => report.notes.push({ where, code, message });

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

// ---------------------------------------------------------------- реестр и карта

const registry = existsSync(join(SRC, '_registry.json')) ? readJson(join(SRC, '_registry.json')) : [];
const registryIds = new Set(registry.map((r) => r.room_id));
const adjacency = existsSync(join(SRC, '_adjacency.json')) ? readJson(join(SRC, '_adjacency.json')) : null;

report.stats.registry = {
  rooms: registry.length,
  floors: [...new Set(registry.map((r) => r.floor))].sort((a, b) => b - a),
  batches: [...new Set(registry.map((r) => r.batch))].sort((a, b) => a - b),
};

if (adjacency) {
  const edges = adjacency.edges ?? [];
  const descriptive = edges.filter((e) => !registryIds.has(e.to) || !registryIds.has(e.from));
  report.stats.adjacency = {
    edges: edges.length,
    unresolved: (adjacency.unresolved ?? []).length,
    descriptiveExits: descriptive.map((e) => ({ id: e.id, from: e.from, to: e.to })),
  };
  for (const u of adjacency.unresolved ?? []) {
    note('_adjacency.json', 'ADJ_UNRESOLVED', `${u.id} · ${u.topic} — ${u.note}`);
  }
  for (const e of descriptive) {
    warn(
      `_adjacency.json:${e.id}`,
      'EXIT_TO_NON_ROOM',
      `ребро ведёт вне реестра: ${e.from} → ${e.to} (${e.note ?? 'без пояснения'}). ` +
        `v3 ExitSchema требует toLocationId — нужно расширение (K6: kind='DESCRIPTIVE', toLocationId=null)`,
    );
  }
}

// ---------------------------------------------------------------- комнаты

const roomFiles = existsSync(ROOMS)
  ? readdirSync(ROOMS)
      .filter((f) => f.endsWith('.json') && !f.endsWith('.gm.json'))
      .sort()
  : [];

const triggerTypes = new Map();
const conditionTypes = new Map();
const effectTypes = new Map();
const guidanceKeys = new Set();
const rooms = [];

for (const file of roomFiles) {
  const path = join(ROOMS, file);
  const where = `rooms/${file}`;
  let room;
  try {
    room = readJson(path);
  } catch (cause) {
    error(where, 'JSON_PARSE', cause.message);
    continue;
  }

  const roomId = room.room_id;
  const summary = {
    file,
    room_id: roomId,
    floor: room.floor,
    title: room.title,
    exits: (room.exits ?? []).length,
    objects: (room.objects ?? []).length,
    items: (room.items ?? []).length,
    events: (room.events ?? []).length,
    hasGmFile: existsSync(join(ROOMS, file.replace(/\.json$/, '.gm.json'))),
    issues: [],
  };

  // --- обязательные поля и версия схемы
  if (room.schema_version !== '2.0') {
    error(where, 'SCHEMA_VERSION', `ожидается "2.0", получено ${JSON.stringify(room.schema_version)}`);
  }
  for (const field of REQUIRED_ROOM_FIELDS) {
    if (!(field in room)) error(where, 'MISSING_FIELD', `нет обязательного поля "${field}"`);
  }
  if (roomId !== file.replace(/\.json$/, '')) {
    error(where, 'ID_FILENAME_MISMATCH', `room_id "${roomId}" ≠ имя файла "${file}"`);
  }
  if (!registryIds.has(roomId)) error(where, 'NOT_IN_REGISTRY', `room_id "${roomId}" отсутствует в _registry.json`);

  // --- пустые поля, которые v3 считает содержательными
  if (typeof room.base_description === 'string' && room.base_description.trim() === '') {
    // D176 (закрыт Q9): описание берётся из lore.public_revelation.text_snippet.
    const snippet = room.lore?.public_revelation?.text_snippet ?? '';
    if (typeof snippet === 'string' && snippet.trim().length > 0) {
      summary.descriptionSource = 'lore.public_revelation.text_snippet';
      summary.descriptionChars = snippet.length;
      note(
        where,
        'DESCRIPTION_FROM_SNIPPET',
        `base_description пуст → description берётся из lore.public_revelation.text_snippet ` +
          `(${snippet.length} симв., лимит ${V3_LIMITS.locationDescriptionMax}) — D176`,
      );
      if (snippet.length > V3_LIMITS.locationDescriptionMax) {
        error(where, 'DESCRIPTION_TOO_LONG', `text_snippet ${snippet.length} > ${V3_LIMITS.locationDescriptionMax}`);
      }
    } else {
      error(
        where,
        'NO_DESCRIPTION_SOURCE',
        'base_description пуст и lore.public_revelation.text_snippet пуст — описание не из чего взять',
      );
    }
  } else {
    summary.descriptionSource = 'base_description';
    summary.descriptionChars = (room.base_description ?? '').length;
  }
  if ((room.objects ?? []).length === 0) {
    warn(where, 'NO_OBJECTS', 'objects[] пуст — v3 objectStates/интерактив не на что опереть (вопрос Q10)');
  }
  if ((room.title ?? '').length > V3_LIMITS.locationNameMax) {
    error(where, 'NAME_TOO_LONG', `title длиннее ${V3_LIMITS.locationNameMax} символов`);
  }

  // --- атмосфера: v1 структурная (5 полей), v3 — строка ≤ 500
  const atm = room.atmosphere ?? {};
  const atmKeys = Object.keys(atm);
  if (atmKeys.length > 0) {
    const flat = atmKeys.map((k) => `${k}: ${atm[k]}`).join('; ');
    note(
      where,
      'ATMOSPHERE_STRUCTURED',
      `v1 atmosphere{${atmKeys.join(',')}} → v3 строка (${flat.length} симв., лимит ${V3_LIMITS.atmosphereMax}) — поправка K8`,
    );
    if (flat.length > V3_LIMITS.atmosphereMax)
      error(where, 'ATMOSPHERE_TOO_LONG', `склеенная атмосфера ${flat.length} > ${V3_LIMITS.atmosphereMax}`);
  }

  // --- hazards: v1 объект с типизированными полями, v3 — string[]
  const hz = room.hazards ?? {};
  if (Object.keys(hz).length > 0) {
    note(where, 'HAZARDS_STRUCTURED', `v1 hazards{${Object.keys(hz).join(',')}} → v3 string[] — поправка K9`);
  }

  // --- exits
  const declaredObjects = new Set((room.objects ?? []).map((o) => o.id ?? o.object_id ?? o.objectId));
  const derivedLabels = [];
  for (const [i, exit_] of (room.exits ?? []).entries()) {
    const label = exit_.direction ?? '';
    const targetTitle = registry.find((r) => r.room_id === exit_.target_room_id)?.title ?? null;
    derivedLabels.push({
      exit: i,
      to: exit_.target_room_id,
      via: exit_.via ?? null,
      ...deriveExitLabel(exit_, targetTitle),
      descriptionChars: label.length,
    });
    if (label.length > V3_LIMITS.exitLabelMax) {
      warn(
        `${where}:exits[${i}]`,
        'EXIT_LABEL_TOO_LONG',
        `direction ${label.length} симв. > v3 label.max(${V3_LIMITS.exitLabelMax}) — нужен label + description (K6)`,
      );
      summary.issues.push('EXIT_LABEL_TOO_LONG');
    }
    if (!registryIds.has(exit_.target_room_id)) {
      warn(
        `${where}:exits[${i}]`,
        'EXIT_TARGET_NOT_IN_REGISTRY',
        `target_room_id "${exit_.target_room_id}" не в реестре (описательный выход) — K6`,
      );
      summary.issues.push('EXIT_TARGET_NOT_IN_REGISTRY');
    }
    for (const field of ['via', 'one_way', 'hidden', 'lock_type', 'key_required', 'requires_flag']) {
      if (field in exit_ && !['locked', 'lockReason', 'label', 'toLocationId'].includes(field)) {
        // фиксируем один раз на комнату, а не на каждый выход
        summary.exitExtraFields = [...new Set([...(summary.exitExtraFields ?? []), field])];
      }
    }
  }
  summary.derivedExitLabels = derivedLabels;
  if (summary.exitExtraFields?.length) {
    note(
      where,
      'EXIT_FIELDS_LOST',
      `поля выходов v1 не представлены в v3 ExitSchema: ${summary.exitExtraFields.join(', ')} — поправка K6`,
    );
  }

  // --- сверка exits с _adjacency.json (единый источник v1 D44)
  // ВАЖНО: ребро с one_way=false ДВУНАПРАВЛЕННОЕ (e02–e08 карты), поэтому допустимый
  // выход комнаты — это ребро из неё ИЛИ ребро в неё с one_way=false.
  if (adjacency) {
    const allowed = new Map(); // target → edge
    for (const e of adjacency.edges ?? []) {
      if (e.from === roomId) allowed.set(e.to, e);
      else if (e.to === roomId && e.one_way === false) allowed.set(e.from, e);
    }
    const exitTargets = new Set((room.exits ?? []).map((e) => e.target_room_id));

    for (const t of exitTargets) {
      if (allowed.has(t)) continue;
      const reverse = (adjacency.edges ?? []).find((e) => e.from === t && e.to === roomId);
      if (reverse && reverse.one_way === true) {
        error(
          where,
          'EXIT_CONTRADICTS_ONE_WAY',
          `в exits[] есть ${roomId} → ${t}, но ребро ${reverse.id} объявлено односторонним (${t} → ${roomId})`,
        );
      } else {
        error(
          where,
          'EXIT_NOT_IN_ADJACENCY',
          `в exits[] есть ${roomId} → ${t}, но в _adjacency.json ребра нет ни в одну сторону (D44: карта — единственный источник)`,
        );
      }
      summary.issues.push('EXIT_MISMATCH');
    }

    for (const [t, e] of allowed) {
      if (exitTargets.has(t) || !registryIds.has(t)) continue;
      warn(
        where,
        'EXIT_MISSING_FROM_ADJACENCY',
        `в _adjacency.json есть ребро ${e.id} (${roomId} ↔ ${t}, one_way=${e.one_way}), но в exits[] комнаты его нет`,
      );
      summary.issues.push('EXIT_MISSING_FROM_ADJACENCY');
    }
  }

  // --- events
  const eventIds = new Set();
  const initialFlags = new Set(Object.keys(room.state?.initial ?? {}));
  const persistentFlags = new Set(room.state?.persistent_story_flags ?? []);
  for (const [i, ev] of (room.events ?? []).entries()) {
    const evWhere = `${where}:events[${i}](${ev.id ?? '?'})`;
    if (!ev.id) error(evWhere, 'EVENT_NO_ID', 'событие без id');
    else if (eventIds.has(ev.id)) error(evWhere, 'EVENT_ID_DUP', `дубль id "${ev.id}"`);
    else eventIds.add(ev.id);

    const t = ev.trigger?.type;
    if (t) {
      triggerTypes.set(t, (triggerTypes.get(t) ?? 0) + 1);
      const mapped = TRIGGER_MAP[t];
      if (!mapped) error(evWhere, 'TRIGGER_UNKNOWN', `неизвестный тип триггера "${t}" — нет ни в v1-карте, ни в v3`);
      else if (mapped.status === 'gap') {
        warn(evWhere, 'TRIGGER_NOT_IN_V3', `${t}: ${mapped.note}`);
        summary.issues.push('TRIGGER_NOT_IN_V3');
      }
      // объекты, на которые ссылается триггер, должны быть объявлены
      const targets = [ev.trigger.target, ...(ev.trigger.targets ?? [])].filter((x) => typeof x === 'string');
      for (const target of targets) {
        if (declaredObjects.size > 0 && !declaredObjects.has(target)) {
          error(
            evWhere,
            'EVENT_TARGET_NOT_DECLARED',
            `триггер ссылается на объект "${target}", которого нет в objects[]`,
          );
        }
      }
      if (declaredObjects.size === 0 && targets.length > 0) {
        summary.undeclaredTargets = [...new Set([...(summary.undeclaredTargets ?? []), ...targets])];
      }
    }

    for (const c of ev.conditions ?? []) {
      conditionTypes.set(c.type, (conditionTypes.get(c.type) ?? 0) + 1);
      const mapped = CONDITION_MAP[c.type];
      if (!mapped) error(evWhere, 'CONDITION_UNKNOWN', `неизвестный тип условия "${c.type}"`);
      if (c.type === 'state_is' && typeof c.path === 'string') {
        if (!initialFlags.has(c.path) && !persistentFlags.has(c.path)) {
          warn(
            evWhere,
            'CONDITION_PATH_NOT_IN_STATE',
            `условие ссылается на флаг "${c.path}", которого нет в state.initial/persistent_story_flags`,
          );
        }
        if (!V3_LIMITS.flagKeyPattern.test(c.path)) {
          error(evWhere, 'FLAG_KEY_INVALID', `ключ флага "${c.path}" не соответствует шаблону v3`);
        }
      }
    }

    for (const e of ev.effects ?? []) {
      effectTypes.set(e.type, (effectTypes.get(e.type) ?? 0) + 1);
      const mapped = EFFECT_MAP[e.type];
      if (!mapped) error(evWhere, 'EFFECT_UNKNOWN', `неизвестный тип эффекта "${e.type}"`);
      else if (mapped.status === 'partial') warn(evWhere, 'EFFECT_PARTIAL_MAP', `${e.type}: ${mapped.note}`);
      if (e.type === 'set_flag' && e.flag) {
        if (!initialFlags.has(e.flag) && !persistentFlags.has(e.flag)) {
          warn(evWhere, 'SET_FLAG_NOT_DECLARED', `флаг "${e.flag}" не объявлен в state.initial/persistent_story_flags`);
        }
        if (!V3_LIMITS.flagKeyPattern.test(e.flag))
          error(evWhere, 'FLAG_KEY_INVALID', `ключ флага "${e.flag}" не соответствует шаблону v3`);
      }
      if (e.type === 'move_group' && e.target && !registryIds.has(e.target)) {
        error(evWhere, 'MOVE_TARGET_NOT_IN_REGISTRY', `move_group ведёт в "${e.target}", которого нет в реестре`);
      }
    }

    const g = ev.narrative_guidance ?? {};
    for (const k of Object.keys(g)) guidanceKeys.add(k);
    if (Object.keys(g).length > 0 && !('aiGuidance' in ev)) {
      // в v3 у WorldEvent нет поля для авторских указаний — см. K10
      summary.hasGuidance = true;
    }
    if (!('once' in ev))
      warn(evWhere, 'EVENT_NO_ONCE', 'нет поля once — v3 по умолчанию once=true (поведение изменится)');
  }
  if (summary.undeclaredTargets?.length) {
    // D172 (закрыт Q10): объекты заводятся конвертером из целей событий
    // с meta.source='derived' и черновым описанием на утверждение заказчику.
    warn(
      where,
      'OBJECTS_TO_DERIVE',
      `objects[] пуст, но события ссылаются на ${summary.undeclaredTargets.length} объект(а): ` +
        `${summary.undeclaredTargets.join(', ')} — конвертер создаст их как meta.source='derived' (D172), описания потребуют утверждения`,
    );
    summary.objectsToDerive = summary.undeclaredTargets;
  }
  if (summary.hasGuidance) {
    note(
      where,
      'EVENT_GUIDANCE_NO_V3_FIELD',
      'narrative_guidance событий некуда положить в v3 WorldEvent — поправка K10',
    );
  }

  // --- приватность: что в «публичном» файле v1 на самом деле не для игрока
  if (room.ai_guidance) {
    note(
      where,
      'AI_GUIDANCE_IN_PUBLIC_FILE',
      'ai_guidance лежит в публичном файле v1 (D59) и предназначен модели, не игроку — PublicLocationView обязан его отсекать (K11)',
    );
  }
  if (room.lore?.secret_truth) {
    const keys = Object.keys(room.lore.secret_truth);
    note(
      where,
      'SECRET_TRUTH_IN_PUBLIC_FILE',
      `lore.secret_truth{${keys.join(',')}} в публичном файле v1: restrictions/floor_truth идут модели, truth/future_connections — в .gm.json (K11)`,
    );
  }
  if (!summary.hasGmFile) {
    warn(where, 'NO_GM_FILE', 'нет парного .gm.json — GM-only сведения отсутствуют (для этой комнаты допустимо)');
  }
  if (room.actors && ((room.actors.enemies ?? []).length || (room.actors.npcs ?? []).length)) {
    note(where, 'ACTORS_NO_V3_FIELD', 'actors{enemies,npcs} не имеет аналога в v3 — нужен модуль или расширение (K12)');
  }
  if ((room.state?.initial ?? {}) && Object.keys(room.state.initial).length) {
    note(
      where,
      'ROOM_INITIAL_STATE',
      `state.initial (${Object.keys(room.state.initial).length} флагов) — в v3 нет стартового состояния локации, маппинг в storyFlags с namespace (K5)`,
    );
  }

  rooms.push(summary);
}

// ---------------------------------------------------------------- сводка

report.stats.roomsFound = roomFiles.length;
report.stats.roomsInRegistry = registry.length;
report.stats.roomsMissingFiles = registry.length - roomFiles.length;
report.stats.rooms = rooms;
report.stats.triggerTypes = Object.fromEntries([...triggerTypes].sort());
report.stats.conditionTypes = Object.fromEntries([...conditionTypes].sort());
report.stats.effectTypes = Object.fromEntries([...effectTypes].sort());
report.stats.guidanceKeys = [...guidanceKeys].sort();
report.stats.triggerCoverage = Object.fromEntries(
  [...triggerTypes.keys()].map((t) => [t, TRIGGER_MAP[t] ?? { v3: null, status: 'unknown' }]),
);
report.stats.conditionCoverage = Object.fromEntries(
  [...conditionTypes.keys()].map((c) => [c, CONDITION_MAP[c] ?? { v3: null, status: 'unknown' }]),
);
report.stats.effectCoverage = Object.fromEntries(
  [...effectTypes.keys()].map((e) => [e, EFFECT_MAP[e] ?? { v3: null, status: 'unknown' }]),
);
report.counts = { errors: report.errors.length, warnings: report.warnings.length, notes: report.notes.length };

if (AS_JSON) {
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
} else {
  const line = (s = '') => process.stdout.write(s + '\n');
  line('=== МНЕМОСИН · анализ исходных данных мира (v1 schema 2.0) ===');
  line(`каталог: ${SRC.replace(ROOT + '/', '')}`);
  line('');
  line(`Реестр:      ${report.stats.registry.rooms} комнат, этажи ${report.stats.registry.floors.join(', ')}`);
  line(
    `Карта:       ${adjacency ? `${report.stats.adjacency.edges} рёбер, unresolved ${report.stats.adjacency.unresolved}` : 'нет файла'}`,
  );
  line(
    `Файлов комнат: ${report.stats.roomsFound} из ${report.stats.roomsInRegistry} (не хватает ${report.stats.roomsMissingFiles})`,
  );
  line('');
  line('--- DSL: типы из реальных данных против v3 §III.4');
  for (const [t, n] of Object.entries(report.stats.triggerTypes)) {
    const m = TRIGGER_MAP[t] ?? { v3: null, status: 'unknown', note: 'нет в карте маппинга' };
    const mark = m.status === 'ok' ? '✅' : m.status === 'gap' ? '❌' : '⚠️';
    line(`  ${mark} trigger  ${t} (${n}) → ${m.v3 ?? 'НЕТ В v3'}  ${m.note}`);
  }
  for (const [c, n] of Object.entries(report.stats.conditionTypes)) {
    const m = CONDITION_MAP[c] ?? { v3: null, status: 'unknown', note: '' };
    line(`  ${m.status === 'ok' ? '✅' : '❌'} condition ${c} (${n}) → ${m.v3 ?? 'НЕТ В v3'}  ${m.note}`);
  }
  for (const [e, n] of Object.entries(report.stats.effectTypes)) {
    const m = EFFECT_MAP[e] ?? { v3: null, status: 'unknown', note: '' };
    const mark = m.status === 'ok' ? '✅' : m.status === 'partial' ? '⚠️' : '❌';
    line(`  ${mark} effect   ${e} (${n}) → ${m.v3 ?? 'НЕТ В v3'}  ${m.note}`);
  }
  line(`  ключи narrative_guidance: ${report.stats.guidanceKeys.join(', ') || '—'}`);
  line('');
  for (const level of ['errors', 'warnings', 'notes']) {
    if (report[level].length === 0) continue;
    line(`--- ${level.toUpperCase()} (${report[level].length})`);
    for (const item of report[level]) line(`  [${item.code}] ${item.where}: ${item.message}`);
    line('');
  }
  line(`Итого: ERROR ${report.counts.errors} · WARN ${report.counts.warnings} · NOTE ${report.counts.notes}`);
  line(
    report.counts.errors > 0
      ? 'Данные НЕ готовы к конвертации (см. ERROR).'
      : 'Данные пригодны к конвертации с учётом WARN и поправок K1–K16 (решения D164–D193).',
  );
}

process.exit(report.counts.errors > 0 ? 1 : 0);
