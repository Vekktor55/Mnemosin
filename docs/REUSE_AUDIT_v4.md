# МНЕМОСИН — аудит существующего репозитория перед переходом на Architecture v4

**Дата аудита:** 2026-11-09  
**Объект:** `https://github.com/Vekktor55/Mnemosin`, ветка `main`  
**Цель:** определить, какие компоненты старого Table MVP больше не нужны, что можно удалить в новой линии разработки, а что следует сохранить или адаптировать.

> **Границы аудита.** Это source-level аудит публично доступных README, архитектурных документов, package manifests, entrypoints и ряда ключевых файлов. Полный `git clone` и запуск тестов в этой среде не удались из-за недоступности DNS GitHub; вложенные directory listings также не все открылись. Поэтому рекомендации даны на уровне пакетов, подсистем и подтверждённых точек связности, но не являются разрешением удалять файлы вслепую. Код и GitHub не изменялись.

---

## 1. Краткий вердикт

**Для Architecture v4 следует отказаться от старого игрового приложения Table MVP и реализовать новый realtime-клиент и новый игровой runtime. При этом не следует выбрасывать всю серверную основу.**

Текущий `main` всё ещё описывает Table MVP: текстовые действия, Turn Engine, черновик AI Director и обязательное GM Review. В v4 игровая сцена и непрерывная авторитетная симуляция становятся основой игры; старые turn/GM-подсистемы больше не являются правильной моделью исполнения.

Рекомендуемая стратегия: **controlled rewrite в той же Git-истории**.

- Сохранить текущую версию отдельным tag/архивной веткой.
- Работать над v4 в отдельной ветке.
- Удалить старые игровые подсистемы из runtime v4 после отключения их зависимостей.
- Сохранить и адаптировать общую инфраструктуру, где она соответствует новым требованиям.
- Не переносить старые контракты и state model автоматически: они во многих местах моделируют ход, GM и граф локаций, которых в v4 больше нет.

---

## 2. Что подтверждено в текущем репозитории

На главной странице GitHub видны пакеты `apps/server`, `client`, `core`, `modules`, `gateways`, `infrastructure`, `shared/contracts`, `tests`, `e2e`, `tools`, `content/source-v1` и `docs`. README описывает текущий продукт как GM-in-the-loop Table MVP; в нём указаны Svelte 5 + Vite с отдельными `/player/` и `/gm/` входами, Turn Engine, AI Director и GM Review. README заявляет приёмку Stage 1 16/16 PASS, но это заявление не было независимо проверено запуском тестов в рамках данного аудита.

**Есть несогласованность документации:** README говорит, что Stage 1 завершён, тогда как заголовок `docs/ARCHITECTURE.md` по-прежнему помечает Stage 1 как «в разработке». Перед миграцией следует сверить фактическое состояние CI и обновить статус документации.

---

## 3. Матрица компонентов

Обозначения:

- **REMOVE** — старая функциональность не нужна в v4; после отключения ссылок её можно удалить из новой ветки.
- **REPLACE** — старый компонент не соответствует новой модели, но его ответственность должна быть реализована заново.
- **ADAPT** — полезен как основа, но требует изменения интерфейсов/поведения.
- **KEEP** — сохранить без концептуальной замены, возможны обычные исправления.
- **ARCHIVE** — сохранить для истории/миграции, не загружать в контекст coding agent как активную спецификацию.
- **INVESTIGATE** — недостаточно подтверждений для безопасного решения.

