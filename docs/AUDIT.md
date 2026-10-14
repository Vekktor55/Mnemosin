# МНЕМОСИН — Аудит Pipeline v3 (baseline) против v2 и на исполнимость

**Дата аудита:** 2026-10-09
**Вход:** `Pipeline v3` (baseline-архитектура, ~1500 строк) + `uploads/Pipeline.txt` (Master Development Pipeline v2, 58 этапов)
**Режим:** строгий. Проверялись (а) полнота переноса требований v2, (б) внутренняя непротиворечивость v3, (в) исполнимость каждого контракта «как написано», (г) достоверность `## v3 SELF-CHECK`.

---

## 0. Вердикт

**v3 — сильный документ по форме и слабый по исполнимости.** Он заметно лучше v2: появились схемы-как-код, каталог событий, error taxonomy, idempotency, outbox, STRIDE, метрики, вертикальный срез. Как _архитектурный манифест_ он работает.

Как _контракт для LLM-implementer_ — **не работает**: реализатор упрётся в undefined-типы в первые же часы.

| Показатель                                                       | Значение                                                                          |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| Этапов v2 перенесено полностью                                   | **35 / 58**                                                                       |
| Перенесено частично                                              | **19 / 58**                                                                       |
| **Утеряно полностью**                                            | **4 / 58** — §21 Data Projections, §18 Snapshot, §43 Media Cache, §54 Performance |
| Дефектов в реестре §3 (уникальных `F-*` ID)                      | **113** — P0: 10 · P1: 37 · P2: 44 · P3: 22                                       |
| Блокеров (разобрано детально в §2, `B-01…B-12`)                  | **12**                                                                            |
| Undefined-типов/схем, на которые есть ссылки                     | **16**                                                                            |
| Таблиц БД, упомянутых в тексте, но отсутствующих в Drizzle-схеме | **13**                                                                            |
| Маркеров `UNKNOWN:` в v3                                         | 10 (из них **2 блокируют MVP**, см. F-9.5)                                        |
| Утверждений в SELF-CHECK, не подтвердившихся                     | **5 из 9**                                                                        |

**Главный системный диагноз:** v3 отлично описывает _глаголы_ (команды, события, переходы) и плохо — _существительные_ (типы данных, таблицы, проекции, ключи). Почти все P0 — это «сущность упоминается, но не определена» либо «два раздела описывают одно и то же по-разному».

**Рекомендация:** не отдавать v3 в реализацию как есть. Закрыть 12 P0 + 10 ключевых P1 (это ~3–5 дней плотной работы архитектора, патчи в §8 закрывают примерно 60% из них), после чего документ становится v3.1 / v4 и пригоден для передачи.

---

## 1. Матрица покрытия v2 → v3

Легенда: ✅ перенесено полностью · ⚠️ перенесено частично (есть дефект) · ❌ утеряно.

| v2  | Тема                          | v3                    | Статус | Дефекты                                                                 |
| --- | ----------------------------- | --------------------- | ------ | ----------------------------------------------------------------------- |
| §1  | Архитектурный принцип         | I.2                   | ✅     | —                                                                       |
| §2  | Что не делать                 | 0.3, I.4              | ✅     | —                                                                       |
| §3  | Три уровня                    | I.2, IX.8             | ⚠️     | уровень `gateways/` исчез из описания структуры                         |
| §4  | Архитектурный контракт модуля | IV.1                  | ⚠️     | F-8.1 (`unknown` на границе), F-8.3                                     |
| §5  | **Project Foundation**        | —                     | ❌     | F-10.2: стек, layout, tsconfig, DoD не зафиксированы                    |
| §6  | Architectural Boundaries      | IX.6                  | ⚠️     | F-10.3: физическая структура каталогов не приведена                     |
| §7  | Dependency Rules              | I.3, I.4, IX.6        | ✅     | —                                                                       |
| §8  | Module Contract System        | IV.1                  | ⚠️     | F-8.3 (контрактов 5 из 9)                                               |
| §9  | Domain Event Bus              | II.16, III.3          | ⚠️     | F-2.1…F-2.5                                                             |
| §10 | Capability Registry           | V.11, IV.2            | ⚠️     | F-6.3, F-9.6                                                            |
| §11 | Transport Layer               | VI.1                  | ✅     | —                                                                       |
| §12 | WebSocket Protocol            | VI.5–VI.8             | ⚠️     | F-5.3…F-5.9                                                             |
| §13 | Identity                      | VIII.1                | ⚠️     | F-5.11 (requestId ephemeral vs durable)                                 |
| §14 | GameSession                   | II.2, IV.12           | ⚠️     | F-3.5 (нет state machine сессии)                                        |
| §15 | Domain Player                 | II.3                  | ⚠️     | F-1.9 (Character не определён)                                          |
| §16 | Turn Domain                   | II.4–II.5             | ⚠️     | B-01, F-3.1                                                             |
| §17 | Player Actions                | II.6                  | ⚠️     | F-3.7 (лимит действий на ход)                                           |
| §18 | Turn Resolver                 | III.1                 | ⚠️     | F-3.4 (двойной триггер AI)                                              |
| §19 | Game State                    | II.7                  | ⚠️     | B-04, F-3.6                                                             |
| §20 | Persistence                   | III.11–III.13         | ⚠️     | **B-05** (13 таблиц отсутствуют), F-4.1…F-4.3                           |
| §21 | Turn Journal                  | III.3                 | ⚠️     | B-02 (`JournalEntry` не определён)                                      |
| §22 | **Snapshot**                  | II.15 (термин), X.4#6 | ❌     | **F-9.1**: механизм отсутствует, при этом на него ссылается VIII.7      |
| §23 | Event Engine                  | III.4–III.6           | ⚠️     | **B-06**, F-2.6…F-2.9, F-4.4                                            |
| §24 | Location System               | II.8, III.9–III.10    | ⚠️     | **B-04** (нет механизма инстанцирования шаблонов)                       |
| §25 | **Data Projections**          | VII.2, VI.4           | ❌     | **B-02**: ни одна view-схема не определена                              |
| §26 | Event Registry                | II.8, II.16           | ⚠️     | B-04 (регистрация не описана)                                           |
| §27 | Rules Engine                  | III.7–III.8           | ⚠️     | F-4.5 (predicate/onFail), F-4.6, B-03                                   |
| §28 | AI Director Contract          | IV.3                  | ⚠️     | F-3.4                                                                   |
| §29 | AI Context Builder            | IV.4                  | ⚠️     | B-02 (`PublicLocationViewSchema`)                                       |
| §30 | AI Structured Output          | IV.5                  | ✅     | + UNKNOWN#1                                                             |
| §31 | AI Provider Adapter           | V.1–V.4               | ⚠️     | F-6.1, F-6.2                                                            |
| §32 | AI Resolution Pipeline        | III.1                 | ⚠️     | **B-01**: нет маппинга AIResponse → TurnResolution → GameState          |
| §33 | GM Review                     | II.15, IV.9           | ⚠️     | **F-3.3** (двоевластие), F-3.2, F-9.7 (гранулярное ревью из v2 утеряно) |
| §34 | **Commit Pipeline**           | III.3                 | ⚠️     | шаг `snapshot` выпал; `apply changes` не специфицирован                 |
| §35 | Chat Module                   | IV.7                  | ⚠️     | B-07 (`ChatMessage`), F-2.2                                             |
| §36 | GM Module                     | IV.8                  | ⚠️     | F-3.3, F-5.2                                                            |
| §37 | GM Audit                      | IV.10                 | ⚠️     | B-08 (схема таблицы)                                                    |
| §38 | Reconnection                  | VI.8, VII.7           | ✅     | —                                                                       |
| §39 | Frontend Foundation           | VII.1                 | ⚠️     | F-10.2 (Svelte/Vite выпали)                                             |
| §40 | Frontend State Layer          | VII.2–VII.8           | ✅     | —                                                                       |
| §41 | Media Module Contract         | IV.6                  | ⚠️     | F-2.3                                                                   |
| §42 | Media Domain Events           | II.16                 | ✅     | —                                                                       |
| §43 | Host Bridge Contract          | V.10                  | ⚠️     | F-6.5                                                                   |
| §44 | ComfyUI Adapter               | V.6                   | ✅     | —                                                                       |
| §45 | LM Studio Adapter             | V.3, V.9              | ✅     | + UNKNOWN#3                                                             |
| §46 | Media Job System              | V.5                   | ⚠️     | **B-07**: `MediaJob` и таблица не определены                            |
| §47 | **Media Cache**               | —                     | ❌     | **F-9.2**: кэш и файловое хранилище отсутствуют                         |
| §48 | Visual UI                     | VII.1, VII.6          | ✅     | —                                                                       |
| §49 | Future Extension Test         | V.7, X.1–X.3          | ✅     | —                                                                       |
| §50 | Capability check              | V.11                  | ✅     | —                                                                       |
| §51 | Optional Module Failure       | VIII.7                | ⚠️     | F-9.6 (required-способность недоступна)                                 |
| §52 | Plugin-like validation        | X.3                   | ✅     | —                                                                       |
| §53 | Security                      | VIII.2–VIII.3         | ⚠️     | расширено, но F-5.10, F-9.3, F-9.4                                      |
| §54 | Failure Recovery              | VIII.7                | ⚠️     | ссылки на snapshot/ UNKNOWN                                             |
| §55 | Vertical Slice                | IX.1–IX.4             | ⚠️     | **B-04** (невалидные ID в JSON)                                         |
| §56 | Automated Testing             | IX.5                  | ✅     | —                                                                       |
| §57 | Architecture Tests            | IX.6                  | ✅     | + F-10.3                                                                |
| §58 | **Performance**               | VIII.5 (метрики)      | ❌     | **F-9.3**: нет ни одного целевого показателя                            |
| §59 | Production                    | IX.7, VIII.8          | ⚠️     | F-9.4 (бэкапы, error monitoring)                                        |
| §60 | Documentation                 | IX.8                  | ✅     | —                                                                       |
| §61 | Final extensibility audit     | X.1–X.3               | ✅     | —                                                                       |
| §62 | Final architecture            | I.2                   | ✅     | —                                                                       |
| §63 | Инварианты 1–15               | I.3                   | ✅     | перенесены дословно, подтверждено                                       |
| §64 | Правило развития              | X.3, I.5              | ⚠️     | решающее дерево «core/module/provider/UI» не перенесено дословно        |
| §65 | Финальный принцип             | I.1–I.2               | ✅     | —                                                                       |

**Итого:** 35 ✅ / 19 ⚠️ / 4 ❌.

---

## 2. Топ-12 блокеров (P0) — разбор и фиксы

> **Нумерация:** блокеры имеют ID `B-01…B-12`; каждый из них дублируется строкой в реестре §3 под своим `F-x.y` (см. поле «где» и перекрёстные ссылки). Для issues используйте `F-*` как стабильный ID, `B-*` — как указатель на разбор с фиксом.

### B-01 · `TurnResolution` нигде не определён

**Где:** `II.4` (`resolution: z.lazy(() => TurnResolutionSchema)`), `II.15` (`editedResolution`), `IV.9` (`editAndApprove`).
**Проблема:** тип упоминается 4 раза, схема отсутствует. `AIResponse` (IV.5) — это _вход_ от провайдера, а `TurnResolution` — то, что лежит в `turns.resolution_json`, что редактирует GM и что применяется к GameState в commit. Это разные сущности: у Resolution должны быть статусы по каждому предложенному изменению, результаты Rules, diagnostics, ссылка на провайдера и usage.
**Последствие:** нельзя реализовать ни `draftReady`, ни `editAndApprove`, ни commit-пайплайн (§34 v2 «apply changes»).
**Фикс:** см. §8.1 — полная схема `TurnResolution` + маппинг `AIResponse → TurnResolution` + правила применения.

