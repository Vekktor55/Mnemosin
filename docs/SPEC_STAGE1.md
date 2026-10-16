# SPEC_STAGE1 — «МНЕМОСИН», этап 1 «Стол» (Table MVP)

> Собрано по факту реализации (промпты 1.1–1.13). Источник истины протоколов —
> код `@mnemosin/contracts`; приёмка — `node tools/verify/stage1.mjs` (16/16 A1,
> агрегированная таблица, D288) и `npm run test:e2e` (9 сценариев Playwright).

Версия **1.0** · 2026-10-09
Статус: **готов к разработке** по `DEV_PLAN_STAGE1.md` (13 промптов).
Основание: `МНЕМОСИН Pipeline v3` (Части I–IX), `MNEMOSIN_v3_AUDIT.md` (патчи §8.1–§8.10), `ROADMAP.md` (D101–D112, критерии A1.1–A1.16).
Первоисточник истины после старта работ — **код пакета `@mnemosin/contracts`**; этот документ является его спецификацией и сверяется с ним в CI (`docs:check`, промпт 3.9; до этапа 3 — вручную при каждом изменении контрактов).

**Правило чтения (как в v3 §0.4):** product-team читает §1–§3, §12–§13; LLM-implementer читает всё последовательно, таблицы §6–§9 являются контрактами.

---

## 1. Назначение и границы этапа

Этап 1 даёт **играбельную партию без единого внешнего сервиса**: 6 игроков + GM, чат, действия, ход, черновик, ревью GM, коммит, перемещение по локациям, полная персистентность и защита приватных данных. AI-генерация работает через офлайн-стенды, реализующие тот же порт `AIPort`, что и боевые провайдеры этапа 2.

**Входит в этап 1:**

- монорепо (ESM, TypeScript strict), каркас пакетов и правила зависимостей с автоматическим контролем;
- пакет контрактов `@mnemosin/contracts`: доменные схемы, DSL-схемы (объявлены, но не исполняются), каталог событий, WS/HTTP-контракты, Error Taxonomy, view-проекции;
- SQLite (WAL) + Drizzle: полная схема, миграции, репозитории, `UnitOfWork`, атомарная идемпотентность, optimistic lock, `event_outbox`, `turn_journal`;
- домен: Session, Player, Character, Turn, PlayerAction, GameState, LocationDefinition, StoryFlag, ObjectState, PlayerKnowledge;
- машины состояний Turn и Session; Turn Engine (`resolveTurn`, `commitTurn`);
- модули: `session`, `turn`, `chat`, `story`, `gm`, `gm-review`, `gm-audit`, `ai-director`;
- порт `AIPort` + три стенда (`ScriptedAI`, `EchoAI`, `FailingAI`) + Capability Registry с retry/backoff/circuit breaker;
- транспорт: Fastify HTTP + нативный WebSocket (`@fastify/websocket`), JWT-auth, rate-limit (token + IP), CORS, единый формат ошибки;
- проекции и матрица приватности (единственное место, где домен превращается в клиентские данные);
- клиент Svelte 5 + Vite: WS-клиент с reconnect/offline-queue, stores, UI игрока и GM (Review / Turn / State / Inspect / Notes / Audit);
- e2e (Playwright), property-based тест приватности, `tools/verify/stage1.mjs` на 16 критериев.

**Не входит в этап 1 (осознанно) — и почему это безопасно:**

| Не входит                                                | Появится       | Почему отложение безопасно                                                                                                                                            |
| -------------------------------------------------------- | -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event Engine DSL (исполнение триггеров/условий/эффектов) | 2.1            | Схемы DSL объявлены в контрактах с первого дня; в Turn Engine — hook `applyEffects`, в этапе 1 пропускающий эффекты черновика напрямую. Замена hook'а не трогает ядро |
| Rules Engine                                             | 2.2            | `RulesPort` объявлен, `rulesStub` возвращает `PASS`; интерфейс идентичен боевому                                                                                      |
| World-pack, slug→UUID инстанцирование                    | 2.3            | В этапе 1 локации грузятся из fixtures **уже с валидными UUID** (`tools/gen-location-fixtures.mjs` + `remap.stage1.json`)                                             |
| Контент Doll Room и события                              | 2.4            | В этапе 1 — две локации (Reception, Corridor), D110                                                                                                                   |
| Реальные AI-провайдеры (OpenRouter, LMStudio)            | 2.6, 2.7       | `AIPort` реализован стендами; добавление провайдера = 1 файл + 1 строка конфига (критерий A1.14)                                                                      |
| Media/ComfyUI/HostBridge                                 | 2.10–2.13      | Модуль `media-director` не зарегистрирован; таблицы `media_jobs`/`media_cache` созданы заранее; `CAPABILITY_CHANGED` уже умеет сообщать об отсутствии провайдера      |
| Cost model, бюджет                                       | 2.8            | `diagnostics.usage` пишется с этапа 1 (стенды отдают псевдо-usage), `costUsd = null`                                                                                  |
| Snapshot-восстановление                                  | 3.1            | Этап 1 восстанавливается из SQLite + `reconcileOnBoot`; таблица `snapshots` создана, но не пишется                                                                    |
| Метрики Prometheus, алерты                               | 3.2            | Есть `MetricsSink`-интерфейс и структурированные логи с `traceId`                                                                                                     |
| Multi-tab presence, perf-тесты, аудио-плагин             | 3.6, 3.8, 3.7  | Multi-tab технически возможен (registry хранит `playerId → Set<connectionId>`), но не является критерием этапа                                                        |
| Аутентификация игроков через OAuth, экспорт партии       | backlog (3.13) | Токен-сессия закрывает задачу этапа                                                                                                                                   |

---

## 2. Роли, права, идентификация

### 2.1 Роли

| Роль            | Как получается                                                      | Что может                                                                                                                                                                                                                                                                         | Чего не может                                                                            |
| --------------- | ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| **Игрок**       | `POST /sessions/:id/join` (без токена) → JWT c `gm:false`           | занять место в партии, отправлять действия хода, писать в публичный и приватный чат, видеть публичную проекцию состояния, свою `playerKnowledge`, историю чата                                                                                                                    | видеть черновик хода, GM-заметки, чужой knowledge, полный GameState; вызывать GM-команды |
| **GM**          | `POST /auth/session` (создаёт сессию и GM-игрока) → JWT c `gm:true` | всё, что игрок, плюс: старт/пауза/завершение сессии, открытие/блокировка/разблокировка/отмена хода, ревью черновика (approve / edit&approve / reject / retry), перемещение группы, системные сообщения, заметки, inspect (state / AI context / journal), аудит, исключение игрока | менять GameState напрямую в обход команд (нет такого маршрута)                           |
| **Наблюдатель** | —                                                                   | в этапе 1 отсутствует (backlog)                                                                                                                                                                                                                                                   | —                                                                                        |

**Правило:** GM — это `Player` с `isGM=true` (v3 §II.2, заметка). Отдельной сущности «GM-аккаунт» нет.

### 2.2 Идентификаторы (v3 §VIII.1)

| ID               | Область                       | Жизненный цикл            | Где хранится                             |
| ---------------- | ----------------------------- | ------------------------- | ---------------------------------------- |
| `sessionId`      | партия                        | создание → `ENDED`        | БД                                       |
| `playerId`       | игрок в партии                | join → left/kicked        | БД                                       |
| `characterId`    | персонаж                      | создаётся при join        | БД                                       |
| `connectionId`   | один WS-сокет                 | open → close              | память сервера                           |
| `requestId`      | одна WS-команда               | отправка → ack            | клиент + LRU-кэш сервера (`dedupeTtlMs`) |
| `idempotencyKey` | мутирующая команда            | создание → TTL 24 ч       | БД (`idempotency_records`)               |
| `turnId`         | ход                           | OPEN → COMMITTED/FAILED   | БД                                       |
| `traceId`        | одна операция сквозь все слои | вход HTTP/WS → все записи | логи, journal, audit, cost               |

Правила: `sessionId ≠ playerId ≠ connectionId`; у одного игрока может быть несколько соединений (multi-tab), `connectionId` уникален всегда; `requestId` ≠ `idempotencyKey` (первый — для дедупликации доставки, второй — для идемпотентности эффекта).