| Компонент                                                                                   | Решение для v4                               | Почему                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `modules/turn`                                                                              | **REMOVE**                                   | Реализует `resolveTurn/commitTurn/rejectTurn/retryTurn`, статусы хода и turn-scoped orchestration. В v4 нет Turn Engine и границы хода.                                                                                                                                                        |
| `modules/gm-review`                                                                         | **REMOVE**                                   | Единственная задача — approve/reject/edit/retry черновика и переход REVIEW → COMMITTED. В обычной партии нет human review.                                                                                                                                                                     |
| `modules/gm`                                                                                | **REMOVE / REPLACE**                         | Текущий GM-модуль управляет ходами, перемещением группы, GM-командами и GM-инспекцией. Часть административных действий появится в Observer/God Actions, но это другой набор прав и контрактов.                                                                                                 |
| `modules/ai-director`                                                                       | **REMOVE / REPLACE**                         | `generateDraft` для Turn Engine больше не нужен. Интерактив Андрея должен стать отдельным Andrew Service, а не универсальным режиссёром партии.                                                                                                                                                |
| `modules/gm-audit`                                                                          | **REPLACE, не терять идею**                  | Пакет пишет append-only аудит GM-действий. Сам GM workflow исчезает, но аудит вмешательств Observer/God Actions и developer actions полезен. Переименовать/переработать в общий `observer-audit` или `administration-audit`.                                                                   |
| `modules/chat`                                                                              | **ADAPT**                                    | Публичный и приватный чат полезны. Удалить GM-only сообщение как пользовательский игровой канал; приватность/шёпот должны дополнительно проверяться сервером по позиции и правилам близости.                                                                                                   |
| `modules/story`                                                                             | **ADAPT**                                    | Флаги сюжета и знания игроков потенциально полезны для COLD/evidence/knowledge. Текущая запись через turn-scoped `StateService` не переносится без изменений.                                                                                                                                  |
| `modules/session`                                                                           | **ADAPT**                                    | Лобби, создание комнаты, join/leave и участники нужны. Текущий SessionService создаёт GM-персонажа и зависит от TurnService и LocationService — эти зависимости надо убрать.                                                                                                                   |
| `client/src/gm/**`                                                                          | **REMOVE**                                   | Старая GM SPA (GmLogin, GMPanel и Review/Turn/State/Inspect/Notes/Audit tabs) не соответствует необязательному Observer Mode. Observer строить отдельно.                                                                                                                                       |
| `client/src/player/TurnPanel*` и turn UI                                                    | **REMOVE**                                   | Игровой экран, основанный на отправке действий и статусе хода, заменяется постоянной PixiJS-сценой и DOM overlay.                                                                                                                                                                              |
| `client/src/player` целиком                                                                 | **INVESTIGATE / REBUILD**                    | Логика TurnPanel устаревает, но вход, восстановление identity и login UI могут быть полезны как материал для новой SPA.                                                                                                                                                                        |
| `client/src/stores`                                                                         | **ADAPT**                                    | Удалить turn/resolution/GM-specific stores. Состояния соединения, лобби, чата и UI можно использовать как образец, но новая scene state model другая.                                                                                                                                          |
| `client/src/net/WSClient`                                                                   | **ADAPT**                                    | Полезны reconnect/backoff, heartbeat, типизированная маршрутизация и offline handling. Но текущий клиент связан со старым WS schema и `isGM`. **Движение нельзя помещать в offline queue и переотправлять после reconnect**; очередь оставить только для подходящих durable/idempotent команд. |
| `shared/contracts` package                                                                  | **KEEP**                                     | Единый источник истины для Zod-схем — правильный архитектурный принцип. Сам пакет остаётся, содержимое контрактов мигрирует.                                                                                                                                                                   |
| Старые turn/GM contract schemas                                                             | **REMOVE**                                   | Удалить после перевода всех потребителей: Turn, PlayerAction-as-turn, Resolution, GM review, TURN_* events/messages/routes и GM-only DTO. Не удалять базовые ids/errors/time/session/player схемы без проверки переиспользования.                                                              |
| `core/src/turns/turn-service.ts`                                                            | **REMOVE**                                   | Доменная машина Turn и команды открытия/блокировки/коммита хода не нужны.                                                                                                                                                                                                                      |
| `core/src/turns/journal.ts`                                                                 | **ADAPT / MOVE**                             | Это не только «журнал ходов»: append-only журнал полезен для аудита, восстановления и расследования. Сейчас он требует `turnId` и `JournalKind`, поэтому его следует обобщить на match/session event journal, а не удалить.                                                                    |
| `core/src/state/StateService`                                                               | **ADAPT / REPLACE CONTRACT**                 | Текущая реализация завязана на `GameStateSchema`, `StateMutation`, StoryFlag, ObjectState, PlayerKnowledge и TurnId. Полезны optimistic locking, атомарность, транзакционные границы и append history; саму старую GameState-модель нельзя использовать как есть для COLD.                     |
| `core/src/locations/LocationService`                                                        | **REPLACE**                                  | Моделирует граф комнат и `currentLocationId`/`moveGroup`. Новая сцена требует spatial grid, клеточную/непрерывную координату, collision, doors, navigation и World Pack. Исторические данные можно конвертировать, но LocationService не является основой симуляции.                           |
| `core/src/domain/transition.ts`                                                             | **ADAPT**                                    | Turn и Session transitions, вероятно, смешаны. Удалить turn transitions, сохранить/перепроектировать lifecycle transitions матча и сессии.                                                                                                                                                     |
| `core/src/domain/command.ts`                                                                | **KEEP / ADAPT**                             | Общая идемпотентная оболочка команд пригодится для durable COLD commands. Она не должна оборачивать каждый HOT movement tick.                                                                                                                                                                  |
| `core/src/domain/ports` / UnitOfWork                                                        | **KEEP / ADAPT**                             | Границы persistence и DI полезны. Пересмотреть интерфейсы под match, player, world pack, event log и snapshots.                                                                                                                                                                                |
| `core/src/events` / outbox / EventBus                                                       | **KEEP / ADAPT**                             | Полезная инфраструктура дискретных COLD-событий. Не пропускать через неё каждый 20 Hz tick или каждую координату. Проверить transaction/outbox guarantees.                                                                                                                                     |
| `infrastructure/database`                                                                   | **KEEP / ADAPT**                             | SQLite + Drizzle могут оставаться. Нужны новая схема и миграции для матчей, world packs, snapshots и истории. Не удалять применённые migration files.                                                                                                                                          |
| `infrastructure/config`                                                                     | **KEEP**                                     | Env/YAML validation, fail-fast и redaction нужны. Пересмотреть устаревшие настройки turn/GM/AI Director.                                                                                                                                                                                       |
| `infrastructure/logging`                                                                    | **KEEP**                                     | Pino, traceId и redaction полезны и не зависят от turn-модели.                                                                                                                                                                                                                                 |
| `infrastructure/jobs`                                                                       | **KEEP / ADAPT**                             | Scheduler полезен для outbox, cleanup, presence и периодических задач. Удалить turn-reconcile и старый capability probe, если он относится к AI Director; добавить новые jobs только по необходимости.                                                                                         |
| `infrastructure/ai`                                                                         | **ADAPT**                                    | Провайдерные адаптеры, scripted/failing test doubles, retry/timeout/circuit breaker можно использовать для Андрея. Capability `TEXT_AI` и старый Director wiring нужно заменить на Andrew-specific capability.                                                                                 |
| `gateways/http`                                                                             | **KEEP / ADAPT**                             | Fastify routes, auth, validation, error handler, rate-limit и health/version полезны. Удалить GM/turn routes, добавить lobby/session/observer routes.                                                                                                                                          |
| `gateways/ws`                                                                               | **KEEP / REPLACE ROUTING**                   | Handshake, heartbeat, connection registry, dedupe, broadcast/projection и rate-limit полезны. Старые TURN/GM routers, DTO и deps заменить на scene input/snapshot/delta, chat, interaction, session и observer operations.                                                                     |
| `apps/server`                                                                               | **KEEP AS COMPOSITION ROOT, REWRITE WIRING** | Bootstrap, config, logger, DB, HTTP/WS server, health, graceful shutdown остаются. Старые `reconcileOnBoot`, `buildModules`, `buildAIStack` и wiring GM/Turn заменить новыми сервисами.                                                                                                        |
| `.dependency-cruiser.cjs`, ESLint architecture rules                                        | **ADAPT**                                    | Автоматическая проверка границ — ценная часть проекта. Переписать правила под новые слои и PixiJS client; не отключать архитектурный контроль.                                                                                                                                                 |
| `tests/` toolchain (Vitest)                                                                 | **KEEP**                                     | Unit/integration/arch/contract тестовая инфраструктура нужна. Удалять только устаревшие assertions/fixtures, относящиеся к Turn/GM semantics.                                                                                                                                                  |
| `e2e/` Playwright                                                                           | **KEEP / ADAPT**                             | Сохранить общую механику запуска браузерных тестов и подход к reconnect/privacy. `gm-review` и `stage1-table` сценарии заменить новыми realtime/Observer tests.                                                                                                                                |
| `tools/verify/stage1.mjs`                                                                   | **ARCHIVE, затем REMOVE FROM ACTIVE CI**     | Это приёмка старого Table MVP (A1.1–A1.16), а не v4. Сохранить в legacy для истории, но заменить командой v4 acceptance до отключения.                                                                                                                                                         |
| `tools/fixtures/locations.stage1.json`, remap и location fixture generator                  | **ARCHIVE / REPLACE**                        | Старый location graph fixture не является spatial World Pack. Сохранить исходные content data, затем создать/валидировать новый world pack.                                                                                                                                                    |
| `content/source-v1/**`                                                                      | **KEEP / ARCHIVE AS SOURCE CONTENT**         | Не удалять: это потенциальный источник лора и контента. Конвертировать нужные сведения в авторскую статику v4 после проверки соответствия канону.                                                                                                                                              |
| Старые `docs/ROADMAP.md`, `SPEC_STAGE1.md`, `DEV_PLAN_STAGE1..3.md`, `ARCHITECTURE.md` (v3) | **ARCHIVE**                                  | Не удалять как историческое обоснование; перенести/пометить в `docs/legacy-v3/`, чтобы агент не воспринимал их как актуальный источник требований.                                                                                                                                             |