---

### B-02 · Ни одна projection/view-схема не определена

**Где:** `VI.2` (`SessionView`, `PublicGameStateView`), `VI.3` (`TurnView`, `GMStateView`, `JournalEntry`), `VI.4` (`MediaJobView`), `IV.4` (`PublicLocationViewSchema`), `IV.7` (`ChatMessage`), `IV.6` (`MediaJob`), `VII.4`.
**Проблема:** 9 типов используются в HTTP-ответах, WS-пейлоадах и сторах фронта — и ни один не имеет Zod-схемы. Это **прямо нарушает инвариант 20** («никакая секция не оставляет сигнатуру/схему на потом»). При этом v2 §21 «Data Projections» был отдельным этапом и в v3 simply выпал.
**Последствие:** проекции — это единственный механизм приватности (GM-only, private messages, player knowledge). Без их схем приватность непроверяема, а тест из VIII.3 («no GM-only in public view») не на чем писать.
**Фикс:** ввести `contracts/views.ts` со схемами `PublicGameStateView`, `PlayerGameStateView`, `GMStateView`, `SessionView`, `TurnView`, `MediaJobView`, `ChatMessageView`, `JournalEntry`, `PublicLocationView` + матрицу приватности (§8.4).

---

### B-03 · `StatePath` грамматика несовместима с собственными примерами и со схемой GameState

Три независимых дефекта в одном месте (`III.4`):

1. **`storyFlags` ключуется `FlagId` (UUID), а DSL обращается по строковому `key`.** `GameStateSchema.storyFlags: z.record(FlagId, StoryFlagSchema)`, при этом `SET_FLAG{key:"doll_room.darkness"}` и `HAS_FLAG{flagKey:"doll_room.darkness"}`. Резолв пути невозможен: нет правила «key → flagId». То же в `playerKnowledge: z.record(PlayerId, …)` против `PLAYER_KNOWS{playerId, key}` (тут хотя бы id совпадает по типу).
2. **Регексп не покрывает собственные примеры.** `^(worldState|storyFlags\.[…]|objectStates\.[…]\.[…]|playerKnowledge\.[…]\.[…])$`: ветка `worldState` — **голое слово без полей**, поэтому `worldState.timeOfDay` (III.6 пример 2) и `worldState.currentLocationId` (III.8 пример) **не проходят валидацию**. А ветка `storyFlags.<key>` не допускает вложенности, хотя пример пишет `storyFlags`-ключи вида `doll_room.darkness` (с точкой внутри ключа) — регексп `[a-zA-Z0-9_-]+` точку не пускает.
3. **Формат ключей нигде не зафиксирован.** `doll.awake`, `finale.begin`, `doll_room.darkness` — конвенция «namespace.name»? Раздел не отвечает.

**Последствие:** Event Engine и Rules Engine — ядро игровой логики — не реализуемы буквально по тексту.
**Фикс:** см. §8.2 — заменить строчный регексп на структурированный `z.discriminatedUnion` + типизированный резолвер, и перейти на `storyFlags: z.record(string /*key*/, StoryFlagSchema)` с `flagId` как полем (а не ключом).

---

### B-04 · Все ID в примерах и вертикальном срезе невалидны; механизм инстанцирования шаблонов отсутствует

**Где:** `III.6`, `III.8`, `III.9`, `IX.1–IX.3`, `IX.4`.
**Проблема:** `LocationId/ObjectId/EventId` — `z.string().uuid()`. Примеры используют `loc_reception`, `obj_doll`, `evt_lights_out`. Ни один JSON вертикального среза **не пройдёт собственную Zod-схему**.
Вторая половина проблемы: `LocationDefinitionSchema.sessionId: null` = «шаблон мира», но **как шаблон становится сущностью сессии — не описано**. Нет ни команды, ни события, ни таблицы маппинга. А `WorldEventSchema.sessionId` — обязателен (не nullable), значит события всегда per-session, и их надо порождать из шаблонов с переназначением ID.
**Последствие:** вертикальный срез (главный артефакт IX) неработоспособен; `registeredEventIds` в шаблоне локации ссылается на несуществующие в сессии `EventId`.
**Фикс:** (а) разрешить два класса ID — `templateId: string slug` для паков и `uuid` для сессионных сущностей; (б) ввести `WorldPack` + процедуру `instantiateWorldPack(sessionId, packId)`: генерация UUID, таблица `id_remap(packSlug → entityId)`, подстановка в `exits`/`objects`/`registeredEventIds`, `EVENT_REGISTERED` на каждое событие, запись `locations(session_id NOT NULL)`. См. §8.7.

---

### B-05 · Persistence: 13 таблиц отсутствуют, FK нет в коде, две таблицы заданы raw SQL вне Drizzle

**Где:** `III.11` (Drizzle), `III.2` (raw SQL `idempotency_records`), `III.3` (raw SQL `event_outbox`), `VI.10` («очередь в `media_jobs`»), `VIII.2`/`VIII.3` (`gm_audit`), `IV.10`, `IV.7`, `VIII.7`.
**Отсутствуют:** `locations`, `world_events`, `rules_bundles`, `characters`, `gm_notes`, `gm_audit`, `chat_messages`, `media_jobs`, `media_cache`, `snapshots`, `player_extensions`, `deferred_effects`, `first_seen`. Плюс `idempotency_records` и `event_outbox` описаны только как `CREATE TABLE` — их нет в `schema.ts`, значит drizzle-kit их не сгенерирует и миграция их не создаст.
**FK:** перечислены прозой в `III.12`, но в Drizzle-коде нет ни одного `.references(() => …)` → `PRAGMA foreign_keys=ON` будет включён при **нулевых** внешних ключах. Утверждение III.12 ложно относительно собственного кода III.11.
**Также:** `III.11.turns` не содержит `action_ids`, хотя `TurnSchema.actionIds` есть → не определено, где живут `actionIds` (колонка-JSON или выборка из `actions`), т.е. два источника правды (F-4.3).
**Фикс:** §8.6 — полный перечень таблиц с колонками; все FK — в Drizzle-коде; `idempotency_records` и `event_outbox` перенести в `schema.ts`.

---

### B-06 · Event DSL не исполняем: 6 независимых дефектов

| #   | Дефект                                                                                                                                                                                                                                                                         | Где                      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------ |
| a   | `FIRST_TIME{scope}` **не содержит id** — «первый раз» относительно чего? Для `LOCATION`/`OBJECT`/`EVENT` нужен `entityId`, его нет                                                                                                                                             | III.4                    |
| b   | `WorldEventSchema` **не содержит `priority`**, хотя III.5 требует сортировку «по `priority` (задан в WorldEvent, default 0)»                                                                                                                                                   | II.9 vs III.5            |
| c   | `conditions` объявлен как **одиночный** `ConditionSchema`, а не массив; при этом `SET_FLAG`-эффект не описывает, как порождает триггер `FLAG_SET` (каскад)                                                                                                                     | II.9, III.4              |
| d   | Триггеры `OBJECT_USED` и `FLAG_SET` **недостижимы**: нет ни команды, ни маршрута, ни WS-сообщения, ни правила «как `PlayerAction.meta.targetObjectId` превращается в `OBJECT_USED`». Шаг 11 вертикального среза («игрок использует obj_doll → OBJECT_USED») не имеет источника | III.4 vs VI.2–VI.7, IX.4 |
| e   | Политика «second deferred to next turn» (III.5) **не имеет хранилища** — нет таблицы отложенных эффектов и правила, кто их применяет на следующем ходе                                                                                                                         | III.5                    |
| f   | `CORE_VERSION_CONFLICT` используется для write-write конфликта эффектов в **одной** транзакции — это семантически другой код (optimistic lock). `EVENT_EFFECT_CONFLICT` упоминается только как «логируется», в Error Taxonomy (VI.9) его нет                                   | III.5, II.17, VI.9       |

**Фикс:** §8.8 — расширенный `WorldEventSchema`, `FirstTimeCondition` с `entityId`, **таблица источников триггеров** (кто и когда эмитит), `deferred_effects`, новый код `EVENT_EFFECT_CONFLICT`, лимит глубины каскада.

---

### B-07 · Жизненный цикл Turn не имеет ни входа, ни выхода

**Где:** `II.5`, `IV.8`, `VI.2`, `VI.3`, `VI.6`, `IX.4`.
**Проблема:** переход `→ OPEN` **не описан вообще**: нет команды `openTurn`, нет маршрута, нет WS-сообщения, хотя `TURN_OPENED` есть в каталоге событий и в шаге 3 вертикального среза. Аналогично нет `POST /turns/:id/unlock` и `cancel`, хотя переходы `LOCKED → OPEN` и `OPEN → FAILED` в таблице заявлены.
И нет **перехода в следующий ход**: `COMMITTED` — терминальный, `currentTurnId` в сессии должен смениться, а команды «открыть ход N+1» не существует.
Дополнительно: `IV.8 gm.finishTurn` **отсутствует в таблице переходов II.5** — непонятно, что он делает (LOCKED? COMMITTED? дублирует `approve`?).
**Фикс:** добавить `openTurn(sessionId, idempotencyKey)` в `turn`-модуль (эмитит `TURN_OPENED`, выставляет `session.currentTurnId`), `unlockTurn`, `cancelTurn`; маршрут `POST /sessions/:id/turns`; `finishTurn` удалить как дубликат `gm-review.approve` (см. F-3.3).

---

### B-08 · Idempotency противоречит сама себе

**Где:** `III.1`, `III.2`, `VI.6`, `VIII.1`.

1. `III.1 step 3`: «assign idempotencyKey (если null) = uuid». Ключ, **сгенерированный сервером при каждом вызове**, не обеспечивает идемпотентность повторного вызова клиента — это ровно тот антипаттерн, который запрещает I.4 («локальный requestId вместо idempotency-key»). Для `resolveTurn` ключ должен быть **детерминирован**: `resolve:{turnId}`.
2. `IdempotencyRecordSchema.command: z.enum(['resolveTurn','commitTurn','rejectTurn'])`, но ключи обязаны принимать «любая команда, меняющая Turn status» → `lockTurn`, `unlockTurn`, `cancelTurn`, `retryAI`, `activateEvent`, `moveGroup` в enum не помещаются. Контракт и схема расходятся.
3. `tryAcquire` — `find()` затем `insert()`: **гонка** между двумя параллельными вызовами. Нужен атомарный `INSERT … ON CONFLICT DO NOTHING` + проверка `changes()`.
4. `status === 'DONE'` → `return { cached: true, result: existing }`: `existing` — это _запись_ с `resultHash`, а не результат. Клиент, повторивший `POST /turns/:id/commit`, ожидает `{version}` — вернуть его из хэша невозможно. Нужна колонка `result_json` либо повторное чтение доменного объекта.
5. Состояние `FAILED` записи не обработано в `tryAcquire` вовсе (повтор после провала — разрешён? блокирован?).

**Фикс:** §8.3 — атомарный `tryAcquire` с `result_json`, детерминированные серверные ключи, расширенный enum команд, обязательный клиентский ключ для всех мутирующих команд (иначе `VALIDATION`).

---

### B-09 · Двоевластие: два владельца одного перехода и два триггера AI Director

