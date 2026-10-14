# CONTENT_MAPPING — данные мира v1 (schema 2.0) → модели v3

Версия 1.0 · 2026-10-10 · решения D164–D171, поправки к контрактам K1–K12
Основание: `content/source-v1/` (`_registry.json`, `_adjacency.json`, `rooms/floor0_airlock.json` + `.gm.json`), `МНЕМОСИН Pipeline v3` §II.8–II.9, §III.4, §IV.4, `docs/AUDIT.md` §8.2/§8.7/§8.8.
Инструмент проверки: `npm run inspect:content` (`tools/inspect-v1-rooms.mjs`).

**Главный вывод:** реальные данные богаче модели v3. v3-контракты в текущем виде **теряют 12 классов информации**, а одно событие из восьми не переносится вовсе без изменения DSL. Контракты нужно расширить **до** промпта 1.2 (иначе 2.3–2.4 упрутся в схемы, которые не описывают контент). Расширения перечислены в §3 и стоят дёшево: это добавление полей, а не переписывание модели.

---

## 1. Что получено

| Данные                                                                                                                                                | Объём                                                                                                       | Статус                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `_registry.json`                                                                                                                                      | 50 комнат, этажи 0 и −1…−7, поля `n/floor/index_on_floor/room_id/title/floor_name/batch/origin/floor_truth` | получен целиком                                                                                            |
| `_adjacency.json`                                                                                                                                     | 63 ребра, 8 этажей, `meta.legend` (via, source, lock_type), `unresolved[4]`                                 | получен целиком                                                                                            |
| `rooms/floor0_airlock.json` + `.gm.json`                                                                                                              | «Шлюз», этаж 0: 2 выхода, `atmosphere{5}`, `hazards{6}`, `state.initial{9}`, `events[8]`, `ai_guidance{5}`  | получен 2026-10-09                                                                                         |
| 5 комнат этажа −1 + 5 парных `.gm.json`: `floor-1_lobby`, `floor-1_reception`, `floor-1_relaxation`, `floor-1_psychotherapist`, `floor-1_locker_room` | **50 событий** суммарно, до 17 флагов `state.initial` на комнату, объекты и выходы                          | получены 2026-10-12                                                                                        |
| Остальные **42 комнаты** (этажи −2…−7)                                                                                                                | —                                                                                                           | **нет**: для scope этапа 2 (этажи 0 и −1) данные получены полностью; догрузка — новая версия pack'а (D175) |

**Итого: 8 публичных файлов комнат из 50, 77 событий, 17 выходов, 8 файлов `.gm.json`, «сирот» нет.** Scope этапа 2 (этажи 0 и −1) данными закрыт полностью (Q11).

Отчёт анализатора по всем 7 комнатам: **`ERROR 0 · WARN 79 · NOTE 59`** — данные пригодны к конвертации. Профиль предупреждений: 47 × `TRIGGER_NOT_IN_V3` (K1–K3, K14), 8 × `EXIT_LABEL_TOO_LONG` (D177), 5 × `NO_OBJECTS`/`OBJECTS_TO_DERIVE` (D172: **28 объектов** к созданию), 5 × `EMPTY_DESCRIPTION` (D176), по 1 × `EXIT_TO_NON_ROOM`, `EXIT_TARGET_NOT_IN_REGISTRY` (K6), `SET_FLAG_NOT_DECLARED`, `EFFECT_PARTIAL_MAP` (K4).

---

## 2. Полевое соответствие

### 2.1 Локация

| v1 (room 2.0)                                                                                              | v3 `LocationDefinition`                                  | Статус                                                  | Действие               |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------- | ---------------------- |
| `room_id` (slug)                                                                                           | `templateSlug` → `locationId` (uuid при инстанцировании) | ✅                                                      | конвертер, `remap`     |
| `title`                                                                                                    | `name` (≤80)                                             | ✅                                                      | —                      |
| `base_description`                                                                                         | `description` (≤2000)                                    | ⚠️ **пусто** у Шлюза                                    | Q9                     |
| `lore.public_revelation.text_snippet`                                                                      | кандидат в `description`                                 | ⚠️                                                      | Q9 (решение заказчика) |
| `lore.public_revelation.summary`                                                                           | `narrativeNotes` (AI/GM)                                 | ✅                                                      | —                      |
| `role.function`, `role.story_truth`                                                                        | `narrativeNotes`                                         | ✅                                                      | только в AI-вид        |
| `role.type`, `role.revelation_level`                                                                       | `tags[]`                                                 | ✅                                                      | —                      |
| `atmosphere{lighting,sounds,smell,temperature,tone}`                                                       | `atmosphere: string ≤500`                                | ⚠️ структура → строка (243 симв., в лимит укладывается) | **K8**                 |
| `hazards{gas_level,acid,electricity,darkness_requires_light,turret,trap_trigger}`                          | `hazards: string[]`                                      | ❌ потеря структуры                                     | **K9**                 |
| `objects[]`, `items[]`                                                                                     | `objects[]`                                              | ⚠️ **пусты**, но события ссылаются на 4 объекта         | Q10                    |
| `exits[]`                                                                                                  | `exits[]`                                                | ❌ 6 полей не представлено                              | **K6**                 |
| `state.initial{9 флагов}`                                                                                  | —                                                        | ❌ в v3 нет стартового состояния локации                | **K5**                 |
| `state.persistent_story_flags[]`                                                                           | `storyFlags` (глобальные)                                | ✅                                                      | без namespace          |
| `events[]`                                                                                                 | `WorldEvent` (отдельные сущности) + `registeredEventIds` | ⚠️                                                      | §2.3                   |
| `ai_guidance{role,core_instruction,revelation_pacing[6],forbidden_knowledge_reveal[7],supernatural_limit}` | `narrativeNotes` (≤2000) — **не вмещает**                | ❌                                                      | **K10**, **K11**       |
| `actors{enemies,npcs}`                                                                                     | —                                                        | ❌ нет в v3                                             | **K12** (вне Core)     |
| `meta{schema_version,source_files,notes}`                                                                  | `meta` шаблона                                           | ✅                                                      | —                      |
| `.gm.json` (весь)                                                                                          | —                                                        | ❌ **в v3 нет GM-only блока локации**                   | **K7**                 |
| `_registry`: `floor`, `index_on_floor`, `floor_name`, `batch`, `floor_truth`, `origin`                     | `tags[]` + `meta`                                        | ✅                                                      | —                      |