---

## 4. Что реально можно признать устаревшим уже сейчас

На уровне продуктовой архитектуры v4 можно прямо сейчас принять решения:

1. **Старый Turn Engine больше не является частью v4.** `modules/turn` и `core` TurnService должны уйти из новой реализации.
2. **Human GM Review не входит в игровую партию.** `modules/gm-review` и соответствующая Player/GM UI больше не являются production feature.
3. **Старая GM-панель не является Observer.** `client/src/gm/**` не следует развивать; Observer/God Mode проектируется отдельно с явным read-all projection и отдельными command permissions.
4. **AI Director, генерирующий resolution черновики ходов, удаляется.** Его нельзя просто переименовать в AndrewService.
5. **Старое перемещение группы между локациями не является пространственной симуляцией.** `LocationService.moveGroup/currentLocationId` заменяется World Simulation.
6. _\*Старые TURN_* и GM__ контракты не должны попадать в новый WS/HTTP протокол.** Новый контрактный пакет остаётся, но каталог схем создаётся заново с согласованным источником истины.

Это решения об архитектуре v4. Они не означают, что директории можно удалить до устранения импортов и тестов.

---

## 5. Что нельзя удалять «заодно»

### 5.1 `core/src/turns` нельзя удалять целиком

`core/src/turns/index.ts` экспортирует одновременно `JournalService` и `TurnService`. Удаление всей папки потеряет журнал. Переместить/переименовать JournalService в общий `core/events` или `core/journal`, а turn-service удалить отдельно.