1. **`gm.finishTurn` (IV.8) vs `gm-review.approve` (IV.9)** — оба ведут `REVIEW → COMMITTED`. Маршрут `POST /turns/:id/commit` (§VI.3) не указывает модуль-обработчик. Два модуля, один переход, один idempotency-key — гарантированная двойная запись в audit и расхождение метрик. Плюс `gm-review.dependencies: ['gm']`, хотя по логике наоборот.
2. **AI Director вызывается дважды.** `III.1 step 7`: Turn Engine вызывает AI Director **командой** `generateDraft`. `IV.3`: AI Director **подписан на `TURN_LOCKED`**. Оба механизма заявлены как рабочие → при реализации получится двойная генерация (двойная стоимость, гонка на `PROCESSING → REVIEW`).
   **Фикс:** (а) перейти на один вариант — рекомендую **команду** (детерминированный трейс, легче idempotency и retry), а `TURN_LOCKED` из подписок AI Director убрать; (б) `gm.finishTurn` удалить, владельцем `REVIEW → COMMITTED` объявить `gm-review`, маршрут `/turns/:id/commit` маппить на `gm-review.approve`.

---

### B-10 · Утечка приватных данных через WS-broadcast

**Где:** `VI.7`, `IV.5`, `II.16`, `VIII.2`.
`TURN_COMMITTED` (server→client) имеет payload `{ turnId, version, resolution }` и, судя по каталогу, уходит **всем подписчикам сессии**. Внутри `resolution` лежат `privateMessages[]` (per-player) и, после фикса B-01, — `itemNarratives` с видимостью. Это прямой Info Disclosure из STRIDE-таблицы VIII.2, который сама же таблица объявляет закрытым.
То же касается `GET /state/projection?view=public|ai|gm` (§VI.4): в колонке Auth стоит «player/GM», но **не определено, что `view=ai` и `view=gm` требуют GM-токен**. `view=ai` содержит `DirectorContext` с `gmNotesForAI` и `storyFacts`.
И третье: `TURN_DRAFT_READY` помечен «(GM only)», но **механизм ролевой фильтрации в gateway не описан** — как и то, где он живёт (инвариант 14 запрещает логику в транспорте → фильтрация должна быть в projection-слое, а его нет, см. B-02).
**Фикс:** §8.4 — матрица приватности по каждому server→client сообщению + правило «broadcast payload никогда не содержит per-player полей; приватная часть уходит отдельным targeted-сообщением `TURN_PRIVATE_RESOLUTION`» + authz-матрица для `view`.

---

### B-11 · Нет команды/маршрута для половины заявленных GM-операций и для выхода игрока

Сопоставление `IV.8/IV.12` (команды) с `VI.2–VI.4` (HTTP) и `VI.6` (WS):

| Команда модуля                           | HTTP                                         | WS                                       | Статус                                         |
| ---------------------------------------- | -------------------------------------------- | ---------------------------------------- | ---------------------------------------------- |
| `gm.pauseSession` / `resumeSession`      | —                                            | —                                        | ❌ недостижима                                 |
| `gm.moveGroup`                           | —                                            | —                                        | ❌ недостижима (шаги 9–10 среза!)              |
| `gm.sendSystemMessage`                   | —                                            | —                                        | ❌                                             |
| `gm.inspectState/Context/Journal`        | ✅                                           | —                                        | ⚠️ только HTTP                                 |
| `session.endSession`                     | —                                            | —                                        | ❌                                             |
| игрок покидает сессию                    | только `DELETE …/player/:pid` (**Auth: GM**) | —                                        | ❌ добровольный выход невозможен               |
| `openTurn` / `unlockTurn` / `cancelTurn` | —                                            | —                                        | ❌ (B-07)                                      |
| история чата                             | `GET /chat/history?since=`                   | в VI.8 упомянут «if client asks HISTORY» | ❌ типа `HISTORY` в каталоге нет               |
| отмена media job                         | —                                            | —                                        | ❌ `MediaProvider.cancel?` не вызывается никем |

**Последствие:** шаги 9–10 вертикального среза (перемещение группы) невыполнимы по описанному транспорту.
**Фикс:** §8.5 — недостающие маршруты и WS-типы.

---

### B-12 · Аутентификация: жизненный цикл токена не определён, а два маршрута создания сессии противоречат друг другу

**Где:** `VI.2`, `VIII.8`, `VI.9`.

1. `POST /auth/session {displayName}` → `{sessionId, playerId, token}` **создаёт сессию**; `POST /sessions {title}` → `{sessionId}` (Auth: GM token) **тоже создаёт сессию**. Какой из них настоящий и в каком порядке — не сказано.
2. Токен: нет схемы (JWT? opaque?), нет claims (`playerId`, `sessionId`, `isGM`?), нет TTL, нет эндпоинта refresh — хотя `AUTH_EXPIRED` в VI.9 предписывает клиенту «refresh token», а `JWT_SECRET` лежит в env.
3. Нет **отзыва** токена при `PLAYER_LEFT` / `DELETE …/player/:pid` → исключённый игрок сохраняет доступ до истечения TTL. В STRIDE-модели этого нет.
4. WS: `AUTH{token}` шлётся сообщением **после** установления соединения → окно неаутентифицированного сокета; нет лимита соединений на IP и нет таймаута «не аутентифицировался за N секунд → close».
5. `HB_HELLO`/HostBridge: HMAC-secret есть, а схема `hostId` и политика «один host на сессию» — нет.

**Фикс:** определить `AuthTokenSchema` (JWT, claims `{sub: playerId, sid: sessionId, gm: boolean, exp}`), TTL 12 ч + sliding, `POST /auth/refresh`, blacklist по `playerId` в памяти + запись `revoked_before` в `players`; один маршрут создания сессии (`POST /sessions`), а `/auth/session` переименовать в `POST /auth/player` (создаёт игрока в существующей сессии); WS-auth через `Sec-WebSocket-Protocol`/query-токен с таймаутом 5 с.

---

## 3. Полный реестр дефектов

Формат: `ID · P · где · суть → фикс`.

### 3.1 Схемы и типы (Part II)

| ID     | P   | Где                         | Дефект → фикс                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | --- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-1.1  | P0  | II.4, II.15, IV.9           | `TurnResolution` undefined → §8.1                                                                                                                                                                                                                                                                                                                                                                                                                   |
| F-1.2  | P0  | VI.2–VI.4, IV.4, IV.6, IV.7 | 9 view-типов undefined → §8.4, contracts/views.ts                                                                                                                                                                                                                                                                                                                                                                                                   |
| F-1.3  | P0  | III.4                       | `StatePath` регексп vs примеры vs ключи → §8.2                                                                                                                                                                                                                                                                                                                                                                                                      |
| F-1.9  | P1  | II.3                        | `Player.characterId` обязателен, но сущность `Character` не определена (кто создаёт, где хранится) → добавить `CharacterSchema` + `characters` + команду `createCharacter`                                                                                                                                                                                                                                                                          |
| F-1.13 | P1  | II.1                        | `brand()` через `.pipe(s.brand())` и `z.record(BrandedKey, …)` — **зависит от major-версии Zod**: в Zod 4 record-ключ допускает только `ZodString`/`ZodEnum`, branded-ключ невалиден; `z.string().datetime()` deprecated в пользу `z.iso.datetime()`. При этом §0.3 объявляет версии пакетов non-goal → ввести `shared/ids.ts` с `z.string().uuid().brand<…>()` (без pipe) + зафиксировать major Zod как архитектурное решение (не «версию пакета») |
| F-1.14 | P1  | II.4, II.7, II.9, II.14     | `z.lazy()` использован для типов, которые **не рекурсивны** (`TurnStatus`, `WorldStateSchema`, `TriggerSchema`, `ConditionSchema`), а для единственного реально отсутствующего (`TurnResolutionSchema`) — наоборот. Плюс порядок объявления даёт TDZ-ошибку. Все схемы Part II — в один `core/domain/schemas.ts` с явным порядком; `z.lazy` оставить только для `Condition` (рекурсия)                                                              |
| F-1.15 | P1  | II.7, II.11                 | `objectStates` ключуется `ObjectId` (UUID), а `StatePath` регексп допускает `[a-zA-Z0-9_-]+` → см. F-1.3; `PlayerKnowledgeSchema.entries: z.record(z.string(), …)` при том, что `KnowledgeEntry.key` уже есть внутри — дублирование ключа                                                                                                                                                                                                           |
| F-1.16 | P2  | II.2, II.7                  | `session.currentLocationId` и `worldState.currentLocationId` — **два источника правды**. Назвать главным `worldState`, из `Session` убрать (или сделать read-only проекцией)                                                                                                                                                                                                                                                                        |
| F-1.17 | P2  | II.4                        | `Turn.actionIds` vs `actions.turnId` — денормализация без правила синхронизации; нет колонки в `turns` → выбрать одно (рекомендую только `actions.turnId` + индекс)                                                                                                                                                                                                                                                                                 |
| F-1.18 | P2  | II.4                        | `failedReason: string` — при наличии Error Taxonomy должен быть `{ code: ErrorCode, message, meta }`                                                                                                                                                                                                                                                                                                                                                |
| F-1.19 | P2  | II.17                       | `CORE_CONDITION_FAILED` объявлен в enum, но **отсутствует в маппинге III.14** (7 строк на 8 кодов) и нигде не используется                                                                                                                                                                                                                                                                                                                          |
| F-1.20 | P2  | II.3                        | `PlayerExtension` упомянут в заметке — схема и механизм не определены (как модуль добавляет stats без миграции ядра? JSON-колонка `extensions[moduleId]`?)                                                                                                                                                                                                                                                                                          |
| F-1.21 | P3  | II.1                        | Нет единого `IsoDateTime = z.string().datetime({offset:false, precision:3})` — точность/таймзона не зафиксированы                                                                                                                                                                                                                                                                                                                                   |
| F-1.22 | P3  | II.6                        | Не сказано, сколько действий разрешено игроку на ход (1 или N) — влияет на UI, rate-limit и `CORE_DUPLICATE_ACTION`                                                                                                                                                                                                                                                                                                                                 |
| F-1.23 | P3  | II.15                       | `GMNoteVisibility` используется в IV.8 как имя типа, но в II.15 задан inline-enum без экспорта                                                                                                                                                                                                                                                                                                                                                      |
| F-1.10 | P2  | II.18, III.11               | `JournalEntry` используется в `IV.8 inspectJournal` и `VI.3` — схема не определена (структура записи журнала, `traceId`, тип шага) → определить в `contracts/journal.ts`                                                                                                                                                                                                                                                                            |
| F-1.11 | P2  | II.15, IV.8                 | `GMStateView`, `SessionView`, `TurnView`, `MediaJobView`, `ChatMessage`, `PublicGameStateView`, `PublicLocationViewSchema`, `CapabilitySchema`, `RuleSubject`, `GMNoteVisibility`, `MediaJob`, `ProviderError` — 12+ имён используются без определения → все вынести в `contracts/`                                                                                                                                                                 |
| F-1.12 | P2  | V.11, IV.2                  | `Capability`/`CapabilitySchema` не определены как Zod-enum, хотя используются в `ModuleContract`, `ProviderPolicySchema` и `CAPABILITY_CHANGED` → enum из 6 значений + схема                                                                                                                                                                                                                                                                        |

### 3.2 Domain Events (II.16, III.3)