### 2.2 Выходы (`exits[]`) — детальное расхождение

Реальный выход Шлюза:

```json
{
  "target_room_id": "surface_cemetery",
  "direction": "Внешняя гермодверь, за которой остались кладбище и ночной воздух",
  "is_locked": true,
  "lock_type": "condition",
  "key_required": null,
  "requires_flag": "surface_door_forced",
  "hidden": false,
  "one_way": true,
  "via": "door"
}
```

v3 `ExitSchema` = `{ toLocationId, label ≤60, locked, lockReason ≤200 }`. Расхождения:

1. `direction` = 64 и 71 символ → **не влезает в `label.max(60)`** (проверено на обоих выходах).
2. `target_room_id: "surface_cemetery"` — **нет в реестре**: это описательный выход, не локация (`_adjacency.json` e00, `unresolved.u04`). v3 требует `toLocationId` — представить нечем.
3. `one_way`, `hidden`, `via`, `lock_type`, `key_required`, `requires_flag` — **6 полей теряются**. При этом `requires_flag`/`lock_type`/`key_required` — рабочая механика (чем отпирается выход), а `hidden` влияет на проекцию игроку.

→ поправка **K6**.

### 2.3 События и DSL

Фактические типы в данных (Шлюз, 8 событий) против v3 §III.4:

| v1                                                                 | Кол-во | v3                                  | Статус                                               |
| ------------------------------------------------------------------ | ------ | ----------------------------------- | ---------------------------------------------------- |
| `trigger.type: enter_room` + `first_time:true`                     | 6      | `ENTER_ROOM` + условие `FIRST_TIME` | ✅ маппится                                          |
| `trigger.type: inspect_object{target}`                             | **29** | —                                   | ❌ **K1** (нет триггера осмотра)                     |
| `trigger.type: interact{target}`                                   | 5      | `OBJECT_USED`                       | ✅                                                   |
| `trigger.type: attempt_interaction{targets[],interaction_types[]}` | 8      | —                                   | ❌ **K2**                                            |
| `trigger.type: compound_player_action{required_actions[]}`         | 5      | —                                   | ❌ **K3**                                            |
| `trigger.type: object_changed{…}`                                  | 1      | —                                   | ❌ **K14**                                           |
| `trigger.type: object_unlocked{…}`                                 | 2      | —                                   | ❌ **K14**                                           |
| `trigger.type: take_item{…}`                                       | 2      | —                                   | ❌ **K14** (предметы вне Core, K12)                  |
| `conditions[].type: state_is{path,equals}`                         | 51     | `EQ{path,value}`                    | ✅ (путь локальный → **K5**)                         |
| `effects[].type: set_flag{flag,value}`                             | 72     | `SET_FLAG{key,value}`               | ✅                                                   |
| `effects[].type: narrative_marker{message}`                        | 6      | `EMIT_NARRATIVE{text,visibility}`   | ✅                                                   |
| `effects[].type: move_group{target}`                               | 1      | `TELEPORT{playerIds,toLocationId}`  | ⚠️ **K4** (в v1 нет `playerIds` — уходит вся группа) |
| `effects[].type: reveal_object{…}`                                 | 1      | —                                   | ❌ **K15**                                           |
| `events[].category` (`scene/discovery/interaction/reaction`)       | 58     | —                                   | → `tags[]`                                           |
| `events[].narrative_guidance{13 ключей}`                           | 58     | —                                   | ❌ **K10**                                           |
| `events[].once`                                                    | 58     | `once`                              | ✅                                                   |

**Итого по 8 комнатам (77 событий): 62 экземпляра триггеров не покрываются DSL v3** — `inspect_object` 29, `attempt_interaction` 8, `compound_player_action` 5, `object_unlocked` 2, `take_item` 2, `object_changed` 1. Плюс один эффект `reveal_object`. Без поправок K1–K3, K14, K15 перенести их нельзя.

Ключи `narrative_guidance`, встречающиеся в данных (13): `purpose`, `sequence[]`, `must_not_explain[]`, `allowed_revelation`, `forbidden_revelation`, `effect`, `mechanical_consequence`, `important`, `forbidden`, **`consequence`**, **`default_visibility`**, **`frequency`**, **`secret_role`**. Это **указания модели**, а не текст для игрока — в v3 для них нет места ни в `WorldEvent`, ни в `LocationDefinition` (там `narrativeNotes` ≤2000 на всю локацию).

