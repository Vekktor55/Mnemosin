# DEV_PLAN_STAGE1 — 13 промптов разработки «МНЕМОСИН», этап 1 «Стол»

Версия 1.0 · 2026-10-09 · решения D101–D112 (см. `ROADMAP.md` §8)
Основание: `МНЕМОСИН Pipeline v3` (Части I–IX), `MNEMOSIN_v3_AUDIT.md` (реестр `F-*`/`B-*`, патчи §8), `ROADMAP.md` (критерии A1.1–A1.16).

Формат — тот же, что в v1 `DEV_PLAN.md`: **каждый промпт самодостаточен** и вставляется в отдельную сессию разработки; сервер поднимается в промпте 1.1 и дальше каждый слой проверяется на живом процессе; внешний AI заменён офлайн-стендами, поэтому **весь этап прогоняется без ключей и без сети**.

| Промпт | Что делает                                                                                                                         | Критерии A1 | Закрывает дефекты аудита                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | ----------- | ---------------------------------------------------- |
| 1.1    | Монорепо-каркас: ESM+TS strict, config (Zod, fail-fast), pino+`traceId`+redact, `/health`, graceful shutdown → **сервер стартует** | 1           | F-10.1, F-10.2, F-10.3, F-9.8                        |
| 1.2    | `shared/contracts` — все Zod-схемы как единственный источник истины (патч аудита §8.1)                                             | 3           | B-01, B-02, B-03, F-1.10…F-1.23, F-6.3, F-6.4, F-7.4 |
| 1.3    | Architecture-тесты: `dependency-cruiser` + eslint + Vitest-набор границ                                                            | 2, 14       | F-10.3, F-8.1                                        |
| 1.4    | SQLite+Drizzle: полная схема, миграции, репозитории, `UnitOfWork`, атомарная идемпотентность, optimistic lock                      | 4, 5, 11    | B-05, B-08, F-5.1…F-5.10                             |
| 1.5    | Event bus + outbox publisher + `turn_journal`                                                                                      | 11          | F-2.5, F-2.8, F-2.9                                  |
| 1.6    | Core: машина состояний Turn, `openTurn/lock/unlock/cancel`, сессия                                                                 | 6           | B-07, F-3.5                                          |
| 1.7    | AI-стенды (`ScriptedAI`/`EchoAI`/`FailingAI`) + Capability Registry + политики провайдеров                                         | 12, 13, 14  | F-7.1…F-7.5, F-9.6                                   |
| 1.8    | Turn Engine: `resolveTurn` + `commitTurn`, hooks `rulesStub`/`applyEffects`                                                        | 6, 8        | B-09, F-3.1, F-3.2                                   |
| 1.9    | Модули `chat`, `story`, `gm` (+`moveGroup`, локации), `gm-review`, `gm-audit`                                                      | 10, 15      | B-09, F-8.3…F-8.6, F-3.6, F-3.8, F-3.9               |
| 1.10   | HTTP-транспорт: auth (JWT+refresh+отзыв), маршруты, error mapper, rate-limit (token+IP), CORS                                      | 1, 7        | B-11, B-12, F-6.6                                    |
| 1.11   | WS-гейтвей: handshake+auth, heartbeat, ролевая маршрутизация, проекции и приватность, дедуп по `requestId`                         | 7, 9        | B-10, F-6.1, F-6.7…F-6.15                            |
| 1.12   | Клиент Svelte: WS-client (backoff, offline-queue), stores, UI игрока и GM                                                          | 8, 9, 10    | F-10.1, F-10.4…F-10.6                                |
| 1.13   | E2E «Стол», README, сквозной прогон A1.1–A1.16, CI, тест «нет приватного в broadcast»                                              | все         | F-11.2, F-11.3                                       |

---

## Общие правила (встроены в каждый промпт отдельным блоком)

1. **Монорепо, ESM, Node ≥ 22, TypeScript `strict`** (D101). Пакеты: `shared/contracts`, `core`, `modules/*`, `infrastructure/*`, `gateways/http`, `gateways/ws`, `client`, `tools`, `e2e`. `npm run dev` = `tsx watch apps/server/src/main.ts`.
2. **Источник истины — `@mnemosin/contracts`** (D112). Любой payload (HTTP body, WS-сообщение, доменное событие, конфиг, строка БД после маппинга) проходит Zod-парсинг. `any`/`unknown` на границе модуля запрещены; `unknown` допустим только внутри `z.unknown()` и сразу парсится.
3. **Не хватает данных или решения — остановись и спроси.** Не изобретай игровые механики, сюжет, локации и поля сверх схем этапа 1. Правила и события — заглушки (этап 2), не «упрощённая реализация от себя».
4. **Ошибки пересекают границы только как `ErrorCode` из Error Taxonomy** (`@mnemosin/contracts/errors`). Внутренние `CoreError`/`ProviderError` маппятся в gateways, наружу уходит `{ error: { code, message, meta, requestId } }`.
5. **Логи**: pino JSON, `traceId` в каждой записи (генерируется на входе HTTP/WS), redact-лист из config (`token`, `authorization`, `password`, `*.key`, `rawText` при `LOG_REDACT_PLAYER_TEXT=1`). Секреты не логируются никогда.
6. **Транзакции**: долгие операции (AI, media, сеть) — никогда внутри `db.transaction()`. Доменные события публикуются **после** COMMIT через `event_outbox`.
7. **Идемпотентность**: любая мутирующая команда принимает `idempotencyKey` от клиента; отсутствие → `VALIDATION`. Сервер не генерирует ключ «за клиента»; внутренние вызовы используют детерминированные ключи (`resolve:{turnId}` и т.п.).
8. **Проверка обязательна**: после написания кода — `npm run typecheck && npm run lint && npm test`, сервер должен стартовать, а заявленные в шапке критерии A1 — демонстрироваться на живом процессе (скриптом в `tools/verify/` или тестом). Промпт не завершён, пока проверка не прошла.
9. Любое принятое по ходу решение фиксируй в `docs/ARCHITECTURE.md` следующим номером **D113+**.

---

## Промпт 1.1 — Каркас монорепо (сервер должен запуститься)

```
Опираясь на ROADMAP.md §8 (D101–D112) и МНЕМОСИН v3 §VI.1, §VIII.4, §VIII.8, создай каркас проекта «МНЕМОСИН» в текущем каталоге. Цель промпта: `npm run dev` поднимает процесс, `GET /health` отвечает 200 (критерий A1.1).

1. npm workspaces. Пакеты (каждый — со своим package.json, tsconfig, `type: module`):
   shared/contracts, core, modules/session, modules/turn, modules/chat, modules/story,
   modules/gm, modules/gm-review, modules/gm-audit, modules/ai-director,
   infrastructure/database, infrastructure/ai, gateways/http, gateways/ws,
   apps/server, client, tools, e2e.
   В этом промпте создаются только каркасы пакетов (index.ts с экспортом-заглушкой) и реально наполняются: shared/contracts (пустой, заполняется в 1.2), infrastructure/config, apps/server, tools.
2. Корневой package.json: engines.node ">=22", scripts:
   dev = npm run dev -w apps/server
   build = tsc -b
   typecheck = tsc -b --noEmit
   lint = eslint . && prettier --check .
   test = vitest run
   test:watch = vitest
   test:arch = vitest run --project arch
   test:e2e = playwright test
   db:generate = drizzle-kit generate
   db:migrate = drizzle-kit migrate
   verify:stage1 = node tools/verify/stage1.mjs
   devDependencies: typescript, tsx, vitest, eslint, prettier, @types/node, dependency-cruiser, drizzle-kit, playwright.
   dependencies (в соответствующих пакетах): fastify, @fastify/websocket, @fastify/cors, @fastify/rate-limit, @fastify/static, zod, pino, pino-pretty, better-sqlite3, drizzle-orm, jose, nanoid. Версии — ^major, точные зафиксирует lockfile.
3. tsconfig.base.json: strict, noUncheckedIndexedAccess, exactOptionalPropertyTypes, verbatimModuleSyntax, module/moduleResolution NodeNext, target ES2023, изолированные declaration-файлы. tsconfig каждого пакета наследует base и объявляет project references только на разрешённые зависимости (core → shared/contracts; modules → core, shared; infrastructure → core, shared; gateways → modules, shared; client → shared). Это физическая гарантия правил зависимостей (критерий A1.2, детальнее в промпте 1.3).
4. .env.example (значения пустые, комментарии — что обязательно):
   NODE_ENV=development            # development | stage | production
   PORT=3000
   DATABASE_URL=file:./data/mnemosin.sqlite   # обязательно
   JWT_SECRET=                     # обязательно, >= 32 символов
   JWT_TTL_SECONDS=43200
   LOG_LEVEL=info
   LOG_REDACT_PLAYER_TEXT=1
   AI_PROVIDER=scripted            # scripted | echo | failing (этап 1); openrouter | lmstudio (этап 2)
   AI_SCRIPTED_FIXTURE=tools/fixtures/resolution.ok.json
   OPENROUTER_API_KEY=             # только этап 2
   LMSTUDIO_BASE_URL=              # только этап 2
   MEDIA_PROVIDER=debug            # debug (этап 1); comfyui (этап 2)
   HOSTBRIDGE_SECRET=              # обязательно для comfyui
   CONFIG_DIR=./config
   STATE_DIR=./data/state
5. config/: capabilities.yaml, provider-policies.yaml, limits.yaml — по образцу MNEMOSIN_v3_AUDIT.md §8.9 (значения лимитов: maxPlayersPerSession 12, wsRatePerConnection {ACTION_SUBMIT:5, CHAT_PUBLIC:10}, aiMaxConcurrentPerSession 1, mediaMaxConcurrentPerSession 2, sessionBudgetUsd 5, idempotencyTtlHours 24, outboxMaxAttempts 5, eventCascadeMaxDepth 3, chatRingBuffer 500, reconnect {baseMs 500, factor 2, capMs 15000, jitter 0.2, maxAttempts 8}, heartbeat {intervalMs 20000, idleTimeoutMs 45000}, wsAuthTimeoutMs 5000, dedupeTtlMs 300000). В этом промпте файлы создаются и валидируются, потребляются — в 1.7/1.11.
6. infrastructure/config/src/index.ts:
   - EnvSchema (Zod) + ConfigFilesSchema (Zod) — полный parse при старте;
   - loadConfig(): читает .env (dotenv), config/*.yaml (yaml), валидирует; при ошибке — process.exit(1) с сообщением вида `CONFIG_INVALID: JWT_SECRET must be at least 32 chars` БЕЗ вывода значений;
   - экспорт типизированного readonly-объекта config и x509-подобных геттеров не нужно — только plain object;
   - отдельный модуль redact.ts: REDACT_PATHS (список pino-redact путей) и maskSecrets(obj).
7. infrastructure/logging/src/logger.ts: pino-логгер (JSON в prod, pino-pretty в dev), уровни из config, обязательное поле traceId (через pino child-логгер), redact по REDACT_PATHS, helper withTrace(traceId). Плюс middleware-хелпер newTraceId() (crypto.randomUUID) для HTTP/WS.
8. apps/server/src/main.ts + app.ts:
   - buildApp(config): Fastify с плагинами requestId, cors (origin из config, в dev — localhost:5173), rate-limit (per token и per IP — заглушка конфигурации, реализуется в 1.10), static (client/dist в prod, media-файлы из STATE_DIR/media), errorHandler (маппинг ErrorCode → HTTP, заглушка до 1.10);
   - GET /health → { ok, version (из package.json), uptime, env, capabilities: {} (заполняется в 1.7), db: 'unknown' (заполняется в 1.4) };
   - GET /version → { version, gitTag (если доступен), contractsVersion (из shared/contracts) };
   - main.ts: loadConfig → logger → buildApp → listen(PORT) → graceful shutdown (SIGINT/SIGTERM: закрыть http, сбросить соединения, закрыть БД, логи 'shutdown_complete');
   - старт без DATABASE_URL или с коротким JWT_SECRET → немедленный выход с внятным сообщением (часть A1.1).
9. tools/verify/stage1.mjs — заготовка: поднимает сервер дочерним процессом на случайном порту, ждёт /health, печатает чек-лист критериев A1 с флагами (пока все, кроме A1.1, — 'not_implemented'), завершается с кодом 0 если A1.1 зелёный. Дальнейшие промпты добавляют сюда свои проверки.
10. .gitignore: node_modules, dist, .turbo, coverage, data/** (кроме data/.gitkeep), .env, *.sqlite*, playwright-report, test-results. .editorconfig, prettier и eslint конфиги (eslint — с правилом no-restricted-imports, заготовки границ добавит 1.3).
11. docs/ARCHITECTURE.md — создать и внести D101–D112 из ROADMAP §8 таблицей (вопрос / решение / следствие для кода) + раздел «Структура каталогов» с фактическим деревом из п.1 + раздел «Правила зависимостей» (contracts ← core ← modules ← infrastructure/gateways ← apps; client ← contracts).
12. Проверка: npm install, npm run typecheck, npm run lint, npm test (пустые наборы проходят), npm run dev → curl /health = 200 и содержит capabilities; запуск с пустым JWT_SECRET → падение с CONFIG_INVALID; node tools/verify/stage1.mjs → A1.1 PASS.

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode из Error Taxonomy; pino JSON с traceId и redact; долгие операции вне транзакций, события через outbox; идемпотентность обязательна для мутирующих команд; в конце прогони typecheck+lint+test и проверь, что сервер стартует; решения фиксируй в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.2 — `shared/contracts`: все схемы как единственный источник истины

```
Реализуй пакет shared/contracts (@mnemosin/contracts) — единственный источник истины о типах и сообщениях. Основание: МНЕМОСИН v3 Часть II, §III.4, §IV.4–IV.5, §V.1, §V.11, §VI.5–VI.9 и патчи MNEMOSIN_v3_AUDIT.md §8.1, §8.2, §8.3, §8.4, §8.8, §8.9. Закрывает блокеры B-01, B-02, B-03 и дефекты F-1.10…F-1.23, F-6.3, F-6.4, F-7.4. Цель: ни один последующий промпт не объявляет схемы у себя (критерий A1.3).