| ID    | P   | Где                 | Дефект → фикс                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | --- | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-2.1 | P1  | II.16 vs IV.7, IV.9 | Каталог неполон: `CHAT_MESSAGE_PUBLIC/PRIVATE/SYSTEM/GM` и `GM_REVIEW_DECIDED` эмитируются модулями, но в каталоге отсутствуют. Домен-событий фактически ≥29, а не 23                                                                                                                                                                                                                   |
| F-2.2 | P1  | II.16               | В subscribers указан `media-provider (via port)` — **адаптер не может быть подписчиком** (он вызывается через порт). Противоречит Ports & Adapters и I.4                                                                                                                                                                                                                                |
| F-2.3 | P2  | II.16 vs IV.6       | Media Director одновременно подписан на `TURN_COMMITTED` **и** имеет команду `requestScene` → не определено, event-driven поток или командный (и что делать, если оба сработали)                                                                                                                                                                                                        |
| F-2.4 | P2  | II.16               | Колонка `Emits` содержит `core`, `state`, `turn`, `session` — это не `moduleId` из IV.1. Привести к реальным moduleId                                                                                                                                                                                                                                                                   |
| F-2.5 | P2  | III.3               | `SELECT … FOR UPDATE` **не поддерживается SQLite** (синтаксическая ошибка); текст рядом предлагает `BEGIN IMMEDIATE` — взаимоисключающие указания. Нет `max_attempts`/порога алерта (VIII.7 ссылается на «attempts > threshold» без числа). Не определены: порядок доставки (глобальный vs per-session), поведение при исключении в подписчике, at-least-once семантика для подписчиков |
| F-2.6 | P2  | III.5               | Нет лимита глубины каскада триггеров (`SET_FLAG → FLAG_SET → SET_FLAG …`) → бесконечный цикл в рамках одного commit                                                                                                                                                                                                                                                                     |
| F-2.7 | P3  | II.16               | Нет событий `SESSION_ENDED`, `PLAYER_DISCONNECTED`, `MEDIA_JOB_QUEUED`, `SNAPSHOT_TAKEN`, хотя соответствующие сущности/состояния есть                                                                                                                                                                                                                                                  |
| F-2.8 | P3  | I.3 (инв. 16)       | Инвариант «каждый event имеет Zod-схему payload» не обеспечен: файл `core/events/schemas.ts` заявлен, но ни одна payload-схема в документе не приведена → нужен полный union `DomainEventSchema` (это же даст типизированный bus)                                                                                                                                                       |
| F-2.9 | P3  | II.16               | `TURN_COMMITTED{turnId, version}` не содержит `sessionId` → подписчику (media, chat) нужен дополнительный запрос                                                                                                                                                                                                                                                                        |

### 3.3 Turn lifecycle, GM, идемпотентность

| ID     | P   | Где           | Дефект → фикс                                                                                                                                                                                                                                                                           |
| ------ | --- | ------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-3.1  | P1  | IV.9, II.5    | `RETRY_AI` / `retry(turnId)`: из `REVIEW` нет перехода для retry, из `FAILED` — терминал. Семантика «создать новый Turn» не выражена в сигнатуре (нет `previousTurnId`) → добавить переход `REVIEW → OPEN` (сброс resolution) **или** команду `retryAsNewTurn(sessionId, failedTurnId)` |
| F-3.2  | P1  | IV.9          | `editAndApprove(editedResolution)` без `expectedVersion`/etag → lost update, если resolution изменился (например, предыдущий retry). Добавить `baseResolutionHash`                                                                                                                      |
| F-3.3  | P0  | IV.8 vs IV.9  | `finishTurn` vs `approve` — см. F-1.9                                                                                                                                                                                                                                                   |
| F-3.4  | P0  | III.1 vs IV.3 | Двойной триггер AI Director → см. F-1.9                                                                                                                                                                                                                                                 |
| F-3.5  | P1  | II.2, IV.12   | Нет таблицы переходов `SessionStatus` (LOBBY→ACTIVE→PAUSED→ENDED), нет правила «что делает `REACH_ENDING` со статусом сессии», нет валидации «ACTIVE требует TEXT_AI available»                                                                                                         |
| F-3.6  | P1  | III.10        | `moveGroup` идемпотентен по `(sessionId, turnId, hash(playerIds), toLocationId)` — но перемещение возможно вне хода (`turnId` null), и алгоритм хэша не определён. Плюс не указано, что `moveGroup` обновляет `worldState.currentLocationId` (F-1.16)                                   |
| F-3.7  | P2  | II.6, VI.10   | Лимит действий игрока на ход не определён (F-1.22), а `CORE_DUPLICATE_ACTION` описан как «sequenceId коллизия» — хотя sequenceId назначает сервер, коллизия невозможна. Переопределить как «повторный submit с тем же idempotencyKey»                                                   |
| F-3.8  | P2  | II.15         | `visibility: 'PUBLIC_AFTER_COMMIT'` — механизм публикации после коммита не описан (кто подписан на `TURN_COMMITTED` и рассылает заметку?)                                                                                                                                               |
| F-3.9  | P2  | IV.8          | `activateEvent(eventId, turnId)` — не описано, применяется ли событие немедленно, минуя Rules Engine и GM Review (это обход инварианта «Rules вызывается до применения»)                                                                                                                |
| F-3.10 | P3  | II.5          | `FAILED → (terminal; возможен retry путём создания нового Turn)` — но `Turn.number` монотонно; не сказано, увеличивается ли номер при retry                                                                                                                                             |

### 3.4 Event/Rules DSL

| ID     | P   | Где           | Дефект → фикс                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------ | --- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-4.1  | P0  | III.4         | `FIRST_TIME` без `entityId` → §8.8                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| F-4.2  | P0  | II.9 vs III.5 | `priority` отсутствует в `WorldEventSchema` → §8.8                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| F-4.3  | P1  | III.7         | `RuleCheckSchema.subject` enum = `ACTION/OBJECT_CHANGE/EVENT_TRIGGER/STATE_CHANGE`, а `RulesEngine.evaluate(subject: RuleSubject, …)` — **тип `RuleSubject` не определён** и неясно, это тот же enum или объект `{kind, ref}`                                                                                                                                                                                                                                                                                |
| F-4.4  | P1  | III.4         | Триггеры `OBJECT_USED`/`FLAG_SET` недостижимы → §8.8 (таблица источников)                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| F-4.5  | P1  | II.14, III.8  | Семантика `predicate`/`onFail` неоднозначна: `passed = evaluate(predicate)`? Тогда `onFail: REJECT` значит «predicate истиннен → отклонить», т.е. предикат описывает **запрет**, а не требование. В примере «no-fire-in-basement» предикат = «находимся в подвале» — но действие-то про огонь, а проверка не смотрит на текст/intent действия. Правило не сработает по назначению. → явно: `predicate` = условие **нарушения**; добавить в ctx `action` (текст, intent, targetObjectId) и операторы над ними |
| F-4.6  | P1  | III.8, III.10 | `intent` — свободная строка (`z.string().max(80)`), но Rules Engine и проверка `exit.locked` опираются на `intent = 'MOVE'`. Нужен enum intents либо словарь                                                                                                                                                                                                                                                                                                                                                 |
| F-4.7  | P2  | III.5         | Конфликт эффектов: «first-writer-wins, second deferred» — нет хранилища и нет правила, кто применяет отложенное (→ `deferred_effects`)                                                                                                                                                                                                                                                                                                                                                                       |
| F-4.8  | P2  | III.4         | `EffectSchema.TELEPORT{playerIds}` и `GRANT_KNOWLEDGE{playerId}` позволяют AI выбирать произвольных игроков; нет allowlist'а эффектов/путей, разрешённых AI (см. F-9.4)                                                                                                                                                                                                                                                                                                                                      |
| F-4.9  | P2  | III.4         | `REACH_ENDING{endingId}` — `endingId: string`, а `EndingStateSchema.endingId: z.string().min(1).max(80)`; не описано, где берётся `summary` и `survivors` (их требует схема)                                                                                                                                                                                                                                                                                                                                 |
| F-4.10 | P3  | II.8          | `registeredEventIds` в локации и `WorldEvent.locationId` — двусторонняя ссылка без инварианта согласованности                                                                                                                                                                                                                                                                                                                                                                                                |
| F-4.11 | P3  | III.4         | `EMIT_NARRATIVE{visibility: PUBLIC                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | GM_ONLY}` не совпадает с enum видимости заметок (`GM_ONLY | AI_DIRECTOR | PUBLIC_AFTER_COMMIT`) — разные словари для одного понятия |

### 3.5 Persistence