### 2.3 Токены (закрывает блокер B-12)

- Формат: JWT HS256 (`jose`), `JWT_SECRET` ≥ 32 символов из env.
- Claims: `{ sub: playerId, sid: sessionId, gm: boolean, typ: 'access'|'refresh', iat, exp, jti }`.
- TTL: access — `JWT_TTL_SECONDS` (43200 = 12 ч), refresh — 30 дней.
- Refresh: `POST /auth/refresh`; rotation по `jti`, лимит `refreshMaxPerToken=5`.
- **Отзыв:** колонка `players.revoked_before`; токен недействителен, если `iat < revoked_before`. Выставляется при `kickPlayer` и `leaveSession` (исключённый игрок теряет доступ немедленно, а не по истечении TTL).
- Хранение на клиенте: память + `sessionStorage`; в `localStorage` — **запрещено** (D126).
- WS: токен передаётся в handshake — через subprotocol `mnemosin.v1.<jwt>` (основной способ) или `?token=` (совместимость); приоритет — D123. Окно неаутентифицированного соединения — `wsAuthTimeoutMs=5000`, затем close 4401/4408.

---

## 3. Игровой цикл

### 3.1 Поток хода

```text
GM: openTurn ─────────────▶ TURN OPEN (n)
                              │
игроки: submitAction ×N ──────┤ (sequenceId 1..N назначает сервер)
                              │
GM: lockTurn ───────────────▶ LOCKED ──▶ TURN_LOCKED
                              │
Turn Engine: resolveTurn ───▶ PROCESSING ──▶ TURN_PROCESSING_STARTED
                              │  ├─ build DirectorContext
                              │  ├─ AIPort.generate (ВНЕ транзакции)
                              │  ├─ RulesPort.evaluate (этап 1: stub → PASS)
                              │  └─ save TurnResolution (status всех item'ов PROPOSED)
                              ▼
                            REVIEW ──▶ TURN_DRAFT_READY (только GM)
                              │  ├─ approve ─────────▶ COMMITTED
                              │  ├─ editAndApprove ──▶ COMMITTED
                              │  ├─ reject ──────────▶ FAILED
                              │  └─ retry ───────────▶ OPEN (resolution очищен)
                              ▼
commitTurn (в транзакции):
   applyResolution → GameState.version+1 → turn=COMMITTED
   → turn_journal → outbox(TURN_COMMITTED, STATE_COMMITTED)
   → [после COMMIT] публикация событий → рассылки, чат, приватные сообщения
                              ▼
GM: openTurn ─────────────▶ TURN OPEN (n+1)   ← следующий ход открывает GM (D117)
```

`resolveTurn` **не применяет состояние** и не коммитит (v3 §III.1). Применение — только в `commitTurn`.

### 3.2 Машина состояний Turn

Разрешённые переходы (единственный источник — `TURN_TRANSITIONS` в контрактах):

| Из           | В            | Триггер (команда)                           | Кто                                         | Требует idempotencyKey                    |
| ------------ | ------------ | ------------------------------------------- | ------------------------------------------- | ----------------------------------------- |
| —            | `OPEN`       | `openTurn`                                  | GM                                          | да                                        |
| `OPEN`       | `LOCKED`     | `lockTurn`                                  | GM                                          | да                                        |
| `LOCKED`     | `OPEN`       | `unlockTurn`                                | GM                                          | да                                        |
| `LOCKED`     | `PROCESSING` | `resolveTurn` (внутреннее)                  | Turn Engine                                 | да (детерминированный `resolve:{turnId}`) |
| `PROCESSING` | `REVIEW`     | `draftReady` (внутреннее)                   | Turn Engine                                 | — (внутри той же команды)                 |
| `PROCESSING` | `FAILED`     | `processingFailed`                          | Turn Engine                                 | —                                         |
| `REVIEW`     | `COMMITTED`  | `approve` / `editAndApprove` → `commitTurn` | **gm-review** (единственный владелец, D119) | да                                        |
| `REVIEW`     | `FAILED`     | `reject` → `rejectTurn`                     | gm-review                                   | да                                        |
| `REVIEW`     | `OPEN`       | `retry`                                     | gm-review                                   | да                                        |
| `OPEN`       | `FAILED`     | `cancelTurn`                                | GM                                          | да                                        |

Терминальные: `COMMITTED`, `FAILED`. Недопустимый переход → `CORE_INVALID_STATE_TRANSITION` (409).

**Отклонения от v3 §II.5 (зафиксированы как решения):** добавлен переход `REVIEW → OPEN` для retry (в v3 retry возможен только «созданием нового Turn», что не выражалось в сигнатуре — дефект F-3.1); команда `gm.finishTurn` **удалена** как дубликат `gm-review.approve` (дефект B-09, решение D119).

### 3.3 Машина состояний Session

| Из                        | В        | Команда         | Условие                                                                                                    |
| ------------------------- | -------- | --------------- | ---------------------------------------------------------------------------------------------------------- |
| —                         | `LOBBY`  | `createSession` | задан `title` и GM                                                                                         |
| `LOBBY`                   | `ACTIVE` | `startSession`  | ≥ 1 игрок, GM присутствует, `TEXT_AI` доступна (иначе `CAPABILITY_UNAVAILABLE`, F-9.6), открывается ход №1 |
| `ACTIVE`                  | `PAUSED` | `pauseSession`  | —                                                                                                          |
| `PAUSED`                  | `ACTIVE` | `resumeSession` | —                                                                                                          |
| `LOBBY`/`ACTIVE`/`PAUSED` | `ENDED`  | `endSession`    | эмитится `SESSION_ENDED`                                                                                   |

`ENDED` терминален. Новая партия = новая сессия (при D108 прежняя архивируется: `sessions.archived_at`).

### 3.4 Действия игроков

- Отправка возможна только в статусе хода `OPEN`; иначе `TURN_NOT_OPEN` (маппится в `CONFLICT`).
- `sequenceId` назначается сервером внутри транзакции (`max+1`), гарантируется `UNIQUE(turn_id, sequence_id)`.
- Лимит: `limits.actionsPerPlayerPerTurn = 5` → превышение даёт `RATE_LIMIT`.
- `meta.intent` — из enum `ActionIntent`: `SPEAK | ACT | MOVE | USE | OBSERVE | WAIT | CUSTOM` (закрывает F-4.6: свободная строка не позволяла правилам опираться на intent).
- `meta.targetObjectId` / `meta.targetPlayerId` — только существующие сущности сессии.
- Повтор с тем же `idempotencyKey` → возвращается прежний `actionId` (не дубль).

### 3.5 Перемещение группы

`gm.moveGroup({sessionId, playerIds, toLocationId, idempotencyKey, turnId?})`:

1. проверка: все `playerIds` принадлежат сессии; `toLocationId` существует (`CORE_LOCATION_NOT_FOUND`); переход разрешён exit'ом и exit не `locked` (`RULE_REJECTED`);
2. обновление `worldState.currentLocationId` через `StateService.apply` (единственный источник истины; из `Session` поле `currentLocationId` **удалено** — F-1.16);
3. `LOCATION_CHANGED{sessionId, fromLocationId, toLocationId, playerIds}` → рассылка `STATE_PROJECTION`;
4. идемпотентность: детерминированный ключ `move:{sessionId}:{turnId|'naive'}:{sha1(sorted playerIds)}:{toLocationId}` (F-3.6);
5. в этапе 1 триггер `ENTER_ROOM` **не исполняется** (Event Engine появится в 2.1); точка расширения — `EventTriggerSource.enterRoom()`.

### 3.6 Черновик и ревью GM

`TurnResolution` (полная схема — патч аудита §8.1, в контрактах с промпта 1.2):