### 5.2 `StateService` нельзя просто оставить как есть

Нынешний `StateService` работает со старым GameState и мутирует его через turn-scoped `StateMutation`; журнал принимает `turnId`. Для v4 нужна другая модель: HOT state в памяти; COLD aggregate mutations для ролей, inventory, evidence, crafting, match phase и т.п. Сохранить можно принципы атомарности, optimistic concurrency, outbox и history, не обязательно сам класс и его API.

### 5.3 `session` не равен `GM`

Создание комнаты, lobby, joining/leaving игроков и аутентификация нужны. Но текущий SessionService создаёт GM как участника и зависит от TurnService/LocationService. Сохранить session lifecycle как концепцию, отделив host/creator, игрока и необязательного Observer.

### 5.4 `chat` полезен, но старой модели приватности недостаточно

Текущий ChatService различает PUBLIC/PRIVATE/SYSTEM/GM. В v4 нужны публичный чат, близкий шёпот и адресное приватное взаимодействие при соблюдении spatial rules. Сервер должен проверять дистанцию, этаж/локацию и момент наличия канала. GM-only канал можно исключить.

### 5.5 Транспорт и база — не старый игровой цикл

Fastify, WebSocket, JWT, rate limits, error serialization, outbox, reconnect и DB transaction patterns не становятся ненужными только потому, что меняется интерфейс. Их надо адаптировать и перепроверить, а не удалять по принципу «всё старое — плохо».