### 2.4 Видимость контента — три уровня, а не два

В v1 «публичный» файл означает **«то, что уходит модели»**, а не «то, что видит игрок» (v1 D55/D58/D59). Фактическое распределение в Шлюзе:

| Содержание                                                                                                           | Игрок               | AI (DirectorContext) | GM  |
| -------------------------------------------------------------------------------------------------------------------- | ------------------- | -------------------- | --- |
| `title`, `base_description`, `atmosphere`, видимые `objects`, незапертые/не-`hidden` `exits`, `hazards`              | ✅                  | ✅                   | ✅  |
| `ai_guidance{core_instruction, revelation_pacing, forbidden_knowledge_reveal, supernatural_limit}`                   | ❌                  | ✅                   | ✅  |
| `lore.public_revelation.summary`, `role.story_truth`, `lore.secret_truth.restrictions/floor_truth`                   | ❌                  | ✅                   | ✅  |
| `events[].narrative_guidance` (только зарегистрированные события локации)                                            | ❌                  | ✅                   | ✅  |
| `exits[].hidden`, запертые выходы с `requires_flag`                                                                  | ❌ (до обнаружения) | ✅                   | ✅  |
| `.gm.json`: `lore.secret_truth.truth/future_connections`, `gm.secret_values`, `gm.puzzle_solutions`, `gm.noise_note` | ❌                  | **❌**               | ✅  |

v3 оперирует двумя уровнями (`PublicLocationView` и `narrativeNotes «для GM/AI Director»`) — третьего («GM-only, никогда модели») в модели нет. Это прямой аналог v1-критерия приёмки №9 («содержимое `.gm.json` не встречается ни в одном запросе к Gemini»), который в v3 нечем выразить.

→ поправки **K7** и **K11**, плюс обязательный тест (аналог v1 критерия 9): маркер из `.gm.json` не встречается ни в `DirectorContext`, ни в `PublicGameStateView`, ни в WS-трафике.

---

## 3. Поправки к контрактам (K1–K12)

Принимаются как изменения `@mnemosin/contracts` **в промпте 1.2** (D166). Для каждой указано, что именно добавляется; все изменения аддитивны, существующие поля не ломаются.

### K1 · Триггер осмотра объекта

```ts
z.object({ kind: z.literal('OBJECT_INSPECTED'), objectId: ObjectId });
```

Источник (таблица источников триггеров, патч аудита §8.8): `PlayerAction` с `meta.intent='OBSERVE'` и `meta.targetObjectId`, подтверждённый в `TurnResolution` как APPROVED. Отличается от `OBJECT_USED` (intent `USE`) — в данных это разные события (`OUTER_DOOR_EXAMINED` против `DESCENT_TO_FLOOR_MINUS_1`).

### K2 · Триггер неудачной попытки

```ts
z.object({
  kind: z.literal('ATTEMPT_INTERACTION'),
  objectIds: z.array(ObjectId).min(1),
  intents: z.array(ActionIntent).min(1),
});
```

Источник: `Rules Engine` вернул `REJECT`/`SOFT_REJECT` для действия с одним из `intents` на одном из `objectIds`. Точная семантика v1-события `AIRLOCK_LOUD_FORCE_NO_EFFECT` («шум есть, эффекта нет»): оно должно срабатывать **именно когда действие не удалось**.

### K3 · Составное действие

```ts
z.object({
  kind: z.literal('COMPOUND_ACTION'),
  required: z
    .array(
      z.object({
        intent: ActionIntent,
        targetKind: z.enum(['OBJECT', 'PLAYER', 'SELF', 'GROUP']).optional(),
      }),
    )
    .min(2),
});
```

**Семантика (D168):** движок не вычисляет этот триггер сам. Он срабатывает, только если AI Director **предложил** событие (оно есть в `allowedEventIds` и пришло в `proposedEvents`), а Rules Engine проверил, что действия хода покрывают `required`. Основание: в v1 распознавание составного действия (`notice:own_belongings` + `compare:group_items`) делала модель, детерминированного правила нет.

### K4 · Перемещение группы

```ts
z.object({
  kind: z.literal('TELEPORT'),
  playerIds: z.array(PlayerId).optional(),
  toLocationId: LocationId,
});
```

`playerIds` отсутствует → перемещаются все игроки текущей локации (поведение v1 `move_group`). Правило зафиксировать в JSDoc и в `docs/EVENT_SCHEMA.md`.

### K5 · Ключи флагов и стартовое состояние локации

- Шаблон ключа: `/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,79}$/` — **точка разрешена**. (В патче аудита §8.2 точка была исключена из charset при том, что примеры v3 её используют, — это дефект самого патча, исправляется здесь.)
- Конвенция: глобальные флаги — `snake_case` как в v1 (`mnemosin_name_known`, `descent_started`); локальные флаги комнаты — `<room_id>.<flag>` (`floor0_airlock.group_awake`).
- `LocationTemplateSchema.initialFlags: z.record(flagKey, Scalar)` → при инстанцировании записываются в `storyFlags` с `setBy='ENGINE'`, `setAtTurnId` = первый ход.
- Условия `state_is{path}` конвертируются в `EQ` с **полным** `StatePath` вида `{kind:'FLAG', key:'floor0_airlock.group_awake'}`.

### K6 · Выходы