| Поле                      | Назначение                                                                                                                 |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `source`                  | `AI` \| `GM_MANUAL` \| `AI_THEN_GM_EDIT`                                                                                   |
| `aiResponseHash`          | sha256 от сырого `AIResponse` (связка с журналом и A2.8)                                                                   |
| `baseVersion`             | версия GameState на момент сборки черновика (для optimistic lock при commit)                                               |
| `segments[]`              | публичные и GM-сегменты нарратива, каждый с `audience` и `editedByGM`                                                      |
| `privateMessages[]`       | per-player сообщения со `status`                                                                                           |
| `proposedEvents[]`        | `eventId` (только из `allowedEventIds`), `effects[]`, `status`, `ruleResults[]`, `gmComment`                               |
| `proposedObjectChanges[]` | `objectId`, `patch`, `status`, `ruleResults[]`                                                                             |
| `proposedWorldStatePatch` | `timeOfDay` / `weather` / `ambientFlags`                                                                                   |
| `visualScene`             | описание сцены (в этапе 1 только сохраняется, media-модуля нет)                                                            |
| `diagnostics`             | `providerId`, `model`, `attempts`, `schemaRepairAttempts`, `usage`, `costUsd`, `durationMs`, `softRejects[]`, `warnings[]` |

Статусы item'ов: `PROPOSED → APPROVED | REJECTED | EDITED → APPLIED | SKIPPED`. При commit применяются **только** `APPROVED` и `EDITED`.

Решения GM:

| Решение                    | Команда                                                                                    | Эффект                                                                                                                 |
| -------------------------- | ------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Одобрить                   | `gm-review.approve({turnId, idempotencyKey})`                                              | `commitTurn`                                                                                                           |
| Отредактировать и одобрить | `gm-review.editAndApprove({turnId, editedResolution, baseResolutionHash, idempotencyKey})` | проверка hash (расхождение → 409 `VERSION_CONFLICT` + актуальный resolution в `meta`), сохранение правки, `commitTurn` |
| Отклонить                  | `gm-review.reject({turnId, reason, idempotencyKey})`                                       | `FAILED`, `TURN_FAILED`                                                                                                |
| Перегенерировать           | `gm-review.retry({turnId, idempotencyKey})`                                                | из `REVIEW` → `OPEN` (resolution очищен); из `FAILED` → новый ход, действия прежнего хода **не копируются** (D118)     |

---

## 4. Интерфейс игрока (`/player`)

Компоненты (v3 §VII.1):

```text
GameShell
├── ConnectionBar        статус соединения, попытка реконнекта, «подключиться снова»
├── SystemFeed           системные сообщения, CAPABILITY_CHANGED, ошибки с clientAction
├── PublicChat           лента, optimistic-отправка, статусы delivered/failed
├── PrivateChat          только свои приватные сообщения
├── TurnPanel
│   ├── TurnStatus       номер хода, статус, сколько действий принято
│   ├── ActionsInput     текст + intent + target; счётчик оставшихся действий (5/ход)
│   └── MyActions        свои действия текущего хода с sequenceId
├── PlayerPanel          список игроков, текущая локация, публичные флаги
└── VisualPanel          заглушка этапа 1 («визуал появится на этапе 2»)
```

Правила экрана:

- игрок **никогда** не видит: черновик хода, GM-заметки, чужой `playerKnowledge`, полный GameState, `diagnostics` провайдера;
- при `RULE_REJECTED` показывается `message` из `meta` человеческим языком, а не код ошибки;
- при `ERROR` — код + `clientAction` из `ERROR_TABLE` (например, `CONFLICT` → «обновите состояние и повторите»);
- отправка действия оптимистична: показывается сразу, при `ACTION_ACK` заменяется на серверный `actionId`, при `ERROR` — откат с причиной;
- `GM_COMMIT_TURN`-подобные операции не оптимистичны (v3 §VII.8);
- весь пользовательский текст рендерится через `textContent` (никакого `innerHTML`).

---

## 5. Интерфейс GM (`/gm`)

```text
GameShell (GM)
├── ConnectionBar / SystemFeed / PublicChat / PrivateChat / PlayerPanel   (как у игрока)
├── TurnPanel
│   ├── TurnControls     Open next / Lock / Unlock / Cancel
│   ├── ActionsFeed      все действия хода с sequenceId и playerId
│   └── ResolutionView   черновик: сегменты, приватные сообщения, события, изменения объектов
├── GMPanel
│   ├── Review           approve / edit&approve / reject / retry; diagnostics; softRejects/warnings; requiresGM
│   ├── State            worldState, флаги, объекты по локациям, knowledge игроков; ручная правка флага (setBy='GM')
│   ├── Move             выбор игроков и локации (с проверкой exits/locked)
│   ├── Inspect          AI context (view=ai), journal по ходу
│   ├── Notes            заметки с visibility (GM_ONLY | AI_DIRECTOR | PUBLIC_AFTER_COMMIT)
│   └── Audit            лента gm_audit
└── VisualPanel          заглушка этапа 1
```

Обязательные поведения:

- `TURN_DRAFT_READY` и полный `TURN_RESOLUTION_GM` приходят **только** GM (политика `GM_ONLY`);
- `Edit & Approve` отправляет `baseResolutionHash`; при 409 панель показывает актуальный черновик из `meta` и помечает «черновик изменён, обновите»;
- каждое GM-действие порождает запись `gm_audit` (append-only) и `GM_ACTION_PERFORMED`;
- повтор любой мутирующей операции с тем же `idempotencyKey` безопасен (клиент генерирует ключ один раз на операцию и переиспользует при ретраях).

---

## 6. Протокол WebSocket

Транспорт: нативный WS через `@fastify/websocket` на `/ws` (D102). Envelope: `WSEnvelopeSchema` (v3 §VI.5) + **типизированные union'ы** `WSClientMessage` / `WSServerMessage` (дискриминатор `type`), определённые в контрактах (закрывает F-6.3: `type: z.string()` + `payload: z.unknown()` запрещены).

Общие поля envelope: `type`, `requestId?` (8–64 символа), `sessionId?`, `payload`, `ts` (IsoDateTime).

### 6.1 Handshake и жизненный цикл соединения

```text
client → WS /ws (subprotocol 'mnemosin.v1.<jwt>'  |  ?token=<jwt>)
server → HELLO {serverVersion, contractsVersion, capabilities}
server → AUTH_OK {playerId, sessionId, isGM}
server → STATE_PROJECTION          (public view)
server → STATE_PROJECTION_PRIVATE  (свой knowledge)
server → SESSION_STATUS
server → TURN_UPDATE               (текущий ход)
server → PLAYER_PRESENCE
далее   → инкрементальный поток
```

Порядок гарантирован: `STATE_PROJECTION` всегда **до** инкрементальных обновлений (per-connection outbound queue с барьером).
Таймауты: `wsAuthTimeoutMs=5000` (нет токена → close 4401), heartbeat: сервер шлёт `PING` каждые 20 с, ждёт `PONG`; idle 45 с → close 4408.
Лимиты: `wsMaxConnectionsPerIp=20`, `wsMaxConnectionsPerPlayer=4`, `wsMaxPayloadBytes=65536`.
Коды закрытия: `4401 AUTH_INVALID` · `4403 AUTH_FORBIDDEN` · `4408 IDLE/AUTH_TIMEOUT` · `4429 RATE_LIMIT` · `4500 INTERNAL`.

### 6.2 Каталог client → server (28 типов)