---

## 6. Точки связности, которые блокируют простое удаление

Удаление legacy modules требует согласованного изменения как минимум следующих мест:

1. `apps/server/package.json` — сейчас перечисляет зависимости `module-turn`, `module-gm-review`, `module-chat`, `module-story`, `module-gm`, `module-gm-audit`, `module-session`, `module-ai-director`.
2. `apps/server/src/main.ts` — импортирует `reconcileOnBoot` из `module-turn`, строит AI Stack, CoreServices и старый ModuleStack, валидирует/подписывает registry.
3. `apps/server/src/modules.ts` — напрямую создаёт ChatService, StoryService, TurnEngine, GmService, GmAuditService и GmReviewService; `gm` вызывает `turn.resolveTurn` после lock.
4. `apps/server/src/modules-registry.ts` — импортирует старые contracts и регистрирует session/turn/chat/story/gm/gm-review/gm-audit/ai-director (и объявленный media-director).
5. `apps/server/src/ai.ts` — создаёт `AiDirectorService` и `TEXT_AI` provider registry.
6. `core/src/services.ts` — создаёт TurnService, LocationService, SessionService с зависимостями друг от друга.
7. HTTP/WS gateway dependencies, router и contracts — содержат Turn/Gm/GmReview operations.
8. root `package.json` workspaces и `tsconfig` project references — нужно обновить после удаления workspace package.
9. contract/arch/unit/integration/e2e tests, fixtures и `tools/verify/stage1.mjs` — часть ожидает старый Stage 1.
10. UI entrypoints и stores — `PlayerApp` подключает `TurnPanel`, а `GmApp` запускает отдельный GM интерфейс.

Следовательно, безопасная единица изменения — **одна согласованная migration PR**, удаляющая imports + wiring + routes/contracts/tests вместе с legacy modules; не по одной папке в произвольном порядке.

---

## 7. Рекомендуемый список фактического удаления на ветке v4

### Группа A — убрать из composition root в первом migration slice

- Вызов `reconcileOnBoot` и импорт из `@mnemosin/module-turn`.
- `buildModules()` старого Table MVP и его `ModuleStack`.
- `buildAIStack()` в текущем виде, если он создаёт `AiDirectorService`; заменить его позже на Andrew AI wiring.
- `modules-registry` с декларациями старых turn/gm modules.
- Старые `TurnOps`, `GmOps`, `GmReviewOps` в HTTP/WS dependency contracts.

**Не удалять при этом:** database bootstrap, health/version endpoints, logging/config, Fastify instance, base WS server/connection registry, outbox infrastructure и graceful shutdown.

### Группа B — удалить старые игровые пакеты после разрыва imports

- `modules/turn/`
- `modules/gm-review/`
- `modules/gm/`
- `modules/ai-director/`

### Группа C — удалить/заменить старые frontend части

- `client/src/gm/` — целиком как старый GM интерфейс.
- `client/src/player/TurnPanel*` и turn-specific subcomponents.
- turn/review/GM state из client stores и UI handlers.
- `/gm/` MPA entrypoint, routing и ссылки на него.

Оставить как материал для адаптации: login/join формы, identity/session restore, общие shell UI элементы, connection bar, error display, chat components, WS retry/backoff. Ничего из этого не переносить без проверки.

### Группа D — удалить turn-specific core/domain после перепроектирования COLD