```ts
export const ExitSchema = z.object({
  kind: z.enum(['LOCATION', 'DESCRIPTIVE']).default('LOCATION'),
  toLocationId: LocationId.nullable(), // null только для DESCRIPTIVE
  label: z.string().min(1).max(60), // короткая подпись для UI
  description: z.string().max(200).nullable(), // полный текст v1 direction
  oneWay: z.boolean().default(false),
  hidden: z.boolean().default(false),
  via: z.enum(['door', 'stairs', 'elevator', 'shaft', 'hatch', 'vent']).nullable(),
  locked: z.boolean().default(false),
  lock: z
    .object({
      type: z.enum(['keycard', 'code', 'key', 'power', 'puzzle', 'condition']).nullable(),
      keyRequired: z.string().max(80).nullable(),
      requiresFlag: z.string().max(80).nullable(),
      reason: z.string().max(200).nullable(), // бывш. lockReason
    })
    .default({ type: null, keyRequired: null, requiresFlag: null, reason: null }),
});
```

Правило конвертации `direction` (64/71 симв.): `label` = короткая форма (≤60), `description` = исходный текст целиком. Короткую форму берём из `_adjacency.json` (`via` + имя цели), **не придумывая текст**; если однозначной короткой формы нет — вопрос заказчику (Q12).
Инвариант: `kind='LOCATION'` ⇒ `toLocationId !== null`; `kind='DESCRIPTIVE'` ⇒ `toLocationId === null` (проверяется `.refine`).

### K7 · GM-only блок локации

```ts
export const LocationGmSecretSchema = z.object({
  truth: z.string().max(4000).nullable(),
  futureConnections: z.string().max(4000).nullable(),
  staticNotes: z.string().max(4000).nullable(),
  secretValues: z.record(z.string().max(80), z.union([z.boolean(), z.string(), z.number()])),
  puzzleSolutions: z.record(z.string().max(80), z.string().max(2000)),
  manualControls: z.array(z.string().max(120)),
  noiseNote: z.string().max(1000).nullable(),
});
// LocationDefinition += gmSecret: LocationGmSecretSchema.nullable()
```

**Жёсткое правило:** `gmSecret` не попадает ни в `DirectorContext`, ни в `PublicLocationView`, ни в `PublicGameStateView`. Нарушение = дефект уровня B-10 (утечка). Хранится в отдельной колонке `locations.gm_secret_json`, доступ — только через `GMStateView`.

### K8 · Атмосфера

**Поправка от 2026-10-12:** `LocationDefinition.atmosphere.max` поднимается с 500 до **1000** — у Регистратуры склейка даёт 564 символа (проверено анализатором, `ATMOSPHERE_TOO_LONG`).

**Поправка от 2026-10-12 (D179):** `LocationDefinition.atmosphere.max` поднимается с 500 до **1000** — склейка атмосферы Регистратуры даёт 564 символа (обнаружено анализатором как `ATMOSPHERE_TOO_LONG`).

`LocationTemplateSchema.atmosphereParts{lighting,sounds,smell,temperature,tone}` сохраняется как есть (в `locations.meta_json`), а `LocationDefinition.atmosphere` заполняется склейкой `«{lighting}; {sounds}; {smell}; {temperature}; {tone}»` (у Шлюза 243 символа при лимите 500). Структура нужна UI и будущему аудио-модулю (3.7: `sounds` → подсказка для TTS/эмбиента).

### K9 · Опасности

```ts
export const HazardSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('GAS'), level: z.enum(['none', 'low', 'medium', 'high', 'lethal']) }),
  z.object({ kind: z.literal('ACID'), active: z.boolean() }),
  z.object({ kind: z.literal('ELECTRICITY'), active: z.boolean() }),
  z.object({ kind: z.literal('DARKNESS'), requiresLight: z.boolean() }),
  z.object({ kind: z.literal('TURRET'), active: z.boolean() }),
  z.object({ kind: z.literal('TRAP'), trigger: z.string().max(120).nullable() }),
  z.object({ kind: z.literal('OTHER'), label: z.string().max(200) }),
]);
// LocationDefinition.hazards: z.array(HazardSchema)   (вместо string[])
```

Значения `gas_level`, `darkness_requires_light` и т.п. также пишутся в `worldState.ambientFlags` при входе в локацию — чтобы DSL-условия могли на них ссылаться (`EQ{path:{kind:'AMBIENT',key:'gas_level'}, value:'none'}`).

### K10 · Указания модели в событии и в локации

```ts
export const EventAiGuidanceSchema = z
  .object({
    purpose: z.string().max(500).nullable(),
    sequence: z.array(z.string().max(200)).max(12),
    mustNotExplain: z.array(z.string().max(200)).max(12),
    allowedRevelation: z.string().max(1000).nullable(),
    forbiddenRevelation: z.string().max(1000).nullable(),
    effect: z.string().max(500).nullable(),
    mechanicalConsequence: z.string().max(500).nullable(),
    important: z.string().max(500).nullable(),
    // добавлены по данным этажа −1 (2026-10-12):
    consequence: z.string().max(500).nullable(),
    defaultVisibility: z.enum(['PUBLIC', 'GM_ONLY']).nullable(),
    frequency: z.string().max(200).nullable(), // для once=false: «раз в ход», «каждый раз»
    secretRole: z.string().max(500).nullable(),
  })
  .partial();
// WorldEvent += aiGuidance: EventAiGuidanceSchema.nullable()
// LocationDefinition.narrativeNotes: max 2000 → 6000 (ai_guidance Шлюза не влезает в 2000)
```