| type                | payload                                                          | auth   | ack                | возможные ошибки                                                               |
| ------------------- | ---------------------------------------------------------------- | ------ | ------------------ | ------------------------------------------------------------------------------ |
| `AUTH`              | `{token}`                                                        | none   | `AUTH_OK`          | `AUTH_INVALID`, `AUTH_EXPIRED`                                                 |
| `SUBSCRIBE`         | `{sessionId}`                                                    | player | `SUBSCRIBED`       | `NOT_FOUND`, `AUTH_FORBIDDEN`                                                  |
| `UNSUBSCRIBE`       | `{sessionId}`                                                    | player | —                  | —                                                                              |
| `ACTION_SUBMIT`     | `{turnId, rawText, meta?, idempotencyKey}`                       | player | `ACTION_ACK`       | `CONFLICT` (ход не OPEN), `VALIDATION`, `RATE_LIMIT`, `RULE_REJECTED` (этап 2) |
| `CHAT_PUBLIC`       | `{text, requestId}`                                              | player | `CHAT_ACK`         | `VALIDATION`, `RATE_LIMIT`                                                     |
| `CHAT_PRIVATE`      | `{toPlayerId, text, requestId}`                                  | player | `CHAT_ACK`         | `NOT_FOUND`, `VALIDATION`                                                      |
| `HISTORY`           | `{sessionId, since?, limit?}`                                    | player | `HISTORY_RESULT`   | `VALIDATION`, `AUTH_FORBIDDEN`                                                 |
| `LEAVE`             | `{}`                                                             | player | —                  | —                                                                              |
| `GM_OPEN_TURN`      | `{sessionId, idempotencyKey}`                                    | GM     | `TURN_UPDATE`      | `CONFLICT`, `AUTH_FORBIDDEN`                                                   |
| `GM_LOCK_TURN`      | `{turnId, idempotencyKey}`                                       | GM     | `TURN_UPDATE`      | `CONFLICT`                                                                     |
| `GM_UNLOCK_TURN`    | `{turnId, idempotencyKey}`                                       | GM     | `TURN_UPDATE`      | `CONFLICT`                                                                     |
| `GM_COMMIT_TURN`    | `{turnId, idempotencyKey}`                                       | GM     | `TURN_COMMITTED`   | `CONFLICT`, `VERSION_CONFLICT`, `IDEMPOTENCY_IN_FLIGHT`, `RULE_REJECTED`       |
| `GM_EDIT_APPROVE`   | `{turnId, editedResolution, baseResolutionHash, idempotencyKey}` | GM     | `TURN_COMMITTED`   | `VERSION_CONFLICT`, `VALIDATION`, `IDEMPOTENCY_IN_FLIGHT`                      |
| `GM_REJECT_TURN`    | `{turnId, reason, idempotencyKey}`                               | GM     | `TURN_UPDATE`      | `CONFLICT`                                                                     |
| `GM_RETRY_AI`       | `{turnId, idempotencyKey}`                                       | GM     | `TURN_UPDATE`      | `CONFLICT`, `PROVIDER_UNAVAILABLE`, `CAPABILITY_UNAVAILABLE`                   |
| `GM_MOVE_GROUP`     | `{sessionId, playerIds, toLocationId, idempotencyKey}`           | GM     | `STATE_PROJECTION` | `CORE_LOCATION_NOT_FOUND`, `RULE_REJECTED`, `CONFLICT`                         |
| `GM_PAUSE`          | `{sessionId, idempotencyKey}`                                    | GM     | `SESSION_STATUS`   | `CONFLICT`                                                                     |
| `GM_RESUME`         | `{sessionId, idempotencyKey}`                                    | GM     | `SESSION_STATUS`   | `CONFLICT`                                                                     |
| `GM_END_SESSION`    | `{sessionId, idempotencyKey}`                                    | GM     | `SESSION_STATUS`   | `CONFLICT`                                                                     |
| `GM_SYSTEM_MESSAGE` | `{sessionId, text}`                                              | GM     | `CHAT_ACK`         | `VALIDATION`                                                                   |
| `GM_ADD_NOTE`       | `{sessionId, turnId?, visibility, text}`                         | GM     | `GM_NOTE_ACK`      | `VALIDATION`                                                                   |
| `GM_KICK_PLAYER`    | `{sessionId, playerId}`                                          | GM     | `PLAYER_PRESENCE`  | `NOT_FOUND`                                                                    |
| `GM_ACTIVATE_EVENT` | `{eventId, turnId, idempotencyKey}`                              | GM     | `GM_ACTION_ACK`    | **этап 1:** `NOT_IMPLEMENTED` → `VALIDATION` c `meta.stage=2`                  |
| `PING`              | `{}`                                                             | any    | `PONG`             | —                                                                              |

Правила:

- любая мутирующая команда **обязана** содержать `idempotencyKey` (16–128 символов); отсутствие → `VALIDATION` (сервер ключи не додумывает — B-08);
- дедупликация доставки — по `requestId`: LRU-кэш `requestId → {ack, at}` с TTL `dedupeTtlMs=300000`; повтор → прежний ack без повторного исполнения;
- rate limit (token bucket на соединение): `ACTION_SUBMIT` 5/s, `CHAT_PUBLIC` 10/s, прочие 20/s → `RATE_LIMIT` **без разрыва соединения**;
- неизвестный `type` → `ERROR{VALIDATION}`, соединение сохраняется.

### 6.3 Каталог server → client (35 типов: 21 в этапе 1 + 14 объявлены на этапы 2–3) и матрица приватности

Политика — поле `WS_PRIVACY_POLICY` в контрактах; реализуется **только** в `gateways/ws/src/projections.ts` (инвариант 14: транспорт не содержит логики, он применяет готовую политику).

| type                       | политика               | payload                                           | источник-событие                                                |
| -------------------------- | ---------------------- | ------------------------------------------------- | --------------------------------------------------------------- |
| `HELLO`                    | SENDER_ONLY            | `{serverVersion, contractsVersion, capabilities}` | handshake                                                       |
| `AUTH_OK`                  | SENDER_ONLY            | `{playerId, sessionId, isGM}`                     | handshake                                                       |
| `SUBSCRIBED`               | SENDER_ONLY            | `{sessionId}`                                     | SUBSCRIBE                                                       |
| `SESSION_STATUS`           | BROADCAST              | `{sessionId, from, to}`                           | `SESSION_STATUS_CHANGED`                                        |
| `PLAYER_PRESENCE`          | BROADCAST              | `{playerId, status, connections}`                 | join/leave/disconnect                                           |
| `STATE_PROJECTION`         | BROADCAST              | `PublicGameStateView`                             | `STATE_COMMITTED`, `LOCATION_CHANGED`, reconnect                |
| `STATE_PROJECTION_PRIVATE` | TARGETED               | `{knowledge: KnowledgeEntry[]}`                   | `STATE_COMMITTED`, reconnect                                    |
| `TURN_UPDATE`              | BROADCAST              | `{turnId, number, status, actionCount}`           | `TURN_OPENED`/`LOCKED`/`UNLOCKED`/`PROCESSING_STARTED`/`FAILED` |
| `TURN_DRAFT_READY`         | **GM_ONLY**            | `{turnId}`                                        | `TURN_DRAFT_READY`                                              |
| `TURN_RESOLUTION_GM`       | **GM_ONLY**            | `TurnResolution` (полный)                         | `TURN_DRAFT_READY`, `GM_EDIT_APPROVE`                           |
| `TURN_COMMITTED`           | BROADCAST              | `{turnId, version, publicSegments[]}`             | `TURN_COMMITTED`                                                |
| `TURN_PRIVATE_RESOLUTION`  | **TARGETED**           | `{turnId, text}`                                  | `TURN_COMMITTED` (per-player)                                   |
| `CHAT_PUBLIC`              | BROADCAST              | `ChatMessageView`                                 | `CHAT_MESSAGE_PUBLIC`                                           |
| `CHAT_PRIVATE`             | TARGETED               | `ChatMessageView`                                 | `CHAT_MESSAGE_PRIVATE`                                          |
| `CHAT_SYSTEM`              | BROADCAST              | `ChatMessageView`                                 | `CHAT_MESSAGE_SYSTEM`                                           |
| `CHAT_GM`                  | **GM_ONLY**            | `ChatMessageView`                                 | `CHAT_MESSAGE_GM`                                               |
| `GM_ACTION_ACK`            | SENDER_ONLY (+GM_ONLY) | `{action, ok, meta}`                              | `GM_ACTION_PERFORMED`                                           |
| `GM_NOTE_ACK`              | SENDER_ONLY            | `{noteId}`                                        | `GM_NOTE_ADDED`                                                 |
| `CAPABILITY_CHANGED`       | BROADCAST              | `{capability, available, providers[]}`            | `CAPABILITY_CHANGED`                                            |
| `ERROR`                    | SENDER_ONLY            | `{code, message, meta, requestId}`                | любая ошибка                                                    |
| `PONG`                     | SENDER_ONLY            | `{}`                                              | PING                                                            |

**Жёсткое правило (закрывает блокер B-10):** broadcast-payload **не содержит** per-player полей. Приватное уходит отдельным TARGETED-сообщением. В `TURN_COMMITTED` нет ни `privateMessages`, ни `proposedEvents` с GM-комментариями, ни `diagnostics`. Полный черновик — только `TURN_RESOLUTION_GM` (GM_ONLY).