**Поправка от 2026-10-10 (D166):** схемы локаций, выходов, опасностей, событий и DSL дополняются поправками **K1–K16** из `docs/CONTENT_MAPPING.md` §3 — реальные данные мира v1 (получены заказчиком, `content/source-v1/`) богаче модели v3: 6 событий Шлюза из 8 не переносятся текущим DSL, 6 полей выходов теряются, для GM-only блока (`.gm.json`) в v3 нет поля. Добавить: триггеры OBJECT_INSPECTED / ATTEMPT_INTERACTION / COMPOUND_ACTION (K1–K3), `TELEPORT.playerIds` как optional (K4), шаблон ключа флага с точкой (K5), ExitSchema v2 с `kind/label/description/oneWay/hidden/via/lock{}` (K6), `LocationGmSecretSchema` (K7), `atmosphereParts` (K8), `HazardSchema` как discriminated union (K9), `EventAiGuidanceSchema` + увеличение `narrativeNotes` до 6000 (K10), три проекции локации Public/Ai/Gm (K11), `actors`/`items` как непрозрачные данные (K12), `DirectorContext.characterNames[]` + `namePolicy: WITHHELD|PARTIAL|ALL` (K13, D173 — имена в нарративе только после флага `remembered_name.<playerId>`), триггеры `OBJECT_CHANGED`/`OBJECT_UNLOCKED`/`ITEM_TAKEN` (K14), эффекты `REVEAL_OBJECT`/`GIVE_ITEM` (K15), `atmosphere.max = 1000` (D179), 4 новых ключа `EventAiGuidanceSchema` — `consequence`, `defaultVisibility`, `frequency`, `secretRole` (K10). `CONTRACTS_VERSION = '0.2.0'`.

1. src/ids.ts — branded ID: SessionId, PlayerId, CharacterId, TurnId, ActionId, EventId, LocationId, ObjectId, FlagId, MediaJobId, ConnectionId, IdempotencyKey (16..128). Реализация: z.string().uuid().brand<'X'>() БЕЗ .pipe() (F-1.13: branded-ключи и pipe ломаются на Zod 4). IdempotencyKey — z.string().min(16).max(128).brand(). Добавь хелперы isSessionId(v) и newId<'X'>() (crypto.randomUUID), а также IdMap-тип для remap (пригодится в этапе 2).
2. src/time.ts — IsoDateTime = z.string().datetime({ offset: false, precision: 3 }) и nowIso()/plusMs(). Все даты в документах используют только IsoDateTime (F-1.21).
3. src/errors.ts:
   - ErrorCode = z.enum([...]) — ОБЪЕДИНЁННЫЙ список: 8 CoreErrorCode из v3 §II.17 + 17 публичных кодов из §VI.9 + EVENT_EFFECT_CONFLICT + CAPABILITY_UNAVAILABLE + BUDGET_EXCEEDED + PROVIDER_BAD_GATEWAY + PROVIDER_BUDGET + HB_SIGNATURE_INVALID + HB_REPLAY_REJECTED + HB_HOST_UNKNOWN (закрывает F-6.4);
   - ErrorCategory = z.enum(['validation','conflict','provider','rules','auth','system']);
   - ERROR_TABLE: Record<ErrorCode, { category, http, wsType:'ERROR', clientAction }> — данные таблицы §VI.9 как код;
   - HttpErrorBody = z.object({ error: z.object({ code: ErrorCode, message: z.string().max(500), meta: z.record(z.string(), z.unknown()).optional(), requestId: z.string().optional() }) });
   - классы CoreError(code, message, meta), ProviderError(code, providerId, meta), ConflictError — все наследуют Error и несут ErrorCode.