- `core/src/turns/turn-service.ts` и его экспорты.
- Turn transition table/Turn FSM.
- `resolution-hash.ts` и turn-resolution application path, если нет другого потребителя.
- `TurnId`, `TurnStatus`, `PlayerAction` и прочие turn-only схемы после миграции всех references.

Оставить/перенести: JournalService, общие command/idempotency primitives, ports/UnitOfWork, event bus/outbox. StateService и LocationService — не сохранять как есть; спроектировать замену.

### Группа E — чистка старого acceptance/content tooling после появления v4 gates

- `tools/verify/stage1.mjs` вывести из активного CI и сохранить под legacy.
- `e2e/gm-review` и `e2e/stage1-table` вывести из активной приёмки, заменить realtime/observer tests.
- Старые location fixtures/remap/generator архивировать после миграции нужного контента в World Pack.
- Вынести v3 docs в `docs/legacy-v3/` и обновить корневой индекс документации.

---

## 8. Что сохранить и использовать в v4

1. Node.js + TypeScript strict + ESM + npm workspaces.
2. Fastify server bootstrap и health/version, rate limit, error handler.
3. JWT/auth implementation как основу, но заменить GM role/claims на актуальные player/observer privileges.
4. WebSocket server transport: handshake, heartbeat, presence, reconnect handling, connection registry, rate limit, dedupe — с новым router/protocol.
5. SQLite + Drizzle persistence, migrations, UnitOfWork, transaction handling — после проверки драйвера и новой схемы.
6. Pino logging, traceId, redaction.
7. Config loading/validation and secrets handling.
8. Generic EventBus/outbox/idempotency building blocks для COLD events and durable commands.
9. Vitest, Playwright, ESLint, Prettier, dependency-cruiser, CI/gitleaks.
10. Svelte 5 + Vite as app shell; add PixiJS as scene renderer. Старые turn screens не сохранять.
11. Content source files as canonical/archive source; migrate needed story content deliberately.

---

## 9. Дополнительные риски и несогласованности

### 9.1 README и Architecture document расходятся в статусе Stage 1

README говорит «этап 1 завершён» и 16/16 PASS; заголовок `docs/ARCHITECTURE.md` говорит «этап 1 в разработке». Уточнить по CI run и локальному `npm run verify:stage1`, затем привести документы к одному статусу.

### 9.2 `worldpack:validate` пока не выполняет проверку

В root `package.json` команда `worldpack:validate` сейчас выводит текст, что она реализуется в промпте 2.3, а затем завершается с кодом 0. Её нельзя считать существующим валидатором. В v4 нужен отдельный реальный validator для World Pack schema, topology, collision, spawn points, object IDs и asset references.

### 9.3 DB driver надо перепроверить, но БД не надо выбрасывать

README и `drizzle.config.ts` описывают SQLite/Drizzle; `infrastructure/database/package.json` использует `@libsql/client` и `libsql`, тогда как в root devDependencies присутствуют `@types/better-sqlite3`. Сам `drizzle.config.ts` комментирует libsql как SQLite-compatible driver. Это не доказывает ошибку, но coding agent должен определить фактический runtime driver по `database/src/client.ts` и проверить, нет ли устаревших зависимостей. Не менять драйвер только ради очистки.

### 9.4 Предположение «одна активная сессия на сервер»

Старое решение D108 ограничивает сервер одной активной сессией. Это не следует автоматически переносить в v4. Нужно явно решить, поддерживает ли первая версия несколько параллельных матчей на одном server process. До решения не удалять ограничение и не закреплять его как вечное.

### 9.5 Нельзя безоговорочно использовать offline queue для real-time input

Текущий WSClient переотправляет idempotent offline-queued messages. Для v4 это допустимо только для подходящих durable commands; movement/input frames должны отбрасываться при disconnect и после reconnect отправляется новый input state/snapshot request. Иначе персонаж может «доиграть» старые нажатия после восстановления связи.

---

## 10. Безопасный порядок миграции