Правило: `aiGuidance` события попадает в `DirectorContext` **только** если событие входит в `allowedEventIds` текущей локации (инвариант v2 §26 сохраняется).

### K11 · Три проекции контента локации

Вместо двух (`public` / `narrativeNotes`) — три, и это фиксируется в `contracts/transport/views.ts`:

| Проекция             | Состав                                                                                                                                                                     | Кто получает             |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ |
| `PublicLocationView` | title, description, atmosphere, видимые objects, exits без `hidden` (с `locked` и `lock.reason`, но без `requiresFlag`), hazards (видимая часть)                           | игрок (BROADCAST)        |
| `AiLocationView`     | Public + `ai_guidance` + `lore.public_revelation` + `secret_truth.restrictions/floor_truth` + `narrativeNotes` + `aiGuidance` зарегистрированных событий + `hidden`-выходы | только `DirectorContext` |
| `GmLocationView`     | Ai + `gmSecret`                                                                                                                                                            | только GM                |

Тест (обязателен в 2.5 и в `verify:stage2`): уникальный маркер из `.gm.json` (`ZZ_GM_SECRET_MARKER`, добавляется в фикстуру) не встречается в `DirectorContext` и в WS-трафике — аналог v1-критерия №9.

### K12 · Актёры и предметы — вне Core

`actors{enemies,npcs}` и `items[]` (якоря, инвентарь) в Core не моделируются: сохраняются в `locations.actors_json` / `locations.items_json` как непрозрачные данные, интерпретируются будущими модулями (`actors`, `inventory`) через `PlayerExtension`/собственные таблицы. Основание — инварианты 1 и 13 (Core не знает игровые подсистемы) и v3 §II.3 (характеристики — не в Core).

### K13 · Имена персонажей в контексте AI (D173)

```ts
export const NamePolicy = z.enum(['WITHHELD', 'PARTIAL', 'ALL']);
// DirectorContextSchema += {
//   characterNames: z.array(z.object({ playerId: PlayerId, name: z.string().min(1).max(60) })),
//   namePolicy: NamePolicy,
// }
```

Правила:

- имя задаёт игрок при join (`characterName`, D157) и **всегда** видно в UI/чате — это out-of-character разметка (практика v1 D80);
- в `DirectorContext.characterNames` попадают **только** игроки с глобальным флагом `remembered_name.<playerId>` (boolean, `setBy: 'GM' | 'ENGINE'`);
- `namePolicy` = `ALL`, если имена есть у всех активных игроков; `PARTIAL` — если у части; `WITHHELD` — если ни у кого;
- при `namePolicy !== 'ALL'` в `directorInstructions` добавляется явный запрет: «не называй персонажей по именам, используй описания» — это сохраняет `ai_guidance.forbidden_knowledge_reveal[0]` и канон амнезии (v1 D34);
- флаг ставит GM вручную (`gm.setFlag`) или событие/эффект `SET_FLAG` — механизма «вспомнил автоматически» в этапе 2 нет (backlog);
- тест (обязателен в 2.5): при `WITHHELD` строки имён **отсутствуют** в собранном контексте (grep по canonical JSON) и в дампе промпта.

Альтернатива, которая рассматривалась и отклонена: хранить «кто чьё имя знает» в `PlayerKnowledge` per-наблюдатель. Отклонено, потому что нарратив один на всех, а per-player раскрытие имён потребовало бы нескольких версий текста хода.

### K14 · Три триггера, которых нет в v3 (найдены в данных этажа −1)

```ts
// TriggerSchema +=
z.object({ kind: z.literal('OBJECT_CHANGED'), objectId: ObjectId, key: z.string().max(60).optional() }),
z.object({ kind: z.literal('OBJECT_UNLOCKED'), objectId: ObjectId }),
z.object({ kind: z.literal('ITEM_TAKEN'), itemSlug: z.string().max(80), playerId: PlayerId.optional() }),
```

Источники триггеров (дополнение к таблице патча аудита §8.8):

| Trigger           | Источник                                                  | Момент                                                |
| ----------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| `OBJECT_CHANGED`  | применение `CHANGE_OBJECT_STATE` (эффект или правка GM)   | внутри commit-транзакции, после записи `objectStates` |
| `OBJECT_UNLOCKED` | `Rules Engine` или эффект сняли `locked` у выхода/объекта | внутри commit-транзакции                              |
| `ITEM_TAKEN`      | модуль `inventory` (**вне Core**, K12)                    | событие модуля → Event Engine                         |

Реальные события, которые без них не перенести: `STEPS_BELOW_HEARD` (object_changed), `RECEPTION_SAFE_UNLOCKED`, `RECEPTION_MONITOR_UNLOCKED` (object_unlocked), `WOODEN_BLOCK_FOUND`, `RECEPTION_KEYS_TAKEN` (take_item).

`ITEM_TAKEN` — единственный триггер, зависящий от модуля вне Core. Такие события конвертируются, но помечаются `requiresModule:'inventory'` и в этапе 2 **не регистрируются** в `allowedEventIds`, пока модуль не появился: иначе AI сможет ссылаться на событие, которое никогда не сработает. Это сохраняет инвариант 9 («optional modules cannot break Core») — решение D180.

### K15 · Эффект раскрытия объекта (и выдачи предмета)