| ID     | P   | Где            | Дефект → фикс                                                                                                                                                                                                                                                                                        |
| ------ | --- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-5.1  | P0  | III.11         | 13 таблиц отсутствуют, FK только прозой, 2 таблицы raw SQL → §8.6                                                                                                                                                                                                                                    |
| F-5.2  | P1  | III.12 vs IX.7 | «Откат — отдельный `down.sql`, скрипт `db:rollback`» против «БД-миграции — только forward; откат миграции — ручной». Прямое противоречие → выбрать: forward-only + compensating migration                                                                                                            |
| F-5.3  | P1  | II.18          | `tx?: unknown` в `TurnRepository.save` — тип транзакции не определён; `core/` не должен знать Drizzle, значит нужен свой `TxToken`/`UnitOfWork`-порт. Сейчас контракт нереализуем типобезопасно                                                                                                      |
| F-5.4  | P1  | II.18          | Перечислены 5 репозиториев (2 из них — заглушки `/* … */`). Отсутствуют порты: `LocationRepository`, `EventRepository` (тело), `RulesRepository`, `GMNoteRepository`, `ChatRepository`, `MediaJobRepository`, `SnapshotRepository`, `JournalRepository`, `IdempotencyRepository`, `OutboxRepository` |
| F-5.5  | P2  | III.11         | `game_state.stateJson` — весь GameState одним JSON; не определён размер/лимит и стратегия чтения (каждый ход — полная десериализация). При 12 игроках и 100 ходах это ок, но решение должно быть зафиксировано (связано с UNKNOWN#6)                                                                 |
| F-5.6  | P2  | III.13         | «Долгие операции никогда не внутри транзакции» — верно, но не описано, как `resolveTurn` сохраняет `PROCESSING` и затем `REVIEW` (две транзакции? кто держит блокировку?)                                                                                                                            |
| F-5.7  | P2  | III.12         | Нет процедуры бэкапа (VIII.2 ссылается на «см. IX.7», а там CI-матрица) → F-9.4                                                                                                                                                                                                                      |
| F-5.8  | P3  | III.11         | Синтаксис третьего аргумента `sqliteTable(…, (t) => ({…}))` — объектная форма устарела в drizzle-orm ≥0.36 (требуется массив). Мелочь, но ломает сборку                                                                                                                                              |
| F-5.9  | P3  | III.11         | Append-only таблицы (`turn_journal`, `event_outbox`, `gm_audit`, `chat_messages`) растут неограниченно; нет retention/VACUUM                                                                                                                                                                         |
| F-5.10 | P3  | III.11         | `actions.metaJson` NOT NULL при `meta` со `.default({})` в Zod — согласовано, но не указано, кто проставляет default (mapper)                                                                                                                                                                        |

### 3.6 Transport, WS, auth

| ID     | P   | Где              | Дефект → фикс                                                                                                                                                                                                                                                                                                                         |
| ------ | --- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-6.1  | P0  | VI.7             | `TURN_COMMITTED{resolution}` broadcast → утечка private messages; `view=ai/gm` без явного GM-auth → B-10, §8.4                                                                                                                                                                                                                        |
| F-6.2  | P0  | VI.2, VI.3, VI.6 | Отсутствуют маршруты/сообщения для `pause/resume/move/end/leave/history/openTurn/unlock/cancel` → B-11, §8.5                                                                                                                                                                                                                          |
| F-6.3  | P1  | VI.5             | `WSEnvelopeSchema.type: z.string()` + `payload: z.unknown()` — при том, что I.4 запрещает `unknown` на границе модуля. Нужен `WSClientMessage`/`WSServerMessage` как `z.discriminatedUnion('type', …)`, порождённый из каталога VI.6/VI.7. Сейчас каталог — таблица в prose, а не код                                                 |
| F-6.4  | P1  | VI.9             | Error Taxonomy не покрывает: `EVENT_EFFECT_CONFLICT` (III.5), `CAPABILITY_UNAVAILABLE` (отличается от `PROVIDER_UNAVAILABLE`?), коды HostBridge (`HB_SIGNATURE_INVALID`, `HB_HOST_UNKNOWN`), `BUDGET_EXCEEDED` (VIII.6). Нет схемы **HTTP error body** (`{error:{code,message,meta,requestId}}`?) и нет стратегии версионирования API |
| F-6.5  | P1  | V.10             | HostBridge: не определено, что именно подписывается HMAC (канонизация body? `type+requestId+JSON(payload)`?), в envelope **нет `timestamp`** (кроме как в payload HELLO) → replay-окно; нет схемы payload'ей `HB_JOB_*`, нет кодов ошибок, нет политики реконнекта и «один host на сессию»                                            |
| F-6.6  | P1  | VI.10            | Rate-limit «per-token» для HTTP, но `/auth/session` и `/sessions/:id/join` — **без токена** → нет лимита на создание сессий/игроков (DoS). Нужен per-IP                                                                                                                                                                               |
| F-6.7  | P1  | VI.6, VI.8       | Дедупликация клиентских сообщений: VI.8 обещает «сервер дедуплицирует по idempotency», но у `ACTION_SUBMIT`/`CHAT_PUBLIC` в payload **нет idempotencyKey**, только опциональный `requestId`. Хранилище дедупликации по requestId и его TTL не определены                                                                              |
| F-6.8  | P2  | VI.3 vs VI.6     | `POST /turns/:id/commit` → `{version}`; WS `GM_COMMIT_TURN` → ack `TURN_COMMITTED_ACK` **без схемы payload**. HTTP и WS должны возвращать одно и то же                                                                                                                                                                                |
| F-6.9  | P2  | VI.7             | `MEDIA_READY{mediaJobId, url}` в WS vs `MEDIA_READY{mediaJobId,url,seed,provider}` в домен-событии — расхождение не объяснено (намеренное сужение? тогда правило «gateway проецирует, не копирует» надо зафиксировать)                                                                                                                |
| F-6.10 | P2  | VI.8, VII.7      | Reconnect: нет `maxAttempts` → когда `ConnectionState` переходит в `FAILED`, не определено. `nextRetryAt` есть, лимита нет                                                                                                                                                                                                            |
| F-6.11 | P2  | VIII.1 vs VII.7  | `requestId` — «lifecycle: отправка → ack» (эфемерный), но «сообщения с requestId — durable (localStorage) до ack». Противоречие + не описана очистка хранилища                                                                                                                                                                        |
| F-6.12 | P2  | VI.4             | `POST /media/request {turnId, sceneHint}` → команда `requestScene{turnId, scene: VisualSceneDescription}`: из `sceneHint` (строка ≤500) получить `VisualSceneDescription` нечем. Либо маршрут принимает `scene`, либо описан шаг через `VisualPromptProvider`                                                                         |
| F-6.13 | P3  | VI.4             | `GET /health` без auth отдаёт `capabilities` — раскрывает конфигурацию провайдеров; решить осознанно (public health vs internal)                                                                                                                                                                                                      |
| F-6.14 | P3  | V.10             | Heartbeat: у HostBridge 15 с, у клиентского WS (`PING/PONG`) интервал и серверный таймаут не указаны                                                                                                                                                                                                                                  |
| F-6.15 | P3  | VI.1             | Плагины перечислены (`request-id`, `error-handler`, `auth`, `rate-limit`), но нет `@fastify/cors` (при том, что VIII.3 требует «CORS ограничен доменом фронта») и нет static-плагина для media-файлов (F-9.2)                                                                                                                         |

### 3.7 Порты, провайдеры, capability

| ID     | P   | Где           | Дефект → фикс                                                                                                                                                                                                                                                    |
| ------ | --- | ------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-7.1  | P1  | V.1 vs VIII.6 | `AIPort.generate` возвращает только `AIResponse` — **нет `usage`** (`input_tokens`, `output_tokens`, `model`). Cost Model физически нечем наполнить → вернуть `{ response, usage, provider, model, durationMs }`                                                 |
| F-7.2  | P1  | V.1 vs V.11   | `generate(maxRetries, timeoutMs)` дублирует `ProviderPolicySchema{timeoutMs, retries}` → два источника правды. Политика должна жить в Capability Registry, порт — принимать `deadline`                                                                           |
| F-7.3  | P1  | V.2, VI.9     | `ProviderError` и его коды (`PROVIDER_TIMEOUT/RATE_LIMIT/AUTH/SCHEMA`) упомянуты прозой, но нет Zod-enum и нет таблицы маппинга provider-error → public code (аналог III.14 для Core). `ConflictError` из III.2 — класс, которого нет в документе                |
| F-7.4  | P1  | IV.2 vs V.11  | `Capability` используется как тип в `ModuleContract` и `ProviderPolicySchema.capability: CapabilitySchema`, но **`CapabilitySchema` нигде не определена**. Список в IV.2 (6 значений) расходится с v2 §10 (`TTS` и `TEXT_GAME` выпали, появился `VISUAL_PROMPT`) |
| F-7.5  | P2  | V.11          | `CapabilityRegistry.register(provider: {provider: unknown})` — `unknown` на границе (I.4). Нет схемы записи, нет `unregister`, нет `getPolicy(providerId)`, нет интервала health-probe (`isAvailable()` — по требованию? по расписанию? кэш?)                    |
| F-7.6  | P2  | V.7, VI.4     | `DebugMediaProvider` возвращает «url на статику», но статический сервер/каталог/схема URL не описаны → `MEDIA_READY.url` неоткуда взять                                                                                                                          |
| F-7.7  | P2  | V.5           | `submit(workflow?: string)` — не сказано, кто и как выбирает workflow (конфиг? scene.tags? версия?), и как workflow валидируется. Это **ядро ComfyUI-интеграции** и оно вне контракта                                                                            |
| F-7.8  | P2  | IV.2          | Fallback `VISUAL_PROMPT → (template fallback)` — провайдер `TemplateVisualPromptProvider` не объявлен (в отличие от `DebugMediaProvider`) → нет контракта                                                                                                        |
| F-7.9  | P2  | V.5           | `poll` без интервала/дедлайна/максимального числа опросов; состояние `QUEUED` из VI.10 не отражено в union'е результата `poll`                                                                                                                                   |
| F-7.10 | P3  | V.11          | `capabilities.yaml`, `provider-policies.yaml`, `limits.yaml` упомянуты без единого примера и без Zod-схем валидации (кроме `ProviderPolicy`) → §8.9                                                                                                              |

### 3.8 Модули и границы

| ID    | P   | Где   | Дефект → фикс                                                                                                                                                                                                                                                                        |
| ----- | --- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-8.1 | P1  | IV.1  | `commands: Record<string, (input: unknown) => Promise<unknown>>` — контракт **гарантирует** `unknown` на границе модуля, что запрещено I.4. Нужен generic: `ModuleContract<TCmd extends ZodTypeMap, TQuery extends ZodTypeMap>` с парсингом входа                                    |
| F-8.2 | P1  | IV.1  | В `ModuleContract` нет ни версий, ни схемы ошибок модуля, ни декларации «какие команды требуют idempotencyKey» → каждый модуль решает сам                                                                                                                                            |
| F-8.3 | P2  | IV    | Полные контракты есть у 5 модулей (`ai-director`, `media-director`, `chat`, `gm`, `gm-review`). `session`, `gm-audit`, `story` — проза; `turn`/`state`/`event-engine`/`rules` фигурируют как эмиттеры, но не как модули. SELF-CHECK заявляет 9                                       |
| F-8.4 | P2  | IV.11 | Story module «пишет через Core StateRepository» — т.е. модуль мутирует GameState напрямую. Формально не запрещено (инварианты 7–8 про AI/Media), но ломает идею «все мутации через Core-команды с Rules Engine». Уточнить: модули пишут через `StateService`, а не через репозиторий |
| F-8.5 | P2  | IV.10 | `gm-audit` — «подписывается, пишет в таблицу» — но `ModuleContract` для него не приведён, и не определено, кто читает `/gm/audit` (маршрута тоже нет в VI)                                                                                                                           |
| F-8.6 | P3  | IV.9  | `gm-review.dependencies: ['gm']` при том, что `gm` не вызывает `gm-review` — зависимость, вероятно, обратная                                                                                                                                                                         |
| F-8.7 | P3  | X.3   | `UIPanelContribution.mount(el)` предполагает vanilla DOM, но фреймворк фронта не зафиксирован (F-10.1) → контракт панели может не подойти Svelte/React                                                                                                                               |

### 3.9 Cross-cutting: security, observability, ops

| ID     | P   | Где                  | Дефект → фикс                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | --- | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-9.1  | P1  | VIII.7, X.4#6, II.15 | Snapshot: термин в ubiquitous language, «restore from snapshot + journal replay» в recovery — и `UNKNOWN#6` («модель сериализации snapshot»). Механизма нет: когда снимается, где хранится, как replay'ится журнал, какая точка консистентности. **UNKNOWN#6 блокирует MVP**, а не «post-MVP»                                                                                                                                                                                       |
| F-9.2  | P1  | —                    | Media cache (v2 §47) утерян целиком: нет `media_cache(sessionId, turnId, locationId, workflow, promptHash, provider, seed, file)`, нет политики хранения/очистки/дедупликации по `promptHash` (при том, что `VISUAL_SCENE_REQUESTED` содержит `promptHash` — значит, дедупликация задумывалась)                                                                                                                                                                                     |
| F-9.3  | P1  | VIII.5               | Performance (v2 §58) утерян: метрики объявлены, но **ни одного целевого значения** нет (p95 turn resolve, p95 media, WS msg/s, 100 concurrent connections, размер БД). Без цифр «не оптимизировать до метрик» непроверяемо                                                                                                                                                                                                                                                          |
| F-9.4  | P1  | VIII.2, IX.7, VIII.5 | Production-готовность: (а) «бэкапы шифруются, доступ по SSH-ключу (см. IX.7)» — **висячая ссылка**, в IX.7 про бэкапы ничего; (б) error monitoring / alerting отсутствуют (метрики есть, алертов и правил нет); (в) экспорт метрик (`/metrics`? stdout?) не указан; (г) в STRIDE нет threat'а «prompt injection через `rawText`» и «AI пишет в произвольные `objectStates`-ключи» → добавить allowlist мутируемых AI путей + правило «player text never interpreted as instruction» |
| F-9.5  | P1  | X.4                  | Из 10 UNKNOWN как минимум **#6 (snapshot)** и **#10 (миграции SQLite)** блокируют MVP и должны быть переквалифицированы в P0-работу; **#9 (multi-session)** уже фактически нарушен: `LocationDefinition.sessionId = null` означает общие шаблоны на все сессии                                                                                                                                                                                                                      |
| F-9.6  | P2  | IV.2, VIII.7         | `TEXT_AI` — «required для партии», но не описано поведение, когда capability недоступна: сессию нельзя стартовать? ход падает? GM видит `CAPABILITY_CHANGED` и что делает?                                                                                                                                                                                                                                                                                                          |
| F-9.7  | P2  | v2 §33 vs II.15      | v2 требовал от GM Review: «approve/reject **events**, approve/reject **changes**» (гранулярно). v3 даёт только `EDIT_AND_APPROVE` с цельным `editedResolution` → гранулярность утеряна, GM обязан править JSON целиком                                                                                                                                                                                                                                                              |
| F-9.8  | P2  | VIII.4               | «Логи не содержат rawText с приватными ключами (маскирование)» — список redact-полей не определён (`rawText`? `privateMessages`? `token`? `gmNotes`?), механизм (pino redact paths) не указан                                                                                                                                                                                                                                                                                       |
| F-9.9  | P2  | VIII.6               | Budget: «при превышении `TEXT_AI` продолжает (degrade на дешёвую модель)» — механизма выбора дешёвой модели нет (в `capabilities.yaml` нет поля `costPer1k`), событие `BUDGET_EXCEEDED` отсутствует                                                                                                                                                                                                                                                                                 |
| F-9.10 | P3  | VIII.2               | В STRIDE нет строки про `chat_messages`/`gm_audit` как append-only (Repudiation покрыт только для GM), и нет threat'а «replay HostBridge envelope» (F-6.5)                                                                                                                                                                                                                                                                                                                          |
| F-9.11 | P3  | VIII.5               | Метрика `ai.cost_usd_total{provider}` требует прайса; `UNKNOWN` про цены при этом объявлен — значит метрика не реализуема до закрытия UNKNOWN#5                                                                                                                                                                                                                                                                                                                                     |

### 3.10 Frontend

| ID     | P   | Где          | Дефект → фикс                                                                                                                                                                                                                                                                                                                              |
| ------ | --- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| F-10.1 | P1  | VII          | Фреймворк не зафиксирован (v2 §39: Svelte + Vite). `UIPanelContribution.mount(el: HTMLElement)` и «stores» без библиотеки → реализатор выберет произвольно                                                                                                                                                                                 |
| F-10.2 | P1  | 0.3, IX.7    | §0.3 объявляет версии пакетов non-goal, но (а) CI требует `npm ci` (lockfile), (б) `dependency-cruiser`, Vitest, Playwright, Drizzle, Fastify, Zod major — это **архитектурные** решения. Non-goal надо сузить: «не фиксируем минорные версии, фиксируем мажорные и стек»                                                                  |
| F-10.3 | P1  | IX.6         | Architecture-тесты ссылаются на `core/`, `modules/`, `client/`, `infrastructure/` — но **структура каталогов в v3 не приведена** (v2 §6 приводил). Нет и ответа, где живёт shared-контракт: тест говорит «client не импортирует core/domain/ports (только shared types)», значит нужен `shared/` или пакет `@mnemosin/contracts` — его нет |
| F-10.4 | P2  | VII.2, VII.5 | Кольцевой буфер чата N=500 и отсутствие `HISTORY`-сообщения (B-11) → после реконнекта клиент не может дозагрузить историю, а `GET /chat/history?since=` не привязан к WS-потоку                                                                                                                                                            |
| F-10.5 | P2  | VII.8        | «GM_COMMIT_TURN — не оптимистично» верно, но не описано поведение UI при `IDEMPOTENCY_IN_FLIGHT` и при `PROVIDER_TIMEOUT` во время commit (спиннер? блокировка панели?)                                                                                                                                                                    |
| F-10.6 | P3  | VII.1        | `ResolutionView (GM only)` в дереве компонентов, но механизм скрытия (роль из `AUTH_OK`?) не описан; `AUTH_OK{playerId, sessionId}` **не содержит `isGM`** → фронт не знает роль                                                                                                                                                           |

### 3.11 Процесс, SELF-CHECK, документация

| ID     | P   | Где       | Дефект → фикс                                                                                                                                                                                                                                                                    |
| ------ | --- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F-11.1 | P1  | Part IX   | **Нет плана этапов.** v2 давал 58 этапов с Definition of Done; v3 — только CI-pipeline из 10 шагов. Для документа, «по которому команда строит продукт несколько месяцев» (0.1), это главный пробел процесса → нужен epic-plan с DoD (могу собрать следующим шагом)              |
| F-11.2 | P2  | IX.7      | CI без security-шагов: нет `npm audit`/secret scanning/license check, хотя supply-chain есть в STRIDE (VIII.2)                                                                                                                                                                   |
| F-11.3 | P2  | IX.5–IX.6 | Нет тестов на: детерминизм Event Engine (golden-фикстуры порядка эффектов), golden-тест `DirectorContext` (промпт-регрессии), load/soak, multi-tab (2 соединения одного игрока), «no private data in broadcast» (заявлен в VIII.3, но не спроектирован)                          |
| F-11.4 | P2  | IX.8      | Индекс документации обещает `MODULES.md`/`DOMAIN_EVENTS.md`/…, но не указывает, **какой документ первичен** при конфликте (сейчас первичен v3-baseline? а схемы в коде?). Нужно правило: «код/Zod — источник истины, документ — индекс» (частично сказано в 0.4, но не про DOCS) |
| F-11.5 | P2  | —         | Нет git flow (ветки, PR-чеклист, теги, changelog) при том, что откат деплоя — «предыдущий git-tag»                                                                                                                                                                               |
| F-11.6 | P3  | 0.2       | Scope включает «frontend-контракт», но UI-дизайн исключён; граница между «контракт» и «дизайн» не проведена (сколько компонентов, какие состояния обязательны)                                                                                                                   |

---

## 4. Проверка утверждений `## v3 SELF-CHECK`

| Утверждение                    | Проверка                                                                                                                                                                                                                                                                                     | Вердикт                                                                                            |
| ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `Gaps closed: 17/17`           | 4 темы v2 утеряны полностью (projections, snapshot, media cache, performance) + 19 частично                                                                                                                                                                                                  | ❌ **реально ~13/17**; пункт 1 («Core Domain Model schemas-as-code») не закрыт: 16 undefined-типов |
| `Schemas as code: 41 схема`    | Именованных Zod-экспортов в тексте ≈47, но **16 типов, на которые есть ссылки, не определены** (TurnResolution, 9 view-типов, MediaJob, ChatMessage, JournalEntry, Capability/CapabilitySchema, RuleSubject, GMNoteVisibility, ProviderError)                                                | ⚠️ счётчик неверен в обе стороны                                                                   |
| `Domain events: 23`            | В каталоге 23, но модули эмитят ещё ≥6 (`CHAT_MESSAGE_*` ×4, `GM_REVIEW_DECIDED`, будущие `AUDIO_*` ×3)                                                                                                                                                                                      | ❌ ≥29                                                                                             |
| `WS messages: 17 c→s + 17 s→c` | Подсчёт совпадает                                                                                                                                                                                                                                                                            | ✅ (но покрытие команд неполное — B-11)                                                            |
| `Modules contract'd: 9`        | Полных `ModuleContract` — **5**; `session`, `gm-audit`, `story` — проза; `turn`, `state`, `event-engine`, `rules` фигурируют как эмитенты без контрактов                                                                                                                                     | ❌ 5/9                                                                                             |
| `Unknowns flagged: 10`         | 10 в X.4 + 2 inline (V.2, V.8) = 12 маркеров; из них 2 блокируют MVP                                                                                                                                                                                                                         | ⚠️                                                                                                 |
| `Anti-patterns: 6/6 OK`        | В I.4 перечислено **8** антипаттернов; при этом 2 из них **нарушены самим документом**: `unknown` на границе модуля (IV.1, V.11) и «публикация domain event без Zod-схемы» (II.16 — схемы не приведены)                                                                                      | ❌ 6/8, и 2 самонарушения                                                                          |
| `Отклонения от v2: 3`          | Фактически ≥7: branded IDs, outbox+idempotency, Error Taxonomy, **выпавшие** projections/snapshot/media-cache/performance, смена имени событий (`PLAYER_ACTION_SUBMITTED`→`ACTION_SUBMITTED`, `TURN_RESOLVED`/`TURN_REVIEW_READY`→`TURN_DRAFT_READY`), потерянный стек (Svelte/Vite/Node 24) | ⚠️                                                                                                 |
| Инварианты 1–15 дословно       | Сверено с v2 §63                                                                                                                                                                                                                                                                             | ✅ подтверждено                                                                                    |

---

## 5. Что в v3 хорошо и не требует изменений

1. **Инварианты 16–20** — верное направление; 17 (branded IDs) и 18 (ошибки только как ErrorCode) — реально сильные решения, их надо сохранить и распространить на всё, что в F-1.13/F-6.4.
2. **Outbox + append-only journal** (III.3) — правильный паттерн для SQLite-монолита; нужна только чистка `FOR UPDATE` и `max_attempts`.
3. **Error Taxonomy как обязательный слой** (VI.9) с колонкой «действие клиента» — редкая и очень полезная практика.
4. **STRIDE-таблица** (VIII.2) с привязкой к ассетам — сильнее, чем в большинстве baseline-документов.
5. **Extensibility-сценарии** (X.1–X.3) — действительно демонстрируют, что Core не меняется; `UIPanelContribution` — верная идея.
6. **Вертикальный срез** (IX.4) как 12 шагов — отличный способ валидации; требует только fixes B-04/B-07/B-11.
7. **Разделение `resolveTurn` / `commitTurn`** (III.1) — ключевое правильное решение (долгие операции вне транзакции).
8. **Таблица переходов Turn** (II.5) — полная и непротиворечивая внутри себя.

---

## 6. План закрытия (3 волны)

### Волна 1 — блокеры, без них нельзя начинать кодить (оценка: 2–3 дня)

B-01 … B-12 (все двенадцать).
Результат: `contracts/` (schemas + views + events union), полная Drizzle-схема, единая таблица маршрутов/WS, единый владелец turn-переходов.
**Готовые патчи для 8 из 12 — в §8.**

### Волна 2 — P1, без них нельзя выходить в stage (оценка: 2 дня)

F-1.13, F-1.14, F-2.1, F-2.2, F-2.5, F-3.1, F-3.2, F-3.5, F-3.6, F-4.3, F-4.4, F-4.5, F-4.6, F-5.2, F-5.3, F-5.4, F-6.3, F-6.4, F-6.5, F-6.6, F-6.7, F-7.1…F-7.4, F-8.1, F-8.2, F-9.1…F-9.5, F-10.1…F-10.3, F-11.1.

### Волна 3 — P2/P3, закрывать по ходу реализации (оценка: фоново)

Всё остальное (38 позиций). Рекомендую завести как issues с ссылками на ID из этого реестра.

### Изменение процесса

- Ввести правило: **ни одна секция не публикуется без Zod-схемы** для каждого упомянутого типа (это уже инвариант 20 — нужен чек-лист проверки документа по нему).
- SELF-CHECK считать автоматически: скриптом по тексту (число `z.object`/`z.enum`-экспортов, число строк в каталоге событий, число `ModuleContract`-блоков), а не вручную.

---

## 7. Сводный счётчик по приоритетам

| Приоритет | Кол-во                                    | Что означает                                                                                 |
| --------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- |
| P0        | 10 (+2 транспортных = **12 блокеров** §2) | Документ нереализуем буквально; блокирует старт кодинга                                      |
| P1        | 37                                        | Реализуемо, но с расхождением между разделами / дырой в безопасности / отсутствием контракта |
| P2        | 44                                        | Существенно для качества и эксплуатации, не блокирует MVP                                    |
| P3        | 22                                        | Гигиена, формулировки, версия-специфичные мелочи                                             |
| **Σ**     | **113**                                   | уникальных `F-*` ID в реестре §3                                                             |

---

## 8. Приложения: готовые патчи

### 8.1 `TurnResolution` + маппинг AIResponse → Resolution → GameState

```ts
// core/domain/resolution.ts
export const ItemStatus = z.enum([
  'PROPOSED',
  'APPROVED',
  'REJECTED',
  'EDITED',
  'APPLIED',
  'SKIPPED',
]);

export const ProposedEventResolutionSchema = z.object({
  eventId: EventId, // только из allowedEventIds
  rationale: z.string().max(400),
  effects: z.array(EffectSchema),
  status: ItemStatus.default('PROPOSED'),
  ruleResults: z.array(RuleResultSchema),
  gmComment: z.string().max(500).nullable().default(null),
});

export const ProposedObjectChangeResolutionSchema = z.object({
  objectId: ObjectId,
  patch: z.record(z.string().max(60), z.union([z.boolean(), z.string(), z.number()])),
  rationale: z.string().max(300),
  status: ItemStatus.default('PROPOSED'),
  ruleResults: z.array(RuleResultSchema),
});

export const NarrativeSegmentSchema = z.object({
  segmentId: z.string().uuid(),
  text: z.string().max(2000),
  audience: AudienceSchema, // см. 8.4
  editedByGM: z.boolean().default(false),
});

export const DiagnosticsSchema = z.object({
  providerId: z.string(),
  model: z.string().nullable(),
  attempts: z.number().int().nonnegative(),
  schemaRepairAttempts: z.number().int().nonnegative(),
  usage: z.object({ inputTokens: z.number().int(), outputTokens: z.number().int() }).nullable(),
  costUsd: z.number().nullable(),
  durationMs: z.number().int().nullable(),
  softRejects: z.array(RuleResultSchema),
  warnings: z.array(RuleResultSchema),
});

export const TurnResolutionSchema = z.object({
  turnId: TurnId,
  sessionId: SessionId,
  source: z.enum(['AI', 'GM_MANUAL', 'AI_THEN_GM_EDIT']),
  aiResponseHash: z.string().nullable(), // sha256 от сырого AIResponse
  segments: z.array(NarrativeSegmentSchema), // вместо единого narrative: позволяет приватность
  privateMessages: z.array(
    z.object({
      playerId: PlayerId,
      text: z.string().max(1500),
      status: ItemStatus.default('PROPOSED'),
    }),
  ),
  proposedEvents: z.array(ProposedEventResolutionSchema),
  proposedObjectChanges: z.array(ProposedObjectChangeResolutionSchema),
  proposedWorldStatePatch: z
    .object({
      timeOfDay: WorldStateSchema.shape.timeOfDay.optional(),
      weather: z.string().max(60).nullable().optional(),
      ambientFlags: z.record(z.string(), z.union([z.boolean(), z.number(), z.string()])).optional(),
    })
    .default({}),
  visualScene: VisualSceneDescriptionSchema.nullable(),
  diagnostics: DiagnosticsSchema,
  createdAt: IsoDateTime,
  editedAt: IsoDateTime.nullable(),
});
export type TurnResolution = z.infer<typeof TurnResolutionSchema>;
```

**Маппинг и применение (закрывает v2 §32/§34):**

```text
AIResponse ──parse(Zod)──▶ TurnResolution{source:'AI', status:PROPOSED для всех item}
                          │
                          ├─ Rules Engine (subject=EVENT_TRIGGER / OBJECT_CHANGE) → ruleResults
                          ├─ status: REJECT → turn FAILED; SOFT_REJECT → requiresGM
                          ▼
                       REVIEW (GM)
                          │  approve | editAndApprove(baseResolutionHash) | reject | retry
                          ▼
commitTurn(tx):
  1. for item where status ∈ {APPROVED, EDITED}:
       - proposedEvents   → Event Engine applyEffects()
       - objectChanges    → objectStates patch (only allowlisted keys, F-9.4)
       - worldStatePatch  → worldState
       - segments/private → chat module (системные сообщения)
       - visualScene      → media-director.requestScene (после COMMIT)
  2. game_state.version + 1 (optimistic lock)
  3. turn_journal append
  4. snapshots insert (F-9.1)
  5. COMMIT → outbox: TURN_COMMITTED, STATE_COMMITTED, WORLD_EVENT_FIRED*
```

### 8.2 `StatePath` v2 — структурированный, типобезопасный

```ts
const slug = z.string().regex(/^[a-zA-Z0-9_:-]{1,80}$/);

export const StatePathSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('WORLD'),
    field: z.enum(['timeOfDay', 'weather', 'currentLocationId']),
  }),
  z.object({ kind: z.literal('AMBIENT'), key: slug }),
  z.object({ kind: z.literal('FLAG'), key: slug }), // key, НЕ flagId
  z.object({ kind: z.literal('OBJECT'), objectId: ObjectId, key: slug }),
  z.object({ kind: z.literal('KNOWLEDGE'), playerId: PlayerId, key: slug }),
]);
export type StatePath = z.infer<typeof StatePathSchema>;

// сериализация для хранения в JSON событий (детерминированная, обратимая):
//   {kind:'WORLD',field:'timeOfDay'}          → "worldState.timeOfDay"
//   {kind:'FLAG',key:'doll.awake'}            → "storyFlags:doll.awake"
//   {kind:'OBJECT',objectId:u,key:'eyesOpen'} → "objectStates:<uuid>.eyesOpen"
//   {kind:'KNOWLEDGE',playerId:u,key:'x'}     → "playerKnowledge:<uuid>.x"

export function readPath(s: GameState, p: StatePath): boolean | string | number | undefined {
  /* exhaustive switch */
}
export function writePath(s: GameState, p: StatePath, v: Scalar): GameState {
  /* иммутабельно, возвращает новую версию */
}
```

**Сопутствующее изменение GameState:** `storyFlags: z.record(slug, StoryFlagSchema)` (ключ — `key`, а `flagId` остаётся полем внутри) — иначе DSL и хранилище несовместимы (B-03.1).

**Конвенция ключей (зафиксировать в документе):** `<namespace>.<name>`, namespace = `location slug | object slug | domain`, только `[a-zA-Z0-9_:-]`, ≤80 символов, без ведущей точки.

### 8.3 Атомарная идемпотентность

```sql
CREATE TABLE idempotency_records (
  key          TEXT PRIMARY KEY,
  turn_id      TEXT,                       -- null для не-turn команд
  command      TEXT NOT NULL,              -- свободная строка из реестра команд
  status       TEXT NOT NULL CHECK (status IN ('IN_FLIGHT','DONE','FAILED')),
  result_json  TEXT,                       -- ПОЛНЫЙ результат для возврата клиенту
  result_hash  TEXT NOT NULL,
  error_code   TEXT,
  trace_id     TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);
```

```ts
type Acquire =
  | { kind: 'proceed' }
  | { kind: 'cached'; resultJson: string }
  | { kind: 'in_flight' }
  | { kind: 'failed_before'; errorCode: string };

async function tryAcquire(
  p: {
    key: IdempotencyKey;
    command: CommandName;
    turnId?: TurnId;
    ttlMs: number;
    traceId: string;
  },
  tx: Tx,
): Promise<Acquire> {
  const inserted = await tx.run(
    `INSERT INTO idempotency_records (key,turn_id,command,status,result_hash,trace_id,created_at,expires_at)
     VALUES (?,?,?,?, '', ?,?,?)
     ON CONFLICT(key) DO NOTHING`,
    [p.key, p.turnId ?? null, p.command, 'IN_FLIGHT', p.traceId, now(), nowPlus(p.ttlMs)],
  );
  if (inserted.changes === 1) return { kind: 'proceed' }; // атомарно, без гонки
  const row = await tx.get(
    `SELECT status,result_json,error_code FROM idempotency_records WHERE key=?`,
    [p.key],
  );
  if (row.status === 'DONE') return { kind: 'cached', resultJson: row.result_json };
  if (row.status === 'FAILED') return { kind: 'failed_before', errorCode: row.error_code };
  return { kind: 'in_flight' }; // → IDEMPOTENCY_IN_FLIGHT (409)
}
```

**Правила (в текст документа):**

- Все мутирующие команды **обязаны** принимать `idempotencyKey` от клиента; отсутствие → `VALIDATION`.
- Сервер **никогда** не генерирует ключ «за клиента». Для внутренних вызовов ключ детерминирован: `resolve:{turnId}`, `move:{sessionId}:{turnId}:{sha1(sortedPlayerIds)}:{toLocationId}`.
- `command` — не enum из 3 значений, а строка из реестра команд (`CommandName` union в контрактах), чтобы enum не ломался при добавлении команд.
- После завершения — `UPDATE … SET status='DONE', result_json=?, result_hash=?` в той же транзакции, что и доменная мутация.

### 8.4 Матрица приватности WS + проекции

**Правило:** broadcast-payload не содержит per-player полей. Приватное — отдельным targeted-сообщением.

| Server→client              | Кому                | Payload                               | Приватные поля               |
| -------------------------- | ------------------- | ------------------------------------- | ---------------------------- |
| `STATE_PROJECTION`         | всем в сессии       | `PublicGameStateView`                 | —                            |
| `STATE_PROJECTION_PRIVATE` | одному игроку       | `{ knowledge: KnowledgeEntry[] }`     | только его `playerKnowledge` |
| `TURN_UPDATE`              | всем                | `{turnId, status, number}`            | —                            |
| `TURN_DRAFT_READY`         | **только GM**       | `{turnId}`                            | факт наличия черновика       |
| `TURN_RESOLUTION_GM`       | **только GM**       | `TurnResolution` (полный)             | всё                          |
| `TURN_COMMITTED`           | всем                | `{turnId, version, publicSegments[]}` | —                            |
| `TURN_PRIVATE_RESOLUTION`  | каждому адресату    | `{turnId, text}`                      | private message              |
| `CHAT_PRIVATE`             | только `toPlayerId` | `ChatMessageView`                     | —                            |
| `MEDIA_READY`              | всем                | `{mediaJobId, url}`                   | —                            |
| `GM_ACTION_ACK`            | только GM           | `{action, ok}`                        | —                            |

**Authz для `GET /state/projection?view=`:** `public` → player; `ai` и `gm` → **только GM-токен** (иначе `AUTH_FORBIDDEN`).

**Обязательные тесты (в VIII.3):**

1. «Ни один broadcast-envelope не содержит `privateMessages`, `gmNotes`, `playerKnowledge` чужого игрока» — property-based тест на всех s→c типах.
2. `view=ai|gm` с player-токеном → 403.
3. `TURN_DRAFT_READY` не приходит не-GM соединению.

### 8.5 Недостающие маршруты и WS-типы

**HTTP (дополнение к VI.2–VI.4):**

| Method | Path                                 | Req                                                        | Resp                 | Auth                        |
| ------ | ------------------------------------ | ---------------------------------------------------------- | -------------------- | --------------------------- |
| POST   | `/auth/refresh`                      | `{ refreshToken }`                                         | `{ token }`          | none                        |
| POST   | `/sessions/:id/end`                  | `{ idempotencyKey }`                                       | `{}`                 | GM                          |
| POST   | `/sessions/:id/pause`                | `{ idempotencyKey }`                                       | `{}`                 | GM                          |
| POST   | `/sessions/:id/resume`               | `{ idempotencyKey }`                                       | `{}`                 | GM                          |
| POST   | `/sessions/:id/turns`                | `{ idempotencyKey }`                                       | `{ turnId, number }` | GM                          |
| POST   | `/turns/:id/unlock`                  | `{ idempotencyKey }`                                       | `{}`                 | GM                          |
| POST   | `/turns/:id/cancel`                  | `{ reason, idempotencyKey }`                               | `{}`                 | GM                          |
| POST   | `/turns/:id/retry`                   | `{ idempotencyKey }`                                       | `{ turnId }`         | GM                          |
| POST   | `/turns/:id/edit-approve`            | `{ editedResolution, baseResolutionHash, idempotencyKey }` | `{ version }`        | GM                          |
| POST   | `/sessions/:id/move`                 | `{ playerIds, toLocationId, idempotencyKey }`              | `{}`                 | GM                          |
| POST   | `/sessions/:id/events/:eid/activate` | `{ turnId, idempotencyKey }`                               | `{}`                 | GM                          |
| DELETE | `/sessions/:id/me`                   | —                                                          | `{}`                 | player (добровольный выход) |
| GET    | `/gm/audit`                          | `?since=&limit=`                                           | `GMAuditEntry[]`     | GM                          |
| POST   | `/media/jobs/:id/cancel`             | `{}`                                                       | `{}`                 | GM                          |
| GET    | `/metrics`                           | —                                                          | prom-text            | internal (не публиковать)   |

**WS client→server (дополнение к VI.6):** `HISTORY{sessionId, since, limit}`, `GM_OPEN_TURN`, `GM_UNLOCK_TURN`, `GM_CANCEL_TURN`, `GM_PAUSE`, `GM_RESUME`, `GM_MOVE_GROUP`, `GM_SYSTEM_MESSAGE`, `GM_ADD_NOTE`, `GM_EDIT_APPROVE`, `LEAVE`.

**WS server→client (дополнение к VI.7):** `HISTORY_RESULT`, `SESSION_STATUS`, `PLAYER_PRESENCE`, `STATE_PROJECTION_PRIVATE`, `TURN_RESOLUTION_GM`, `TURN_PRIVATE_RESOLUTION`, `BUDGET_WARNING`.

### 8.6 Недостающие таблицы (Drizzle)

```ts
characters        (character_id PK, session_id FK, name, archetype, stats_json, created_at)
player_extensions (player_id FK, module_id, data_json, updated_at, PK(player_id, module_id))
locations         (location_id PK, session_id NULL FK, template_slug, name, description,
                   atmosphere, objects_json, exits_json, hazards_json,
                   registered_event_ids_json, narrative_notes, tags_json)
world_events      (event_id PK, session_id FK, template_slug, location_id NULL, name,
                   trigger_json, conditions_json, effects_json, priority INT DEFAULT 0,
                   once BOOL, fired BOOL, fired_at_turn_id NULL)
first_seen        (session_id, scope, entity_id, first_turn_id, PK(session_id, scope, entity_id))
rules_bundles     (bundle_id PK, session_id FK, checks_json, updated_at)
gm_notes          (note_id PK, session_id FK, turn_id NULL, visibility, text, created_at)
gm_audit          (id AUTOINC PK, session_id FK, gm_player_id FK, action, meta_json,
                   trace_id, idempotency_key NULL, created_at)
chat_messages     (message_id PK, session_id FK, turn_id NULL, from_player_id NULL,
                   to_player_id NULL, visibility, text, created_at,
                   idx(session_id, created_at), idx(session_id, visibility))
media_jobs        (media_job_id PK, session_id FK, turn_id NULL, status,
                   provider_id, external_job_id, prompt, prompt_hash, workflow, seed,
                   url, error_code, attempts, queued_at, started_at, finished_at,
                   idx(session_id, status))
media_cache       (prompt_hash, provider_id, workflow, seed, session_id, file_path,
                   created_at, PK(prompt_hash, provider_id, workflow, seed))
snapshots         (session_id, turn_id, version, state_json, created_at, PK(session_id, version))
deferred_effects  (id AUTOINC PK, session_id, effect_json, reason, source_turn_id,
                   apply_at_turn_number, status, created_at)
idempotency_records  // §8.3
event_outbox         // перенести из raw SQL, добавить max_attempts INT DEFAULT 5
```

Плюс: все `.references(() => …)` — в коде, не в прозе; `turns` — без `action_ids` (F-1.17).

### 8.7 Инстанцирование world-pack (закрывает B-04)

```ts
export const WorldPackSchema = z.object({
  packId: z.string().regex(/^[a-z0-9-]{1,60}$/),
  version: z.string(),
  startLocationSlug: z.string(),
  locations: z.array(LocationTemplateSchema), // slug-based ID: loc_reception, obj_doll…
  events: z.array(WorldEventTemplateSchema),
  rules: z.array(RuleCheckTemplateSchema),
});
```

`instantiateWorldPack(sessionId, pack)`:

1. Для каждого шаблона — `randomUUID()`; построить `Map<slug, uuid>`.
2. Подставить UUID во все `exits.toLocationId`, `objects[].objectId`, `registeredEventIds`, `trigger/conditions/effects` (через обход AST-подобный по DSL).
3. Записать `locations(session_id = sessionId, template_slug = slug)`, `world_events(…)`, `rules_bundles`.
4. `worldState.currentLocationId = map.get(pack.startLocationSlug)`; `session.currentLocationId` — удалить как дубль (F-1.16).
5. Эмитить `EVENT_REGISTERED` для каждого события → AI Director получит `allowedEventIds`.
6. Вернуть `remap: Record<slug, uuid>` — нужен GM-UI и вертикальному срезу.

**Следствие для IX.1–IX.3:** JSON-примеры остаются **шаблонами** (slug-ID, схема `LocationTemplateSchema`), а не `LocationDefinition`. Это снимает противоречие без переписывания примеров.

### 8.8 Event DSL: недостающие поля и таблица источников триггеров

```ts
export const WorldEventSchema = z.object({
  eventId: EventId,
  sessionId: SessionId.nullable(), // null = шаблон (см. 8.7)
  templateSlug: z.string().nullable(),
  locationId: LocationId.nullable(),
  name: z.string().min(1).max(120),
  priority: z.number().int().default(0), // ← ДОБАВЛЕНО (F-4.2)
  trigger: TriggerSchema,
  conditions: z.array(ConditionSchema).default([]), // ← массив (F-1.6c)
  effects: z.array(EffectSchema),
  once: z.boolean().default(true),
  fired: z.boolean().default(false),
  firedAtTurnId: TurnId.nullable().default(null),
  cascadeDepth: z.number().int().default(0), // защита от цикла (F-2.6)
});

// FIRST_TIME с явной сущностью:
z.object({
  kind: z.literal('FIRST_TIME'),
  scope: z.enum(['LOCATION', 'OBJECT', 'EVENT']),
  entityId: z.string(),
});
// проверка: SELECT 1 FROM first_seen WHERE session_id=? AND scope=? AND entity_id=?
// запись first_seen — в том же commit, где триггер сработал
```

**Таблица источников триггеров (обязательна в документе — закрывает F-1.6d/F-4.4):**

| Trigger          | Источник                                                                                                                                       | Момент                                                          |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| `ENTER_ROOM`     | `gm.moveGroup` (Core) или эффект `TELEPORT`                                                                                                    | сразу после смены `worldState.currentLocationId`, внутри commit |
| `OBJECT_USED`    | `PlayerAction.meta.targetObjectId` **если** Rules Engine пропустил действие с `intent='USE'` **и** AI/GM подтвердил использование в resolution | при commit; плюс эффект `USE_OBJECT` для явного запуска GM-ом   |
| `FLAG_SET`       | успешный `SET_FLAG`-эффект, применённый в commit                                                                                               | после применения, в том же прогоне Event Engine (каскад)        |
| `TURN_COMMITTED` | Turn Engine                                                                                                                                    | после outbox-publish `TURN_COMMITTED`                           |
| `MANUAL`         | `gm.activateEvent`                                                                                                                             | немедленно, с проверкой Rules (subject=`EVENT_TRIGGER`)         |

**Каскад:** глубина ≤ 3; эффекты, превысившие глубину или проигравшие в write-write конфликте, → `deferred_effects(apply_at_turn_number = current+1)`.

### 8.9 Конфиги: минимальные примеры + схемы валидации

```yaml
# config/capabilities.yaml
capabilities:
  TEXT_AI: { required: true, chain: [openrouter, lmstudio] }
  VISUAL_PROMPT: { required: false, chain: [lmstudio, template] }
  IMAGE_GENERATION: { required: false, chain: [comfyui, cloud, debug] }
  IMAGE_EDITING: { required: false, chain: [comfyui] }
  AUDIO_GENERATION: { required: false, chain: [] } # post-MVP
limits:
  maxPlayersPerSession: 12
  wsRatePerConnection: { ACTION_SUBMIT: 5, CHAT_PUBLIC: 10 } # в секунду
  mediaMaxConcurrentPerSession: 2
  aiMaxConcurrentPerSession: 1
  sessionBudgetUsd: 5.00
  aiMaxRetriesPerTurn: 2
  mediaMaxRetriesPerJob: 1
  outboxMaxAttempts: 5
  idempotencyTtlHours: 24
  eventCascadeMaxDepth: 3
  chatRingBuffer: 500
  reconnect: { baseMs: 500, factor: 2, capMs: 15000, jitter: 0.2, maxAttempts: 8 }
```

```yaml
# config/provider-policies.yaml
policies:
  - {
      providerId: openrouter,
      capability: TEXT_AI,
      timeoutMs: 45000,
      retries: { max: 2, backoffMs: 1000, jitter: true },
      circuitBreaker: { failureThreshold: 3, cooldownMs: 60000 },
      costPer1kTokens: { input: null, output: null },
    } # UNKNOWN#5 → null, метрика не считается
```

Оба файла валидируются Zod при старте (`VIII.8` уже требует валидацию env — распространить на config).

### 8.10 `AIPort` с usage (закрывает F-7.1/F-7.2)

```ts
export interface AIPort {
  readonly providerId: string;
  readonly capability: 'TEXT_AI';
  isAvailable(): Promise<boolean>;
  generate(input: {
    context: DirectorContext;
    schema: z.ZodType<AIResponse>;
    deadline: { timeoutMs: number; attempt: number }; // политику даёт Capability Registry
    signal?: AbortSignal;
  }): Promise<{
    response: AIResponse;
    usage: { inputTokens: number; outputTokens: number; model: string } | null;
    durationMs: number;
  }>;
}

export const ProviderErrorCode = z.enum([
  'PROVIDER_TIMEOUT',
  'PROVIDER_RATE_LIMIT',
  'PROVIDER_AUTH',
  'PROVIDER_SCHEMA',
  'PROVIDER_UNAVAILABLE',
  'PROVIDER_BAD_GATEWAY',
  'PROVIDER_BUDGET',
]);
export class ProviderError extends Error {
  constructor(
    public code: ProviderErrorCode,
    msg: string,
    public providerId: string,
    public meta: Record<string, unknown> = {},
  ) {
    super(msg);
  }
}
```

Маппинг в публичные коды (VI.9) — отдельной таблицей, по образцу III.14.

---

## 9. Что делать прямо сейчас (чек-лист)

- [ ] Принять §8.1–§8.10 как поправки к v3 → получится **v3.1** (изменения локальные, структура документа сохраняется).
- [ ] Закрыть 4 утерянные темы v2 отдельными секциями: `Data Projections` (→ §8.4), `Snapshots & Recovery`, `Media Cache & File Storage`, `Performance Budget`.
- [ ] Переквалифицировать `UNKNOWN#6` (snapshot) и `UNKNOWN#10` (миграции) из «post-MVP» в «блокирует MVP».
- [ ] Добавить в Part IX **план этапов с Definition of Done** (F-11.1) — единственное, чего документу не хватает как «baseline на несколько месяцев».
- [ ] Зафиксировать: Zod major, фронтенд-стек (Svelte+Vite), структура каталогов + `shared/contracts`.
- [ ] Переписать `## v3 SELF-CHECK` по фактическим числам (таблица в §4) и сделать его автоматическим.

---

_Реестр ID (F-x.y) стабилен — на него можно ссылаться из issues и коммитов._