1. Создать tag текущей Table MVP версии, проверить clean Git working tree и сохранить CI status.
2. Создать ветку `architecture-v4`.
3. Архивировать актуальные v3 docs и исходные content/fixtures без физического удаления.
4. Добавить краткий `AGENTS.md`, `CODEBASE_MAP.md`, `REUSE_MATRIX.md`, `IMPLEMENTATION_STATUS.md`, `ARCHITECTURE_DECISIONS.md`.
5. Утвердить v4 package/layer map и новый контрактный каталог.
6. Переписать server composition root без Turn/GM/AI Director; оставить сервер живым с health, auth/lobby stub, DB и WS transport.
7. Одновременно вырезать old module registry, routes/dependencies and legacy runtime packages.
8. Заменить player MPA/TurnPanel на новую single SPA shell + PixiJS blank scene.
9. Добавить новые contracts и `scene` transport; не смешивать 20 Hz scene ticks с narrative/chat events.
10. Разработать World Pack loader/validator; только после этого мигрировать стартовый шлюз.
11. Перенести COLD domain concepts (match/player/role/inventory/evidence/phase) и journal; не использовать старый GameState без ревизии.
12. Добавлять Doll AI, Andrew, Observer и дополнительные игровые подсистемы отдельными вертикальными slices.

После каждого шага должны проходить `typecheck`, `lint`, unit/contract/architecture tests, интеграционные тесты изменённого слоя и минимальный живой smoke test.

---

## 11. Итоговая рекомендация

**Не удалять весь репозиторий и не начинать с чистого пустого репозитория. Начать новую линию реализации v4 в отдельной ветке и удалить старую игровую модель согласованным срезом.**

### Можно принять как устаревшее уже сейчас

- `modules/turn`;
- `modules/gm-review`;
- `modules/gm` как игровой GM controller;
- `modules/ai-director` как генератор turn resolution;
- старый `client/src/gm/**`;
- turn-specific UI и protocol contracts;
- old graph-based group movement (`LocationService.moveGroup`) как основу сцены.

### Нельзя просто удалить

- `core`;
- `shared/contracts`;
- `apps/server`;
- `gateways/http`, `gateways/ws`;
- `infrastructure/database`, `config`, `logging`, `jobs`;
- EventBus/outbox/idempotency;
- JournalService;
- общий WSClient connection logic;
- тестовую инфраструктуру;
- source-v1 content.

### Главная оговорка

Эти выводы позволяют **сразу пометить legacy-компоненты как не входящие в v4 и планировать их удаление**, но не следует выполнять физическое удаление отдельных директорий без одновременного обновления server wiring, package manifests, workspace references, contracts, routes и tests. Самый безопасный вариант — один контролируемый migration slice после фиксации legacy tag.

---

## 12. Источники, проверенные при аудите

- Repository README: `https://github.com/Vekktor55/Mnemosin`
- Root manifest: `https://raw.githubusercontent.com/Vekktor55/Mnemosin/main/package.json`
- `docs/ARCHITECTURE.md`
- `docs/ROADMAP.md`
- `docs/SPEC_STAGE1.md`
- `.dependency-cruiser.cjs`
- `apps/server/src/main.ts`, `app.ts`, `modules.ts`, `modules-registry.ts`, `core-services.ts`, `ai.ts`, `projections.ts`
- `modules/{turn,gm,gm-review,gm-audit,ai-director,chat,story,session}/package.json` and relevant `src/index.ts` / service files
- `core/src/{index.ts,services.ts,turns/*,session/*,state/*,locations/*}`
- `shared/contracts/src/index.ts`
- `client/package.json`, `client/src/{gm/GmApp.svelte,player/PlayerApp.svelte,net/ws-client.ts}`
- `gateways/{http,ws}/src/index.ts`
- `infrastructure/{database,config,logging,jobs,ai}/package.json`
- `drizzle.config.ts`

**Проверки, не выполненные в этой среде:** `git clone`, `npm install`, `npm test`, `npm run verify:stage1`, CI history. Эти пункты остаются для локальной верификации владельцем репозитория/coding agent.