Сообщения этапа 2 (`MEDIA_STARTED`, `MEDIA_READY`, `MEDIA_FAILED`, `BUDGET_WARNING`, `AUDIO_*`) объявлены в контрактах заранее, но в этапе 1 не отправляются.

### 6.4 Реконнект и offline-queue (v3 §VI.8, §VII.7)

```text
1. клиент обнаруживает разрыв (close или отсутствие PONG)
2. экспоненциальный backoff: base 500 мс, factor 2, cap 15 с, jitter ±20 %, maxAttempts 8 → затем состояние FAILED и кнопка «Подключиться снова»
3. новое соединение → HELLO → AUTH_OK
4. сервер шлёт фиксированный набор (п. 6.1)
5. клиент отправляет HISTORY{since} при необходимости
6. клиент переотправляет сообщения из offline-queue с теми же requestId/idempotencyKey
7. сервер дедуплицирует: по requestId (доставка) и по idempotencyKey (эффект)
```

Offline-queue: сообщения с `idempotencyKey` хранятся в `localStorage` (`mnemosin:pending:<playerId>`) и удаляются по ack; токены в `localStorage` не хранятся никогда (D126).

---

## 7. HTTP-каталог

Фактическое число маршрутов в контрактах: **45** (из них **32** на этап 1, остальные объявлены с `stage: 2|3` и до реализации отвечают `NOT_IMPLEMENTED`). Ниже — этап 1 и ключевые маршруты следующих этапов.

Единый формат ошибки (для всех маршрутов): `{ "error": { "code": ErrorCode, "message": string, "meta"?: object, "requestId"?: string } }`.
Все request/response — Zod-схемы из контрактов (`RouteContract { method, path, auth, request, response, errors[] }`, массив `HTTP_ROUTES`).

### 7.1 Auth и сессия

| Method | Path                        | Request                                | Response                                       | Auth   | Ошибки                                                |
| ------ | --------------------------- | -------------------------------------- | ---------------------------------------------- | ------ | ----------------------------------------------------- |
| POST   | `/auth/session`             | `{displayName, characterName, title?}` | `{sessionId, playerId, token, refreshToken}`   | none   | `VALIDATION`, `RATE_LIMIT`                            |
| POST   | `/auth/refresh`             | `{refreshToken}`                       | `{token}`                                      | none   | `AUTH_INVALID`, `AUTH_EXPIRED`                        |
| POST   | `/sessions`                 | `{title}`                              | `{sessionId}`                                  | GM     | `VALIDATION` (алиас `/auth/session`, D122)            |
| POST   | `/sessions/:id/join`        | `{displayName, characterName}`         | `{playerId, characterId, token, refreshToken}` | none   | `NOT_FOUND`, `CONFLICT` (нет мест/роли), `RATE_LIMIT` |
| GET    | `/sessions/:id`             | —                                      | `SessionView`                                  | player | `NOT_FOUND`                                           |
| POST   | `/sessions/:id/start`       | `{idempotencyKey}`                     | `{turnId}`                                     | GM     | `CONFLICT`, `CAPABILITY_UNAVAILABLE`                  |
| POST   | `/sessions/:id/pause`       | `{idempotencyKey}`                     | `{}`                                           | GM     | `CONFLICT`                                            |
| POST   | `/sessions/:id/resume`      | `{idempotencyKey}`                     | `{}`                                           | GM     | `CONFLICT`                                            |
| POST   | `/sessions/:id/end`         | `{idempotencyKey}`                     | `{}`                                           | GM     | `CONFLICT`                                            |
| DELETE | `/sessions/:id/me`          | —                                      | `{}`                                           | player | `NOT_FOUND`                                           |
| DELETE | `/sessions/:id/player/:pid` | —                                      | `{}`                                           | GM     | `NOT_FOUND`                                           |

### 7.2 Ход, действия, чат

| Method | Path                      | Request                                                  | Response                 | Auth   | Ошибки                                                                   |
| ------ | ------------------------- | -------------------------------------------------------- | ------------------------ | ------ | ------------------------------------------------------------------------ |
| POST   | `/sessions/:id/turns`     | `{idempotencyKey}`                                       | `{turnId, number}`       | GM     | `CONFLICT`                                                               |
| POST   | `/turns/:id/action`       | `{rawText, meta?, idempotencyKey}`                       | `{actionId, sequenceId}` | player | `CONFLICT`, `VALIDATION`, `RATE_LIMIT`                                   |
| POST   | `/turns/:id/lock`         | `{idempotencyKey}`                                       | `{}`                     | GM     | `CONFLICT`, `IDEMPOTENCY_IN_FLIGHT`                                      |
| POST   | `/turns/:id/unlock`       | `{idempotencyKey}`                                       | `{}`                     | GM     | `CONFLICT`                                                               |
| POST   | `/turns/:id/cancel`       | `{reason, idempotencyKey}`                               | `{}`                     | GM     | `CONFLICT`                                                               |
| POST   | `/turns/:id/commit`       | `{idempotencyKey}`                                       | `{version}`              | GM     | `CONFLICT`, `VERSION_CONFLICT`, `IDEMPOTENCY_IN_FLIGHT`, `RULE_REJECTED` |
| POST   | `/turns/:id/edit-approve` | `{editedResolution, baseResolutionHash, idempotencyKey}` | `{version}`              | GM     | `VERSION_CONFLICT`, `VALIDATION`                                         |
| POST   | `/turns/:id/reject`       | `{reason, idempotencyKey}`                               | `{}`                     | GM     | `CONFLICT`                                                               |
| POST   | `/turns/:id/retry`        | `{idempotencyKey}`                                       | `{turnId}`               | GM     | `CONFLICT`, `PROVIDER_UNAVAILABLE`                                       |
| GET    | `/turns/:id`              | —                                                        | `TurnView`               | player | `NOT_FOUND`                                                              |
| GET    | `/chat/history`           | `?since=&limit=&visibility=`                             | `ChatMessageView[]`      | player | `VALIDATION`                                                             |

### 7.3 GM, состояние, сервис

| Method | Path                  | Request                                     | Response                                                                        | Auth                                                | Ошибки                                                 |
| ------ | --------------------- | ------------------------------------------- | ------------------------------------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------ |
| POST   | `/sessions/:id/move`  | `{playerIds, toLocationId, idempotencyKey}` | `{}`                                                                            | GM                                                  | `CORE_LOCATION_NOT_FOUND`, `RULE_REJECTED`, `CONFLICT` |
| POST   | `/gm/inspect/state`   | `{sessionId}`                               | `GMStateView`                                                                   | GM                                                  | `NOT_FOUND`                                            |
| POST   | `/gm/inspect/context` | `{turnId}`                                  | `DirectorContextView`                                                           | GM                                                  | `NOT_FOUND`                                            |
| POST   | `/gm/inspect/journal` | `{turnId}`                                  | `JournalEntry[]`                                                                | GM                                                  | `NOT_FOUND`                                            |
| POST   | `/gm/note`            | `{sessionId, turnId?, visibility, text}`    | `{noteId}`                                                                      | GM                                                  | `VALIDATION`                                           |
| GET    | `/gm/audit`           | `?since=&limit=`                            | `GMAuditEntry[]`                                                                | GM                                                  | `VALIDATION`                                           |
| GET    | `/state/projection`   | `?view=public\|ai\|gm`                      | соответствующий view                                                            | `public` — player; **`ai`, `gm` — только GM**       | `AUTH_FORBIDDEN`                                       |
| GET    | `/health`             | —                                           | `{ok, version, contractsVersion, uptime, env, capabilities, db, schemaVersion}` | none                                                | —                                                      |
| GET    | `/version`            | —                                           | `{version, gitTag?, contractsVersion}`                                          | none                                                | —                                                      |
| GET    | `/metrics`            | —                                           | prom-text                                                                       | internal (в prod — только `METRICS_PORT`/localhost) | `AUTH_FORBIDDEN`                                       |
| GET    | `/media/jobs/:id`     | —                                           | `MediaJobView`                                                                  | player                                              | **этап 1:** `NOT_IMPLEMENTED` (501)                    |
| POST   | `/media/request`      | `{turnId, sceneHint}`                       | `{mediaJobId}`                                                                  | GM                                                  | **этап 1:** 501                                        |