```ts
// EffectSchema +=
z.object({ kind: z.literal('REVEAL_OBJECT'), objectId: ObjectId }),
z.object({ kind: z.literal('GIVE_ITEM'), itemSlug: z.string().max(80), playerId: PlayerId.optional() }),
```

`REVEAL_OBJECT` устанавливает `objectStates[objectId].visible = true`. В v3 поле `visible` в `ObjectStateSchema` есть, а способа изменить его из DSL не было. Реальное событие: `HIDDEN_DOOR_OPENED` (Кабинет психотерапевта) — без этого эффекта Скрытый тамбур не появится, и рёбра e08/e09 карты останутся недостижимыми.

`GIVE_ITEM` — как `ITEM_TAKEN`, зависит от модуля `inventory` (K12, D180).

### K16 · Предметы (`items[]`) — фактические данные и минимальная модель

В полученных 6 комнатах предмет ровно **один** — `reception_keys` в Регистратуре:

```json
{
  "id": "reception_keys",
  "name": "Связка ключей регистратуры",
  "description": "Три ключа на стальном кольце: от шкафчиков раздевалки, от внутренней двери за картотекой и один без бирки, крупнее остальных, с насечкой в виде буквы «В».",
  "takeable": true,
  "unique": true,
  "story_relevance": "major_clue",
  "persistent_state": { "taken": false },
  "hidden_role": "Крупный ключ с насечкой «В» связан с Секретным архивом (Сектор В) на этаже -3; не раскрывать назначение по одному виду ключа."
}
```

Два следствия:

1. **`hidden_role` — поле для модели, не для игрока** (как `ai_guidance`). Добавляется в матрицу видимости K11: `PublicLocationView` его не содержит, `AiLocationView` — содержит.
2. **Проверка владения предметом на этажах 0 и −1 не нужна.** Все 51 условие `state_is` в полученных комнатах проверяют флаги, а не инвентарь; ни один выход этажей 0/−1 не имеет `key_required` (ключевые замки начинаются с этажа −2: `pharmacy_key`, `keycard_service`, `keycard_level_2`, `keycard_level_5`).

Решение принято (**D182**, Q16 закрыт) — **минимальная модель без модуля `inventory`**:

```ts
// предмет = интерактивный объект с состоянием, а не отдельная сущность
LocationObjectTemplate { objectSlug: 'reception_keys', interactive: true, takeable: true,
                         itemMeta?: { unique, storyRelevance, hiddenRole } }
objectStates[objectId] = { taken: false, … }
// ITEM_TAKEN ← OBJECT_USED на объекте с takeable:true (intent USE/ACT, подтверждено в resolution)
// эффект TAKE_ITEM → CHANGE_OBJECT_STATE { taken: true }
```

Это делает события `RECEPTION_KEYS_TAKEN` и `WOODEN_BLOCK_FOUND` **работоспособными в этапе 2** и отменяет для них ограничение D180 (оно остаётся в силе только для `give_item` с адресной выдачей конкретному игроку). Полноценный инвентарь v1 (владелец `holder_slot`, якоря `is_anchor`, передача предмета между игроками — v1 критерий 16) остаётся в backlog: он нужен, когда предметы станут личными, а не общими (якоря, этажи −3…−7).

---

## 4. Конвертер (поправка к промптам 2.3–2.4)

`tools/convert-v1-rooms.mjs` (появляется в промпте 2.3, не раньше — нужны контракты из 1.2):

```text
content/source-v1/{_registry.json,_adjacency.json,rooms/*.json,rooms/*.gm.json}
      │
      ├─ 1. валидация входного формата (V1RoomSchema — описать в contracts как входную схему)
      ├─ 2. tools/inspect-v1-rooms.mjs как предусловие: ERROR = 0, иначе конвертация не начинается
      ├─ 3. сборка LocationTemplate[]: slug = room_id, поля по §2.1, meta.source сохраняется
      ├─ 4. exits: из файла комнаты, сверка с _adjacency.json (расхождение = ERROR)
      ├─ 5. events[] комнаты → WorldEventTemplate[]: slug = 'evt_' + lowercase(id),
      │      trigger/conditions/effects по §2.3, narrative_guidance → aiGuidance (K10)
      ├─ 6. state.initial → initialFlags с namespace (K5); persistent_story_flags → глобальные
      ├─ 7. .gm.json → gmSecret (K7), отдельный файл шаблона, meta.sensitive=true
      └─ 8. правила: из lock_type/requires_flag/hidden сгенерировать проверки бандла
             (move-through-locked-exit, hidden-exit-requires-discovery)
      ↓
content/worldpacks/mnemosin-hotel/{pack.json,locations/*.json,events/*.json,rules/*.json,_remap.preview.json}
```

Требования к конвертеру:

