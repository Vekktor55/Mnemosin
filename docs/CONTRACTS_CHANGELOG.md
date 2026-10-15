# CONTRACTS_CHANGELOG — история изменений `@mnemosin/contracts`

Формат: [Keep a Changelog](https://keepachangelog.com/ru/1.1.0/). Версия — `CONTRACTS_VERSION` в `shared/contracts/src/index.ts`.
Правило (D112): код — источник истины; любое изменение схем фиксируется здесь и, если оно затрагивает планы, — в `docs/ARCHITECTURE.md` как решение `D*`.

---

## [0.5.0] — 2026-10-14 · промпты 1.8–1.9 (Turn Engine; модули chat/story/gm/gm-audit)

Аддитивные изменения: расширены enum-каталоги и данные подписчиков. Обратной несовместимости нет — существующие значения сохранены.

### Добавлено

| Правка   | Что                                                                                                                                                                                                                                        |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **D237** | `JournalKind` (domain/journal.ts) += `ending_reached` — промпт 1.8 п.4: применение эффекта `REACH_ENDING` в этапе 1 фиксируется журналом (`endingState` + журнал; `endSession` — этап 3). Готового вида в каталоге не было (F-1.10)        |
| **D246** | `CommandName` (domain/jobs.ts) += `sendPublicMessage`, `sendPrivateMessage`, `sendSystemMessage`, `sendGMMessage`, `addNote`, `grantKnowledge` — каталог обязан покрывать ВСЕ мутирующие команды (D218); модули промпта 1.9 добавили шесть |
| **D245** | `EVENT_SUBSCRIBERS.TURN_COMMITTED` (events/subscribers.ts) += `gm` — промпт 1.9 п.6 (F-3.8): gm публикует заметки `PUBLIC_AFTER_COMMIT` в чат после коммита хода; подписки в каталоге данных не было                                       |

В промпте 1.8 `CommandName` не изменялся: команды gm-review маппятся на существующие (`commitTurn`, `rejectTurn`, `retryTurn`, `editAndApprove`); approve — вызов `commitTurn` с `gmDecision` (D236). Новых доменных событий нет: `TURN_PRIVATE_RESOLUTION` из текста промта 1.8 в каталоге отсутствует — доставка приватных сегментов в этапе 1 идёт через подписку chat на `TURN_COMMITTED` (промпт 1.9), см. D238.

### Проверка

`CONTRACTS_VERSION = '0.5.0'`; contract-тесты проходят без правок (размер EVENT_NAMES не изменился — 40).

---

## [0.4.0] — 2026-10-13 · промпт 1.6 (машины состояний Turn/Session)

Аддитивное изменение: расширены два enum-каталога. Обратной несовместимости нет — все существующие значения сохранены, 71 contract-тест проходит без правок.

### Добавлено

| Правка   | Что                                                                                                                                                                                                  |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D218** | `CommandName` (domain/jobs.ts) += `createSession`, `joinSession`, `leaveSession`, `createCharacter` — каталог обязан покрывать ВСЕ мутирующие команды; сервисы лобби 1.6 добавили четыре недостающие |
| **D218** | `JournalKind` (domain/journal.ts) += `action_submitted` — подача действия игрока стала шагом журнала хода (промпт 1.6: «все команды пишут journal»)                                                  |

Обоснование — **D218** (`docs/ARCHITECTURE.md` §1.9). Событие `TURN_UNLOCKED`, которое промпт 1.6 предписывал добавить (решение D114), уже присутствует в каталоге с промпта 1.2 — contracts не изменялись.

### Проверка

`CONTRACTS_VERSION = '0.4.0'`; 252 теста (contract 71 · arch 25 · unit 53 · integration 103). `verify:stage1` = 10 PASS / 0 FAIL (добавлены A1.6, A1.15).

---

## [0.3.1] — 2026-10-13 · промпт 1.5 (шина событий)

**Только типы, runtime без изменений.** Ни одна Zod-схема не изменена — все 71 contract-тест проходят без правок.

### Исправлено

| Правка   | Что                                                                                                                                                                                                                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D213** | `buildEnvelopeUnion` (envelope.ts) возвращает `z.ZodType<EnvelopeOf<T, Extra>, ZodTypeDef, unknown>` вместо `z.ZodDiscriminatedUnion<'type', EnvelopeOptions>`; добавлен экспорт типа `EnvelopeOf`. Касты `as Record<string, z.ZodTypeAny>` убраны с трёх call-sites: `DomainEventSchema`, `WSClientMessageSchema`, `WSServerMessageSchema` |

Обоснование — **D213** (`docs/ARCHITECTURE.md` §1.8): через собранные d.ts (tsc -b между пакетами) прежний возвращаемый тип терял литеральную карту payload'ов, и `z.infer` вырождал `DomainEvent['type']`/`payload` в `unknown`. Дефект обнаружен typecheck'ом промпта 1.5 — первым кодом, который читает `DomainEvent['type']` из другого пакета (`core/events`, `infrastructure/database/outbox-publisher`).

### Проверка

`CONTRACTS_VERSION = '0.3.1'`; 172 теста (contract 71 · arch 20 · unit 45 · integration 36). `DomainEvent['type']` = `EventName` (40 литералов) во всех пакетах.

---

## [0.3.0] — 2026-10-12 · промпт 1.4 (персистентность)

Аддитивное изменение: добавлен недостающий тип снапшота. Обратной несовместимости нет.

### Добавлено

| Правка  | Что                                                                                                                                                            |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **K17** | `SnapshotSchema` (`domain/snapshot.ts`): `id`, `sessionId`, `label`, `turnNumber`, `createdByTurnId`, `createdBy`, `state: GameState`, `checksum`, `createdAt` |
| **K17** | `SnapshotListEntrySchema` = снапшот без `state` (для списков: тело тяжёлое, в перечислении не нужно)                                                           |
| **K17** | `SnapshotId` — брендовый uuid в `ids.ts`                                                                                                                       |

Обоснование — **D198**: таблица `snapshots` требовалась схемой БД промпта 1.4, а типа в контрактах не было (gap промпта 1.2). Снапшот хранит состояние **целиком**, а не дельту: откат обязан работать без воспроизведения истории.

### Проверка

`CONTRACTS_VERSION = '0.3.0'`; 145 тестов (contract 71 · arch 20 · unit 29 · integration 25). Round-trip `Snapshot` через БД покрыт интеграционным тестом: `state_json` хранит только `GameState`, остальные поля — колонки; маппер собирает объект и сверяет его со схемой.

---

## [0.2.1] — 2026-10-12 · данные Скрытого тамбура + промпт 1.3

### Изменено

- `EventAiGuidanceSchema` += `conditionNote` (D191): 14-й ключ `narrative_guidance`, найден contract-тестом на реальных данных в `floor-1_hidden_vestibule` (событие `DESCENT_TO_FLOOR_MINUS_2`).
- `EnvSchema.AI_PROVIDER` и `EnvSchema.MEDIA_PROVIDER`: **строка вместо enum** (D192). Иначе добавление провайдера требовало бы правки схемы, что ломает критерий A1.14 («1 файл + 1 строка конфига»). Защита production сохранена через deny-list `STUB_PROVIDERS` в `@mnemosin/config`.

### Данные мира

- Получены `floor-1_hidden_vestibule.json` и `floor-1_exam_a.gm.json` → **Q11 закрыт для этажей 0 и −1**: 8 публичных файлов, 8 `.gm.json`, 77 событий, 17 выходов, «сирот» нет.
- Сводка по DSL: `inspect_object` 39, `attempt_interaction` 10, `enter_room` 8, `interact` 7, `compound_player_action` 5, `object_unlocked` 3, `take_item` 3, `object_changed` 2 → **62 экземпляра триггеров вне DSL v3** (K1–K3, K14).

---

## [0.2.0] — 2026-10-12 · промпт 1.2

Первый полный набор схем. Закрывает блокеры аудита B-01, B-02, B-03 и дефекты F-1.10…F-1.23, F-6.3, F-6.4, F-7.4, F-8.1, F-8.2.

### Добавлено

- **Идентификаторы** (`ids.ts`): 13 брендовых ID + `IdempotencyKey`, `Slug`, `FlagKey`, `HostId`, `Scalar`, хелперы `newId()`/`id()`.
- **Время** (`time.ts`): единый `IsoDateTime` (UTC, миллисекунды) — устраняет F-1.21.
- **Ошибки** (`errors.ts`): 43 кода (8 Core + 18 публичных v3 + 17 добавленных), `ERROR_TABLE` с категорией/HTTP/`clientAction`, `CORE_TO_PUBLIC`, `PROVIDER_TO_PUBLIC`, `HttpErrorBodySchema`, классы `AppError`/`CoreError`/`ProviderError`/`ConflictError`, `toErrorCode()`.
- **Домен**: `Session` (+ `SESSION_TRANSITIONS`, без `currentLocationId` — F-1.16), `Player`/`Character`/`PlayerExtension`, `Turn` (+ `TURN_TRANSITIONS`, `TURN_TRANSITION_TABLE`, без `actionIds` — F-1.17, структурированный `failed` — F-1.18), `PlayerAction` (intent-enum — F-4.6), `GameState` (флаги по `key` — B-03, knowledge как массив — F-1.15), `LocationDefinition`/`LocationTemplate`/`WorldPack`, `TurnResolution` (**B-01**), `GMNote`/`GMReviewDecision`/`GmAuditEntry`, `IdempotencyRecord` (+`resultJson` — B-08), `JournalEntry` (+enum `kind` — F-1.10), `MediaJob`/`AudioJob`, `ChatMessage`.
- **DSL**: `StatePath` как structured union + `serializePath`/`parsePath`/`readPath` (**B-03**), `Condition` (13 операторов, включая `ACTION_INTENT`/`ACTION_TARGET`/`ACTION_TEXT_MATCH`), `Trigger` (11 видов), `Effect` (11 видов), `WorldEvent` (+`priority`, `conditions[]`, `cascadeDepth`, `aiGuidance`, `requiresModule`), `RuleCheck`/`RuleSubject`/`RuleResult`/`RulesBundle`, `DeferredEffect`, `FirstSeen`.
- **События**: 40 payload-схем, `DomainEventSchema` (discriminated union), `EVENT_EMITTERS`/`EVENT_SUBSCRIBERS` (только `moduleId` — F-2.2/F-2.4), `assertEventCatalogConsistent()`.
- **Транспорт**: 28 client-типов и 35 server-типов WS как discriminated unions (**F-6.3**), `WS_PRIVACY_POLICY` (матрица приватности — **B-10**), `FORBIDDEN_IN_BROADCAST`, `WS_REQUIRES_IDEMPOTENCY_KEY`, `WS_GM_ONLY`, `WS_CLOSE_CODE`, 45 `RouteContract` (**B-11**), 9 view-проекций (**B-02**).
- **AI**: `DirectorContext` (+`characterNames`, `namePolicy` — K13/D173), `AIResponse`, `AIGenerationResult` (+`usage` — F-7.1), `VisualPromptResult`.
- **Модули**: `ModuleContract` как generic с Zod-схемами команд (**F-8.1**), `idempotentCommands` (F-8.2), `defineModule()`, `UiPanelContribution`.

### Поправки по данным мира v1 (K1–K16, D164–D190)

| Поправка | Что изменилось                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| K1–K3    | Триггеры `OBJECT_INSPECTED`, `ATTEMPT_INTERACTION`, `COMPOUND_ACTION`                                                          |
| K4       | `TELEPORT.playerIds` опционален (отсутствие = вся группа)                                                                      |
| K5       | `FlagKey` допускает точку; конвенция `<room_id>.<flag>`                                                                        |
| K6       | `ExitSchema` v2: `kind` LOCATION/DESCRIPTIVE, `label`+`description`, `oneWay`, `hidden`, `via`, `lock{}`                       |
| K7       | `LocationGmSecretSchema` + `LocationDefinition.gmSecret`                                                                       |
| K8       | `AtmospherePartsSchema` (структура) + склейка в `atmosphere`                                                                   |
| K9       | `HazardSchema` — discriminated union вместо `string[]`                                                                         |
| K10      | `EventAiGuidanceSchema` (13 ключей), `LocationAiGuidanceSchema`, `narrativeNotes` 2000 → 6000                                  |
| K11      | Три проекции локации: `PublicLocationView` / `AiLocationView` / `GmLocationView`                                               |
| K12      | `actors`/`items` — непрозрачные данные в `LocationMeta`                                                                        |
| K13      | `NamePolicy`, `characterNames`, `GM_SET_NAME_REMEMBERED`                                                                       |
| K14      | Триггеры `OBJECT_CHANGED`, `OBJECT_UNLOCKED`, `ITEM_TAKEN`                                                                     |
| K15      | Эффекты `REVEAL_OBJECT`, `GIVE_ITEM`                                                                                           |
| K16      | `LocationObject.takeable` + `ItemMeta{unique, storyRelevance, hiddenRole}`                                                     |
| D179     | `atmosphere.max` 500 → 1000 (Регистратура = 564)                                                                               |
| D184     | `ATTEMPT_INTERACTION.interactionTypes` (словарь контента), `objectIds` может быть пустым                                       |
| D185     | `narrative_marker{value}` → `SET_FLAG` с ключом `<room>.marker.<value>` (правило конвертера)                                   |
| D186     | `WorldEventCategory`: 9 значений по фактическому словарю данных                                                                |
| D187     | `allowedRevelation`/`forbiddenRevelation` — массивы; `forbidden` — `string \| string[]`; `defaultVisibility` — свободный текст |
| D188     | `SET_FLAG.value` — `default(true)` (1 случай из 84 в данных без значения)                                                      |
| D189     | `CapabilitySchema`/`ProviderPolicySchema` переехали из `@mnemosin/config` в contracts                                          |
| D190     | `ExitSchema.description`/`.via` получили `default(null)`                                                                       |

### Тесты

71 contract-тест в `tests/contract/`: round-trip и негативные случаи всех доменных схем, таблицы переходов, `StatePath` round-trip (включая пути из примеров v3, которые прежний регексп не пропускал), полнота `WS_PRIVACY_POLICY`, отсутствие запрещённых полей в BROADCAST-схемах, согласованность `WS_REQUIRES_IDEMPOTENCY_KEY`, уникальность и полнота `HTTP_ROUTES`, согласованность каталога событий, 40 payload-фикстур, покрытие `ERROR_TABLE`, и **отдельный набор на реальных данных мира** (7 комнат, 67 событий): каждый триггер/условие/эффект v1 выражается схемами v3, атмосфера влезает в лимит, подписи выходов ≤60, полная конвертация Шлюза в `LocationDefinition`, изоляция `gmSecret`.

---

## [0.1.0] — 2026-10-09 · промпт 1.1

Каркас: `CONTRACTS_VERSION` и пакет-заглушка (схемы ещё не объявлялись).