Rate-limit: глобально 100 req/min на IP, 300 req/min на токен; `/auth/*` и `/sessions/:id/join` — 10 req/min на IP (закрывает F-6.6); мутирующие turn-маршруты — 30 req/min на токен. Превышение → `RATE_LIMIT` (429) + `Retry-After`.

---

## 8. Модель данных

### 8.1 GameState (этап 1)

```ts
GameState {
  sessionId, version, updatedAt,
  worldState: { currentLocationId, timeOfDay, weather?, ambientFlags{} },
  storyFlags: Record<FlagKey /* 'doll_room.darkness' */, StoryFlag>,   // ключ — key, не flagId (патч §8.2)
  objectStates: Record<ObjectId, ObjectState>,
  playerKnowledge: Record<PlayerId, { playerId, entries: KnowledgeEntry[] }>,
  endingState: EndingState | null
}
```

Отклонения от v3 §II.7 (зафиксированы): `storyFlags` ключуется строковым `key` (в v3 — `FlagId`, что делало DSL-пути нерезолвимыми, блокер B-03); `playerKnowledge.entries` — массив, а не record (устраняет дублирование ключа, F-1.15); `Session.currentLocationId` удалён (F-1.16).

### 8.2 Таблицы этапа 1

| Таблица                                                                                                     | Назначение                                      | Ключевые поля / индексы                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions`                                                                                                  | партия                                          | `session_id` PK, `status`, `gm_player_id`, `current_turn_id`, `archived_at`, `created_at`                                                         |
| `players`                                                                                                   | игрок                                           | `player_id` PK, `session_id` FK, `display_name`, `is_gm`, `status`, `revoked_before`                                                              |
| `characters`                                                                                                | персонаж                                        | `character_id` PK, `session_id` FK, `name`, `archetype`, `stats_json`                                                                             |
| `player_extensions`                                                                                         | данные модулей о игроке                         | PK(`player_id`,`module_id`), `data_json`                                                                                                          |
| `locations`                                                                                                 | локации сессии                                  | `location_id` PK, `session_id` FK, `template_slug`, `objects_json`, `exits_json`, `registered_event_ids_json`                                     |
| `turns`                                                                                                     | ходы                                            | `turn_id` PK, `session_id` FK, `number`, `status`, `idempotency_key`, `resolution_json`, временные метки фаз; idx(`session_id`,`number`)          |
| `actions`                                                                                                   | действия                                        | `action_id` PK, `turn_id` FK, `player_id` FK, `sequence_id`, `raw_text`, `meta_json`; **UNIQUE(`turn_id`,`sequence_id`)**                         |
| `game_state`                                                                                                | состояние                                       | `session_id` PK, `version`, `state_json`, `updated_at`                                                                                            |
| `turn_journal`                                                                                              | журнал хода (append-only)                       | `id` AUTOINC, `turn_id`, `trace_id`, `entry_json`, `created_at`; idx(`turn_id`)                                                                   |
| `idempotency_records`                                                                                       | идемпотентность                                 | `key` PK, `command`, `status`(IN_FLIGHT/DONE/FAILED), **`result_json`**, `result_hash`, `error_code`, `trace_id`, `expires_at`                    |
| `event_outbox`                                                                                              | outbox                                          | `id` AUTOINC, `event_name`, `payload`, `trace_id`, `emitted_at`, `published_at`, `attempts`, `last_error`, `status`(PENDING/PUBLISHED/DEAD)       |
| `chat_messages`                                                                                             | чат                                             | `message_id` PK, `session_id` FK, `turn_id`, `from_player_id`, `to_player_id`, `visibility`, `text`, `created_at`; idx(`session_id`,`created_at`) |
| `gm_notes`                                                                                                  | заметки GM                                      | `note_id` PK, `session_id` FK, `turn_id`, `visibility`, `text`, `created_at`                                                                      |
| `gm_audit`                                                                                                  | аудит GM (append-only)                          | `id` AUTOINC, `session_id`, `gm_player_id`, `action`, `meta_json`, `trace_id`, `idempotency_key`, `created_at`                                    |
| `world_events`, `rules_bundles`, `first_seen`, `deferred_effects`, `media_jobs`, `media_cache`, `snapshots` | созданы в этапе 1, **заполняются в этапах 2–3** | —                                                                                                                                                 |

PRAGMA (обязательно, проверяются при старте): `journal_mode=WAL`, `foreign_keys=ON`, `busy_timeout=5000`, `synchronous=NORMAL`. Все FK объявлены **в Drizzle-коде** (`.references()`), а не только в документации (закрывает B-05).
Миграции: `drizzle-kit generate` → `NNNN_*.sql` + соседний `down.sql`; в проде — forward-only, `down.sql` — только для dev (устраняет противоречие F-5.2).

### 8.3 Идемпотентность (патч §8.3)

```text
withIdempotency(key, command, fn):
  INSERT … ON CONFLICT(key) DO NOTHING      ← атомарно, внутри транзакции
  changes()==1 → proceed → fn() → UPDATE status='DONE', result_json, result_hash
  status DONE   → вернуть result_json (тот же ответ клиенту)
  status FAILED → вернуть прежнюю ошибку (failed_before)
  status IN_FLIGHT → 409 IDEMPOTENCY_IN_FLIGHT
```

Правила: ключ **всегда** приходит от клиента для мутирующих команд; сервер использует детерминированные ключи только для внутренних вызовов (`resolve:{turnId}`, `move:{…}`); TTL 24 ч, очистка — фоновый джоб; `IN_FLIGHT` старше 120 с разблокируется при `reconcileOnBoot`.

### 8.4 Outbox и журнал

- Доменные события пишутся в `event_outbox` **внутри** транзакции вместе с мутацией; публикуются **после** COMMIT фоновым циклом (`BEGIN IMMEDIATE`, батч 100, `ORDER BY id`) — без `FOR UPDATE` (в SQLite его нет, F-2.5).
- Обработчики обязаны быть идемпотентны (at-least-once).
- `attempts > outboxMaxAttempts(5)` → `status='DEAD'` + error-лог + метрика (алерт в этапе 3).
- `turn_journal` — append-only, каждая запись содержит `traceId` и `kind` из enum (`processing_started`, `ai_call_started/finished/failed`, `rules_evaluated`, `draft_ready`, `gm_decision`, `commit_started`, `state_applied`, `effects_applied`, `committed`, `failed`).

---

## 9. Интеграция AI в этапе 1: порт и стенды

### 9.1 `AIPort` (патч §8.10)

```ts
interface AIPort {
  readonly providerId: string;
  readonly capability: 'TEXT_AI';
  isAvailable(): Promise<boolean>;
  generate(input: {
    context: DirectorContext;
    schema: z.ZodType<AIResponse>;
    deadline: { timeoutMs: number; attempt: number }; // политику задаёт Capability Registry
    signal?: AbortSignal;
  }): Promise<{
    response: AIResponse;
    usage: { inputTokens; outputTokens; model } | null;
    durationMs: number;
  }>;
}
```

Отклонения от v3 §V.1: `maxRetries`/`timeoutMs` убраны из аргументов (единственный источник политики — `provider-policies.yaml`, F-7.2); добавлен `usage` (без него cost model этапа 2 нечем наполнить, F-7.1).

### 9.2 Стенды

| Провайдер    | env                                                                                | Поведение                                                                                                                                                                                                             |
| ------------ | ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ScriptedAI` | `AI_PROVIDER=scripted`                                                             | отдаёт валидный `AIResponse` из `AI_SCRIPTED_FIXTURE`; подставляет в нарратив число действий из контекста; usage — детерминированный псевдорасчёт. Сеть не используется, состояние партии сверх контекста не читается |
| `EchoAI`     | `AI_PROVIDER=echo`                                                                 | нарратив = `rawText` действий по порядку `sequenceId`; приватные сообщения и предложения пусты. Нужен как второй провайдер для проверки fallback                                                                      |
| `FailingAI`  | `AI_PROVIDER=failing` + `AI_FAILING_MODE=timeout\|schema\|rate_limit\|unavailable` | имитирует отказы для проверки retry, breaker, `TURN_FAILED`, деградации                                                                                                                                               |