4. src/domain/*.ts — доменные схемы (v3 Часть II) с исправлениями аудита:
   - session.ts: SessionStatus + SESSION_TRANSITIONS (таблица допустимых переходов LOBBY/ACTIVE/PAUSED/ENDED как Record<from, to[]>) + SessionSchema. УБРАТЬ currentLocationId из Session (F-1.16: единственный источник — worldState);
   - player.ts: PlayerStatus, PlayerSchema, CharacterSchema (characterId, sessionId, name, archetype, statsJson: z.record, createdAt) — закрывает F-1.9;
   - turn.ts: TurnStatus + TURN_TRANSITIONS (строго таблица v3 §II.5: OPEN→LOCKED, LOCKED→OPEN, LOCKED→PROCESSING, PROCESSING→REVIEW, PROCESSING→FAILED, REVIEW→COMMITTED, REVIEW→FAILED, OPEN→FAILED, плюс REVIEW→OPEN для retry — решение F-3.1) + TurnSchema БЕЗ actionIds (F-1.17: источник истины — actions.turnId) и с failed: {code: ErrorCode, message, meta} | null вместо failedReason (F-1.18);
   - action.ts: PlayerActionSchema (sequenceId назначается сервером), ActionIntent = z.enum(['SPEAK','ACT','MOVE','USE','OBSERVE','WAIT','CUSTOM']) — закрывает F-4.6; meta.intent использует этот enum;
   - state.ts: GameStateSchema, WorldStateSchema, StoryFlagSchema, ObjectStateSchema, PlayerKnowledgeSchema/KnowledgeEntrySchema, EndingStateSchema. ВАЖНО: storyFlags = z.record(FlagKey, StoryFlagSchema), где FlagKey = z.string().regex(/^[a-zA-Z0-9_:-]{1,80}$/) — ключом является key, а flagId остаётся полем (патч §8.2, закрывает B-03). playerKnowledge.entries — z.array(KnowledgeEntrySchema) вместо record (устраняет дублирование ключа, F-1.15);
   - location.ts: ExitSchema, LocationObjectSchema, LocationDefinitionSchema (+ templateSlug: z.string().nullable(), priority не нужен) и LocationTemplateSchema — slug-based вариант для world-pack этапа 2 (id-поля: z.string().regex(slug));
   - resolution.ts — ПОЛНОСТЬЮ по патчу аудита §8.1: ItemStatus, ProposedEventResolution, ProposedObjectChangeResolution, NarrativeSegment (с audience), Diagnostics (provider/model/attempts/usage/costUsd/durationMs/softRejects/warnings), TurnResolutionSchema (source, aiResponseHash, segments, privateMessages, proposedEvents, proposedObjectChanges, proposedWorldStatePatch, visualScene, diagnostics). Закрывает B-01;
   - gm.ts: GMNoteVisibility, GMNoteSchema, GMReviewDecisionSchema, GMAuditEntrySchema (auditId, sessionId, gmPlayerId, action, meta, traceId, idempotencyKey, at) — закрывает F-1.11 частично, F-8.5;
   - idempotency.ts: CommandName = z.enum(['resolveTurn','commitTurn','rejectTurn','lockTurn','unlockTurn','cancelTurn','openTurn','retryTurn','moveGroup','activateEvent','pauseSession','resumeSession','endSession','requestScene']) (закрывает B-08.2), IdempotencyRecordSchema со статусами IN_FLIGHT/DONE/FAILED + resultJson + resultHash + errorCode + traceId + expiresAt (патч §8.3);
   - journal.ts: JournalEntrySchema = { id, turnId, traceId, at, kind: z.enum([...]) , payload } с полным списком kind: processing_started, ai_call_started, ai_call_finished, ai_call_failed, rules_evaluated, draft_ready, gm_decision, commit_started, state_applied, effects_applied, committed, failed, snapshot_taken (закрывает F-1.10).
5. src/dsl/*.ts — DSL схемы (v3 §III.4) с патчем §8.8: TriggerSchema (5 видов), ConditionSchema (рекурсивный z.lazy, 11 операторов) и FirstTimeCondition ОБЯЗАТЕЛЬНО с entityId: z.string(); StatePathSchema — structured discriminated union по патчу §8.2 (WORLD|AMBIENT|FLAG|OBJECT|KNOWLEDGE) + функции serializePath()/parsePath() с обратимостью (тест round-trip обязателен) + конвенция ключей в JSDoc; EffectSchema (7 видов) + новый Effect USE_OBJECT (objectId) — нужен, чтобы GM/движок могли порождать триггер OBJECT_USED (закрывает F-4.4); WorldEventSchema с priority, conditions: z.array(...), cascadeDepth, templateSlug, sessionId: nullable; RuleCheckSchema с subject: RuleSubjectSchema = z.discriminatedUnion('kind',[{kind:'ACTION', actionRef},{kind:'OBJECT_CHANGE',objectId},{kind:'EVENT_TRIGGER',eventId},{kind:'STATE_CHANGE',path}]) (закрывает F-4.3); RuleResultSchema; RulesBundleSchema.
6. src/events/*.ts — каталог доменных событий КАК КОД (закрывает F-2.1, F-2.8, F-2.9):
   - payloads.ts: по Zod-схеме на каждое событие из v3 §II.16 + CHAT_MESSAGE_PUBLIC/PRIVATE/SYSTEM/GM + GM_REVIEW_DECIDED + SESSION_ENDED + PLAYER_DISCONNECTED + MEDIA_JOB_QUEUED + BUDGET_WARNING; в каждый payload добавить sessionId (F-2.9);
   - index.ts: DomainEventSchema = z.discriminatedUnion('type', [...]) и типы DomainEvent, DomainEventType; EventName union;
   - subscribers.ts: EVENT_SUBSCRIBERS: Record<EventName, readonly ModuleId[]> — данные таблицы §II.16, но subscriber'ами могут быть ТОЛЬКО moduleId (адаптеры исключены, закрывает F-2.2); emitters — тоже только moduleId (F-2.4).
7. src/transport/*.ts — HTTP и WS как код (закрывает F-6.3):
   - views.ts: PublicGameStateView, PlayerGameStateView (с own knowledge), GMStateView, SessionView, TurnView, MediaJobView, ChatMessageView, PublicLocationView, DirectorContextView (= DirectorContextSchema из v3 §IV.4, но objectStates типизированы, без z.any());
   - audience.ts: AudienceSchema = z.discriminatedUnion('kind',[{kind:'ALL'},{kind:'GM'},{kind:'PLAYER',playerId},{kind:'PLAYERS',playerIds}]) — основа матрицы приватности (патч §8.4);
   - ws.ts: WSClientMessage и WSServerMessage — z.discriminatedUnion('type', ...) по каталогу v3 §VI.6/§VI.7 + дополнения аудита §8.5 — полный перечень строго по docs/SPEC_STAGE1.md §6.2 (27 типов c→s) и §6.3 (21 тип s→c). КАЖДОЕ server-сообщение снабжено полем audience-политикой через WS_PRIVACY_POLICY: Record<ServerMessageType, 'BROADCAST'|'GM_ONLY'|'TARGETED'|'SENDER_ONLY'> (патч §8.4);
   - http.ts: по схеме на каждый request/response всех маршрутов v3 §VI.2–VI.4 + дополнения §8.5 (auth/refresh, sessions/:id/{end,pause,resume,move}, sessions/:id/turns, turns/:id/{unlock,cancel,retry,edit-approve}, sessions/:id/me, gm/audit, media/jobs/:id/cancel). Для каждого маршрута — объект RouteContract { method, path, auth:'none'|'player'|'gm'|'internal', request, response, errors: ErrorCode[] } и массив HTTP_ROUTES (закрывает F-6.2, B-11, B-12).
8. src/ai.ts и src/media.ts: DirectorContextSchema (v3 §IV.4, с типизированными objectStates), AIResponseSchema (v3 §IV.5) + ProposedEventSchema/ProposedObjectChangeSchema/VisualSceneDescriptionSchema, AIUsageSchema {inputTokens, outputTokens, model}, AIGenerationResultSchema {response, usage, durationMs, providerId}; MediaJobSchema {mediaJobId, sessionId, turnId, status: QUEUED|SUBMITTED|READY|FAILED|CANCELLED, providerId, externalJobId, prompt, promptHash, workflow, seed, url, errorCode, attempts, queuedAt, startedAt, finishedAt} (закрывает F-1.11); MediaJobView.
9. src/capability.ts: CapabilitySchema = z.enum(['TEXT_AI','VISUAL_PROMPT','IMAGE_GENERATION','IMAGE_EDITING','AUDIO_GENERATION','VIDEO']) (F-7.4), CapabilityAvailabilitySchema, ProviderPolicySchema (v3 §V.11 + costPer1kTokens: {input: number|null, output: number|null}), CapabilitiesConfigSchema и LimitsConfigSchema по образцу аудита §8.9, ModuleIdSchema = z.enum([...9 модулей этапа 1...]) (F-8.3).
10. src/module.ts — ModuleContract как GENERIC (закрывает F-8.1, F-8.2):
    export interface ModuleContract<TCmd extends ZodCommandMap, TQ extends ZodQueryMap> {
      moduleId: ModuleId; purpose: string; version: string;
      commands: TCmd; queries: TQ;                       // Zod-схемы входа и выхода
      idempotentCommands: readonly string[];             // команды, требующие idempotencyKey
      emits: readonly EventName[]; subscribes: readonly EventName[];
      ports: readonly string[]; dependencies: readonly ModuleId[]; capabilities: readonly Capability[];
    }
    + defineModule() helper, который валидирует контракт (emits/subscribes ⊆ DomainEventSchema, dependencies ⊆ ModuleId).
11. src/index.ts — единый экспорт + CONTRACTS_VERSION (semver, читается /version).
12. Тесты (vitest, проект 'contract'):
    - round-trip каждой схемы: валидные фикстуры из tools/fixtures/contracts/*.json парсятся и сериализуются без потерь;
    - негативные фикстуры: невалидные значения отклоняются (минимум по 2 на каждую схему: лишнее поле, неверный тип);
    - serializePath/parsePath round-trip на 10 путях всех 5 видов;
    - TURN_TRANSITIONS и SESSION_TRANSITIONS совпадают с таблицами v3 §II.5 (snapshot-тест таблицы);
    - WS_PRIVACY_POLICY покрывает ВСЕ типы WSServerMessage (тест «нет сообщения без политики»);
    - HTTP_ROUTES: каждый маршрут имеет request/response-схему и непустой errors[].
13. Проверка: npm run typecheck && npm test -- --project contract; grep-контроль, что в пакете нет `any` (eslint no-explicit-any = error); grep «z.unknown()» — только внутри envelope-обёрток с последующим парсингом (задокументировать комментарием).

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай (в частности не добавляй поля и события сверх перечисленных); ошибки — только ErrorCode; pino+traceId+redact; долгие операции вне транзакций, события через outbox; идемпотентность обязательна; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.3 — Границы: architecture-тесты

```
Реализуй автоматический контроль архитектурных границ (критерии A1.2, A1.14). Основание: v3 §I.3 (инварианты 1–5, 14–15), §I.4 (антипаттерны), §IX.6; аудит F-10.3, F-8.1.

1. .dependency-cruiser.cjs с правилами (каждое — error, не warning):
   - core-no-infra: core/** НЕ импортирует infrastructure/**, gateways/**, modules/**, client/**, apps/**;
   - core-no-vendors: core/** НЕ импортирует fastify, @fastify/*, drizzle-orm, better-sqlite3, pino, jose, openai, любые провайдерские SDK (разрешены: zod, @mnemosin/contracts);
   - contracts-leaf: shared/contracts/** не импортирует ничего кроме zod и node:crypto;
   - modules-no-db: modules/** НЕ импортирует infrastructure/database/** и drizzle-orm (доступ к данным — только через порты core);
   - modules-no-media-state: modules/media-director/** (появится в этапе 2) НЕ импортирует StateRepository;
   - client-contracts-only: client/** импортирует только @mnemosin/contracts из рабочих пакетов (НЕ core, НЕ modules);
   - adapters-no-core: infrastructure/** НЕ импортирует core/** кроме core/domain/ports (порты) — адаптер знает интерфейс, не ядро;
   - no-circular: циклические зависимости запрещены во всех пакетах.
2. eslint: плагин no-restricted-imports с теми же границами (чтобы нарушение ловилось до деплоя, в редакторе), plus @typescript-eslint/no-explicit-any = error для core/, modules/, shared/, gateways/.
3. tests/arch/*.test.ts (vitest project 'arch'):
   - проверка fs: в core/ нет файлов, импортирующих запрещённые пакеты (дублирует cruiser на случай обхода конфигов);
   - проверка, что каждый модуль в modules/*/src/contract.ts экспортирует объект, валидный относительно defineModule() из @mnemosin/contracts (появятся в 1.9; тест умеет пропускать отсутствующие);
   - «proof of extensibility» (A1.14): тест создаёт временный файл infrastructure/ai/src/failing-provider.ts, импортирующий только core/domain/ports и contracts, регистрирует его и asserts, что ни один файл core/ не изменился (сверка git-индекса/хэшей);
   - проверка, что gateways/ не содержит доменной логики: в gateways/** запрещены импорты core/domain/services (только core/application-команды и contracts) — инвариант 14.
4. npm run test:arch → отдельная команда; подключить в CI-скрипт (появится в 1.13).
5. Проверка: намеренно добавь в core/src/tmp-violation.ts импорт 'fastify' → npm run test:arch и npm run lint падают с внятным сообщением; удали файл — снова зелёные. Результат покажи в выводе.

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact; долгие операции вне транзакций, события через outbox; идемпотентность обязательна; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.4 — Персистентность: Drizzle, репозитории, идемпотентность, optimistic lock

```
Реализуй infrastructure/database (критерии A1.4, A1.5, A1.11). Основание: v3 §II.18, §III.2, §III.11–III.13; патчи аудита §8.3 и §8.6; дефекты B-05, B-08, F-5.1…F-5.10.

1. src/schema.ts — ПОЛНАЯ Drizzle-схема этапа 1 (все FK через .references(), все индексы явно; синтаксис третьего аргумента — массив, а не объект, F-5.8):
   sessions, players, characters, player_extensions(player_id, module_id, data_json, PK(player_id,module_id)),
   locations(location_id PK, session_id NULL FK, template_slug, name, description, atmosphere, objects_json, exits_json, hazards_json, registered_event_ids_json, narrative_notes, tags_json),
   world_events(…) — создать таблицу сейчас, но не наполнять (этап 2),
   turns(без action_ids, F-1.17), actions(idx turn_id+sequence_id UNIQUE), game_state(session_id PK, version, state_json, updated_at),
   turn_journal(id AUTOINC, turn_id, trace_id, entry_json, created_at, idx turn_id),
   idempotency_records — ровно по патчу §8.3 (key PK, turn_id NULL, command, status CHECK, result_json, result_hash, error_code, trace_id, created_at, expires_at; idx turn_id, idx expires_at),
   event_outbox(id AUTOINC, event_name, payload, trace_id, emitted_at, published_at NULL, attempts INT DEFAULT 0, last_error NULL),
   chat_messages(message_id PK, session_id FK, turn_id NULL, from_player_id NULL, to_player_id NULL, visibility, text, created_at, idx(session_id, created_at), idx(session_id, visibility)),
   gm_notes, gm_audit, snapshots(session_id, turn_id, version, state_json, created_at, PK(session_id, version)) — таблица создаётся, пишется в этапе 3,
   media_jobs, media_cache — создаются сейчас, используются в этапе 2,
   deferred_effects, first_seen — создаются сейчас, используются в этапе 2,
   rules_bundles — создаётся сейчас, используется в этапе 2.
2. src/client.ts: better-sqlite3 + drizzle; PRAGMA journal_mode=WAL, foreign_keys=ON, busy_timeout=5000, synchronous=NORMAL; проверка PRAGMA при старте (лог с фактическими значениями); healthcheck-запрос для /health.db.
3. Миграции: drizzle-kit generate → infrastructure/database/migrations/NNNN_*.sql; для каждой — соседний down.sql (F-5.2: compensating migration, forward-only в проде, down — только для dev); скрипты npm run db:generate / db:migrate / db:rollback (последний применяет down.sql последней миграции вручную, с подтверждением).
4. src/tx.ts — UnitOfWork: интерфейс TxToken (brand), runInTx(cb) через db.transaction (BEGIN IMMEDIATE), вложенные вызовы — join в существующую транзакцию; порт UnitOfWork объявить в core/domain/ports/unit-of-work.ts (core не знает про Drizzle, F-5.3).
5. core/domain/ports/*.ts — порты (интерфейсы, без реализации): SessionRepository, PlayerRepository, CharacterRepository, TurnRepository, ActionRepository, StateRepository, LocationRepository, ChatRepository, GMNoteRepository, GMAuditRepository, JournalRepository, IdempotencyRepository, OutboxRepository, SnapshotRepository (заготовки media/event/rules-репозиториев — этап 2). Каждый метод — с явными типами из contracts, save() принимает опциональный TxToken.
6. src/repositories/*.ts — реализации всех портов + src/mappers/*.ts (row ↔ domain, весь Zod-парсинг на границе; mapper бросает VALIDATION при битой строке БД).
7. Идемпотентность (src/idempotency.ts) — АТОМАРНО по патчу §8.3:
   tryAcquire({key, command, turnId?, ttlMs, traceId}, tx) → 'proceed' | {cached, resultJson} | 'in_flight' | {failed_before, errorCode};
   реализация через INSERT … ON CONFLICT(key) DO NOTHING + проверка changes() внутри той же транзакции;
   finish(key, {status:'DONE', resultJson, resultHash}, tx) и fail(key, errorCode, tx);
   withIdempotency(key, command, fn) — обёртка: acquire → fn → finish/fail; при 'cached' возвращает результат из result_json; при 'in_flight' бросает ConflictError('IDEMPOTENCY_IN_FLIGHT');
   cleanupExpired() — удаление записей с expires_at < now (джоб запускается в 1.5).
   ТЕСТ ОБЯЗАТЕЛЕН: 50 параллельных вызовов с одним ключом → ровно один 'proceed' (A1.4).
8. Optimistic lock (src/repositories/state.ts): save(state, expectedVersion, tx) → UPDATE game_state SET version=version+1, state_json=?, updated_at=? WHERE session_id=? AND version=?; changes()===0 → CoreError('CORE_VERSION_CONFLICT'). ТЕСТ: две параллельные записи → одна VERSION_CONFLICT (A1.5).
9. src/bootstrap.ts: migrate() + seed-хелпер createDevSession() (создаёт сессию, GM-игрока, 2 локации Reception/Corridor из fixtures — данные берёт из tools/fixtures/locations.stage1.json, ничего не выдумывает; D110).
10. Интеграционные тесты (vitest project 'integration', временная БД в tmp):
    - миграции применяются на пустой БД и накатываются повторно идемпотентно;
    - FK реально работают: вставка action с несуществующим turn_id → ошибка (проверить, что PRAGMA foreign_keys=ON);
    - гонка идемпотентности (п.7); optimistic lock (п.8);
    - crash-симуляция: запись journal + state в транзакции, обрыв процесса (отдельный child process, убитый SIGKILL посередине) → после перезапуска состояние консистентно, незакоммиченная транзакция откатилась (A1.11);
    - mapper round-trip для всех сущностей.
11. /health получает db:'ok' и schemaVersion (число применённых миграций).
12. Проверка: npm run db:migrate на свежей БД, npm test -- --project integration, node tools/verify/stage1.mjs → A1.4, A1.5 PASS (добавить проверки в verify-скрипт: HTTP-вызовы появятся в 1.10, поэтому здесь проверка идёт прямым вызовом сервисов из теста).

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact; долгие операции вне транзакций, события через outbox; идемпотентность обязательна; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.5 — Event bus, outbox publisher, журнал хода

```
Реализуй доменную шину событий и outbox-публикатор (критерий A1.11, закрывает F-2.5, F-2.8, F-2.9). Основание: v3 §III.3, §II.16; аудит §8.6.

1. core/events/bus.ts — in-process EventBus:
   subscribe(eventName | '*', handler) → unsubscribe; publish(event: DomainEvent) — ДО публикации event.parse() через DomainEventSchema (инвариант 16);
   обработчики вызываются последовательно в порядке регистрации, исключение в одном НЕ ломает остальные и логируется как error с traceId и именем события;
   publishMany(events[]) — сохраняет порядок; поддержка async-handler'ов с таймаутом handlerTimeoutMs (из config, default 5000) — по таймауту log error и продолжение;
   метрики-хуки (счётчики published/failed/duration) — через интерфейс MetricsSink (заглушка в этапе 1, prom в этапе 3).
2. core/events/outbox.ts:
   appendOutbox(events, tx) — запись в event_outbox ВНУТРЕННЕЙ транзакции вместе с доменной мутацией;
   publisher-цикл (infrastructure/database/outbox-publisher.ts): BEGIN IMMEDIATE → SELECT до outboxBatchSize (100) записей с published_at IS NULL ORDER BY id → обработать → UPDATE published_at/attempts. БЕЗ `FOR UPDATE` (F-2.5: в SQLite его нет);
   попытки: при ошибке attempts+1, last_error; attempts > outboxMaxAttempts (5) → запись помечается published_at=NULL, status='DEAD' (добавить колонку status: PENDING|PUBLISHED|DEAD), лог error + событие в MetricsSink (алерт в этапе 3);
   интервал опроса outboxPollMs (default 250) + принудительный drain() при graceful shutdown;
   гарантия: at-least-once, порядок по id (глобальный). Обработчики обязаны быть идемпотентны — это требование зафиксировать в JSDoc и в ARCHITECTURE.md (D113).
3. core/turns/journal.ts — JournalService: append(turnId, kind, payload, traceId, tx) → turn_journal; list(turnId) → JournalEntry[] (парсинг через JournalEntrySchema); tail(sessionId, limit).
4. Фоновые джобы (infrastructure/jobs/scheduler.ts): простой интервальный планировщик (без внешних зависимостей) с регистрами: cleanupIdempotency (каждый час), outboxPublisher (каждые outboxPollMs), presenceSweep (каждые 10 с, пригодится в 1.11). Каждый джоб — с try/catch, метрикой длительности и логом; graceful shutdown останавливает планировщик.
5. Тесты (integration):
   - событие, добавленное в outbox внутри транзакции, которая ОТКАТИЛАСЬ, не публикуется;
   - событие из закоммиченной транзакции публикуется ровно один раз при одном работающем публикаторе;
   - при падении обработчика attempts растёт, после 5 попыток запись DEAD, остальные события продолжают публиковаться;
   - порядок публикации совпадает с порядком id;
   - publish() с невалидным payload бросает ошибку и НЕ публикует (инвариант 16);
   - journal: append + list round-trip, traceId сохраняется.
6. Проверка: npm test -- --project integration; в tools/verify/stage1.mjs добавить пункт «outbox: 1 событие → опубликовано, published_at заполнен».

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact; долгие операции вне транзакций, события через outbox; идемпотентность обязательна; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.6 — Core: машина состояний Turn и сессии

```
Реализуй доменные сервисы core (критерий A1.6, закрывает B-07, F-3.5). Основание: v3 §II.5, §III.1 (шаги 1–6), §IV.12; аудит §8.5.

1. core/domain/transition.ts — универсальная проверка перехода: assertTransition(entity:'turn'|'session', from, to) по таблицам TURN_TRANSITIONS / SESSION_TRANSITIONS из contracts; нарушение → CoreError('CORE_INVALID_STATE_TRANSITION', meta:{from,to,entity}).
2. core/turns/turn-service.ts — команды (все мутирующие принимают idempotencyKey и оборачиваются в withIdempotency из 1.4; все пишут journal и appendOutbox в одной транзакции):
   - openTurn({sessionId, idempotencyKey}) → создаёт Turn со status OPEN, number = nextNumber(sessionId), обновляет session.currentTurnId, эмитит TURN_OPENED; повторный вызов при уже открытом OPEN-ходе → CoreError('CORE_INVALID_STATE_TRANSITION') (ход один на сессию);
   - lockTurn({turnId, idempotencyKey}) — только GM (проверка роли на уровне transport, здесь — проверка статуса); OPEN→LOCKED, собирает actionIds из actions по turnId (источник истины — таблица actions, F-1.17), эмитит TURN_LOCKED{turnId, sessionId, actionIds};
   - unlockTurn({turnId, idempotencyKey}) — LOCKED→OPEN, эмитит TURN_LOCKED отменяющее событие TURN_UNLOCKED? — НЕТ: добавить в contracts событие TURN_UNLOCKED{turnId, sessionId} (решение зафиксировать как D114) и эмитить его;
   - cancelTurn({turnId, reason, idempotencyKey}) — OPEN→FAILED, failed:{code:'CORE_INVALID_STATE_TRANSITION'|…}, эмитит TURN_FAILED;
   - submitAction({turnId, playerId, rawText, meta, idempotencyKey}) — только в OPEN; назначает sequenceId = max(sequence_id)+1 ВНУТРИ транзакции (UNIQUE(turn_id, sequence_id) из 1.4 страхует от гонки); повтор того же idempotencyKey → возвращает прежний actionId (DUPLICATE); эмитит ACTION_SUBMITTED; лимит действий на игрока на ход: limits.actionsPerPlayerPerTurn (default 5, добавить в limits.yaml) → RATE_LIMIT;
   - getTurn/getTurnView/listTurns(sessionId).
3. core/session/session-service.ts — createSession({title, gmDisplayName}), joinSession({sessionId, displayName, characterId?}) с проверками: статус LOBBY, playerIds.length < maxPlayersPerSession (12), displayName уникален в сессии; startSession (LOBBY→ACTIVE, требует ≥1 игрока и наличия GM; открывает ход №1 через openTurn), pauseSession (ACTIVE→PAUSED), resumeSession (PAUSED→ACTIVE), endSession (любой→ENDED, эмитит SESSION_ENDED); removePlayer (GM) и leaveSession (сам игрок) → статус LEFT + событие PLAYER_LEFT{reason}.
   Также: character-сервис createCharacter({sessionId, name, archetype}) (в этапе 1 — минимально, stats пустые).
4. core/state/state-service.ts — единственный путь мутации GameState для всех модулей (инвариант 13, 7–8): get(sessionId), apply(sessionId, mutations[], {expectedVersion, turnId, traceId, tx}) → применяет мутации (SET_FLAG, OBJECT_PATCH, WORLD_PATCH, GRANT_KNOWLEDGE, TELEPORT, REACH_ENDING — как функции, а не через DSL этапа 2), version+1, пишет journal 'state_applied', возвращает новую версию и changedKeys; эмитит STATE_COMMITTED{sessionId, version, changedKeys}. Доступ к этому сервису имеют ТОЛЬКО core-команды (turn commit, moveGroup) — зафиксировать экспортом только через core/index.ts и проверить architecture-тестом.
5. core/locations/location-service.ts — loadPackToSession (в этапе 1 читает tools/fixtures/locations.stage1.json с УЖЕ валидными UUID: сгенерируй их скриптом tools/gen-location-fixtures.mjs из slug-шаблонов Reception/Corridor, сохранив remap в fixtures/remap.stage1.json), get(locationId), list(sessionId), exitsOf(locationId), moveGroup({sessionId, playerIds, toLocationId, idempotencyKey, turnId?}) с проверками: exit существует и не locked (иначе RULE_REJECTED), все playerIds принадлежат сессии; обновляет worldState.currentLocationId через state-service; эмитит LOCATION_CHANGED{sessionId, fromLocationId, toLocationId, playerIds}. Идемпотентность — детерминированный ключ move:{sessionId}:{turnId ?? 'naive'}:{sha1(sorted playerIds)}:{toLocationId} (F-3.6: алгоритм хэша — sha1 от JSON отсортированного массива, зафиксировать в JSDoc).
6. Тесты (unit + integration): полный обход машины состояний Turn (все 8 разрешённых переходов + по одному запрещённому на каждый статус); nextNumber монотонно при параллельных openTurn; sequenceId монотонно при 20 параллельных submitAction (ровно 20 уникальных значений); moveGroup идемпотентен (повтор с тем же ключом не меняет version дважды); лимит действий работает; endSession закрывает сессию и не даёт join.
7. Проверка: npm test; node tools/verify/stage1.mjs → A1.6 PASS (проверка через сервисный слой, HTTP появится в 1.10).

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact; долгие операции вне транзакций, события через outbox; идемпотентность обязательна; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.7 — AI-стенды и Capability Registry

```
Реализуй порт AIPort, три офлайн-стенда и Capability Registry (критерии A1.12, A1.13, A1.14; закрывает F-7.1…F-7.5, F-9.6). Основание: v3 §V.1, §V.11, §IV.2; аудит §8.9, §8.10. Аналог tools/mock_gemini.js из v1 — но на уровне порта, а не HTTP.

1. core/domain/ports/ai-port.ts — ровно по патчу аудита §8.10:
   interface AIPort { providerId; capability:'TEXT_AI'; isAvailable(): Promise<boolean>;
     generate(input:{context: DirectorContext; schema: z.ZodType<AIResponse>; deadline:{timeoutMs, attempt}; signal?: AbortSignal})
       : Promise<{response: AIResponse; usage: {inputTokens, outputTokens, model} | null; durationMs: number}> }
   + class ProviderError(code: ProviderErrorCode, providerId, meta).
2. infrastructure/ai/scripted-provider.ts (ScriptedAI): читает фикстуру AI_SCRIPTED_FIXTURE (по умолчанию tools/fixtures/resolution.ok.json — создай её: валидный AIResponse с narrative на русском, 6 privateMessages, 1 proposedEvent (eventId — из remap.stage1.json, иначе proposedEvents пуст), 1 proposedObjectChange, visualSceneDescription). Подставляет в narrative число действий из context (чтобы видно было связь со входом). usage — детерминированные псевдозначения (inputTokens = длина JSON контекста / 4). НИКАКИХ внешних вызовов и чтения состояния партии сверх context.
3. infrastructure/ai/echo-provider.ts (EchoAI): собирает narrative из rawText действий игроков в порядке sequenceId (шаблон «Вы делаете: …»), privateMessages — пустые, proposedEvents/Changes — пустые. Нужен как второй провайдер для проверки fallback-цепочки.
4. infrastructure/ai/failing-provider.ts (FailingAI): режимы через env AI_FAILING_MODE = timeout | schema | rate_limit | unavailable; timeout — ждёт deadline.timeoutMs+1s и бросает ProviderError('PROVIDER_TIMEOUT'); schema — возвращает заведомо невалидный JSON (проверяется схемой в ai-director); isAvailable() → false при unavailable.
5. infrastructure/ai/registry.ts — CapabilityRegistry (v3 §V.11) + патч аудита:
   register({capability, providerId, provider}) с Zod-валидацией записи (не unknown, F-7.5); unregister(providerId);
   resolve(capability) → упорядоченная цепочка из config/capabilities.yaml, отфильтрованная по isAvailable() и состоянию breaker'а;
   isAvailable(capability) → resolve().length > 0;
   healthProbe: по расписанию capabilityProbeMs (default 30000) вызывает isAvailable() у зарегистрированных провайдеров и при изменении доступности эмитит CAPABILITY_CHANGED{capability, available, providers[]} (через bus из 1.5);
   circuit breaker на провайдера по ProviderPolicySchema: failureThreshold (3) → OPEN на cooldownMs (60000), в OPEN resolve() пропускает провайдера; half-open после cooldown — одна пробная попытка;
   retry/backoff: withPolicy(providerId, fn) — max retries, backoffMs, jitter; таймаут из policy (НЕ из аргументов порта — источник истины один, F-7.2);
   getPolicy(providerId), snapshot() для /health и CAPABILITY_CHANGED.
6. modules/ai-director/src/contract.ts — ModuleContract (defineModule) с commands.generateDraft({turnId}) и queries.getDraft({turnId}); subscribes: ['GM_NOTE_ADDED'] (НЕ TURN_LOCKED — решение B-09: вызов только командой из Turn Engine; зафиксировать как D115); emits: ['AI_DRAFT_PROPOSED','AI_GENERATION_FAILED']; ports:['AIPort']; capabilities:['TEXT_AI'].
7. modules/ai-director/src/generate-draft.ts — реализация:
   buildDirectorContext(turnId) (в этапе 1 — упрощённая сборка: currentLocation (PublicLocationView), visiblePlayerActions, relevantState (worldState, activeFlags, objectStates), allowedEventIds (из locations.registeredEventIds), storyFacts (из playerKnowledge/флагов), gmNotesForAI (visibility='AI_DIRECTOR'), directorInstructions из config); контекст проходит DirectorContextSchema.parse;
   вызов registry.resolve('TEXT_AI') → первый доступный провайдер → port.generate(...) → AIResponseSchema.parse; при ProviderError('PROVIDER_SCHEMA') — одна попытка repair (повторный вызов с добавлением в context.directorInstructions строки о нарушении схемы и текстом ошибки); при исчерпании цепочки — AI_GENERATION_FAILED{turnId, errorCode, provider} и throw CoreError('PROVIDER_UNAVAILABLE');
   результат — TurnResolution{source:'AI', aiResponseHash: sha256(JSON), статусы всех item'ов 'PROPOSED', diagnostics{providerId, model, attempts, usage, costUsd: null (этап 2), durationMs}};
   метрики-хуки: ai.duration_ms, ai.schema_errors_total (через MetricsSink).
8. tools/verify/switch-provider.mjs — сценарий A1.12/A1.14: при AI_PROVIDER=scripted ход доходит до REVIEW с нарративом из фикстуры; при echo — нарратив содержит текст действий; при failing(timeout) — TURN_FAILED{PROVIDER_TIMEOUT}, затем breaker OPEN и CAPABILITY_CHANGED{TEXT_AI,false}; переключение происходит ТОЛЬКО через env/config, git-статус файлов core/ и modules/ не изменился (assert).
9. Тесты: contract-тест «любой AIPort-провайдер» (набор общих тестов, прогоняется для всех трёх стендов — это же шаблон для OpenRouter в этапе 2); breaker-логика (порог, cooldown, half-open); fallback scripted→echo при unavailable у scripted; repair при schema-ошибке вызывается ровно один раз.
10. /health: capabilities = registry.snapshot() (A1.13).
11. Проверка: npm test; AI_PROVIDER=scripted npm run dev → /health показывает TEXT_AI available (scripted); AI_PROVIDER=failing → после 3 провалов CAPABILITY_CHANGED и breaker OPEN в health; node tools/verify/switch-provider.mjs → A1.12, A1.13, A1.14 PASS.

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact (ключи провайдеров не логируются); долгие операции вне транзакций, события через outbox; идемпотентность обязательна; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.8 — Turn Engine: resolveTurn и commitTurn

```
Реализуй Turn Engine (критерии A1.6, A1.8; закрывает B-09, F-3.1, F-3.2). Основание: v3 §III.1, §III.2, §III.3, §II.15; аудит §8.1.

1. modules/turn/src/contract.ts — moduleId 'turn': commands resolveTurn, commitTurn, rejectTurn, retryTurn, editAndApprove? (нет — editAndApprove владеет gm-review, см. п.6); queries getTurn, listTurns, getJournal; emits: TURN_OPENED, TURN_LOCKED, TURN_UNLOCKED, TURN_PROCESSING_STARTED, TURN_DRAFT_READY, TURN_COMMITTED, TURN_FAILED, STATE_COMMITTED; ports: ['AIPort'(через ai-director), 'RulesPort']; dependencies: ['ai-director'].
2. modules/turn/src/resolve-turn.ts — строго 14 шагов v3 §III.1, с поправками аудита:
   1) загрузка turn/session/actions/state; 2) проверка status===LOCKED (иначе CORE_INVALID_STATE_TRANSITION);
   3) идемпотентность: withIdempotency(`resolve:{turnId}`, 'resolveTurn', …) — детерминированный серверный ключ, а НЕ случайный uuid (B-08);
   4) переход → PROCESSING (assertTransition), journal 'processing_started', outbox TURN_PROCESSING_STARTED — одной транзакцией;
   5) ПОСЛЕ commit транзакции — вызов ai-director.generateDraft({turnId}) (командой, не событием — D115);
   6) RulesPort.evaluate(subject, ctx) — в этапе 1 rulesStub возвращает [{outcome:'PASS'}] для всех subject (интерфейс полный, реализация в этапе 2; зафиксировать заглушку в ARCHITECTURE.md как D116);
   7) любой REJECT → transition FAILED + TURN_FAILED{errorCode:'CORE_RULE_REJECTED'} + journal 'failed'; SOFT_REJECT/WARN → в resolution.diagnostics.softRejects/warnings и поле requiresGM=true (ход всё равно уходит в REVIEW);
   8) сохранение TurnResolution (turns.resolution_json) + transition → REVIEW + reviewReadyAt + journal 'draft_ready' + outbox TURN_DRAFT_READY + AI_DRAFT_PROPOSED — одной транзакцией;
   9) при ProviderError/AI_GENERATION_FAILED → transition FAILED, journal 'ai_call_failed', TURN_FAILED{errorCode}, GM может retryTurn;
   10) метрика turn.duration_ms, ai.duration_ms.
   ВАЖНО: resolveTurn НЕ применяет состояние и НЕ коммитит (v3 §III.1).
3. modules/turn/src/commit-turn.ts:
   withIdempotency(key, 'commitTurn', …): проверка status===REVIEW; expectedVersion = GameState.version из черновика (сохранить в resolution.baseVersion при draftReady) → при расхождении VERSION_CONFLICT;
   одной транзакцией: applyResolution (п.4) → state-service.apply(expectedVersion) → turn → COMMITTED + committedAt → journal 'committed' → outbox TURN_COMMITTED{turnId, sessionId, version} + STATE_COMMITTED + (WORLD_EVENT_FIRED в этапе 2) → finish idempotency с resultJson {version, turnId};
   возврат клиенту — {version} (из resultJson при повторе, B-08.4);
   повторный commit с тем же ключом → тот же {version}, без второй записи в journal (тест A1.4);
   после commit: автоматически openTurn следующего номера? — НЕТ: следующий ход открывает GM командой openTurn (решение D117, фиксирует A1.6).
4. modules/turn/src/apply-resolution.ts — применение TurnResolution к GameState (только item'ы со статусом APPROVED/EDITED):
   - segments (audience ALL/GM) → chat-модуль sendSystemMessage (в 1.9); приватные сегменты → TURN_PRIVATE_RESOLUTION (через chat);
   - privateMessages → chat.sendPrivateMessage от имени системы (от GM/Director);
   - proposedObjectChanges → objectStates patch ТОЛЬКО по ключам из allowlist'а: config limits.aiMutableObjectKeys (default ['*'] в этапе 1, сужается в этапе 2 — F-9.4/F-4.8);
   - proposedEvents → в этапе 1 применяется только список эффектов, прошедший rulesStub; DSL-движок появится в 2.1 (hook applyEffects(effects[], ctx) — сейчас passthrough в state-service);
   - proposedWorldStatePatch → worldState;
   - visualScene → событие-заявка для media (в этапе 1 — только journal, media-модуля нет);
   - REACH_ENDING → endingState + (в этапе 3) endSession; сейчас — journal 'ending_reached'.
5. modules/turn/src/reject-turn.ts — REVIEW→FAILED с failed{code, message:reason}, journal, TURN_FAILED; retryTurn({turnId, idempotencyKey}) — FAILED→? НЕТ: создаёт НОВЫЙ turn (номер+1) со статусом OPEN, копирует действия прежнего хода? — НЕТ: действия остаются в прежнем ходе, GM решает (зафиксировать как D118); из REVIEW retry = переход REVIEW→OPEN с очисткой resolution (по TURN_TRANSITIONS из 1.2) и повторным resolveTurn.
6. modules/gm-review/src/* — moduleId 'gm-review': commands approve/reject/editAndApprove/retry (все требуют idempotencyKey), queries pendingReviews(sessionId); emits GM_REVIEW_DECIDED; dependencies: [] (НЕ ['gm'] — F-8.6, решение D119: gm-review владеет переходом REVIEW→COMMITTED и вызывает turn.commitTurn; gm.finishTurn УДАЛЁН из контракта gm — B-09).
   editAndApprove({turnId, editedResolution, baseResolutionHash, idempotencyKey}) — проверка hash от текущего сохранённого resolution; расхождение → 409 VERSION_CONFLICT с актуальным resolution в meta (A1.8); при совпадении — save editedResolution (source:'AI_THEN_GM_EDIT', editedAt, все item'ы EDITED) → approve.
   approve → turn.commitTurn. reject → turn.rejectTurn. retry → turn.retryTurn.
7. Тесты: полный цикл OPEN→…→COMMITTED с scripted-провайдером; commit дважды с одним ключом → один journal-запись, version одинаковый; commit с устаревшим expectedVersion → VERSION_CONFLICT; editAndApprove с чужим hash → 409; reject → FAILED + TURN_FAILED с errorCode; retry из REVIEW → OPEN, resolution очищен; при FailingAI → FAILED и retry создаёт новый ход; проверка, что applyResolution применяет ТОЛЬКО APPROVED/EDITED item'ы.
8. Проверка: npm test; node tools/verify/stage1.mjs → A1.6, A1.8 PASS (через сервисный слой; HTTP/WS — в 1.10/1.11).

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact; долгие операции (AI) — СТРОГО вне db.transaction; события через outbox после COMMIT; идемпотентность обязательна; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.9 — Модули: chat, story, gm, gm-audit

```
Реализуй прикладные модули этапа 1 (критерии A1.10, A1.15; закрывает F-8.3…F-8.6, F-3.8, F-3.9). Основание: v3 §IV.7, §IV.8, §IV.10, §IV.11; аудит §8.5.

1. modules/chat/src/contract.ts — moduleId 'chat' по v3 §IV.7 + исправления: emits CHAT_MESSAGE_PUBLIC/PRIVATE/SYSTEM/GM (они уже в contracts, F-2.1); subscribes TURN_COMMITTED, WORLD_EVENT_FIRED (этап 2), PLAYER_JOINED, PLAYER_LEFT, SESSION_STATUS_CHANGED.
2. modules/chat/src/service.ts:
   sendPublicMessage({sessionId, playerId, text}) — sanitize (trim, нормализация переносов, лимит maxMessageLen=1000 из limits.yaml, отклонение управляющих символов) → chat_messages(visibility='PUBLIC') → событие CHAT_MESSAGE_PUBLIC{message: ChatMessageView} → возврат {messageId, sequenceId};
   sendPrivateMessage({sessionId, fromPlayerId, toPlayerId, text}) — visibility='PRIVATE', to_player_id; событие публикуется с audience-политикой TARGETED (доставка — в 1.11);
   sendSystemMessage({sessionId, text, turnId?}) — visibility='SYSTEM', from_player_id=null;
   sendGMMessage({sessionId, gmPlayerId, text}) — visibility='GM';
   history({sessionId, since?, visibility?, playerId?, limit=200}) — для PUBLIC: вся лента; для PRIVATE: только где from=playerId или to=playerId; для GM: только GM (A1.10);
   rate limit: token bucket chat.publicPerSecond=10 из limits.yaml → RATE_LIMIT.
3. modules/story/src/* — moduleId 'story': commands setFlag({sessionId, key, value, setBy, turnId}), grantKnowledge({sessionId, playerId, key, value, source, turnId}), queries listKnownFacts({sessionId, playerId?}); реализация — через core/state-service.apply (НЕ напрямую в репозиторий — F-8.4, решение D120).
4. modules/gm/src/contract.ts — moduleId 'gm' по v3 §IV.8 БЕЗ finishTurn (D119) и с добавлением: pauseSession, resumeSession, endSession, moveGroup, sendSystemMessage, activateEvent (этап 2 — заглушка NOT_IMPLEMENTED), inspectState, inspectAIContext, inspectJournal, addNote, listAudit, kickPlayer. Все команды эмитят GM_ACTION_PERFORMED{sessionId, gmPlayerId, action, meta, traceId, idempotencyKey}.
5. modules/gm/src/inspect.ts:
   inspectState({sessionId}) → GMStateView (полный GameState + игроки + ходы + флаги + objectStates + knowledge всех игроков + список media-джобов (пусто в этапе 1));
   inspectAIContext({turnId}) → DirectorContext (из ai-director.getDraft/lastContext; сохранять последний собранный контекст в journal или отдельной таблице ai_contexts — выбрать и зафиксировать как D121);
   inspectJournal({turnId}) → JournalEntry[].
6. modules/gm/src/notes.ts — addNote({sessionId, turnId?, visibility, text}) → gm_notes + GM_NOTE_ADDED{noteId, visibility, sessionId}; подписка на TURN_COMMITTED для visibility='PUBLIC_AFTER_COMMIT': публиковать такие заметки в чат как SYSTEM-сообщение после коммита (закрывает F-3.8).
7. modules/gm-audit/src/* — moduleId 'gm-audit': subscribes GM_ACTION_PERFORMED, GM_REVIEW_DECIDED; пишет gm_audit (append-only, никаких обновлений); query listAudit({sessionId, since?, limit}) для GET /gm/audit. Модуль НИЧЕГО не мутирует в GameState (проверить тестом).
8. Регистрация модулей: apps/server/src/modules-registry.ts — defineModule-контракты всех 9 модулей, проверка через contracts (emits/subscribes ⊆ DomainEventSchema, dependencies ⊆ ModuleId, отсутствие циклов в dependencies) и boot-подписка subscribes→bus. Тест: реестр валиден, все 9 модулей зарегистрированы (F-8.3).
9. Тесты: chat-видимости (публичное видят все, приватное — только адресат, GM-сообщение не уходит игрокам — на уровне событий и audience-политик); лимиты длины и rate-limit; story.setFlag меняет version ровно на 1 и пишет journal; gm.inspectState не содержит GM-заметок с visibility GM_ONLY в публичной части (это проверка проекции, полная — в 1.11); gm-audit пишет запись на каждое GM-действие и не меняет состояние; PUBLIC_AFTER_COMMIT публикуется ровно один раз.
10. Проверка: npm test; node tools/verify/stage1.mjs → A1.10, A1.15 PASS.

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact (текст игроков маскируется при LOG_REDACT_PLAYER_TEXT=1); долгие операции вне транзакций, события через outbox; идемпотентность обязательна; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.10 — HTTP-транспорт: auth, маршруты, ошибки, rate-limit

```
Реализуй gateways/http (критерии A1.1, A1.7; закрывает B-11, B-12, F-6.6). Основание: v3 §VI.1–VI.4, §VI.9; аудит §8.5. Все маршруты брать ИЗ contracts HTTP_ROUTES (промпт 1.2) — не объявлять заново.

1. gateways/http/src/auth/*:
   - POST /auth/session {displayName, title?} — создаёт сессию И GM-игрока (единственный маршрут создания сессии; POST /sessions оставить как алиас, требующий GM-токен, и задокументировать различие — решение D122);
   - POST /sessions/:id/join {displayName} → {playerId, token, refreshToken};
   - POST /auth/refresh {refreshToken} → {token};
   - JWT (jose, HS256, JWT_SECRET): claims {sub: playerId, sid: sessionId, gm: boolean, typ:'access'|'refresh', exp, iat, jti}; TTL access = JWT_TTL_SECONDS (12 ч), refresh = 30 дней;
   - отзыв: таблица players.revoked_before (добавить колонку в 1.4-миграции) — токен недействителен, если iat < revoked_before; при kickPlayer/leaveSession выставлять revoked_before=now (закрывает B-12.3);
   - middleware requireAuth('player'|'gm'|'none') → кладёт в request.auth {playerId, sessionId, isGM}; 'gm' требует isGM===true, иначе AUTH_FORBIDDEN (403).
2. Реализовать ВСЕ маршруты из HTTP_ROUTES (v3 §VI.2–VI.4 + аудит §8.5), включая:
   sessions (create/join/start/pause/resume/end/me/GET), turns (action/lock/commit/reject/unlock/cancel/retry/edit-approve/GET), chat/history, gm/* (inspect state/context/journal, note, audit, move, activate-event), media/* (заглушка 501 NOT_IMPLEMENTED до этапа 2, но маршруты объявлены), state/projection, health, version, metrics (internal, в dev — открыт).
   Каждый handler: Zod-парсинг request (params/query/body) → вызов команды модуля с idempotencyKey (из body для мутирующих) → Zod-парсинг ответа → reply.
   GET /state/projection?view=public|ai|gm: public — любому игроку; ai и gm — ТОЛЬКО GM (A1.7, F-6.1).
3. gateways/http/src/error-handler.ts — единый setErrorHandler: CoreError/ProviderError/ZodError → HttpErrorBody по ERROR_TABLE (contracts); ZodError → VALIDATION (400) с meta.issues (не более 10, без значений полей длиннее 80 символов); неизвестная ошибка → INTERNAL (500) + лог error с traceId; всегда возвращать requestId из @fastify/request-id.
4. Rate-limit: @fastify/rate-limit — глобально per IP (100 req/min), per token (300 req/min), отдельные лимиты на неаутентифицированные маршруты /auth/* и /sessions/:id/join (10 req/min per IP — закрывает F-6.6), на мутирующие turn-маршруты (30 req/min per token). Превышение → RATE_LIMIT (429) с Retry-After.
5. CORS: origin из config (dev: http://localhost:5173), credentials false (токен в Authorization-заголовке), methods по HTTP_ROUTES.
6. Статика: @fastify/static на client/dist (prod) и на data/state/media (media-файлы появятся в этапе 2; маршрут /media/files/* — с auth player).
7. Никакой доменной логики в gateways (инвариант 14): только парсинг, авторизация, вызов команд, сериализация. Проверить architecture-тестом из 1.3.
8. Тесты (integration, реальный Fastify + tmp-БД):
   - каждый маршрут из HTTP_ROUTES имеет тест на 200/основной код ошибки (таблица-драйв по массиву маршрутов);
   - auth: player-токен на gm-маршруте → 403; истёкший → AUTH_EXPIRED; отозванный → AUTH_INVALID; refresh работает;
   - идемпотентность через HTTP: два POST /turns/:id/commit с одним ключом → второй возвращает тот же version и не создаёт journal-записи (A1.4); параллельные → 409 IDEMPOTENCY_IN_FLIGHT;
   - view=ai с player-токеном → 403 (A1.7);
   - rate-limit на /auth/session срабатывает после 10 запросов с одного IP;
   - тело ошибки всегда соответствует HttpErrorBody (Zod-парсинг ответа в тесте).
9. tools/verify/stage1.mjs: добавить HTTP-проверки A1.1, A1.4, A1.7 (частично).
10. Проверка: npm test; npm run dev → curl-прогон: создать сессию, join 2 игроками, submit action, lock, дождаться REVIEW (scripted AI), commit → {version}; повтор commit → тот же version; view=ai под игроком → 403.

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact; долгие операции вне транзакций, события через outbox; идемпотентность обязательна для всех мутирующих маршрутов; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.11 — WS-гейтвей: авторизация, проекции, приватность

```
Реализуй gateways/ws (критерии A1.7, A1.9; закрывает B-10, F-6.1, F-6.7…F-6.15). Основание: v3 §VI.5–VI.8, §VIII.2; патч аудита §8.4. Все типы сообщений — из contracts WSClientMessage/WSServerMessage.

1. gateways/ws/src/server.ts — @fastify/websocket на /ws:
   - авторизация в handshake: токен через query ?token= ИЛИ через subprotocol 'mnemosin.v1.<jwt>' (реализовать оба, зафиксировать приоритет как D123); невалидный/отсутствующий → close code 4401 с payload {code:'AUTH_INVALID'};
   - окно неаутентифицированного соединения: wsAuthTimeoutMs (5000) — если за это время нет валидного AUTH/токена, close 4408;
   - лимит соединений: wsMaxConnectionsPerIp (default 20) и wsMaxConnectionsPerPlayer (default 4 — multi-tab, детальная обработка в этапе 3) → при превышении close 4429 RATE_LIMIT;
   - после авторизации сервер шлёт HELLO{serverVersion, contractsVersion, capabilities} → AUTH_OK{playerId, sessionId, isGM} (добавить isGM — закрывает F-10.6).
2. gateways/ws/src/connection-registry.ts — in-memory: connectionId (uuid) → {playerId, sessionId, isGM, socket, subscribedAt, lastPongAt}; playerId → Set<connectionId> (multi-tab); методы add/remove/listByPlayer/listBySession/countByIp; события PLAYER_PRESENCE при изменении (для этапа 3).
3. Heartbeat: сервер шлёт PING каждые heartbeatIntervalMs (20000), ожидает PONG; отсутствие PONG idleTimeoutMs (45000) → close 4408 и PLAYER_LEFT-подобный presence-событие (не PLAYER_LEFT: соединение ≠ игрок). Клиентский PING тоже поддерживается (ответ PONG).
4. gateways/ws/src/router.ts — обработка входящих: WSClientMessage.parse → switch по type → вызов команды соответствующего модуля (ACTION_SUBMIT → turn.submitAction; CHAT_PUBLIC/PRIVATE → chat; GM_* → gm/gm-review; SUBSCRIBE → проверка участия в сессии; HISTORY → chat.history; PING → PONG).
   - обязательный idempotencyKey для GM_LOCK_TURN/GM_COMMIT_TURN/GM_REJECT_TURN/GM_EDIT_APPROVE/GM_OPEN_TURN/GM_MOVE_GROUP (отсутствие → VALIDATION);
   - ДЕДУПЛИКАЦИЯ по requestId (F-6.7): LRU-кэш requestId → {response, at} с TTL dedupeTtlMs (300000); повторный requestId → вернуть прежний ack без повторного выполнения;
   - неизвестный type → ERROR{code:'VALIDATION'} без разрыва соединения;
   - rate limit: token bucket per connection из limits.wsRatePerConnection (ACTION_SUBMIT 5/s, CHAT_PUBLIC 10/s, остальные 20/s) → RATE_LIMIT.
5. gateways/ws/src/projections.ts — ЕДИНСТВЕННОЕ место, где доменные данные превращаются в клиентские (инвариант 14 + B-10):
   - buildPublicGameStateView(sessionId, forPlayerId) → PublicGameStateView: worldState, локации (публичные поля), объекты с visible=true, список игроков, текущий ход (id/number/status), storyFlags БЕЗ значений GM-only? — в этапе 1 флаги публичны (решение D124), playerKnowledge — ОТСУТСТВУЕТ;
   - buildPlayerPrivateView(sessionId, playerId) → только его knowledge;
   - buildGMStateView(sessionId) → полный GameState + knowledge всех + заметки GM + journal-хвост;
   - buildTurnView, buildChatMessageView (с учётом адресата), buildMediaJobView (этап 2);
   - каждое server-сообщение формируется ЗДЕСЬ и проходит WS_PRIVACY_POLICY из contracts: BROADCAST → всем в сессии; GM_ONLY → соединениям с isGM; TARGETED → конкретному playerId (все его соединения); SENDER_ONLY → инициатору.
   - ПРАВИЛО: broadcast-payload не содержит per-player полей. Приватная часть хода уходит отдельным TURN_PRIVATE_RESOLUTION адресату; полный resolution — только TURN_RESOLUTION_GM (GM_ONLY). Публичный TURN_COMMITTED содержит {turnId, version, publicSegments}.
6. gateways/ws/src/broadcast.ts — подписки на bus (через modules-registry): STATE_COMMITTED → STATE_PROJECTION (public) + STATE_PROJECTION_PRIVATE (каждому игроку отдельно); TURN_* → TURN_UPDATE; TURN_DRAFT_READY → GM_ONLY; TURN_COMMITTED → broadcast + targeted private; CHAT_* → по visibility; CAPABILITY_CHANGED → broadcast; GM_ACTION_ACK → SENDER_ONLY/GM_ONLY; ERROR → SENDER_ONLY с requestId.
7. Reconnect-контракт (A1.9, v3 §VI.8): после AUTH_OK сервер автоматически шлёт STATE_PROJECTION, STATE_PROJECTION_PRIVATE, TURN_UPDATE (текущий ход), SESSION_STATUS, PLAYER_PRESENCE; HISTORY — по явному запросу клиента {since, limit}. Порядок фиксирован и покрыт тестом.
8. Тесты (integration, реальный WS-сервер + 2–7 клиентов):
   - **property-based тест приватности** (A1.7, fast-check): генерируется случайная партия (случайные privateMessages, GM-заметки всех visibility, knowledge на каждого игрока), прогоняется цикл хода, все исходящие envelope перехватываются сниффером и проверяются: ни в одном сообщении с политикой BROADCAST нет privateMessages/gmNotes/чужого knowledge; для TARGETED получатель совпадает с адресатом;
   - GM_ONLY-сообщения не приходят игроку (A1.8);
   - дедуп по requestId: один и тот же ACTION_SUBMIT с одинаковым requestId, отправленный 3 раза, даёт одно действие и один ack;
   - rate-limit: 50 ACTION_SUBMIT за 100 мс → часть отклонена RATE_LIMIT, соединение живо;
   - reconnect: kill сервера → клиент в RECONNECTING → после подъёма полный набор сообщений (п.7), optimistic-действия, не получившие ack, переотправляются и применяются ровно один раз;
   - handshake без токена → close 4401; с истёкшим → 4401 AUTH_EXPIRED.
9. tools/verify/stage1.mjs: добавить A1.7, A1.9.
10. Проверка: npm test -- --project integration; node tools/verify/stage1.mjs → A1.7, A1.9 PASS.

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact; долгие операции вне транзакций, события через outbox; идемпотентность обязательна; приватность — только через projections.ts и WS_PRIVACY_POLICY; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.12 — Клиент: Svelte + stores + UI игрока и GM

```
Реализуй client/ (критерии A1.8, A1.9, A1.10; закрывает F-10.1, F-10.4…F-10.6). Основание: v3 Часть VII; D103 (Svelte 5 + Vite). Типы — только из @mnemosin/contracts (client не импортирует core/modules, проверяется architecture-тестом).

1. client/vite.config.ts (dev-порт 5173, proxy /health и /ws на 3000), client/src/main.ts, роутинг: /player и /gm (две точки входа, общий shell).
2. client/src/net/ws-client.ts — реализация WSClient из v3 §VII.7:
   connect({url, token}) с handshake-авторизацией (subprotocol), очередь исходящих до AUTH_OK;
   reconnect: экспоненциальный backoff base 500, factor 2, cap 15000, jitter ±20%, maxAttempts 8 (из limits) → после исчерпания состояние FAILED с причиной и кнопкой «Подключиться снова» (закрывает F-6.10);
   offline-queue: сообщения с idempotencyKey/requestId хранятся в localStorage (ключ mnemosin:pending:<playerId>), удаляются по ack; при реконнекте переотправляются; дубли отклоняются сервером по requestId (A1.9);
   heartbeat: ответ на PING, свой PING каждые 20 с;
   on(type, handler) с типизацией по WSServerMessage.
3. client/src/stores/* — по v3 §VII.2 (immutable-сторы на svelte/store или Svelte 5 runes — выбрать и зафиксировать как D125):
   connectionStore (состояния из §VII.3 + attempt + nextRetryAt), sessionStore, turnStore (read-only Turn + pendingAction + submittedActions by requestId), chatStore (кольцевой буфер 500 + pendingMessages + reconcile по messageId), visualStore (заготовка под этап 2: jobs, visibleSceneUrl), uiStore.
   Правило: сторы обновляются ТОЛЬКО обработчиками WS-сообщений и локальными optimistic-операциями с последующим reconcile (v3 §VII.8). GM_COMMIT_TURN — без оптимизма.
4. UI игрока (client/src/player/): GameShell, SystemFeed, PublicChat, PrivateChat, TurnPanel{ActionsInput, TurnStatus}, PlayerPanel, VisualPanel-заглушка («визуал появится на этапе 2»), индикатор соединения и фазы реконнекта, экран входа (displayName → join). Действия отправляются с idempotencyKey (crypto.randomUUID, ≥16 символов), оптимистично отображаются, при ERROR — откат с показом кода и clientAction из ERROR_TABLE.
5. UI GM (client/src/gm/): экран входа (создать сессию / токен), GMPanel с вкладками:
   - Review (A1.8): список item'ов resolution (сегменты, приватные сообщения, предложенные события, изменения объектов) с чекбоксами APPROVED/REJECTED и редактированием текста; показ diagnostics (provider, attempts, usage, durationMs), softRejects/warnings, кнопки Approve / Edit&Approve / Reject / Retry; Edit&Approve отправляет baseResolutionHash и при 409 показывает актуальный resolution из meta;
   - Turn: lock/unlock/open next/cancel, лента действий с sequenceId;
   - State: projection view=gm (флаги, объекты, knowledge, локации), moveGroup (выбор игроков и локации, проверка exits и locked);
   - Inspect: AI context (view=ai) и journal по ходу;
   - Notes: добавление заметок с visibility;
   - Audit: список gm_audit (GET /gm/audit).
6. Стилизация: тёмная тема, CSS-переменные, без UI-библиотек (D103); раздельные player.css (атмосферный) и gm.css (плотный рабочий стол) — принцип из v1 D85.
7. client/src/lib/privacy.ts — клиентская защита: экранирование HTML при рендере текста (textContent, не innerHTML); никогда не сохранять token в localStorage (только sessionStorage/memory) — зафиксировать как D126.
8. Playwright-компонентные сценарии (e2e/): логин игрока, отправка действия, отображение нарратива после commit, приватное сообщение видно только адресату (два браузера), реконнект (остановка сервера), GM-ревью цикл.
9. Проверка: npm run build -w client, npm run dev → руками/скриптом прогнать сценарий: 2 игрока + GM, ход, commit, приватное сообщение; npm run test:e2e -- e2e/player.spec.ts.

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts (client не импортирует core/modules); не хватает данных — спроси, не изобретай; ошибки показывать кодом и clientAction из ERROR_TABLE; приватность — не доверять клиенту (сервер решает, клиент только не отображает лишнего); в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Промпт 1.13 — E2E «Стол», CI, README, сквозной прогон A1

```
Заверши этап 1 (критерий A1.16 и сквозная проверка A1.1–A1.15). Основание: ROADMAP §2.3, v3 §IX.5–IX.7; аудит F-11.2, F-11.3.

1. e2e/stage1-table.spec.ts (Playwright, 7 браузерных контекстов: 6 игроков + GM):
   сценарий «Стол»: GM создаёт сессию → 6 игроков join (разные displayName) → TURN_OPENED виден всем → каждый отправляет действие (проверка sequenceId 1..6) → GM lock → PROCESSING → REVIEW (scripted AI) → TURN_DRAFT_READY только у GM → GM редактирует один сегмент и отклоняет одно изменение объекта → Edit&Approve → TURN_COMMITTED: все видят публичный нарратив, адресат видит приватное сообщение, неотправленные/отклонённые item'ы не видны → GM moveGroup в Corridor → LOCATION_CHANGED, проекция обновилась у всех → GM openTurn → ход №2 OPEN.
   Дополнительно в этом же тесте: реконнект одного игрока в середине хода; повторный commit с тем же idempotencyKey (через HTTP из теста) → version не изменился; попытка игрока вызвать GM-маршрут → 403.
2. e2e/privacy-leak.spec.ts — сниффер WS-трафика (перехват всех сообщений сервера во время сценария) + утверждения из матрицы приватности (патч аудита §8.4): в BROADCAST-сообщениях нет privateMessages, gm_notes с visibility GM_ONLY/AI_DIRECTOR, чужого playerKnowledge; TURN_RESOLUTION_GM приходит только GM.
3. e2e/degraded.spec.ts — AI_PROVIDER=failing(timeout): ход → FAILED с PROVIDER_TIMEOUT, GM видит ошибку и кнопку Retry, после смены провайдера на scripted retry проходит; CAPABILITY_CHANGED{TEXT_AI,false} виден в /health и в SystemFeed (A1.12/A1.13).
4. e2e/restart-recovery.spec.ts — SIGKILL сервера во время PROCESSING → перезапуск → reconcileOnBoot: ход в согласованном состоянии (PROCESSING → FAILED с кодом RECONCILE_INTERRUPTED, либо OPEN — выбрать и зафиксировать как D127), состояние и чат целы, клиент переподключился и получил полную проекцию (A1.9, A1.11).
5. tools/verify/stage1.mjs — финальная версия: последовательно проверяет ВСЕ 16 критериев A1 (HTTP/WS/БД-assert'ы) и печатает таблицу PASS/FAIL; ненулевой код возврата при любом FAIL. Это главный артефакт приёмки этапа.
6. CI (.github/workflows/ci.yml) по v3 §IX.7 + аудит F-11.2:
   npm ci → lint → typecheck → test:unit → test:integration → test:arch → test:contract → build → test:e2e (с AI_PROVIDER=scripted, MEDIA_PROVIDER=debug, без сети) → npm audit --audit-level=high → secret scanning (gitleaks) → verify:stage1.
   Матрица: node 22; кэш npm; артефакты — coverage и playwright-report.
7. Покрытие (v3 §IX.5): core ≥ 90 %, modules ≥ 75 %, adapters/gateways ≥ 60 % — настроить thresholds в vitest.config.ts; при недоборе — CI красный.
8. README.md: что это (этап 1 «Стол»), быстрый старт (cp .env.example .env → заполнить JWT_SECRET/DATABASE_URL → npm install → npm run db:migrate → npm run dev), режимы AI_PROVIDER и MEDIA_PROVIDER, как прогнать проверки (npm run verify:stage1), как запустить e2e, карта пакетов и правил зависимостей, ссылка на docs/.
9. docs/SPEC_STAGE1.md — собрать по факту реализации: границы этапа (входит/не входит из ROADMAP §2.1–2.2), роли и права, фазовый автомат Turn и Session (таблицы), протокол (WS-каталог с политиками приватности + HTTP-каталог с auth), модель данных (список таблиц), критерии A1.1–A1.16 со ссылкой на tools/verify/stage1.mjs, принятые решения D113–D127.
10. docs/ARCHITECTURE.md — дополнить фактическим деревом каталогов, списком модулей и их контрактами, схемой зависимостей, разделом «Что изменилось относительно v3» (перечислить отклонения: удаление currentLocationId из Session, удаление actionIds из Turn, событие TURN_UNLOCKED, удаление gm.finishTurn, REVIEW→OPEN для retry, storyFlags по key, knowledge как массив).
11. Финальная проверка: чистый клон → npm ci → npm run db:migrate → npm run verify:stage1 → все 16 PASS; затем npm run test:e2e → зелёные. Отчёт приложить к сообщению.

ОБЩИЕ ПРАВИЛА: монорепо/ESM/TS strict, Node>=22 (D101); источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; ошибки — только ErrorCode; pino+traceId+redact; долгие операции вне транзакций, события через outbox; идемпотентность обязательна; в конце typecheck+lint+test и старт сервера; решения — в docs/ARCHITECTURE.md как D113+.
```

---

## Приёмка этапа 1 (чек-лист для человека)

- [ ] `git clone && npm ci && npm run db:migrate && npm run dev` — сервер поднялся, `/health` = 200.
- [ ] `npm run verify:stage1` — **16/16 PASS**.
- [ ] `npm run test && npm run test:arch && npm run test:e2e` — зелёные, покрытие core ≥ 90 %.
- [ ] Живая партия: 3+ человека, 3+ хода, без ручных правок БД (ROADMAP §5, Gate 1).
- [ ] `docs/SPEC_STAGE1.md` и `docs/ARCHITECTURE.md` (D101–D127+) соответствуют коду.
- [ ] В реестре аудита закрыты: B-01…B-12 (кроме тех, что по плану относятся к этапу 2: B-04 world-pack, B-06 DSL) и все P1 этапа 1; P2 заведены как issues.
- [ ] Принято решение о старте этапа 2 → пишется `DEV_PLAN_STAGE2.md`.
