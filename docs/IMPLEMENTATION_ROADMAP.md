# МНЕМОСИН — IMPLEMENTATION_ROADMAP.md

**Целевая архитектура v4 · Draft 0.1**  
**Дата:** 2026-11-09  
**Статус:** проектный план последовательной реализации; не является подтверждением фактической реализации этапов.  
**Целевой исполнитель:** автономный coding agent (Qwen 3.8 Max).  
**Назначение:** определить рекомендуемый порядок миграции текущего репозитория к архитектуре v4, зависимости между этапами, критерии завершения, обязательные проверки и правила работы coding agent.

> Этот документ задаёт инженерную последовательность. Он не заменяет игровые и технические спецификации, не закрывает открытые вопросы и не разрешает coding agent самостоятельно выбирать недостающие правила игры.

---

## 0. Как использовать roadmap

### 0.1. Главный принцип

Реализовывать МНЕМОСИН следует **последовательными вертикальными срезами**, каждый из которых можно проверить независимо. Не следует поручать агенту единовременно реализовать всю архитектуру v4.

Один этап roadmap — одна ограниченная задача или небольшая группа тесно связанных задач. После этапа должны существовать:

- работающий код в пределах заявленного объёма;
- тесты, подтверждающие поведение;
- обновлённые контракты и документация, если они затронуты;
- отчёт о выполнении и оставшихся вопросах;
- понятная точка, от которой можно продолжать следующую работу.

### 0.2. Что означает статус этапа

В этом документе используются следующие статусы:

- **READY** — зависимости и необходимые решения закрыты; этап можно планировать к реализации.
- **READY WITH PROVISIONAL DETAILS** — можно реализовать инфраструктуру или прототип, но временные параметры должны быть явно помечены и не должны становиться игровым каноном.
- **BLOCKED BY DECISION** — нельзя реализовывать поведение, пока пользователь не утвердит перечисленные решения.
- **DEFERRED** — функция намеренно отложена и не входит в ближайший вертикальный срез.
- **DONE** — статус может выставляться только после проверки критериев завершения и тестов; наличие кода само по себе не означает DONE.

Статус относится к этапу или отдельной задаче, а не ко всему проекту.

### 0.3. Статус технических решений

Как и в связанных спецификациях:

- **СОГЛАСОВАНО** — прямо установлено исходным документом или пользователем.
- **ПРЕДЛАГАЕТСЯ** — рекомендуемая инженерная организация; не является обязательным игровым правилом.
- **ОТКРЫТО** — требует отдельного решения или измерения.
- **PROTOTYPE-ONLY** — временная настройка для тестового среза, не переносить в production/gameplay config без согласования.

### 0.4. Документы, входящие в комплект v4

Coding agent должен использовать следующие документы как единый комплект:

| Документ                    | Ответственность                                                                                                            |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `SYSTEM_ARCHITECTURE.md`    | Верхнеуровневые границы, стек, слои, безопасность и архитектурные инварианты                                               |
| `HOT_COLD_DESIGN.md`        | Симуляционный tick, владение состоянием, команды и события между HOT/COLD, prediction, interpolation, snapshots и recovery |
| `WORLD_SIMULATION.md`       | Координаты, World Pack, геометрия, движение, коллизии, навигация, газ, свет, звук и пространственные взаимодействия        |
| `DOLL_AI.md`                | Perception, Memory, Decision, Navigation, Action, тактические профили кукол и захват                                       |
| `ANDREY_AI.md`              | Состояние Андрея, знания, убеждения, память, диалоги, LLM Gateway, бюджет и fallback                                       |
| `NETWORK_PROTOCOL.md`       | WebSocket envelope, сообщения, авторизация, Player/Observer/Developer projections, reconnect и resync                      |
| `MATCH_LIFECYCLE.md`        | Комната, состав участников, Scenario Configuration, фазы, этажи, захват/оставление, финал и концовки                       |
| `IMPLEMENTATION_ROADMAP.md` | Последовательность реализации, зависимости, гейты и критерии завершения                                                    |
| `в общем2.txt` / «Цикл 48»  | Исходный игровой канон и сводка решений                                                                                    |

Если файл в репозитории имеет другое имя или расположен в другом каталоге, агент должен сначала найти его и проверить содержимое. Нельзя создавать копию документа под вторым именем только ради совпадения с этой таблицей.

### 0.5. Приоритет источников

При реализации использовать порядок, зафиксированный в `MATCH_LIFECYCLE.md` и `NETWORK_PROTOCOL.md`:

1. Последнее явное решение пользователя.
2. Положения со статусом **СОГЛАСОВАНО** в соответствующих архитектурных документах.
3. Согласованные положения настоящего roadmap.
4. Исходный канон «Цикла 48» и исходное описание игры.
5. Положения **ПРЕДЛАГАЕТСЯ** — только как проектные варианты.
6. Текущий код — источник истины о том, что реально реализовано сейчас, но не автоматическое основание сохранять устаревшие Turn Engine/GM workflow в целевой v4.

Если две спецификации противоречат друг другу и приоритет источников не разрешает конфликт, агент должен остановиться на затронутом участке, описать конфликт и запросить решение. Нельзя молча выбирать удобный вариант.

---

## P00 Audit Results (2026-11-13)

**Branch:** `arch-v2`  
**Audited Baseline HEAD:** `eb15ccff58a49dc1854ad5b5672c5e1cca60084e` ("Выполнена доработка тестов")  
**First P00 Results Commit:** `a1491af7dbc138ec0b8087cbb09c070b78354f37` (child of `eb15ccf`; "Удалены старые тесты" + audit docs + test changes)  
**Corrections Commit:** `55ddad6f6c53ae7baabc9c1f753f4c682aec51ea` (child of `a1491af`; audit/roadmap corrections only)  
**Current HEAD:** `55ddad6` (`arch-v2`)  
**Archive Point:** `main`@`fc62c57` (`stage1-final` tag, commit "довел проект до стадии end_stage_1") — **confirmed Git rollback point; full app restoration not tested**

### Dual-Status Matrix (Actual State / Readiness)

| Phase | Actual State | Readiness | Key Evidence |
|-------|--------------|-----------|--------------|
| P00 | **PARTIAL** (Steps 1–8 done; audit report created, matrix complete) | READY | Git baseline, CI verified at audited SHA, docs validated, inventory complete, report delivered |
| P01 | NOT STARTED | **READY WITH PROVISIONAL DETAILS** | Original roadmap: collect open decisions, classify BLOCKER/PROTOTYPE/CONTENT/DEFERRED. No separate blocker found by audit beyond existing open questions in specs. |
| P02 | NOT STARTED | READY WITH PROVISIONAL DETAILS | No World Pack code; depends on P01 contracts |
| P03 | NOT STARTED | READY WITH PROVISIONAL DETAILS | Depends on P02 contracts |
| P04 | NOT STARTED | READY WITH PROVISIONAL DETAILS | Depends on P02/P03 |
| P05 | NOT STARTED | READY WITH PROVISIONAL DETAILS | Legacy WS/client exist but use v1 protocol |
| P06 | NOT STARTED | READY (prototype) / BLOCKED BY DECISION (production) | Durability decisions HC-06–HC-10 open |
| P07 | NOT STARTED | READY WITH PROVISIONAL DETAILS | Depends on P03–P06 |
| P08A (Doll Baseline) | NOT STARTED | READY WITH PROVISIONAL DETAILS | Sensor model undecided (DOLL-OPEN-01–03) |
| P08B (Capture Integration) | NOT STARTED | **BLOCKED BY DECISION** | Requires P10 Captured/Stasis states |
| P09 | NOT STARTED | READY WITH PROVISIONAL DETAILS | `chat`, `story`, `gm-audit` modules exist as bases |
| P10 | NOT STARTED | **BLOCKED BY DECISION** | Role distribution (7–10), progression rules ML-01–ML-20 open |
| P11 | NOT STARTED | READY (read-only) / BLOCKED BY DECISION (actions) | `gm-audit` partial base |
| P12 | NOT STARTED | READY WITH PROVISIONAL DETAILS | Scripted fallback first; dialog rules open |
| P13 | NOT STARTED | DEFERRED | Requires P10/P12; ending conditions open |
| P14 (Parallel) | NOT STARTED | READY WITH PROVISIONAL DETAILS | **Explicit start conditions:** (1) World Pack schema stabilized (P03), (2) resource IDs/references defined (P02/P03), (3) client display interfaces stable (P05), (4) production World Packs use server-authoritative geometry. **Formal dependencies:** P03, P05, P07. Does NOT wait for P08/P10/P12/P13. |
| P15 | NOT STARTED | DEFERRED | Requires all prior phases. First vertical slice = P03–P05. |