Все три проходят один и тот же **contract-тест `AIPort`** — он же станет шаблоном для OpenRouter/LMStudio в этапе 2 (критерии A1.12, A1.14).

### 9.3 Capability Registry

- `capabilities.yaml` (этап 1): `TEXT_AI: { required: true, chain: [scripted, echo] }`; остальные capability — `chain: []`.
- `provider-policies.yaml`: `timeoutMs`, `retries{max, backoffMs, jitter}`, `circuitBreaker{failureThreshold:3, cooldownMs:60000}`, `costPer1kTokens: {input:null, output:null}`.
- `resolve(capability)` → упорядоченная цепочка доступных провайдеров; `isAvailable(capability)`; health-probe каждые 30 с; при изменении — `CAPABILITY_CHANGED`.
- Breaker OPEN → провайдер пропускается в `resolve()`, half-open после cooldown.
- `TEXT_AI` — **required**: при недоступности `startSession` отклоняется с `CAPABILITY_UNAVAILABLE` (F-9.6), а начатая партия получает `TURN_FAILED{PROVIDER_UNAVAILABLE}` с возможностью retry.

### 9.4 `AIResponse` и guard

Схема — v3 §IV.5 без изменений (`narrative`, `privateMessages[]`, `proposedEvents[]`, `proposedObjectChanges[]`, `visualSceneDescription`).
Преобразование `AIResponse → TurnResolution`: все item'ы получают `status='PROPOSED'`, `diagnostics` заполняется из результата порта.
В этапе 1 `guard` (allowlist/anti-injection, промпт 2.14) ещё не реализован, **но** действует базовая проверка: `proposedEvents[].eventId ∈ allowedEventIds`, иначе item отклоняется с `EVENT_NOT_REGISTERED` (инвариант v2 §26 и v3 §IV.4).

---

## 10. Безопасность (этап 1)

Выдержка из STRIDE v3 §VIII.2, актуальная для этапа 1, и как она проверяется:

| Asset               | Threat          | Mitigation в этапе 1                                                                                                   | Проверка                                  |
| ------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| AI-ключи            | Info disclosure | ключей нет вовсе (стенды); env-only, redact в логах                                                                    | grep-тест логов и трафика                 |
| GM-секреты          | Info disclosure | `visibility`-фильтрация в `projections.ts`; `view=ai\|gm` только GM                                                    | property-based тест + 403-тест            |
| Приватные сообщения | Info disclosure | TARGETED-доставка, broadcast без per-player полей                                                                      | property-based тест (fast-check)          |
| GameState           | Tampering       | мутирующие команды только с токеном нужной роли; `idempotencyKey`; optimistic lock; запись только через `StateService` | тесты A1.4, A1.5, 403/401                 |
| GameState           | Repudiation     | `gm_audit` append-only + `traceId`                                                                                     | тест «каждое GM-действие оставило запись» |
| Сервер              | DoS             | rate-limit per token и per IP, WS token bucket, лимит payload и соединений                                             | тесты флуда                               |
| Транспорт           | Info disclosure | WSS в prod (fail-fast при отсутствии), токены не в `localStorage`                                                      | startup-assert, код-ревью                 |
| Зависимости         | Supply chain    | lockfile + `npm ci`; `npm audit` и gitleaks добавляются в CI в 1.13                                                    | CI                                        |

Чек-лист v3 §VIII.3 в этапе 1 выполняется полностью, кроме пунктов про media/ComfyUI (появятся в этапе 2).

---

## 11. Структура проекта и конфигурация

```text
mnemosin/
├── package.json                     # npm workspaces
├── shared/contracts/                # @mnemosin/contracts — ЕДИНСТВЕННЫЙ источник истины
│   └── src/{ids,time,errors,domain/*,dsl/*,events/*,transport/*,ai,media,capability,module}.ts
├── core/                            # домен: без инфраструктуры (правила — dependency-cruiser)
│   └── src/{domain/{ports,schemas},turns,state,session,locations,events,journal,rules,events-engine,capability}
├── modules/{session,turn,chat,story,gm,gm-review,gm-audit,ai-director}/src/{contract.ts,…}
├── infrastructure/{config,logging,database,ai,storage,metrics,jobs}/
├── gateways/{http,ws}/src/…         # транспорт; логика приватности — в ws/projections.ts
├── apps/server/src/{main.ts,app.ts,modules-registry.ts}
├── client/src/{main.ts,net,stores,player,gm,lib}/
├── config/{capabilities,provider-policies,limits}.yaml
├── content/                         # world-pack'и (этап 2)
├── tools/{verify,fixtures,gen-location-fixtures.mjs,worldpack.mjs,host-agent.mjs,doctor.mjs}
├── e2e/*.spec.ts
├── data/{mnemosin.sqlite,state/{media,prompt-dumps}}   # в .gitignore
└── docs/{ROADMAP,ARCHITECTURE,SPEC_STAGE1,DEV_PLAN_STAGE1..3,AUDIT}.md
```

Правила зависимостей (контролируются `dependency-cruiser` + eslint + arch-тестами):

```text
shared/contracts  ←  core  ←  modules  ←  infrastructure, gateways  ←  apps/server
client  ←  shared/contracts   (только)
infrastructure/*  →  core/domain/ports  (только порты, не сервисы ядра)
```

`.env` этапа 1 (полный список — в промпте 1.1): `NODE_ENV`, `PORT`, `DATABASE_URL`, `JWT_SECRET`, `JWT_TTL_SECONDS`, `LOG_LEVEL`, `LOG_REDACT_PLAYER_TEXT`, `AI_PROVIDER`, `AI_SCRIPTED_FIXTURE`, `AI_FAILING_MODE`, `MEDIA_PROVIDER`, `HOSTBRIDGE_SECRET`, `CONFIG_DIR`, `STATE_DIR`, `METRICS_PORT`. Секреты — только env, `.env.example` с пустыми значениями.

---

## 12. Критерии приёмки A1.1–A1.16

Полные формулировки — в `ROADMAP.md` §2.3. Здесь — способ демонстрации (все пункты прогоняются `node tools/verify/stage1.mjs`, а также закреплены тестами):

| #     | Демонстрация                                                                                                                              | Тесты                                                                         |
| ----- | ----------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| A1.1  | `npm run dev` → `curl /health` = 200; запуск с пустым `JWT_SECRET` → падение с `CONFIG_INVALID` без значения секрета                      | verify:stage1 (a1_1_serverStarts, a1_1_failFast)                              |
| A1.2  | `npm run test:arch` зелёный; намеренный `import 'fastify'` в `core/` → падение                                                            | `tests/arch/*`, `.dependency-cruiser.cjs`                                     |
| A1.3  | WS-сообщение неизвестного типа → `ERROR{VALIDATION}`, соединение живо                                                                     | `integration/ws-router`                                                       |
| A1.4  | два `POST /turns/:id/commit` с одним ключом → одинаковый `version`, одна journal-запись; параллельно → `409 IDEMPOTENCY_IN_FLIGHT`        | `integration/idempotency` (50 параллельных), `e2e`                            |
| A1.5  | две параллельные записи состояния → вторая `VERSION_CONFLICT`, `version` +1                                                               | `integration/state-repo`                                                      |
| A1.6  | обход всех разрешённых переходов + по одному запрещённому на статус                                                                       | `unit/turn-transitions`                                                       |
| A1.7  | property-based: ни в одном BROADCAST нет приватных данных; `?view=ai` под игроком → 403                                                   | `e2e/privacy-leak.spec.ts`                                                    |
| A1.8  | `TURN_DRAFT_READY` только GM; `editAndApprove` с чужим hash → 409; `reject` → `FAILED`                                                    | `e2e/stage1-table.spec.ts`                                                    |
| A1.9  | `kill -9` → клиент `RECONNECTING` → полный набор проекций; offline-queue доставлен один раз                                               | `e2e/restart-recovery.spec.ts`                                                |
| A1.10 | публичные/приватные/системные видны правильным адресатам; порядок по `sequenceId`; `history?since=` совпадает с буфером клиента           | `integration/chat`, `e2e/private-message.spec.ts`, `e2e/privacy-leak.spec.ts` |
| A1.11 | рестарт → сессия, игроки, ход, `version`, чат, журнал на месте; `PROCESSING` → согласованное состояние                                    | `integration/recovery`, `e2e`                                                 |
| A1.12 | переключение `AI_PROVIDER=scripted\|echo\|failing` только через env; `failing` → `TURN_FAILED{PROVIDER_TIMEOUT}` + retry                  | `tools/verify/switch-provider.mjs`, `e2e/degraded.spec.ts`                    |
| A1.13 | breaker размыкается после 3 провалов → `CAPABILITY_CHANGED{false}`; `/health` отражает                                                    | `integration/registry`, `e2e/degraded.spec.ts`                                |
| A1.14 | добавление провайдера = 1 файл + 1 строка конфига; `core/` не изменён (хэш-манифест)                                                      | `tests/arch/extensibility`                                                    |
| A1.15 | `moveGroup` меняет локацию и шлёт `LOCATION_CHANGED`; несуществующая локация → `CORE_LOCATION_NOT_FOUND`; `locked` exit → `RULE_REJECTED` | `integration/locations`, `e2e/stage1-table.spec.ts` (moveGroup в Холл, D287)  |
| A1.16 | сквозной Playwright-сценарий «Стол» (7 браузеров)                                                                                         | `e2e/stage1-table.spec.ts` (+ вызов из verify:stage1, D288)                   |