- **ничего не додумывает**: отсутствующее поле остаётся пустым, в `meta.source` пишется `'v1'` | `'derived'` | `'todo'`; всё с `'todo'` попадает в `content/worldpacks/mnemosin-hotel/_QUESTIONS.md`;
- идемпотентен: повторный прогон даёт побайтово тот же результат (детерминированный порядок ключей, uuid не генерируются — только slug);
- обратим по remap: `instantiateWorldPack` (2.3) создаёт uuid и сохраняет `worldpack_remaps`;
- покрыт snapshot-тестом на Шлюзе: `tools/fixtures/worldpack-airlock.expected.json`;
- **объекты из целей событий (D172):** если `objects[]` пуст, а события ссылаются на `target`/`targets`, конвертер создаёт `LocationObjectTemplate{objectSlug, name: slug → человекочитаемая форма из `direction`/`lore`, description: '', interactive: true, meta.source:'derived'}` и пишет их списком в `_QUESTIONS.md` на утверждение; пустое описание допустимо (v3 `description.max(500)` без min);
- **комнаты-заглушки (D175):** если ребро `_adjacency.json` или `exits[].target_room_id` ведёт в комнату из реестра, файла которой нет, создаётся stub-шаблон: `name` = `title` из реестра, `description` = `''`, `tags: ['stub']`, `meta.source='todo'`, выходы — только обратный; stub попадает в `_QUESTIONS.md`;
- **описательные выходы:** цель вне реестра (`surface_cemetery`) → `kind:'DESCRIPTIVE'`, `toLocationId:null`, `locked:true` (K6);
- **описание (D176, закрыт Q9):** при пустом `base_description` → `description` = `lore.public_revelation.text_snippet`, `meta.source='v1-snippet'`. Проверено на 6 комнатах: 5 берут описание из `text_snippet` (120–257 символов), у Регистратуры `base_description` заполнен (456). Пустых источников не осталось (`NO_DESCRIPTION_SOURCE` = 0); если пусты оба — конвертер падает, текст не сочиняется;
- **короткие подписи выходов (D177, закрыт Q12):** выводятся автоматически, авторский текст не сочиняется:

  ```text
  // D183: формат «Дверь в Регистратуру»
  VIA_LABEL = { door:'Дверь в', stairs:'Лестница в', elevator:'Лифт в',
                shaft:'Шахта в', hatch:'Люк в', vent:'Вентиляционный ход в' }

  label = VIA_LABEL[via] + ' ' + toAccusative(registry.title(target))   // если ≤ 60
        | toAccusative(registry.title(target))                          // если с via не влезло
        | truncateWords(direction, 60)                                  // цели нет в реестре
  description = direction целиком                                       // ≤ 200

  toAccusative: -ая→-ую, -яя→-юю, -ия→-ию, -а→-у, -я→-ю;
                слова ≤2 символов и аббревиатуры не склоняются;
                содержимое скобок/кавычек не изменяется;
                неоднозначные окончания (-ь, -й) → needsReview=true
  ```

  Факт по 6 комнатам (13 выходов): 12 подписей вида «Дверь: Регистратура», «Лифт: Светлый холл», «Дверь: Скрытый тамбур» (17–37 символов) и одна усечённая — для описательного выхода на поверхность («Внешняя гермодверь, за которой остались кладбище и ночной…», 58 символов). Список печатает `npm run inspect:content -- --json` → `stats.rooms[].derivedExitLabels`;

- **недообъявленные флаги:** если `set_flag`/`state_is` ссылается на флаг, отсутствующий в `state.initial` и `persistent_story_flags`, конвертер добавляет его в `initialFlags` со значением `false` и `meta.source='derived'` + записью в `_QUESTIONS.md` (найден 1 случай: `reception_entered`);
- **предметы (K16, D182):** `items[]` → интерактивные объекты с `takeable:true` и `itemMeta{unique, storyRelevance, hiddenRole}`; `hidden_role` уходит только в `AiLocationView` (K11); триггер `take_item` → `ITEM_TAKEN`, эффект — `CHANGE_OBJECT_STATE{taken:true}`;
- **события вне Core (K14/K15):** адресный `give_item` → `requiresModule:'inventory'`, в `allowedEventIds` этапа 2 не регистрируется (D180).

Порядок работ в этапе 2 меняется: **2.3 (world-pack + конвертер) → 2.4 (прогон конвертера на реальных данных вместо ручного написания контента) → 2.1/2.2 (DSL и Rules уже с реальными событиями)**. Контент из v3 §IX.1–IX.3 (Reception/Corridor/DollRoom) остаётся как тестовая фикстура DSL, но **не** как игровой мир.

---

## 5. Вопросы заказчику

| #       | Вопрос                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Блокирует    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------ |
| ~~Q9~~  | **ЗАКРЫТ (D176):** да — `description` ← `lore.public_revelation.text_snippet` при пустом `base_description`, `meta.source='v1-snippet'`. Проверено на 6 комнатах: 5 берут описание из сниппета, у Регистратуры `base_description` заполнен                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | —            |
| ~~Q10~~ | **ЗАКРЫТ (D172):** объекты заводятся конвертером из целей событий (`meta.source='derived'`) — по 6 комнатам их **28**; описания потребуют утверждения                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | —            |
| ~~Q11~~ | **ЗАКРЫТО для scope этапа 2**: получены все 8 комнат этажей 0 и −1 (77 событий, 17 выходов, 8 `.gm.json`, «сирот» нет). Остальные 42 комнаты этажей −2…−7 — позже, новой версией pack'а                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | —            |
| ~~Q12~~ | **ЗАКРЫТ (D177):** `label` выводится автоматически из `via` + `registry.title`, полный текст → `description`; `surface_cemetery` → `kind:'DESCRIPTIVE'`. 14 подписей сгенерированы, список — в §4                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —            |
| ~~Q13~~ | **ЗАКРЫТ (D174):** глобальные `snake_case`, локальные `<room_id>.<flag>`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | —            |
| ~~Q14~~ | **ЗАКРЫТ (D178):** оставляем `'todo'` — переносится в `_QUESTIONS.md` pack'а; этап 2 не блокирует (свет, ключи и питание нужны на этажах −2…−5)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | —            |
| ~~Q16~~ | **ЗАКРЫТ (D182):** минимальная модель — предмет = интерактивный объект с `objectStates.taken`, владение общее на группу; `ITEM_TAKEN` ← `OBJECT_USED` на `takeable:true`. Полный `inventory` (личный владелец, якоря, передача) — backlog для этажей −3…−7. Исходный вопрос: **Предметы: минимальная модель или модуль `inventory`?** Факты: на этажах 0 и −1 один предмет (`reception_keys`), все 51 условие событий проверяют флаги, ни один выход не требует ключа. Предлагаемое решение (K16): предмет = интерактивный объект с `objectStates.taken`, владение общее на группу — тогда `RECEPTION_KEYS_TAKEN` и `WOODEN_BLOCK_FOUND` работают уже в этапе 2. Альтернатива: полноценный `inventory` (личный владелец, якоря, передача) — нужен для этажей −3…−7 и для якорей | 2.3, backlog |
| ~~Q15~~ | **ЗАКРЫТ (D173), механизм — K13.** Коллизия: `ai_guidance.forbidden_knowledge_reveal[0]` запрещает модели называть персонажей по именам (канон амнезии, v1 D34), а D157 отдаёт имена игрокам. Решение: имя всегда видно в UI/чате как out-of-character разметка, а в нарративе модель использует его **только** после флага `remembered_name.<playerId>`                                                                                                                                                                                                                                                                                                                                                                                                                        | —            |