### CI Baseline (Verified at Audited SHA `eb15ccf` — CI #18, PR workflow head `eb15ccf` / merge `5d263f5`)

| Run | SHA | npm ci | lint | typecheck | test:unit | test:integration | Subsequent Steps |
|-----|-----|--------|------|-----------|-----------|------------------|------------------|
| CI #18 | `eb15ccf` (head) | **PASS** | **PASS** | **PASS** (95 unit tests pass) | 95 PASS | **FAIL** (classified below) | NOT RUN (blocked) |
| CI #19 | `a1491af` | **PASS** | **FAIL** | NOT RUN | NOT RUN | NOT RUN | NOT RUN |
| CI #20 | `55ddad6` (HEAD) | **PASS** | **FAIL** (3 `no-unsafe-finally` in `tests/integration/outbox.test.ts`:248,255,259) | NOT RUN | NOT RUN | NOT RUN | NOT RUN |

**Integration Failure Classification (CI #18):**
- Missing `@mnemosin/module-turn` — **stale test dependency**
- `services.turns.submitAction is not a function` — **stale test dependency**
- `buildAIStack is not a function` — **stale test dependency**
- Missing fixtures `locations.stage1.json`, `resolution.ok.json` — **missing fixture**
- Location service: expected `Шлюз`, got `Test Start Location` — **test/fixture mismatch**
- Location service: missing expected exits — **UNKNOWN**
- Location service: `undefined` passed to DB query — **implementation defect (likely)**
- Other location service assertions — **UNKNOWN**

No `contract mismatch` failures identified.

### Critical Blockers (must resolve in P02, not P01)
1. `core/src/session/session-service.ts` calls `this.turns.openTurn()` — broken (requires P10 rewrite or P02 stub)
2. DB schema: `turns`, `actions.turn_id`, `journal_entries.turn_id`, `sessions.currentTurnId` — new migrations needed (P02/P10)
3. `shared/contracts/domain/{turn,gm,gm-review}.ts` legacy schemas still present — delete in P02
4. WS Gateway declares `WsTurnOps`, `WsGmOps`, `WsGmReviewOps` — strip legacy ops in P05
5. Client `GameShell.svelte` / `PlayerApp.svelte` reference deleted `TurnPanel` — rewrite in P05
6. No World Pack schema / loader / validator — design in P03
7. No HOT Runtime — implement in P04
8. No HOT/COLD bridge — implement in P06
9. Doll AI perception/sensor model undecided — decision for P08A production
10. Participant states (Captured/Stasis) not defined — decision in P10
11. Ending conditions / priority table not decided — decision for P13
12. Role distribution rules for 7–10 players — decision for P10 (ML-01–ML-20)

**Note:** `core/src/services.ts` at audited HEAD **receives `TurnServicePort` via DI** (does not create it); `core/src/domain/ports/turn-service.ts` **exists** as a minimal Port interface (`openTurn` only). TypeScript `typecheck` **PASSES** at audited SHA `eb15ccf`. The blocker is architectural (legacy Port still wired), not a compile error.

### Component Decisions Summary
- **KEEP:** `modules/chat`, `gm-audit`, `session`, `story` | `infrastructure/database`, `core/src/turns/journal.ts` (JournalService — standalone, no TurnEngine dep)
- **ADAPT:** `apps/server/src/app.ts`, `gateways/ws-gateway`, `client/src/net/WSClient.ts`, `shared/contracts` (v4 schemas), `core/src/services.ts` (remove TurnServicePort param in P02)
- **REPLACE:** `core/src/session/session-service.ts`, `infrastructure/database/migrations/0000_init.sql`, `client/src/shell/GameShell.svelte`, `client/src/player/PlayerApp.svelte`, `client/src/player/VisualPanel.svelte`
- **REMOVE (done):** `modules/turn`, `gm`, `gm-review`, `ai-director`
- **REMOVE (pending):** `shared/contracts/domain/{turn,gm,gm-review}.ts`, `core/src/domain/ports/turn-service.ts`

### Full Audit Report
📄 **See: `docs/implementation/REPOSITORY_AUDIT.md`** — contains complete baseline, migration table, test classification, CI failure classification, report validity check, risks, and corrected P01/P02 scope.

---

# 1. Целевой результат реализации

## 1.1. Продуктовая цель

Браузерная multiplayer-игра на 6–10 игроков с партией ориентировочно 4–5 часов, непрерывным перемещением в наклонной 2D-сцене, социальными и дедуктивными системами, выживанием, крафтом, тактическими куклами, Андреем и финалом на Э7.

Обычная партия должна полностью работать без человеческого GM и без доступности LLM. Необязательный Observer («Бог») не занимает слот игрока, видит всё скрытое игровое состояние и может иметь отдельно выданные полномочия вмешательства.

## 1.2. Целевая техническая основа

- Server: Node.js 22+ / TypeScript, Fastify.
- Transport: WebSocket.
- Contracts: TypeScript + Zod в едином `shared/contracts`.
- Persistence: SQLite + Drizzle через существующий database adapter.
- Client: Svelte 5 + Vite SPA.
- World rendering: PixiJS.
- Art pipeline: Blender → рендер ресурсов → единая палитра/пикселизация → PixiJS.
- Server simulation: HOT, фиксированный шаг 20 Гц на старте.
- Discrete game state: COLD, контролируемые mutations через существующие application/domain boundaries и `StateService`.
- Doll AI: детерминированные алгоритмы, не LLM.
- Andrew: сценарно ограниченный LLM-assisted персонаж с полноценным fallback.

Этот список описывает целевое состояние, а не гарантирует, что перечисленные компоненты уже присутствуют в коде.

## 1.3. Принципы, которые нельзя нарушать ради скорости реализации

1. Сервер — единственный авторитетный источник игровых координат и канонических игровых фактов.
2. Клиент отправляет намерения/команды, но не устанавливает окончательное состояние мира.
3. Частота HOT 20 Гц не равна частоте рендеринга браузера. Клиент отображает сцену независимо, с prediction/interpolation.
4. HOT не вызывает LLM, HTTP-провайдеров и синхронную запись в БД на каждом тике.
5. COLD отвечает за значимые дискретные изменения, владение предметами, роли, заражение, крафт, улики, историю и progression.
6. У каждого изменяемого факта один владелец истины.
7. PlayerProjection не содержит скрытые роли, заражение и другие секреты.
8. ObserverProjection видит все скрытые игровые факты, но не должна включать инфраструктурные секреты, API keys или JWT.
9. Право Observer на просмотр отделено от права God Actions; вмешательства проходят через явные команды и audit trail.
10. Куклы используют алгоритмическое поведение и не обладают всеведением.
11. LLM Андрея не устанавливает канонические факты, не определяет концовки и не управляет HOT.
12. Недоступность LLM/media provider не должна блокировать основную партию.
13. Crash recovery не равен сюжетной перемотке «Забвение».
14. Открытые игровые правила не превращаются в неявные default constants.
15. Модульный монолит сохраняется, пока измеримая необходимость не обоснует разделение на сервисы.

---

# 2. Стратегия реализации

## 2.1. Не строить всё сразу

Рекомендуемая стратегия — сначала доказать технический фундамент на минимальной тестовой карте, затем расширить его до полного игрового цикла.

Первый вертикальный срез должен быть очень маленьким:

- одна тестовая комната/зона;
- два тестовых игрока;
- серверная авторитетная сетка и движение;
- препятствие и закрытая дверь;
- браузерный PixiJS renderer;
- scene snapshots;
- client-side prediction для собственного персонажа;
- interpolation удалённого персонажа;
- reconnect и resync;
- одна тестовая кукла с waypoint patrol — после готовности базовой навигации.

Этот срез не обязан содержать роли, крафт, LLM, сюжет или полную карту семи этажей.

## 2.2. Вертикальные срезы, а не только горизонтальные слои

Каждая подсистема должна подключаться к работающему тестовому сценарию. Не следует создавать десятки пустых интерфейсов и каталогов до появления первого end-to-end сценария.

Примеры:

- движение: input → server validation → HOT movement → snapshot → client render;
- открытие двери: interaction command → authorization/rule validation → COLD state commit → COLD→HOT revision → collision/navigation update → client projection;
- захват: Doll AI decision → HOT trigger/capture request → COLD validation and commit → participant state update → floor/child-room projection;
- разговор с Андреем: player request → Andrew state/context → LLM adapter or fallback → response validation → private/public audience projection → journal record.

## 2.3. Прототипы и production-контракты

Временные параметры разрешены только для изолированных прототипов:

- хранить их в централизованном `prototype` config;
- помечать `PROTOTYPE-ONLY`;
- не встраивать в игровые правила и авторские World Packs;
- записывать, какой вопрос они позволяют измерить;
- после эксперимента либо заменить утверждённым решением, либо сохранить как configurable value с явно согласованным статусом.

## 2.4. Параллельная работа

Параллелизировать можно подготовку контента, UI и отдельных доменных спецификаций, но только после согласования публичных контрактов.

Не выполнять параллельно несовместимые изменения в:

- `shared/contracts`;
- WS message catalog;
- владельцах HOT/COLD state;
- `WorldPack` schema;
- Match/Participant lifecycle state machine.

При необходимости назначить один этап/ветку владельцем соответствующей общей схемы, а другие ветки — потребителями.

---

# 3. Сводная карта этапов

Таблица задаёт рекомендуемый порядок, а не календарный график. Сроки не указываются: они зависят от фактического состояния кода, найденных зависимостей и результатов прототипов.

| ID  | Этап                                      | Главный результат                                                  | Зависимости                  | Начальный статус                                                  |
| --- | ----------------------------------------- | ------------------------------------------------------------------ | ---------------------------- | ----------------------------------------------------------------- |
| P00 | Инвентаризация и baseline                 | Проверенная карта текущего репозитория без функциональной миграции | Нет                          | READY                                                             |
| P01 | Решения и ADR register                    | Реестр блокирующих вопросов и утверждённых временных границ        | P00                          | READY WITH PROVISIONAL DETAILS                                    |
| P02 | Контракты и архитектурные основы          | Единый Zod/WS catalog и безопасные application boundaries          | P00–P01                      | READY WITH PROVISIONAL DETAILS                                    |
| P03 | World Pack и координаты                   | Загружаемая/валидируемая тестовая карта                            | P02                          | READY WITH PROVISIONAL DETAILS                                    |
| P04 | Минимальный HOT movement                  | Серверное авторитетное перемещение и коллизии                      | P03                          | READY WITH PROVISIONAL DETAILS                                    |
| P05 | Network replication + realtime client     | Prediction, reconciliation, interpolation, PixiJS vertical slice   | P02, P04                     | READY WITH PROVISIONAL DETAILS                                    |
| P06 | HOT/COLD bridge и recovery                | Надёжные дискретные события и проверенное восстановление           | P02, P04                     | BLOCKED BY DECISION для persistence guarantees; прототип допустим |
| P07 | Environment и базовые взаимодействия      | Свет, двери, укрытия, газ/фильтры, стимулы и proximity             | P03–P06                      | Часть READY, часть BLOCKED BY DECISION                            |
| P08 | Doll AI baseline                          | Патруль, восприятие, память, поиск, преследование и захват         | P03–P07                      | BLOCKED BY DECISION для полной сенсорики/захвата                  |
| P09 | COLD gameplay domains                     | Инвентарь, ресурсы, крафт, предметы, evidence, social/sabotage     | P02, P06, P07                | READY WITH PROVISIONAL DETAILS; нужны доменные спецификации       |
| P10 | Match lifecycle                           | Lobby, seed/roles, пролог, этажи, фазы, participant states         | P02, P06, P09                | BLOCKED BY DECISION для ряда правил на 7–10 игроков и progression |
| P11 | Observer и Developer tooling              | Полная Observer view, debug projections, отдельные God Actions     | P02, P05, P06, P10           | Read-only часть READY; actions BLOCKED BY DECISION                |
| P12 | Андрей без LLM и с LLM                    | Scripted lifecycle, memory/beliefs, provider, budget/fallback      | P02, P06, P09, P10           | READY WITH PROVISIONAL DETAILS; открыты диалоговые правила        |
| P13 | Finale, endings и cycle reset             | Детерминированный Ending Resolver и сюжетная перемотка             | P06, P09, P10, P12           | BLOCKED BY DECISION                                               |
| P14 | Art/content pipeline и полные World Packs | Производственный pipeline Blender/World Pack/scene assets          | P03, P05, P07                | READY WITH PROVISIONAL DETAILS                                    |
| P15 | Интеграция, нагрузка и release readiness  | Проверенный вертикальный срез и затем playable alpha               | P00–P14 в необходимом объёме | DEFERRED до готовности функций                                    |

---

# 4. Подробный план реализации

## P00. Инвентаризация текущего репозитория и baseline

**Статус:** READY.  
**Тип:** обязательный аудит без функционального изменения поведения.

### Цель

Установить фактическое состояние ветки репозитория на момент начала реализации. Предыдущие архитектурные документы описывают состояние репозитория на 2026-11-08; перед работой агент обязан проверить актуальную ветку и рабочее дерево.

### Работа агента

1. Проверить текущую ветку, `git status`, незакоммиченные изменения и последние изменения репозитория.
2. Прочитать `README`, архитектурные документы, package manifests, workspaces, scripts и CI configuration.
3. Инвентаризировать:
   - `shared/contracts` и Zod schemas;
   - Fastify routes и WebSocket gateway;
   - auth/session/membership;
   - `StateService`, persistence adapters и Drizzle schema;
   - EventBus/Outbox, idempotency и snapshots;
   - Session/Match/Location/Story/Chat/Journal/Inventory/Items (если присутствуют);
   - Turn Engine, `TURN_*`, GM workflow и старый AI Director;
   - Svelte app, WSClient и текущие views;
   - test suites, architecture tests, dependency-cruiser и lint/typecheck/build.
4. Запустить существующие проверки без изменения кода.
5. Записать фактические команды запуска/проверки и результаты. Не утверждать, что тесты пройдены, если они не запускались.
6. Составить mapping таблицу: `existing component → target v4 role → preserve/refactor/remove/unknown`.
7. Составить список зависимостей от Turn Engine/GM-only contracts.

### Выходные артефакты

- `docs/implementation/REPOSITORY_AUDIT.md` или эквивалентный документ;
- baseline test report;
- migration inventory;
- список рисков и блокеров.

Путь файлов — предложение; сначала проверить принятую структуру `docs/`.

### Критерии завершения

- Актуальная структура проекта подтверждена кодом, а не только README.
- Найдены источники истины для контрактов, state и transport.
- Понятно, какие существующие модули можно сохранить.
- Зафиксированы падающие/неработающие проверки до миграции.
- Функциональный код не изменён.

### Запреты

Не удалять Turn Engine на этом этапе. Не создавать новую реализацию HOT. Не выполнять массовый рефакторинг «для подготовки».

---

## P01. Реестр решений и уточнение архитектурных блокеров

**Статус:** READY WITH PROVISIONAL DETAILS.

### Цель

Не допустить, чтобы coding agent принял решения об игровом каноне вместо владельца проекта. Создать единый реестр открытых решений с указанием, какие этапы ими блокируются.

### Работа

1. Сверить открытые вопросы в `SYSTEM_ARCHITECTURE`, `HOT_COLD_DESIGN`, `WORLD_SIMULATION`, `DOLL_AI`, `ANDREY_AI`, `NETWORK_PROTOCOL`, `MATCH_LIFECYCLE`.
2. Удалить дубли из реестра, но сохранить исходные ID документов.
3. Для каждого вопроса записать:
   - формулировку;
   - варианты, если они перечислены в исходной спецификации;
   - влияние на архитектуру/игровой процесс;
   - этапы, которые блокируются;
   - можно ли выполнить интерфейс/прототип, не выбирая правило;
   - кто и каким способом утверждает решение.
4. Разделить вопросы на:
   - **BLOCKER** — без ответа нельзя безопасно реализовать конкретную механику;
   - **PROTOTYPE** — можно измерить на тестовой карте;
   - **CONTENT** — требуется перед production-контентом;
   - **DEFERRED** — не входит в первый playable slice.
5. Подготовить ADR только для решений, которые уже подтверждены; не превращать предложение в согласованное ADR.

### Важные группы блокеров

- World Simulation: coordinate convention, input mode, collider, grid adjacency, gas/light/sound model, World Pack authoring, interaction gating и priority при конкурентных взаимодействиях (см. `WS-01…WS-22`).
- HOT/COLD: durable HOT event guarantee, snapshot interval, rollback/restore semantics, pause-on-persistence-failure, COLD serialization policy и disconnect semantics (см. `HC-01…HC-14`).
- Doll AI: сенсорная трактовка «слепые, слышат», Мнемосин ×1.5, точность локализации стимулов, этажные способности, coordination, detect/capture и перенос (см. `DOLL-OPEN-01…19`).
- Network: input mode/lease, scene update rates, resume/reconnect, private chat semantics, observer actions and visibility, rate limits, protocol compatibility (см. `NET-01…NET-20`).
- Match: room ownership/ready check/invites, role distribution at 7–10, multiple matches, disconnect/AFK/pause, voting threshold/ties, floor support/return, captured player actions/rescue, finale admission and ending precedence (см. `ML-01…38`).
- Andrew: audience and interaction rules, belief/trust semantics, allowed claims, actual provider and budget (см. `AND-OPEN-*`).

### Критерии завершения

- Все решения, требуемые для ближайшего прототипа, имеют владельца/статус.
- Coding agent может точно определить, что ему разрешено реализовывать без уточнения.
- Отложенные сюжетные правила не блокируют тестирование движения.

---

## P02. Общие контракты, application boundaries и миграционная основа

**Статус:** READY WITH PROVISIONAL DETAILS.  
**Зависимости:** P00, P01.

### Цель

Укрепить общие границы до появления параллельных реализаций протокола и состояния.

### Работа

1. Сохранить `shared/contracts` единственным источником Zod contracts для HTTP/WS.
2. Выполнить mapping старых WS-сообщений к целевому протоколу (`preserve / replace / remove / split`).
3. Определить единый message envelope и семантику разных ID согласно `NETWORK_PROTOCOL.md`.
4. Определить общие идентификаторы/типы, которые реально нужны нескольким модулям: `MatchId`, `ParticipantId`, `PlayerId`, `WorldId`, `FloorId`, `WorldEpoch`, `CommandId`, `EventId`, revisions/sequence.
5. Зафиксировать правила импорта и dependency direction. Контракты не должны импортировать runtime-классы сервера или PixiJS.
6. Сохранить Ports & Adapters и modular monolith. Не создавать микросервисы.
7. Ввести/уточнить error envelope, correlation ID, command idempotency и audit event schemas, если это согласовано контрактами.
8. Подготовить Player/Observer/Developer projection interfaces, не смешивая полномочия.
9. Установить migration policy для старых `TURN_*` и GM-only schemas: удалять только после того, как потребители перенесены и tests подтверждают отсутствие использования.
10. Не менять auth handshake/token transport без решения из `NETWORK_PROTOCOL.md`.

### Тесты

- Zod schema positive/negative tests;
- contract version/compatibility tests;
- dependency-cruiser/architecture tests;
- tests на отсутствие секретных полей в Player projection;
- idempotency unit tests для уже существующего механизма или нового wrapper.

### Критерии завершения

- Один источник схем.
- Нет параллельного неофициального WS catalog.
- Существующие полезные adapters/services найдены и переиспользуются.
- Зависимости модулей не нарушают архитектурные правила.
- Старые turn/GM элементы имеют mapping и план удаления.

---

## P03. World Pack и координатная модель

**Статус:** READY WITH PROVISIONAL DETAILS.  
**Зависимости:** P02.

### Цель

Получить независимое от PixiJS описание тестового игрового пространства, которое сервер может загрузить и проверить.

### Работа

1. Закрыть или явно пометить временными вопросы `WS-01`, `WS-02`, `WS-05`, `WS-06`, `WS-20` в пределах прототипа.
2. Определить временную coordinate convention в одном месте, если пользовательское решение ещё не требуется для прототипа.
3. Реализовать базовые value objects: world/grid/cell position и преобразования, согласованные с `WORLD_SIMULATION.md`.
4. Определить минимальный versioned World Pack schema:
   - manifest;
   - geometry;
   - navigation;
   - objects;
   - spawn points;
   - doll waypoints;
   - client assets references;
   - дополнительные слои gas/lighting/acoustics только в объёме, который нужен тестовой карте.
5. Реализовать World Pack loader и validator.
6. Подготовить одну тестовую комнату/зону с полом, стенами, проходом, дверью и точками появления.
7. Проверить совпадение серверной геометрии и данных, используемых для клиентской проекции, без зависимости от рендера.

### Тесты

- grid/world conversion;
- invalid/out-of-bounds cells;
- duplicate IDs/references;
- disconnected or invalid portals;
- malformed geometry/navigation;
- deterministic load/validation output.

### Критерии завершения

Сервер может загрузить и валидировать тестовую карту без PixiJS. World Pack errors понятны, воспроизводимы и привязаны к объектам/координатам.

---

## P04. Минимальный HOT runtime и авторитетное движение

**Статус:** READY WITH PROVISIONAL DETAILS.  
**Зависимости:** P02, P03.

### Цель

Доказать, что сервер может непрерывно симулировать перемещение игроков с фиксированным шагом, не завися от клиентской позиции.

### Работа

1. Реализовать isolated HOT runtime с фиксированным `dt=50 ms` и диагностикой длительности tick.
2. Определить стабильный порядок обработки входящих movement inputs.
3. Подключить World Pack geometry/collision queries.
4. Реализовать server-authoritative movement и базовые collision constraints.
5. Клиентские координаты использовать только как непроверенное намерение/ввод, не как окончательную позицию.
6. Обеспечить input sequence/ack semantics согласно `HOT_COLD_DESIGN.md` и `NETWORK_PROTOCOL.md`.
7. Сделать тестовую симуляцию для двух игроков на одной карте.
8. Добавить tick overrun metrics и контролируемую политику catch-up/overload по HOT/COLD spec. Не пропускать критическое игровое время молча.

### Тесты

- движение в четырёх/диагональных направлениях, если разрешено выбранной input model;
- скорость и ограничения;
- столкновение со стенами и дверями;
- движение у границ карты;
- stale/duplicate/out-of-order input;
- стабильность порядка команд при одинаковом seed/входах;
- tick duration instrumentation.

### Критерии завершения

Два игрока могут непрерывно двигаться на серверной карте, сервер не принимает присланную клиентом конечную позицию и не допускает проход через запрещённые препятствия.

---

## P05. Сетевое scene replication и первый realtime-клиент

**Статус:** READY WITH PROVISIONAL DETAILS.  
**Зависимости:** P02, P04.

### Цель

Доказать, что 20 Гц серверной симуляции совместимы с плавным отображением браузерной сцены.

### Работа

1. Реализовать scene keyframe/snapshot и delta semantics согласно сетевой спецификации.
2. Разделить `inputSequence`, `sceneSequence`, event sequence, command ID и world epoch.
3. Сделать Player scene projection и отдельный Observer projection channel/DTO в объёме прототипа.
4. Реализовать PixiJS canvas/application bootstrap внутри существующей Svelte SPA.
5. Реализовать camera, grid-to-screen projection и отрисовку test room.
6. Добавить local prediction собственного персонажа, authoritative reconciliation и interpolation buffer для удалённых сущностей.
7. Клиент должен рендерить независимо от server snapshots; цель визуального прототипа — 60 FPS и выше при доступном оборудовании, но измерять actual frame time.
8. Добавить искусственные RTT/jitter/loss profiles в тестовом окружении. Не считать идеальную localhost-сеть доказательством плавности.
9. Реализовать reconnect → полный актуальный keyframe/resync. Старые movement inputs не должны повторно исполняться после reconnect.
10. Проверить, что PlayerProjection не содержит скрытых ролей и состояния заражения.

### Тесты

- scene sequence/base sequence validation;
- input ACK and reconciliation;
- remote interpolation with jitter;
- dropped snapshot and resync;
- player projection privacy;
- browser test на два движущихся персонажа;
- измерение frame time и input-to-visual response.

### Критерии завершения

Два игрока видят друг друга в одной тестовой комнате; собственное движение визуально реагирует сразу, удалённое движение сглаживается; после пропуска snapshots/reconnect клиент восстанавливает актуальное состояние. Качество проверено с искусственными задержками и документировано.

---

## P06. HOT/COLD bridge, durable events и crash recovery foundation

**Статус:** BLOCKED BY DECISION для production durability guarantees; READY для прототипа и контрактов.  
**Зависимости:** P02, P04.

### Цель

Установить надёжную границу между непрерывной симуляцией и долговременными игровыми изменениями.

### Работа

1. Реализовать типизированные `ColdToHotCommand` и `HotGameplayEventEnvelope`.
2. Ввести ревизии для COLD → HOT updates и детерминированное применение на границе tick.
3. HOT events должны содержать event ID, match/world epoch, tick/time context, actor/source refs и correlation metadata в рамках согласованной схемы.
4. COLD processor выполняет domain validation, idempotency и mutations через `StateService`.
5. ACK на durable event выдаётся только после подтверждённой фиксации COLD mutation.
6. Повторная доставка одного event не должна повторять игровой эффект.
7. Отделить ephemeral scene updates от durable gameplay events. Scene delta coalescing не должно терять durable events.
8. Реализовать очередь/Outbox или согласованный механизм доставки, опираясь на фактическую persistence architecture. Не вводить вторую независимую систему доставки без необходимости.
9. Определить snapshot versioning и consistent recovery point.
10. До принятия решения о rollback transient HOT state реализовать crash/restart harness, который показывает фактические потери и порядок восстановления.
11. Не считать crash recovery сюжетной перемоткой.

### Блокирующие решения

- `HC-06`: надёжная фиксация HOT events до потери процесса;
- `HC-07`: snapshot interval;
- `HC-08`: допустимый rollback transient state;
- `HC-09`: условия pause/stop match при проблеме persistence;
- `HC-10`: модель сериализации COLD mutations.

### Тесты

- duplicate HOT event;
- event delivered before/after commit;
- COLD processor failure and retry;
- COLD→HOT revision ordering;
- process restart between HOT event and COLD commit;
- restore from snapshot + durable events;
- no duplicate item/filter/capture result after replay.

### Критерии завершения

Команда и событие имеют определённую семантику commit/ACK/retry; тесты подтверждают, какие данные сохраняются и как восстанавливаются после crash. Production guarantees не заявляются до закрытия перечисленных вопросов.

---

## P07. Пространственная среда и базовые взаимодействия

**Статус:** READY WITH PROVISIONAL DETAILS; часть игровых правил требует решений.  
**Зависимости:** P03–P06.

### Цель

Добавить минимальные механики окружающей среды, которые непосредственно поддерживают исследование и тактику.

### Порядок внутри этапа

1. Door state + dynamic geometry revision.
2. Light switch state + gameplay illumination query + client visual overlay.
3. Hideout enter/exit + occupancy + concealment query.
4. Proximity enter/exit transitions и hysteresis.
5. Газовое поле и точечный запрос уровня загрязнения.
6. Активный фильтр и deterministic consumption.
7. Локальные WorldStimulus types и bounded propagation.
8. Связать стимулы с Perception port, но не реализовывать полноценный Doll AI до P08.

### Работа

- Сервер валидирует взаимодействие по авторитетной позиции, world/room context и permissions.
- COLD владеет долговременными состояниями объектов/команд, HOT получает runtime revision и учитывает их в пространственных запросах.
- Переходы proximity генерируются на enter/exit, а не на каждом tick.
- Укрытие не является абсолютной неуязвимостью.
- Глобальная шкала шума не вводится.
- Визуальный свет и gameplay illumination согласованы, но вычисляются разными подсистемами.
- Газ не моделируется как particles/falling-sand.

### Блокирующие вопросы

См. `WS-08…WS-18`, `WS-21…WS-22`, `HC-11…HC-12` и соответствующие открытые пункты `WORLD_SIMULATION.md`. Для базового прототипа допустимы `PROTOTYPE-ONLY` значения, но только в отдельной конфигурации.

### Тесты

- door open/close changes collision/navigation revision once;
- light state and gameplay illumination query;
- hideout capacity/occupancy and enter/exit;
- proximity hysteresis/no repeated enter events;
- gas lookup and filter depletion event exactly once;
- stimulus locality, occlusion and expiry once agreed;
- simultaneous interaction/capture race scenarios once priority is decided.

### Критерии завершения

Тестовая карта поддерживает двери, переключатель света, укрытие и выбранные environment queries. Все действия проходят server validation, state ownership и event semantics соблюдены.

---

## P08. Doll AI baseline и вертикальный срез захвата

**Статус:** BLOCKED BY DECISION для полной сенсорики и захвата; прототип patrol допустим.  
**Зависимости:** P03–P07 и базовые participant states из P10 (можно временно использовать test harness).

### Цель

Реализовать одну куклу как алгоритмического агента — без LLM — и проверить полный цикл патруля/реакции/преследования/захвата после закрытия необходимых игровых правил.

### Последовательность

1. Doll Definition и runtime state.
2. Navigation waypoint patrol по существующему Navigation API.
3. Perception stimulus routing.
4. Ограниченная Memory с provenance и TTL.
5. FSM/Decision и стабильные transition rules.
6. Search/Investigate/Pursuit после согласования сенсорной модели.
7. Capture request → COLD validation/commit → participant `Captured/Stasis` state.
8. Перенос большой куклой в Детскую после определения роли обычной/большой куклы и условий прерывания.
9. Floor Tactical Profiles и прогрессия Э1–Э6.
10. Coordination/blackboard только после решения об информационном обмене.

### Не делать до согласования

- не выбирать самостоятельно трактовку «слепая кукла» vs световой/направленный detection;
- не применять ×1.5 к произвольно выбранному сенсорному радиусу;
- не делать куклу всеведущей;
- не добавлять открывание дверей/обыск укрытий куклой без утверждённых правил;
- не реализовывать полноценную тактическую координацию только потому, что она архитектурно предусмотрена.

### Тесты

- waypoint patrol determinism;
- stimulus provenance/locality/TTL;
- no omniscient target acquisition;
- memory expiry;
- blocked path and replan;
- multiple doll tie-breaks;
- capture idempotency;
- player remains in match and is not removed;
- replay with same inputs/seed where deterministic behavior is promised.

### Критерии завершения

Одна кукла предсказуемо патрулирует и реагирует только на разрешённые стимулы. После утверждения сенсорики и capture rules она корректно захватывает игрока через COLD, не удаляя его из партии. Этажные профили конфигурируются данными.

---

## P09. COLD gameplay domains

**Статус:** READY WITH PROVISIONAL DETAILS; детальная реализация требует отдельных доменных спецификаций.  
**Зависимости:** P02, P06, P07.

### Цель

Реализовать доменные правила, которые не должны находиться внутри HOT simulation или клиентского UI.

### Области

- Inventory / item ownership / transfer;
- Resources / filters / distribution journal;
- Crafting stations / recipes / components / quality resolution;
- Evidence / documents / authored true/distorted variants / authenticity;
- Social / chat / whisper / notes / contact traces;
- Infected sabotage / private objectives / item corruption;
- devices and their corruption state;
- Journal / Story integration.

### Обязательная подготовка

В текущем комплекте архитектурных документов не все перечисленные домены имеют отдельную полную реализационную спецификацию. До существенной реализации coding agent должен:

1. проверить существующие модули и tests;
2. извлечь подтверждённые правила из «Цикла 48»;
3. перечислить недостающие схемы, state transitions и permissions;
4. при необходимости предложить отдельные спецификации `ITEMS_AND_INVENTORY.md`, `CRAFTING_AND_RESOURCES.md`, `EVIDENCE_AND_SOCIAL.md`;
5. не придумывать рецепты, численные стоимость/расход, состав ролей, правила проверки и private channel policy.

### Рекомендуемый порядок

1. Item definitions and ownership.
2. Resource/filter ledger and active filter integration.
3. Device/object corruption and authenticity states.
4. Crafting pipeline with deterministic resolution.
5. Evidence/document access and true/distorted content selection.
6. Chat/whisper/note/trace privacy integration.
7. Sabotage commands, frequency limits and audit.

### Критерии завершения

Каждый домен имеет одного владельца состояния, typed command/event contracts, server-side authorization, idempotency, persistence tests, privacy tests и понятную связь с Match lifecycle.

---

## P10. Match aggregate, lobby и progression

**Статус:** BLOCKED BY DECISION для полной реализации; базовый aggregate/state machine можно проектировать.  
**Зависимости:** P02, P06, P09; World Pack loader из P03.

### Цель

Оркестрировать полноценную партию, не перенося её progression в HOT tick и не возвращая Turn Engine.

### Последовательность

1. Match aggregate и separation of lifecycle status / progression stage / floor phase.
2. Lobby membership, invitation/ready/start preconditions после решения ML-01…ML-05.
3. Scenario Configuration: seed, version, roles, corrupted items, doll profile selection; validation before start.
4. Prologue/Shuttle start stage.
5. Five phases of floors E1–E6 as COLD progression states; HOT simulation continues while phases change.
6. Participant statuses and locations: active group, left-behind support, captured/stasis; no player elimination.
7. Floor transitions as explicit COLD command, with World Pack/world epoch lifecycle.
8. Floor milestones and authored reveal events, integrated through domain ports.
9. Recovery/resume same Match after disconnect/crash, distinct from narrative loop reset.
10. Post-match result and audit.

### Блокирующие вопросы

- ML-01…ML-07 для room/start/disconnect/pause;
- ML-04 role distribution for 7–10 players;
- ML-08…ML-15 for thresholds, ties, support/return and phase completion;
- ML-16…ML-20 for captured player and rescue behavior.

### Тесты

- valid/invalid lobby start;
- role/scenario configuration constraints;
- deterministic configuration from seed;
- legal/illegal progression transitions;
- floor phase changes do not stop HOT runtime;
- participant left-behind/captured remains a match member;
- duplicate transition commands are idempotent;
- reconnect does not silently alter participant gameplay state;
- floor/world epoch transition and resync.

### Критерии завершения

Полный тестовый lifecycle от создания комнаты до Э6 работает на явно утверждённом составе участников и конфигурации. Неутверждённые варианты игроков/голосований остаются недоступными, а не получают неявные правила.

---

## P11. Observer («Бог») и Developer tooling

**Статус:** read-only Observer projection READY; God Actions BLOCKED BY DECISION.  
**Зависимости:** P02, P05, P06, P10.

### Цель

Разделить полную видимость состояния партии, вмешательства наблюдателя и техническую диагностику разработчика.

### Observer

- необязателен и не занимает player slot;
- видит всё скрытое игровое состояние: роли, заражение, истинные состояния предметов, скрытые события, факты/убеждения Андрея и внутреннее состояние кукол в пределах gameplay state;
- получает отдельную серверную ObserverProjection;
- не получает infrastructure secrets, credentials, provider API keys или данные других матчей;
- не использует PlayerProjection как источник и не собирает секреты на клиенте из player payloads.

### God Actions

- каталог допустимых команд должен быть утверждён отдельно;
- команды проходят permission check, domain validation, idempotency и audit;
- просмотр не автоматически даёт право вмешательства;
- вопросы о видимости вмешательства игрокам и допустимых вмешательствах остаются открытыми (`ML-33…38`, `NET` observer items).

### Developer tooling

- DeveloperProjection отдельно от Observer;
- debugging может включать tick traces, Doll AI decisions, Andrew request traces и replay fixtures;
- GM Review существует только в development/test;
- Developer tools не должны входить в production player/observer permissions по умолчанию.

### Критерии завершения

Observer видит скрытую игровую картину, Player не получает скрытые поля, Developer diagnostics отделены от gameplay, God Actions доступны только после утверждения каталога и полностью журналируются.

---

## P12. Андрей: сначала scripted core, затем LLM

**Статус:** READY WITH PROVISIONAL DETAILS; часть dialog/privacy rules открыта.  
**Зависимости:** P02, P06, базовые COLD/Match state из P09–P10.

### Последовательность

1. Андрей без LLM: Narrative State, Knowledge, Beliefs, Relationships (только если модель утверждена), история и StateService integration.
2. Scripted/echo/failing provider для тестов и fallback.
3. Prompt Builder с минимально необходимым контекстом и untrusted player text.
4. Structured response schema и validator; claims/belief updates — только предложения, не world mutations.
5. LLM Gateway и существующий AI_PROVIDER adapter, если он подходит после аудита.
6. Token/request budget, estimate vs actual usage, queue, timeout, rate limit, circuit breaker, cache и fallback.
7. Narrative arc по Э1–Э7 через authored triggers; LLM только формулирует разрешённую реплику.
8. Observer/Developer projections и developer-only GM Review.
9. Playtest latency/token usage и budget tuning.

### Условия безопасности

- Андрей не изменяет canon, роли, предметы и Match progression напрямую.
- Beliefs не сливаются с World Truth автоматически.
- Ошибки, устаревшие знания и доверие к ложной информации — контролируемые игровые свойства.
- Ответы не проходят обязательный человеческий review в production.
- Любая ошибка или недоступность провайдера приводит к timeout/fallback, не к зависанию партии.

### Критерии завершения

Партия и сюжетная арка Андрея работают с scripted provider при полном отключении LLM. При доступном провайдере LLM формирует валидированные реплики; бюджет/latency/fallback измеряются и видны в Developer diagnostics.

---

## P13. Finale, Ending Resolver и narrative reset

**Статус:** BLOCKED BY DECISION.  
**Зависимости:** P06, P09, P10, P12.

### Цель

Реализовать финал как детерминированную проверку канонических игровых фактов, а не как решение LLM.

### Работа до закрытия правил

- определить immutable/authoritative records для syringe quality, treatment target, identity/name condition, Neofron substitution, developer's reagent validity, active/captured/left-behind participants;
- реализовать tests для хранения и доступа к финальным фактам;
- создать interface/placeholder EndingResolver без выдуманного precedence;
- разделить technical crash recovery и narrative reset abstractions.

### После закрытия ML-21…ML-32

1. Утвердить минимальное число активных участников на Э7 для всех размеров партии.
2. Утвердить ending precedence, включая конкурирующие условия Доминации и инъекции.
3. Утвердить роль имени «Алиса» в Идеальной концовке.
4. Утвердить последствия испорченного антидота для новых заражённых и условий концовок.
5. Утвердить адаптацию Забвения под 6–10 игроков.
6. Утвердить Match vs Cycle identity, reset rules и meta-memory.
7. Утвердить невозможность перемотки после Кристаллизации.
8. Реализовать EndingResolver с таблицей decision cases и regression tests.

### Критерии завершения

Для каждого набора канонических финальных фактов существует однозначный, воспроизводимый результат. LLM не выбирает и не изменяет концовку. Crash recovery не запускает новую сюжетную итерацию.

---

## P14. Production art/content pipeline и World Packs

**Статус:** READY WITH PROVISIONAL DETAILS.  
**Зависимости:** P03, P05, P07; детальная сенсорика не обязательна для базового art export.

### Работа

1. Утвердить authoring format World Pack (см. `WS-20`).
2. Создать pipeline Blender exports → quantization/palette → nearest-neighbor upscale → atlas/background assets.
3. Ввести asset manifest и стабильные IDs, связывающие art assets с world objects.
4. Реализовать Baked Room renderer и Tile-based Area renderer.
5. Согласовать projection matrix и depth sorting на test scene.
6. Реализовать визуальный слой динамического света отдельно от gameplay illumination.
7. Подготовить одну законченную комнату и один перестраиваемый участок.
8. Ввести World Pack validation в build/test pipeline.
9. Не использовать изображения как источник коллизий, навигации или канонических фактов.

### Критерии завершения

Одна baked room и одна tile-based area используют ту же серверную геометрию, объекты совпадают с interaction/collision positions, палитра и pixel scaling проверяются автоматизированно/визуально.

---

## P15. Сквозная интеграция, нагрузочное тестирование и playable alpha

**Статус:** DEFERRED до готовности требуемых вертикальных срезов.

### Цель

Подтвердить работоспособность ключевых систем вместе, а не только по отдельности.

### Проверки

1. 6–10 игроков, если соответствующий role/lobby ruleset утверждён.
2. Один Observer с полной ObserverProjection.
3. Реалистичное число активных кукол и объектов World Pack.
4. HOT tick duration/overrun и очереди HOT↔COLD.
5. 20 Hz server simulation при браузерном render loop, prediction/interpolation.
6. RTT/jitter/loss and reconnect scenarios.
7. Database interruption/restart/crash recovery.
8. Privacy tests для Player/Observer/Developer projections.
9. LLM provider unavailable/timeout/rate limit/budget exhausted.
10. Повтор/дублирование commands and events.
11. Deterministic replay/seed fixtures в пределах обещанной семантики.
12. End-to-end scenario: исследование → локальный стимул → кукла реагирует → игрок скрывается/захвачен → COLD state updates → другие клиенты получают правильные projections.
13. End-to-end scenario: разговор с Андреем при валидном LLM response и при fallback.
14. End-to-end scenario: disconnect/reconnect в разных participant states.

### Критерии alpha

- Основной игровой срез можно пройти без обязательного GM и без LLM.
- Нет подтверждённых утечек скрытых ролей/состояний в PlayerProjection.
- HOT simulation не зависит от LLM/DB на каждом тике.
- Crash recovery поведение соответствует утверждённым гарантиям.
- Игровые действия и финальные исходы определяются сервером.
- Известные ограничения и незавершённые системы перечислены в release notes.

---

# 5. Потоки, которые можно вести параллельно

Параллельная работа разрешается только при стабильных интерфейсах и отсутствии одновременного редактирования общих contracts.

| Поток                                     | Может идти параллельно с | Условие                                                                             |
| ----------------------------------------- | ------------------------ | ----------------------------------------------------------------------------------- |
| Арт-производство и подготовка ассетов     | P03–P13                  | Asset IDs и World Pack references согласованы; art не задаёт collision geometry     |
| Svelte UI shell и интерфейсные макеты     | P03–P10                  | Не содержит самостоятельно реализованных игровых правил                             |
| Domain specs для crafting/evidence/social | P03–P08                  | Сначала спецификация и решения; не менять общие контракты без согласования          |
| Андрей scripted dialogue fixtures         | P03–P10                  | Использует server-owned state contracts; не зависит от LLM                          |
| Нагрузочные harnesses                     | P04–P15                  | Измеряют реальные интерфейсы; не меняют production behavior                         |
| Observer read-only UI                     | P05–P11                  | Использует отдельную ObserverProjection; не получает секреты через PlayerProjection |

Не вести параллельно несколько реализаций `shared/contracts`, World Pack schema, event envelope или Match state machine.

---

# 6. Зависимости и блокирующие решения

## 6.1. Правило блокировки

Открытый вопрос блокирует только те функции, чьё поведение от него зависит. Он не должен останавливать весь проект, если можно безопасно продолжить независимую инфраструктуру.

Примеры:

- Неизвестная модель слуха кукол блокирует production Perception behavior, но не блокирует World Pack loader или базовый waypoint patrol.
- Неизвестные правила ролей на 7–10 игроков блокируют запуск полных матчей этих размеров, но не блокируют тест HOT на двух test entities.
- Неизвестный ending precedence блокирует production EndingResolver, но не блокирует persistence финальных фактов.
- Неизвестный God Actions catalog блокирует вмешательство Observer, но не read-only ObserverProjection.
- Неизвестный LLM provider budget блокирует production provider tuning, но не блокирует Andrew scripted core и provider interface.

## 6.2. Карта блокирующих групп

| Группа вопросов                | Источники                                             | Блокируемая работа                                    | Что можно делать до решения                                      |
| ------------------------------ | ----------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------- |
| Координаты/input/collider/grid | `WS-01…WS-06`, `HC-02…HC-04`, `NET` movement items    | Production movement/physics/input UX                  | Изолированный prototype с пометкой PROTOTYPE-ONLY                |
| HOT durability/recovery        | `HC-06…HC-10`, `O-01`, `O-02`, `WS-17` where relevant | Production crash guarantees                           | Crash harness, event/command contracts, fault injection          |
| Light/vision/sound/gas         | `WS-07…WS-13`, `DOLL-OPEN-01…03`                      | Final perception and detection balance                | Query interfaces, test fixtures, prototype-only models           |
| Doll tactical behavior         | `DOLL-OPEN-04…15`                                     | Full floor profiles, coordination, capture edge rules | Patrol and internal runtime skeleton                             |
| Lobby/matchmaking              | `ML-01…ML-07`, `ML-15`                                | Public room/start flow and full party                 | Match aggregate skeleton, test harness                           |
| Progression/support/vote       | `ML-08…ML-15`                                         | Production floor transitions                          | State machine scaffolding and unit tests for agreed transitions  |
| Captured state/rescue          | `ML-16…ML-20`                                         | Full capture/rescue UX                                | COLD status model only where already agreed; no invented actions |
| Ending/cycle reset             | `ML-21…ML-32`                                         | EndingResolver, reset and meta-memory                 | Store canonical final facts and build resolver interface         |
| Observer actions               | `ML-33…ML-38`, Observer items in `NET`                | God Actions                                           | Full read-only Observer projection                               |
| Andrew privacy/LLM             | `AND-OPEN-*`, budget questions in `ANDREY_AI.md`      | Full dialogue audience/production tuning              | Scripted core, fixtures, local fake provider                     |
| Crafting/evidence/social rules | «Цикл 48» plus any gaps in current code               | Full domain behavior                                  | Existing code audit and separate specifications                  |

## 6.3. Не закрывать открытые вопросы техническими default values

Если в интерфейсе нужны временные параметры для тестового прототипа, они должны:

- быть централизованы;
- иметь маркировку `PROTOTYPE-ONLY`;
- не попадать в production content packs;
- иметь соответствующий test fixture;
- быть перечислены в отчёте этапа.

---

# 7. Сквозные quality gates

Каждый этап должен пройти применимые quality gates. Нельзя считать этап завершённым только потому, что приложение запускается на машине агента.

## 7.1. Code and architecture

- TypeScript strict checks проходят.
- Lint/build проходят по существующим scripts.
- Unit/integration tests нового поведения проходят.
- Dependency/architecture tests проходят.
- Нет циклических зависимостей или обхода Ports & Adapters.
- Серверные модули не импортируют Svelte/PixiJS/client assets.
- Клиентские модули не импортируют mutable server runtime classes.
- Zod schemas остаются единым contract source.

## 7.2. Authority and privacy

- Клиент не может назначить себе конечную позицию/роль/заражение/подлинность/исход.
- Каждый входящий command аутентифицирован, авторизован и валидирован.
- Повтор command/event не повторяет игровой эффект.
- PlayerProjection не содержит скрытых данных.
- ObserverProjection содержит все скрытые игровые факты, предусмотренные спецификацией, но не инфраструктурные секреты.
- Developer diagnostics не доступны игрокам/обычному Observer по умолчанию.
- God Actions журналируются и проверяются отдельным permission.

## 7.3. Realtime simulation

- HOT fixed-step semantics соблюдены.
- В HOT tick нет LLM/HTTP/DB calls.
- Tick duration/overrun измеряются.
- Scene replication отделена от durable events.
- Клиентский рендеринг независим от 20 Hz updates.
- Prediction/reconciliation/interpolation тестируются с jitter/loss.
- При перегрузке игровое время не теряется молча.

## 7.4. Persistence and recovery

- State mutations проходят через утверждённые COLD boundaries.
- Durable event ACK выдаётся по подтверждённой commit semantics.
- Snapshots versioned.
- Recovery test отделён от narrative reset.
- После reconnect клиент получает актуальную projection/keyframe.
- Проверены crash windows между event creation, COLD commit, snapshot и restart.

## 7.5. AI resilience

- Основная партия работает с LLM disabled.
- Андрей имеет scripted provider/fallback.
- LLM timeout/rate limit/budget exhaustion не блокируют игровой цикл.
- LLM response schema валидируется.
- LLM не может записать canonical facts или решить концовку.
- Prompt/context не содержит лишние секреты/чужую приватную переписку.
- Token usage, latency, fallback и provider error metrics доступны Developer diagnostics.

## 7.6. Browser experience

- PixiJS renders independently from server update rate.
- Input feedback for own character is immediate through the approved prediction model.
- Remote entities interpolate across snapshots.
- Scene projection matches server World Pack geometry.
- Dynamic light visual layer aligns with gameplay state.
- Browser tab background/visibility behavior is tested; client cannot advance authoritative time locally.

---

# 8. Definition of Done для одного этапа

Этап можно пометить **DONE** только при выполнении всех применимых пунктов:

1. Объём этапа не расширен незаметно.
2. Все затронутые решения имеют статус.
3. Изменённые файлы перечислены.
4. Новые/изменённые Zod contracts задокументированы и протестированы.
5. Server-side permissions and state ownership проверены.
6. Unit tests проходят.
7. Integration tests проходят для межмодульных потоков.
8. E2E/Playwright tests добавлены там, где этап затрагивает browser flow.
9. Lint/typecheck/build проходят.
10. Architecture/dependency tests проходят.
11. Нет известного нарушения privacy/authority/idempotency.
12. Открытые вопросы перечислены с привязкой к ID.
13. Временные значения помечены `PROTOTYPE-ONLY` и не просочились в production config.
14. Документация и diagrams обновлены.
15. Отчёт содержит фактический результат, а не только список сделанного.

Если обязательная проверка не проходит из-за существующего baseline failure, агент должен указать точное различие: baseline failure или регрессия. Нельзя скрывать неуспешные тесты.

---

# 9. Протокол работы автономного coding agent

Этот раздел предназначен непосредственно для Qwen 3.8 Max или другого coding agent, которому передаётся комплект документов.

## 9.1. Перед началом каждой задачи

1. Прочитать этот roadmap и связанные спецификации, указанные у этапа.
2. Проверить актуальный `git status`, branch и незакоммиченные изменения.
3. Проверить, не обновились ли документы с момента предыдущего запуска.
4. Повторно открыть относящиеся к задаче исходники, schemas, handlers и tests.
5. Найти соответствующие открытые решения и проверить, не появились ли более поздние ответы пользователя.
6. Составить узкий implementation plan только для выбранного этапа.
7. Указать файлы, которые предполагается менять, и зависимости.
8. Не начинать соседние этапы автоматически.

## 9.2. Во время реализации

- Сначала изменять минимальный вертикальный срез.
- Переиспользовать существующие модули, если их назначение и границы совместимы с v4.
- Не создавать каталоги/классы только потому, что они нарисованы в схеме; создавать их при появлении реальной ответственности.
- Не выполнять массовый rename/restructure без необходимости этапа.
- Не удалять старый код до нахождения всех consumers и тестов миграции.
- Не создавать второй WS schema catalog или второй владелец game state.
- Не использовать `any`/untyped payload на межмодульных границах.
- Не вводить неоговорённые таймеры, числа, пороги, роли или игровые эффекты.
- Не менять package/dependency versions, если это не требуется для выбранного этапа.
- Не внедрять microservices, Unity, Three.js или иной неутверждённый стек.
- Не запускать миграции production DB без явного разрешения.
- Не менять секреты, tokens, provider credentials и production settings.

## 9.3. Если обнаружено противоречие или блокер

1. Прекратить только затронутую часть работы.
2. Продолжить независимые части выбранного этапа, если это безопасно.
3. Создать краткий блокер-отчёт с точными ссылками на документы/ID.
4. Указать, какая минимальная формулировка решения требуется от пользователя.
5. Не подменять вопрос «разумным default».
6. Временное решение допускается только как `PROTOTYPE-ONLY`, если оно не влияет на каноническое игровое правило и явно разрешено спецификацией.

## 9.4. После реализации этапа

Агент обязан выдать отчёт в структуре:

```text
Этап: Pxx — <name>
Статус: DONE / PARTIAL / BLOCKED

Что реализовано:
- ...

Файлы:
- created: ...
- modified: ...
- removed: ...

Проверки:
- command: <actual command>
  result: PASS / FAIL
- ...

Решения/допущения:
- AGREED: ...
- PROTOTYPE-ONLY: ...
- OPEN: ...

Остаточные риски:
- ...

Следующий безопасный этап:
- Pxx
```

Не писать `PASS`, если проверка не запускалась. Не заявлять, что код отправлен в GitHub или развернут, если это фактически не сделано.

---

# 10. Порядок передачи задач Qwen

Рекомендуется передавать агенту не все этапы сразу, а один этап за запуск.

### Шаблон запроса на этап

```text
Работай только над этапом Pxx из IMPLEMENTATION_ROADMAP.md.

Перед изменениями:
1. Прочитай SYSTEM_ARCHITECTURE.md и все спецификации, перечисленные в зависимостях этапа.
2. Проверь актуальный репозиторий, git status и текущие тесты.
3. Проверь открытые решения, относящиеся к этапу.
4. Покажи короткий implementation plan и список предполагаемых файлов.

Во время работы:
- не выходи за scope Pxx;
- не придумывай игровые правила;
- не меняй несвязанные модули;
- сохраняй существующие совместимые реализации;
- реализуй тесты вместе с функциональностью.

После работы:
- запусти фактические проверки;
- обнови документы, если контракты/решения изменились;
- выдай отчёт по шаблону раздела 9.4;
- не начинай следующий этап автоматически.
```

### Что передавать агенту в каждом запуске

Минимум:

- `IMPLEMENTATION_ROADMAP.md`;
- `SYSTEM_ARCHITECTURE.md`;
- спецификацию, непосредственно относящуюся к выбранному этапу;
- «Цикл 48» для игровых правил, если этап их затрагивает;
- актуальный репозиторий/ветку.

Не обязательно передавать каждый специализированный документ для каждой задачи, если он не влияет на её границы. Однако agent обязан проверить связанные документы, если обнаруживает cross-module dependency.

---

# 11. Рекомендуемые первые задачи

После добавления roadmap в репозиторий не следует сразу просить Qwen «реализовать v4 целиком».

Рекомендуемая последовательность первых запусков:

1. **P00 — Repository Audit**. Без изменений кода.
2. **P01 — Decision Register**. Без закрытия игровых вопросов агентом.
3. **P02 — Contracts/Architecture Baseline**. Только после проверки P00 и согласования P01.
4. **P03 — World Pack/Coordinates prototype**. Изолированная тестовая карта.
5. **P04 — HOT Movement prototype**. Два test players.
6. **P05 — Network + Pixi realtime vertical slice**. Проверить реальную плавность 20 Hz.
7. **P06 — HOT/COLD bridge/recovery**. Закрыть durability design до production gameplay.

Далее продолжать по таблице P07–P15. Этапы можно частично переставлять только после явной проверки зависимостей и без обхода блокирующих решений.

---

# 12. Риски проекта и способы их контролировать

| Риск                                                     | Возможное последствие                                 | Контроль                                                                                                      |
| -------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Одновременная массовая миграция старой архитектуры       | Большой объём регрессий, трудно найти источник ошибки | P00 baseline, небольшие migration slices, старые модули удалять только после mapping/tests                    |
| Агент принимает открытые игровые решения                 | Несогласованный канон и дорогие переделки             | Status tags, Decision Register, blocking IDs                                                                  |
| HOT event теряется между RAM и COLD commit               | Расхождение мира и истории партии                     | Durable event semantics, fault injection, recovery tests                                                      |
| 20 Hz субъективно кажется дёрганым                       | Плохой realtime UX                                    | Prediction/interpolation prototype с RTT/jitter, frame-time metrics, 20/30 Hz experiment только по измерениям |
| Слишком сложный Doll AI слишком рано                     | Большая стоимость реализации и сложная отладка        | Один патрульный агент, затем perception, memory, pursuit, capture, profiles                                   |
| Куклы получают всеведущую информацию                     | Социальная дедукция теряет смысл                      | Observation provenance, TTL, knowledge boundary tests                                                         |
| LLM становится обязательной для прохождения              | Партия ломается при rate limit/timeout                | Андрей scripted core, fallback, отсутствие LLM на HOT path                                                    |
| Контекст Андрея раскрывает скрытые факты                 | Нарушение роли и канона                               | Minimal context, projection tests, response validator                                                         |
| Observer accidentally exposes Developer secrets          | Утечка credentials/diagnostics                        | Раздельные permissions/projections, security tests                                                            |
| Неопределённые 7–10 player rules                         | Некорректные партии на отдельных размерах             | Не включать непроверенные composition profiles                                                                |
| Художественная сцена не совпадает с серверной геометрией | Игроки кликают/двигаются по неверным областям         | World Pack geometry as authority, projection calibration, visual acceptance tests                             |
| Перегрузка scope coding agent                            | Частично реализованные модули и отсутствие интеграции | Один этап за запуск, Definition of Done, отчёт                                                                |

---

# 13. Вне ближайшего объёма

Следующие задачи не должны незаметно попадать в первые этапы:

- полная реализация всех семи этажей и всех комнат;
- production art для всего комплекса;
- баланс всех сценарных вариантов;
- окончательные профили кукол для Э1–Э6 до закрытия соответствующих решений;
- полная LLM-генерация всего текста или нарратива;
- обязательный human GM/review flow в production;
- Unity/настоящий 3D;
- разрушаемая физика/falling-sand;
- микросервисное разделение backend;
- голосовой чат/WebRTC;
- горизонтальное масштабирование на несколько серверов, пока не определён требуемый concurrency target.

---

# 14. Итоговый критерий готовности архитектуры к полноценной реализации

Архитектура считается готовой к масштабной реализации, когда:

1. P00 подтвердил реальную структуру и baseline репозитория.
2. P01 отделил блокирующие решения от вопросов, которые допускают prototype.
3. Единый contract source и dependency boundaries определены.
4. World Pack может быть загружен/проверен сервером.
5. HOT movement и браузерный realtime vertical slice доказали авторитетное движение и визуальную плавность на тестовой карте.
6. HOT/COLD delivery and recovery semantics подтверждены тестами.
7. Основные правила среды и Doll Perception не противоречат канону.
8. Match lifecycle не опирается на обязательного GM и не возвращает turn-based serialization.
9. Observer, Player и Developer projections изолированы.
10. Андрей работает scripted fallback без LLM.
11. Все блокирующие для первого playable alpha решения либо утверждены, либо соответствующие функции явно исключены из alpha scope.

**Конечная цель roadmap — не максимальное количество написанного кода, а последовательное получение проверяемой игры, в которой сервер управляет миром, клиент плавно его отображает, социальная дедукция сохраняет приватность и достоверность улик, а LLM остаётся необязательным компонентом.**