**Условие сдачи этапа:** `node tools/verify/stage1.mjs` → 16/16 PASS **и** живая партия 3+ человека, 3+ хода (Gate 1 в `ROADMAP.md` §5).
Таблица приёмки агрегирует детальные проверки по 16 идентификаторам (FAIL перекрывает PASS); код возврата ≠ 0 при любом FAIL (D288). E2E-слой: `e2e/{player,private-message,reconnect,gm-review,stage1-table,privacy-leak,degraded,restart-recovery}.spec.ts`.

---

## 13. Решения, принимаемые в ходе этапа 1 (D113–D127)

Значения «по умолчанию» proposed; реализатор обязан зафиксировать итог в `docs/ARCHITECTURE.md` и не менять молча.

| D    | Вопрос                                   | По умолчанию                                                                                                                                                                                                                                                                                                                                                                                                          | Где всплывает                                             |
| ---- | ---------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| D113 | Семантика доставки событий               | at-least-once, обработчики идемпотентны                                                                                                                                                                                                                                                                                                                                                                               | 1.5                                                       |
| D114 | Событие разблокировки хода               | добавить `TURN_UNLOCKED` в каталог                                                                                                                                                                                                                                                                                                                                                                                    | 1.6                                                       |
| D115 | Как вызывается AI Director               | **только командой** из Turn Engine (подписка на `TURN_LOCKED` удалена)                                                                                                                                                                                                                                                                                                                                                | 1.7                                                       |
| D116 | Правила в этапе 1                        | `rulesStub` → всегда `PASS` (интерфейс боевой)                                                                                                                                                                                                                                                                                                                                                                        | 1.8                                                       |
| D117 | Кто открывает следующий ход              | GM командой `openTurn` (автоматически — не открываем)                                                                                                                                                                                                                                                                                                                                                                 | 1.8                                                       |
| D118 | Retry из `FAILED`                        | создаётся новый ход; действия прежнего хода не копируются                                                                                                                                                                                                                                                                                                                                                             | 1.8                                                       |
| D119 | Владелец перехода `REVIEW → COMMITTED`   | `gm-review`; `gm.finishTurn` удалён                                                                                                                                                                                                                                                                                                                                                                                   | 1.8                                                       |
| D120 | Как модули пишут состояние               | только через `StateService` (не через репозиторий)                                                                                                                                                                                                                                                                                                                                                                    | 1.9                                                       |
| D121 | Где хранить последний AI-контекст        | таблица `ai_contexts(turn_id PK, context_json, context_hash, tokens_estimate)`                                                                                                                                                                                                                                                                                                                                        | 1.9                                                       |
| D122 | `POST /auth/session` vs `POST /sessions` | основной — `/auth/session`; `/sessions` остаётся алиасом для GM-токена                                                                                                                                                                                                                                                                                                                                                | 1.10                                                      |
| D123 | Передача WS-токена                       | приоритет у subprotocol `mnemosin.v1.<jwt>`, `?token=` — совместимость (и не логируется)                                                                                                                                                                                                                                                                                                                              | 1.11                                                      |
| D124 | Видимость `storyFlags` игрокам           | в этапе 1 публичны (значения); приватность — через `playerKnowledge`                                                                                                                                                                                                                                                                                                                                                  | 1.11                                                      |
| D125 | Механизм сторов клиента                  | **ЗАФИКСИРОВАНО (1.12):** immutable-сторы `svelte/store` (ARCHITECTURE §1.15); runes — только локальное состояние компонентов                                                                                                                                                                                                                                                                                         | 1.12                                                      |
| D126 | Хранение токена на клиенте               | **ЗАФИКСИРОВАНО (1.12):** память + `sessionStorage`; `localStorage` — только offline-queue (ARCHITECTURE §1.15)                                                                                                                                                                                                                                                                                                       | 1.12                                                      |
| D157 | Имена персонажей                         | **задаёт игрок** при join/создании сессии: поле `characterName` (sanitize, ≤60 символов, уникальность в пределах сессии); хранится в `characters.name`. В UI и в чате имя видно всегда (out-of-character разметка). **В нарративе модель использует имя только после флага `remembered_name.<playerId>`** — механизм K13/D173, реализуется в промпте 2.5; в этапе 1 нарратив приходит со стендов и имён не использует | принято заказчиком 2026-10-09, уточнено 2026-10-10 (D173) |
| D127 | `PROCESSING` при старте сервера          | **ЗАФИКСИРОВАНО (1.13):** → `FAILED{RECONCILE_INTERRUPTED}` + retry GM; реализация reconcileOnBoot — ARCHITECTURE §1.16, e2e/restart-recovery.spec.ts                                                                                                                                                                                                                                                                 | 1.13                                                      |

---

## 14. Дефекты аудита, закрываемые этапом 1

Блокеры: **B-01** (`TurnResolution`), **B-02** (проекции), **B-03** (`StatePath`), **B-05** (таблицы/FK), **B-07** (жизненный цикл Turn), **B-08** (идемпотентность), **B-09** (двоевластие), **B-10** (утечка в broadcast), **B-11** (недостающие маршруты), **B-12** (auth).
Остаются на этап 2: **B-04** (world-pack, UUID/slug), **B-06** (Event DSL).
Полная роспись по промптам — в шапке `DEV_PLAN_STAGE1.md`; контроль остатка — `docs/AUDIT_STATUS.md` (появится в 3.14).

---

## 15. Открытые вопросы (не блокируют старт промпта 1.1)

| #      | Вопрос                                                                                                                                | Кому     | Нужно к       |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------- |
| Q1     | Канон стартового `timeOfDay` и стартовых `storyFlags` партии                                                                          | заказчик | 2.4 (контент) |
| Q2     | Тела событий `evt_bell_rings`, `evt_painting_watch` (в v3 объявлены, но не описаны)                                                   | заказчик | 2.4           |
| ~~Q3~~ | ~~Называть ли персонажей по именам в нарративе~~ — **закрыт D157**: имена задают сами игроки, следовательно в нарративе они допустимы | —        | —             |
| Q4     | Фактические цены токенов провайдеров (`model-prices.yaml`)                                                                            | заказчик | 2.8           |
| Q5     | Хостинг/домен/reverse-proxy для stage и prod, RPO/RTO                                                                                 | заказчик | 3.10          |
| Q6     | Целевые значения perf-бюджета (подтвердить 200 мс p95 / 100 соединений)                                                               | заказчик | 3.8           |
| Q7     | Реальный TTS-провайдер (`UNKNOWN#4`)                                                                                                  | заказчик | после 3.7     |

Вопросы Q1–Q3 не блокируют этап 1: контент этапа 1 — две локации из v3 §IX.1–IX.2 без событий.