---

## 6. Решения

| #        | Решение                                                                                                                                                                                                                                                                                                                                         |
| -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D164** | Данные v1 (`content/source-v1/`) — **source of truth** для контента. Мир не переписывается и не генерируется заново; перенос только конвертером. Контент v3 §IX.1–IX.3 (Reception/Corridor/DollRoom) остаётся тестовой фикстурой DSL                                                                                                            |
| **D165** | Видимость контента локации — **три уровня** (Player / AI / GM), а не два. GM-only блок никогда не уходит модели                                                                                                                                                                                                                                 |
| **D166** | Поправки K1–K12 применяются к `@mnemosin/contracts` **в промпте 1.2** (до того, как схемы будут использованы). Все изменения аддитивны; `CONTRACTS_VERSION` повышается до `0.2.0`                                                                                                                                                               |
| **D167** | Флаги: глобальные — `snake_case` (как в v1), локальные — `<room_id>.<flag>`; шаблон ключа допускает точку                                                                                                                                                                                                                                       |
| **D168** | `COMPOUND_ACTION` срабатывает только по предложению AI Director + проверке Rules Engine (детерминированного распознавания нет)                                                                                                                                                                                                                  |
| **D169** | `ATTEMPT_INTERACTION` = реакция на `REJECT`/`SOFT_REJECT` действия Rules Engine'ом                                                                                                                                                                                                                                                              |
| **D170** | `actors` и `items` вне Core: хранятся как непрозрачные данные, обрабатываются будущими модулями                                                                                                                                                                                                                                                 |
| **D176** | Закрыт **Q9**: при пустом `base_description` описание берётся из `lore.public_revelation.text_snippet` (`meta.source='v1-snippet'`). Если пусты оба — конвертер падает с `NO_DESCRIPTION_SOURCE`, текст не сочиняется. Проверено: 5 комнат из 6 берут описание из сниппета (120–257 символов), у Регистратуры `base_description` заполнен (456) |
| **D177** | Закрыт **Q12**: короткий `label` выводится автоматически — `VIA_LABEL[via] + ': ' + title цели`; если не влезает в 60 — только `title`; для описательных выходов — усечение `direction` по границе слова. Полный `direction` → `description`. Авторские формулировки не изобретаются                                                            |
| **D178** | Закрыт **Q14**: `_adjacency.json unresolved[4]` остаётся `'todo'`, переносится в `_QUESTIONS.md`, этап 2 не блокирует                                                                                                                                                                                                                           |
| **D179** | `LocationDefinition.atmosphere.max` = **1000** (было 500): склейка атмосферы Регистратуры = 564 символа. Источник истины — структурный `atmosphereParts` (K8)                                                                                                                                                                                   |
| **D180** | События с `take_item` / `give_item` конвертируются, помечаются `requiresModule:'inventory'` и **не регистрируются** в `allowedEventIds`, пока модуля `inventory` нет (инвариант 9)                                                                                                                                                              |
| **D171** | Этап 1 остаётся на синтетических Reception/Corridor (D110); реальный Шлюз подключается в этапе 2. Исключение — если приедет `floor-1_lobby.json` (Q11), тогда демо этапа 1 переводится на реальную пару локаций                                                                                                                                 |

---

## 7. Как проверять

```bash
npm run inspect:content              # отчёт: типы DSL против v3, ошибки, предупреждения
npm run inspect:content -- --json    # машинный вывод (используется конвертером в 2.3 как предусловие)
```

Критерий готовности контента к конвертации: `ERROR 0`. **Текущий статус по 6 комнатам (58 событий): ERROR 0 · WARN 69 · NOTE 51** — данные пригодны к конвертации. Закрытые ранее блокеры: объекты (D172), лимит атмосферы (D179), описание комнат (D176).

После промпта 2.3 этот инструмент расширяется до валидатора world-pack'а (проверка slug-ссылок, `remap`, целостности `exits` ↔ `_adjacency.json`) и подключается в CI как шаг `worldpack:validate`.
