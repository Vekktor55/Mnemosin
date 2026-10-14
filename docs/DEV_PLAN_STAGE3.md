# DEV_PLAN_STAGE3 — 14 промптов, этап 3 «Прод и расширяемость»

Версия **1.0 (предварительная)** · 2026-10-09 · решения D101–D112 приняты, D113–D127 (этап 1), D128–D144 (этап 2), D145+ — в этом этапе.
Основание: `МНЕМОСИН Pipeline v3` §VIII.4–VIII.8, §IX.5–IX.8, §X.1–X.5; `MNEMOSIN_v3_AUDIT.md` (F-9.1, F-9.3…F-9.5, F-5.7, F-6.4, F-11.2…F-11.5); `ROADMAP.md` (критерии A3.1–A3.8).

> **Статус v1.0:** план написан до старта этапа 1. После **Gate 2** сверяется с фактическим кодом и становится v1.1. Этап 3 можно переставлять местами внутри себя: промпты 3.7 (плагин) и 3.9 (документация) не блокируют 3.1–3.5 (надёжность), порядок ниже — рекомендуемый.

**Обязательное условие старта:** A1.* и A2.* зелёные (`verify:stage1` 16/16, `verify:stage2` 16/16).

| Промпт | Что делает                                                                                 | Критерии A3 | Закрывает дефекты аудита               |
| ------ | ------------------------------------------------------------------------------------------ | ----------- | -------------------------------------- |
| 3.1    | Snapshots + journal replay + `reconcileOnBoot`                                             | 1           | **F-9.1**, F-5.5, F-5.6, **UNKNOWN#6** |
| 3.2    | Observability: `/metrics` (prom), alert-правила, сквозной `traceId`                        | 2           | F-9.4(b,c), F-5.9                      |
| 3.3    | Failure Recovery: матрица v3 §VIII.7 как исполняемые тесты                                 | 1, 3        | F-2.5, F-5.6                           |
| 3.4    | Budget & degradation: единый `limits.yaml`, политики деградации, восстановление capability | 3           | F-9.6, F-9.9                           |
| 3.5    | Security hardening + security-шаги CI + STRIDE-покрытие тестами                            | 4           | F-9.4, F-9.8, F-9.10, F-11.2           |
| 3.6    | Multi-tab, presence, гонки реконнекта                                                      | 6           | F-6.7, F-10.4                          |
| 3.7    | **Плагин Audio Director + MockTTS + AudioPanel** (доказательство расширяемости)            | 5           | F-8.7, X.3 v3                          |
| 3.8    | Performance: сценарии нагрузки, perf-бюджет в CI                                           | 6           | **F-9.3**                              |
| 3.9    | Документация: 11 документов индекса v3 §IX.8 + генерация из contracts                      | 7           | F-11.4                                 |
| 3.10   | Production: WSS, reverse-proxy, systemd, бэкапы + restore drill, rollback                  | 7           | F-5.7, F-9.4(a)                        |
| 3.11   | Финальный аудит расширяемости (3 сценария v3 §X.1–X.3 как meta-тест)                       | 5           | —                                      |
| 3.12   | Регрессия A1+A2+A3, release-чеклист, тег                                                   | 8           | F-11.5                                 |
| 3.13   | Export/import сессии                                                                       | —           | **UNKNOWN#8**                          |
| 3.14   | Backlog-триаж, передача, план v4                                                           | —           | F-11.1, **UNKNOWN#7, #10**             |

---

## Общие правила этапа 3 (встроены в каждый промпт)

1. Правила этапов 1–2 в силе (монорепо/ESM/TS strict, Node ≥ 22, D101–D103, D108 — одна активная сессия).
2. **Источник истины — `@mnemosin/contracts`.** Изменение схемы = `CONTRACTS_VERSION` + запись D145+.
3. **Не хватает данных или решения — остановись и спроси.** Особенно: значения perf-бюджета, расписание бэкапов, хостинг/reverse-proxy, параметры алертов — это решения заказчика, а не реализатора.
4. **Этап 3 не меняет игровой контракт.** Никаких новых игровых механик; только надёжность, наблюдаемость, безопасность, производительность, документация и ОДИН демонстрационный плагин (3.7). Любое предложение «улучшить игру» — в backlog (3.14).
5. Ядро (`core/`) изменяется только если это нельзя сделать модулем/адаптером; каждое такое изменение — D145+ с обоснованием, architecture-тесты остаются зелёными.
6. Ошибки — только `ErrorCode`; долгие операции вне транзакций; события через outbox; идемпотентность обязательна.
7. Каждый промпт добавляет свои проверки в `tools/verify/stage3.mjs` (создаётся в 3.1) и не ломает `verify:stage1` / `verify:stage2`.
8. Все внешние интеграции — fixture-replay в CI + `@live` вручную. Секреты только в env.
9. Решения фиксируй в `docs/ARCHITECTURE.md` как **D145+**.

---

## Промпт 3.1 — Snapshots, journal replay, восстановление при старте

```
Реализуй механизм снимков и восстановления (критерий A3.1; закрывает F-9.1, F-5.5, F-5.6, UNKNOWN#6). Основание: v2 §18/§22 (Snapshot), v2 §34 (Commit Pipeline: apply → journal → snapshot → events → broadcast), v3 §VIII.7 («restore from snapshot + journal replay»), §II.15 (ubiquitous language).

1. Решение о модели сериализации (закрывает UNKNOWN#6, зафиксировать как D145): **полный JSON-снапшот GameState после каждого COMMITTED хода** + append-only turn_journal как источник уточнений. Обоснование записать в ARCHITECTURE.md: при ≤12 игроках и ≤500 ходах полный снапшот ≤ ~2 МБ, дельта-модель усложняет восстановление и не даёт выигрыша на SQLite. Альтернатива (дельта) — в backlog с условием «если state_json > 4 МБ».
2. core/state/snapshot-service.ts:
   - take(sessionId, turnId, version, tx) → запись snapshots(session_id, turn_id, version, state_json, created_at) ВНУТРИ commit-транзакции (атомарно с применением состояния — иначе снапшот может разойтись с version);
   - latest(sessionId), get(sessionId, version), list(sessionId, limit);
   - retention: limits.snapshotKeepPerSession (default 50) + snapshotKeepDays (default 30) → джоб cleanupSnapshots (планировщик из 1.5); при удалении оставлять каждый 10-й (точка долгого восстановления);
   - метрика snapshots.total, snapshots.bytes.
3. core/state/recovery.ts — reconcileOnBoot() (таблица как в v1 D4/§8.2, расширенная):
   - PROCESSING → FAILED{code:'RECONCILE_INTERRUPTED'} + journal 'failed' (ход не коммитился — состояние целое; GM делает retry);
   - REVIEW → остаётся REVIEW, resolution восстанавливается из turns.resolution_json, GM видит его в панели;
   - LOCKED → остаётся LOCKED (действия сохранены);
   - OPEN → без изменений; COMMITTED/FAILED → без изменений;
   - request_in_flight / idempotency IN_FLIGHT записи старше idempotencyInFlightTimeoutMs (120000) → FAILED{code:'RECONCILE_INTERRUPTED'} (иначе ключ заблокирован навсегда);
   - event_outbox: записи PENDING остаются (публикатор дошлёт), attempts не сбрасывать; DEAD остаются DEAD + warning-лог со списком;
   - media_jobs в SUBMITTED при старте → перевести в QUEUED (at-least-once, jobId идемпотентен) или FAILED, если attempts исчерпаны;
   - deferred_effects PENDING → остаются;
   - вся таблица reconcile — кодом (Record<phase, action>) + snapshot-тест.
4. replayFromSnapshot(sessionId, targetVersion?) — диагностический инструмент: берёт последний снапшот ≤ target и применяет journal-записи 'state_applied' после него; результат сверяется с фактическим GameState (assert равенства по canonical JSON). Используется в 3.3 и в tools/doctor.mjs.
5. tools/doctor.mjs — CLI-диагностика БД: целостность (PRAGMA foreign_key_check, quick_check), версия схемы, незакоммиченные idempotency-записи, DEAD-outbox, расхождение snapshot vs state (через replay), размер БД и топ-таблиц по объёму. Вывод — человекочитаемый отчёт + exit code.
6. Тесты:
   - после commit снапшот существует и state_json == фактический GameState (canonical JSON);
   - **kill -9 в момент commit** (child process, SIGKILL между «state applied» и «outbox published») → после старта состояние консистентно: либо ход COMMITTED и снапшот есть, либо ход в прежнем статусе и снапшота нет; третьего не дано (проверить все варианты через 20 прогонов);
   - PROCESSING при старте → FAILED{RECONCILE_INTERRUPTED}, GM retry создаёт новый ход;
   - REVIEW при старте → resolution доступен GM;
   - replayFromSnapshot даёт побайтово тот же GameState;
   - retention удаляет лишние снапшоты, оставляя каждый 10-й;
   - idempotency IN_FLIGHT старше таймаута разблокирована.
7. tools/verify/stage3.mjs — создать (по образцу stage1/stage2) и добавить A3.1.
8. Проверка: npm test && npm run test:arch; node tools/verify/stage3.mjs → A3.1 PASS; verify:stage1 и verify:stage2 по-прежнему 16/16.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; игровой контракт не меняется; ядро — только если нельзя модулем (D145+); ошибки — только ErrorCode; долгие операции вне транзакций, события через outbox; внешние интеграции — fixture-replay + @live; секреты только в env; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — в docs/ARCHITECTURE.md как D145+.
```

---

## Промпт 3.2 — Observability: метрики, алерты, сквозной traceId

```
Реализуй наблюдаемость (критерий A3.2; закрывает F-9.4(b,c), F-5.9). Основание: v3 §VIII.4–VIII.5; аудит F-9.4.

1. infrastructure/metrics/*: MetricsSink (интерфейс из 1.5) → реализация prom-client: все метрики v3 §VIII.5 (turn.duration_ms, turn.failures_total{code}, ai.duration_ms{provider}, ai.cost_usd_total{provider}, ai.schema_errors_total, ai.violations_total{kind}, ai.injection_suspected_total, media.queue_depth, media.duration_ms{provider}, media.failures_total{provider,code}, media.cache_hits_total, ws.connections_active, ws.reconnect_total, ws.messages_total{type,direction}, provider.breaker_state{provider}, db.transaction_duration_ms, outbox.dead_total, snapshots.bytes) + process-метрики (heap, event loop lag).
2. GET /metrics — prom-text, auth 'internal': в production открыт только с localhost/через separate-порт (METRICS_PORT, default 9464) — решение D146; в dev доступен без auth.
3. Сквозной traceId: middleware HTTP (x-request-id → traceId), WS (traceId на сообщение, прокидывается в команды, адаптеры, outbox-записи, journal, cost_records, gm_audit, media_jobs) — проверить, что traceId одной команды проходит через ВСЕ записи (тест: одна команда → собрать все таблицы → assert одинаковый traceId).
4. Логи: pino с redact-листом (token, authorization, password, *.key, refreshToken) + опция LOG_REDACT_PLAYER_TEXT маскирует rawText/privateMessages/text (закрывает F-9.8 — список полей зафиксировать в contracts как LOG_REDACT_FIELDS); log rotation: файловый транспорт с ротацией по размеру (pino-roll или logrotate-документация) + retention (F-5.9).
5. docs/ALERTS.md — правила алертинга (таблица: метрика, условие, длительность, серьёзность, действие): turn.failures_total рост > 5/10 мин; provider.breaker_state == open > 2 мин; outbox.dead_total > 0; ws.reconnect_total всплеск; media.queue_depth > 10 более 5 мин; ai.cost_usd_total рост выше дневного порога; heap > 80 %; event loop lag p95 > 250 мс. Формат — готовый к Prometheus/Alertmanager (YAML-фрагменты).
6. Retention append-only таблиц (F-5.9): джобы cleanupJournal (хранить journalKeepDays=90), cleanupChat (chatKeepDays=180), cleanupAudit (auditKeepDays=365 — аудит не удалять раньше), cleanupOutbox (published старше 7 дней), auto_vacuum=INCREMENTAL + ежемесячный VACUUM в maintenance-окно (инструкция в DEPLOYMENT.md).
7. Дашборд: docs/observability/grafana-dashboard.json (минимальный: turn latency, failures, AI cost, media queue, WS connections, breaker state) — как артефакт, не требующий запуска в CI.
8. Тесты: /metrics отдаёт все объявленные метрики (assert по списку из contracts METRIC_NAMES — добавить, чтобы новая метрика без регистрации в списке ломала тест); метрики auth в prod-режиме; traceId сквозной (п.3); redact: лог-фикстура с токеном и rawText → в выводе замаскировано; ротация журнала создаёт второй файл при превышении размера (тест с маленьким лимитом); джобы cleanup удаляют по порогу и не трогают свежие записи.
9. tools/verify/stage3.mjs: A3.2 (метрики отдаются, alert-правила присутствуют в docs, traceId проходит от HTTP-запроса до journal и cost_records).
10. Проверка: npm test && npm run test:arch; A3.2 PASS; регрессия stage1/stage2.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай (пороги алертов — вопрос заказчику); игровой контракт не меняется; ошибки — только ErrorCode; долгие операции вне транзакций, события через outbox; секреты только в env; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.3 — Failure Recovery как исполняемые тесты

```
Преврати матрицу отказов v3 §VIII.7 в автоматические тесты (критерии A3.1, A3.3; закрывает F-2.5, F-5.6). Основание: v3 §VIII.7 (11 сценариев), v2 §54.

1. e2e/recovery/*.spec.ts — по одному сценарию на строку матрицы v3 §VIII.7:
   - server crash (SIGKILL) во время PROCESSING / REVIEW / COMMITTED → поведение из reconcileOnBoot (3.1);
   - AI timeout (FailingAI mode=timeout) → retry по политике → после исчерпания TURN_FAILED{PROVIDER_TIMEOUT} → GM retry проходит;
   - AI schema error (mode=schema) → один repair → при повторе AI_GENERATION_FAILED{PROVIDER_SCHEMA}, GM может ввести нарратив вручную (editAndApprove);
   - media provider crash (DEBUG_MEDIA_MODE=fail) → retry 1 → MEDIA_FAILED → fallback Debug → картинка появляется;
   - LMStudio/HostBridge offline (mode=unavailable) → CAPABILITY_CHANGED{false} → текстовая игра продолжается;
   - WS disconnect → reconnect flow §VI.8 → полная проекция, offline-queue доставлен ровно один раз;
   - DB failure: симуляция через better-sqlite3 interrupt/hook (или подменой репозитория на бросающий) → команда отклонена INTERNAL, состояние не повреждено, после восстановления приём команд возобновляется; проверка, что «приём команд останавливается» только если ошибки длятся > dbFailStopThresholdMs (5000) — реализовать флаг health.db='degraded' и отказ мутирующих маршрутов с 503 (решение D147);
   - duplicate commit (повтор idempotencyKey) → cached result, version не изменился;
   - duplicate event (повторная публикация outbox-записи) → подписчик идемпотентен (assert: чат-сообщение не задублировано);
   - outbox publish failure (подписчик бросает) → attempts растёт → после 5 → DEAD + метрика + алерт-лог;
   - circuit breaker open → CAPABILITY_CHANGED{false} → Core продолжает (ход через fallback или FAILED, сессия жива).
2. e2e/recovery/chaos.spec.ts — случайный сценарий (fast-check): последовательность из 20 случайных отказов (kill server, provider fail, ws drop, db error) → инварианты после каждого шага: (а) GameState.version монотонна; (б) нет committed-хода без снапшота; (в) нет дублей системных сообщений в чате; (г) все доменные события опубликованы не более одного раза на запись outbox; (д) idempotency-ключи не заблокированы навечно.
3. tools/verify/stage3.mjs: добавить A3.1 и A3.3-сценарии, которые можно прогнать без сети (все отказы — стенды).
4. Документация: docs/RUNBOOK.md — по каждому сценарию: как детектируется (метрика/лог), что делает система, что делает человек (GM/админ), как проверить восстановление. Таблица должна совпадать с v3 §VIII.7 (любое расхождение — зафиксировать как D148 и обновить v3-документ).
5. Проверка: npm run test:e2e -- e2e/recovery; A3.1, A3.3 PASS; регрессия stage1/stage2.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; игровой контракт не меняется; ошибки — только ErrorCode; долгие операции вне транзакций, события через outbox; секреты только в env; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.4 — Budget & degradation: единая политика

```
Собери деградацию в один управляемый механизм (критерий A3.3; закрывает F-9.6, F-9.9). Основание: v3 §IV.2, §V.11, §VIII.6, §VIII.7.

1. core/capability/degradation.ts — единая политика: CapabilityDegradationPolicySchema в contracts: {capability, trigger: 'unavailable'|'budget'|'manual'|'error_rate', action: 'disable'|'fallback'|'notify_gm'|'block_session_start', notify: boolean, autoRecoverAfterMs: number|null}.
2. Реализация:
   - TEXT_AI unavailable → block_session_start (сессия не стартует, GM видит причину CAPABILITY_UNAVAILABLE) + notify; autoRecover: при восстановлении провайдера CAPABILITY_CHANGED{true} и старт разрешён;
   - IMAGE_GENERATION unavailable/budget → disable + notify, игра продолжается;
   - VISUAL_PROMPT unavailable → fallback на template (уже в 2.9) + notify=false;
   - AUDIO_GENERATION unavailable → disable + notify (модуль из 3.7 должен это пережить);
   - budget exceeded → IMAGE_GENERATION disable; TEXT_AI — переход на самую дешёвую доступную модель (costPer1kTokens из model-prices.yaml), при отсутствии цен — без смены модели, только BUDGET_WARNING.
3. Восстановление (autoRecoverAfterMs): после отключения провайдера registry периодически (capabilityProbeMs) проверяет isAvailable и при успехе возвращает capability + CAPABILITY_CHANGED{true}; тест обязателен.
4. Ручное управление: POST /gm/capabilities {capability, action:'disable'|'enable', reason, idempotencyKey} (auth GM) → audit-запись + CAPABILITY_CHANGED; GET /gm/capabilities → текущее состояние (провайдеры, breaker, причина деградации). Добавить в contracts HTTP_ROUTES.
5. UI: GM-панель «Capabilities»: список capability → провайдеры → статус (available/breaker open/disabled by budget/manual) → кнопка disable/enable; SystemFeed показывает изменения.
6. Тесты: каждая строка политики (4 capability × триггеры); auto-recover; ручное отключение переживает рестарт (сохранять manual-флаги в БД — таблица capability_overrides, миграция); при block_session_start GM видит actionable-сообщение; AUDIO_GENERATION disable не ломает ход (связка с 3.7).
7. tools/verify/stage3.mjs: A3.3.
8. Проверка: npm test && npm run test:e2e && npm run test:arch; A3.3 PASS; регрессия stage1/stage2.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; игровой контракт не меняется; ошибки — только ErrorCode; долгие операции вне транзакций, события через outbox; секреты только в env; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.5 — Security hardening и STRIDE-покрытие

```
Закрой security-долг (критерий A3.4; закрывает F-9.4, F-9.8, F-9.10, F-11.2). Основание: v3 §VIII.2 (STRIDE), §VIII.3 (чек-лист), §VI.10; аудит F-9.4/F-9.10.

1. Транспорт и заголовки: @fastify/helmet-подобная настройка вручную (CSP: default-src 'self'; img-src 'self' data: blob:; connect-src 'self' ws: wss:; style-src 'self' 'unsafe-inline'? — решить и зафиксировать D149; frame-ancestors 'none'), HSTS в production, X-Content-Type-Options, Referrer-Policy; WSS обязателен в NODE_ENV=production (если x-forwarded-proto !== 'https' и соединение не localhost → отказ с INTERNAL/CONFIG_INVALID, fail-fast); лимит размера WS-сообщения (wsMaxPayloadBytes 64 КБ) и HTTP-тела (1 МБ, для /hostbridge/files — 32 МБ).
2. Auth-hardening: bcrypt/argon2 не нужны (нет паролей), но: JWT rotation (jti blacklist при refresh), ограничение на число refresh (refreshMaxPerToken=5), clock tolerance 5 с, обязательная проверка typ (access не принимается как refresh); отзыв токенов при kickPlayer/leaveSession (уже в 1.10) + тест; rate-limit на /auth/* per IP (уже) + капча-флаг в backlog.
3. Приватность — расширить property-based тест из 1.11 на ВСЕ новые сообщения этапа 2 (TURN_RESOLUTION_GM, STATE_PROJECTION_PRIVATE, media, budget, capabilities) и на new view-схемы; добавить тест «prompt-dumps не отдаются по HTTP ни по какому маршруту» (перебор всех маршрутов из HTTP_ROUTES).
4. Секреты: startup-assert, что значения env-секретов не встречаются в config-файлах и в content/**; gitleaks в CI (уже добавлен в 1.13 — проверить правила и allowlist); .env.example без значений; лог-тест на маскирование (из 3.2).
5. Supply chain: npm audit --audit-level=high в CI (fail), npm audit signatures, lockfile-only install (npm ci), Dependabot/Renovate конфиг (docs + .github/dependabot.yml), лицензионная проверка (license-checker: список разрешённых лицензий MIT/Apache-2.0/BSD/ISC/0BSD; прочее — warning) — закрывает F-11.2.
6. STRIDE-покрытие тестами (v3 §VIII.2, каждая строка → тест; недостающие строки добавить в docs/ARCHITECTURE.md — F-9.10):
   - Info disclosure (AI keys) → grep-тест логов/дампов/WS-трафика;
   - Info disclosure (GM secrets) → property-based тест приватности;
   - Info disclosure (private messages) → targeted-доставка (1.11);
   - Tampering (фейковый TURN_COMMITTED от клиента) → клиентское сообщение такого типа отсутствует в WSClientMessage (schema-level), попытка → VALIDATION; commit только GM-токеном;
   - Repudiation (GM отрицает) → gm_audit append-only: тест, что UPDATE/DELETE по gm_audit запрещены (попытка → ошибка/триггер), и каждое GM-действие оставило запись;
   - Spoofing (фейковый HostBridge) → HMAC-тесты (2.13);
   - DoS (флуд) → rate-limit тесты (1.10/1.11) + тест на wsMaxPayloadBytes;
   - Supply chain → CI-шаги (п.5);
   - Info disclosure (дамп БД) → документированная процедура бэкапа с шифрованием (3.10) + тест, что STATE_DIR в .gitignore;
   - Info disclosure (plain WS) → fail-fast на WSS в prod (п.1).
7. Заморозка контрактов: тест, что CONTRACTS_VERSION в /version совпадает с версией пакета, и что изменение schemas в ветке помечено в CHANGELOG (проверка через git diff по shared/contracts/src/** → требование записи в docs/CONTRACTS_CHANGELOG.md) — снижает риск незаметной ломки клиента.
8. tools/verify/stage3.mjs: A3.4 (все STRIDE-тесты перечислены и зелёные, security-шаги CI присутствуют).
9. Проверка: npm test && npm run test:e2e && npm run test:arch; A3.4 PASS; регрессия stage1/stage2.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; игровой контракт не меняется; ошибки — только ErrorCode; секреты только в env; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.6 — Multi-tab, presence, гонки реконнекта

```
Доведи поведение соединений до продуктового (критерий A3.6 частично; закрывает F-6.7, F-10.4). Основание: v3 §VIII.1 (один игрок → несколько connectionId), §VI.8, §VII.7.

1. Presence: player.status ACTIVE/DISCONNECTED — при закрытии ВСЕХ соединений игрока запускается grace-таймер presenceDisconnectGraceMs (60000); если соединение не появилось → status DISCONNECTED + событие PLAYER_DISCONNECTED + уведомление GM (GM_ONLY) и SystemFeed (публично: «игрок отключился», без причин); при возвращении → ACTIVE.
2. Multi-tab: несколько соединений одного playerId получают идентичные targeted-сообщения; дедупликация клиентская (по messageId/eventId); действия из двух вкладок с разными idempotencyKey — оба принимаются (в пределах limits.actionsPerPlayerPerTurn), с одинаковым — дедуплицируются сервером (1.11).
3. Гонки реконнекта: клиент при реконнекте отправляет HISTORY{since} и получает недостающие сообщения; сервер гарантирует, что STATE_PROJECTION приходит ДО любых инкрементальных обновлений (очередь на соединение с барьером) — иначе возможно «мигание» состояния. Реализовать per-connection outbound queue с порядком: AUTH_OK → STATE_PROJECTION → STATE_PROJECTION_PRIVATE → SESSION_STATUS → TURN_UPDATE → PLAYER_PRESENCE → остальной поток.
4. Клиент: reconciliation-логика — при получении STATE_PROJECTION с version > локальной → полная замена сторов (v3 §VII.8); при version < локальной (сервер откатился после recovery) → тоже полная замена + системное сообщение «сервер восстановился»; обработка PLAYER_PRESENCE в PlayerPanel (иконки online/offline).
5. UI: PlayerPanel показывает статусы игроков; GM видит список соединений (connectionId, lastPongAt, ip-хэш) в Audit-панели (без раскрытия IP игрокам — решение D150).
6. Тесты: 3 вкладки одного игрока — все получают приватное сообщение ровно по разу (по messageId), действие из второй вкладки видно в первой; закрытие всех вкладок → через 60 с DISCONNECTED, возвращение → ACTIVE; реконнект во время commit → клиент получил STATE_PROJECTION до TURN_COMMITTED (assert порядка); серверный restart → все клиенты переподключились и состояние синхронно (сверка version у всех).
7. tools/verify/stage3.mjs: A3.6 (multi-tab + порядок сообщений при реконнекте).
8. Проверка: npm test && npm run test:e2e; A3.6 PASS; регрессия stage1/stage2.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; игровой контракт не меняется; ошибки — только ErrorCode; долгие операции вне транзакций, события через outbox; секреты только в env; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.7 — Плагин Audio Director (доказательство расширяемости)

```
Добавь независимый модуль аудио БЕЗ изменения ядра (критерий A3.5; закрывает F-8.7; проверяет сценарий v3 §X.3 и v2 §52). Это архитектурный тест в форме продукта.

1. contracts: AudioProvider-порт, схемы AudioJob (audioJobId, sessionId, turnId?, text, voice, status QUEUED|SUBMITTED|READY|FAILED|CANCELLED, url?, providerId, errorCode?, attempts, queuedAt, finishedAt), AudioJobView, события AUDIO_REQUESTED{audioJobId, sessionId, turnId, textHash}, AUDIO_READY{audioJobId, sessionId, url, providerId}, AUDIO_FAILED{audioJobId, sessionId, errorCode}, capability 'AUDIO_GENERATION' (уже в enum), WS-типы AUDIO_STARTED/AUDIO_READY/AUDIO_FAILED (политики BROADCAST в сессии), ErrorCode AUDIO_PROVIDER_FAILED, HTTP-маршруты GET /audio/jobs/:id и POST /gm/audio/request. CONTRACTS_VERSION minor.
2. modules/audio-director/ — новый пакет: contract.ts (defineModule: moduleId 'audio-director', subscribes ['TURN_COMMITTED','WORLD_EVENT_FIRED'], emits ['AUDIO_REQUESTED','AUDIO_READY','AUDIO_FAILED'], ports ['AudioProvider'], capabilities ['AUDIO_GENERATION'], dependencies []), service.ts: при TURN_COMMITTED берёт публичные сегменты narrative (≤ limits.audioMaxCharsPerTurn, default 1200) → создаёт job → воркер с лимитом audioMaxConcurrentPerSession=1 → AudioProvider.submit/poll → AUDIO_READY; при AUDIO_GENERATION unavailable — модуль НЕ подписывается на обработку (проверка registry.isAvailable) и молча пропускает (инвариант 9: optional module cannot break Core).
3. core/domain/ports/audio-port.ts — interface AudioProvider {providerId; capability:'AUDIO_GENERATION'; isAvailable(); submit({jobId, text, voice}); poll({externalJobId}) → QUEUED|READY{url}|FAILED{reason}; cancel?()}.
4. infrastructure/audio/mock-tts.ts — MockTTSAdapter: генерирует ВАЛИДНЫЙ WAV локально (44-байтный RIFF-заголовок + тишина или синусоида, длительность = text.length/15 c, sampleRate 16000, mono, 16-bit) — без внешних зависимостей; сохраняет через file-store; режимы MOCK_TTS_MODE=ok|slow|fail. (Реальный TTS-провайдер — backlog, UNKNOWN#4; интерфейс уже готов.)
5. Клиент: механизм UIPanelContribution (v3 §X.3) — client/src/plugins/registry.ts с интерфейсом {moduleId, panelId, title, mount(el), visibleWhen(ctx)} и точкой монтирования в GMPanel и в GameShell (отдельная вкладка/панель); client/src/plugins/audio-panel/ — реализация панели (список job'ов, плеер для последней озвучки, громкость, mute, кнопка «озвучить последний ход» для GM); audioStore. Панель появляется только если capability доступна (visibleWhen).
6. **Доказательство неизменности ядра (главный результат промпта):**
   - architecture-тест: core/** не импортирует modules/audio-director и infrastructure/audio (правило добавить в dependency-cruiser);
   - meta-тест (расширение 1.3): снимок списка файлов core/ (хэш-манифест) → добавление аудио-модуля не изменило ни одного файла в core/ (assert по хэшу манифеста, хранится в tests/arch/core-manifest.json и обновляется ТОЛЬКО осознанно);
   - регистрация модуля происходит в apps/server/src/modules-registry.ts одной строкой (показать в отчёте diff: сколько строк вне client/ и contracts/ было добавлено — целевой показатель «≤ 5 строк в bootstrap»).
7. Тесты: контракт AudioProvider для MockTTS (fixture); при TURN_COMMITTED создаётся job и приходит AUDIO_READY с играбельным WAV (проверить заголовок RIFF и длительность); fail-режим → AUDIO_FAILED, ход не затронут; disable capability → job'ы не создаются, игра без изменений; две вкладки получают AUDIO_READY; панель видна только при доступной capability.
8. tools/verify/stage3.mjs: A3.5 (модуль добавлен, core не изменён — assert по манифесту, озвучка приходит, отключение не ломает игру).
9. Проверка: npm test && npm run test:e2e && npm run test:arch; A3.5 PASS; регрессия stage1/stage2 (включая A1.14/A2.16).

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай (TTS-провайдера в этом этапе нет — только mock); игровой контракт не меняется; ошибки — только ErrorCode; долгие операции вне транзакций, события через outbox; секреты только в env; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.8 — Performance: сценарии и бюджет

```
Поставь производительность под контроль (критерий A3.6; закрывает F-9.3 — утерянный v2 §58). Основание: v3 §VI.10, §VIII.5; ROADMAP A3.6.

1. tools/perf/* на k6 (или artillery — выбрать и зафиксировать D151):
   - ws-load.js: 100 соединений (20 сессий? — при D108 одна активная сессия, поэтому 100 соединений = 12 игроков × вкладки + наблюдатели; скорректировать сценарий под фактическую модель и записать допущение), 10 msg/s на соединение в течение 5 минут, метрики: dropped messages, p95 обработки, ws.connections_active, event loop lag;
   - http-load.js: 50 rps смешанных GET (health, projection, chat history) + 5 rps мутирующих (action submit) — p95/p99, error rate;
   - turn-latency.js: 200 последовательных resolveTurn+commitTurn с ScriptedAI → p95 ≤ 200 мс (без AI-задержки);
   - soak.js: 30 минут смешанной нагрузки → heap growth < 10 % от установившегося значения, отсутствие роста RSS, отсутствие утечки FD (отчёт по /proc или process.report).
2. docs/PERFORMANCE.md — perf-бюджет (таблица: метрика, цель, как измеряем, что делаем при превышении) + фактические результаты первого прогона + профиль БД (рост на ход: байт на turn/actions/journal/outbox/chat/snapshots) + прогноз размера БД на 100 ходов и на 500 ходов.
3. Оптимизации ТОЛЬКО по факту измерения (принцип v3 §0.3 «не оптимизируем до метрик»): если p95 не в бюджете — сначала профиль (clinic.js / --prof), потом точечная правка (индекс, batch, отложенная сериализация), каждая правка — с замером до/после и записью D152+.
4. CI: отдельный job 'perf' (не блокирующий merge, но публикующий отчёт-артефакт) + nightly-прогон soak; в основном CI — короткий smoke (30 соединений, 30 с) с жёстким порогом error rate = 0.
5. WS-backpressure: проверить поведение при медленном клиенте (искусственная задержка чтения) — сервер не должен копить неограниченную очередь (лимит outbound queue на соединение, например 1000 сообщений → принудительный disconnect с кодом 4429 и запись ws.backpressure_drops_total); реализовать и покрыть тестом.
6. БД: проверить, что индексы из 1.4 реально используются (EXPLAIN QUERY PLAN на основных запросах: actions by turn, chat history by session+created_at, journal by turn, snapshots by session+version) — отчёт приложить в PERFORMANCE.md; при seq scan на горячих запросах — добавить индекс.
7. tools/verify/stage3.mjs: A3.6 — короткий perf-прогон (turn-latency + ws 30 соединений) с порогами из docs/PERFORMANCE.md.
8. Проверка: npm run perf:smoke; A3.6 PASS; регрессия stage1/stage2 (время прогона e2e не выросло более чем на 20 % — иначе исследовать).

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай (целевые значения perf-бюджета утверждает заказчик); игровой контракт не меняется; ошибки — только ErrorCode; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.9 — Документация (индекс v3 §IX.8)

```
Собери документацию продукта (критерий A3.7 частично; закрывает F-11.4). Основание: v3 §IX.8 (11 документов), §0.4 (две аудитории).

1. docs/ — 11 документов индекса v3 §IX.8: ARCHITECTURE.md (уже ведётся), MODULES.md, DOMAIN_EVENTS.md, WEBSOCKET_PROTOCOL.md, GAME_STATE.md, ROOM_SCHEMA.md, EVENT_SCHEMA.md (создан в 2.16), AI_CONTRACT.md, MEDIA_CONTRACT.md (создан в 2.16), HOST_BRIDGE.md, DEPLOYMENT.md (создаётся в 3.10).
2. **Генерация из кода (принцип «код — источник истины», D112):** tools/docs-gen.mjs — генерирует:
   - DOMAIN_EVENTS.md — из DomainEventSchema (таблица: событие, payload-поля, эмитент, подписчики из EVENT_SUBSCRIBERS);
   - WEBSOCKET_PROTOCOL.md — из WSClientMessage/WSServerMessage + WS_PRIVACY_POLICY (каталог типов, payload, политика приватности, ack, ошибки);
   - MODULES.md — из всех modules/*/src/contract.ts (moduleId, purpose, version, commands с сигнатурами Zod, queries, emits, subscribes, ports, dependencies, capabilities);
   - AI_CONTRACT.md / MEDIA_CONTRACT.md / HOST_BRIDGE.md — из портов и схем (AIPort, MediaProvider, VisualPromptProvider, AudioProvider, HostBridgeEnvelope);
   - GAME_STATE.md — из GameStateSchema + views (публичная/AI/GM-проекции) + таблица «кто может писать»;
   - ROOM_SCHEMA.md — из WorldPackSchema/LocationTemplateSchema + пример из content/worldpacks.
   Сгенерированные файлы помечаются шапкой «AUTO-GENERATED from @mnemosin/contracts vX — не редактировать вручную», исходник — tools/docs-gen.mjs.
3. Ручная часть (не генерируется): rationale, примеры сценариев, схемы последовательностей (mermaid), FAQ для product-team — по структуре v3 §0.4 (две аудитории: product-team читает ARCHITECTURE/ROADMAP/SPEC_*, LLM-implementer — всё).
4. CI-проверка расхождения: npm run docs:check — перегенерирует документы во временный каталог и сравнивает с закоммиченными; расхождение → CI красный (это и есть закрытие F-11.4 «какой документ первичен»: первичен код, документ проверяем).
5. docs/CONTRACTS_CHANGELOG.md — история изменений CONTRACTS_VERSION (major/minor/patch, что изменилось, миграция клиента).
6. README.md (корневой) — обновить: три этапа, быстрый старт, режимы провайдеров, как прогнать verify:stage1/2/3, карта документации, статус (какой этап сдан).
7. Проверка: npm run docs:gen && npm run docs:check; в CI docs:check зелёный; все 11 документов существуют и не пусты; ссылки внутри документов валидны (линк-чекер: lychee или самописный обход markdown-ссылок в CI).

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts (документы генерируются из него); не хватает данных — спроси, не изобретай; игровой контракт не меняется; в конце typecheck+lint+test+test:arch+docs:check; решения — D145+.
```

---

## Промпт 3.10 — Production: WSS, reverse-proxy, бэкапы, откат

```
Подготовь прод (критерий A3.7; закрывает F-5.7, F-9.4(a)). Основание: v3 §IX.7, v2 §59 (TLS, WSS, env, logging, backups, error monitoring).

1. deploy/reverse-proxy/: конфиг Caddy (предпочтительно: автоматический TLS) и альтернатива nginx — оба с: TLS (Let's Encrypt или self-signed для stage), прокси на 127.0.0.1:3000, апгрейд WS для /ws и /hostbridge (nginx: proxy_http_version 1.1 + Upgrade/Connection), таймауты (proxy_read_timeout 3600 для WS), gzip/br для статики, лимит тела клиента (1 МБ; /hostbridge/files — 32 МБ), security-заголовки, логи доступа с маскировкой query-параметра token (важно: токен в query для WS — не логировать; D153).
2. deploy/systemd/mnemosin.service — EnvironmentFile=/etc/mnemosin.env, Restart=always, RestartSec=3, LimitNOFILE=65536, ProtectSystem=strict, ReadWritePaths=/var/lib/mnemosin, NoNewPrivileges, пользователь mnemosin (не root); альтернатива PM2 — deploy/ecosystem.config.cjs.
3. Бэкапы (закрывает висячую ссылку v3 §VIII.2 на IX.7):
   - tools/backup.mjs — `PRAGMA wal_checkpoint(TRUNCATE)` → VACUUM INTO '/backup/tmp/mnemosin-<ts>.sqlite' → шифрование (openssl enc -aes-256-cbc -pbkdf2, ключ из BACKUP_PASSPHRASE или age/rclone-шифрование — выбрать и зафиксировать D154) → ротация (keep daily=7, weekly=4, monthly=6) → опциональная загрузка через rclone (конфиг в env, не в git);
   - systemd timer deploy/systemd/mnemosin-backup.timer (ежедневно в 04:00) + лог-файл;
   - tools/restore.mjs — расшифровка → проверка целостности (PRAGMA integrity_check + foreign_key_check) → подмена файла при остановленном сервисе → запуск → reconcileOnBoot → отчёт;
   - **restore drill** (обязательно, A3.7): tools/restore-drill.mjs — разворачивает бэкап во временный каталог, поднимает второй экземпляр на другом порту, прогоняет verify:stage1/2/3 в режиме read-only и печатает отчёт «данные восстановлены, версия N, ход M, игроков K»;
   - документировать RPO/RTO (цель: RPO ≤ 24 ч, RTO ≤ 15 мин) и проверить на drill.
4. Error monitoring: интеграция Sentry (dsn из env, опционально — при пустом SENTRY_DSN работает без неё): ошибки + unhandledRejection + turn.failures; release/trace propagation (traceId → Sentry tags); приватность: beforeSend удаляет rawText/text/privateMessages (связка с LOG_REDACT_FIELDS).
5. Rollback: deploy/rollback.sh — переключение symlink на предыдущий релиз (структура /var/lib/mnemosin/releases/<ts>), миграции forward-only (F-5.2), при необходимости — down.sql вручную с подтверждением; процедура описана в DEPLOYMENT.md и проверена на stage-сервере (шаг «откатить предыдущий релиз и убедиться, что verify:stage1 проходит»).
6. docs/DEPLOYMENT.md — env matrix из v3 §IX.7 (dev/stage/prod) фактическими значениями, пошаговый деплой, миграции, бэкапы/restore, мониторинг и алерты (ссылка на ALERTS.md), rollback, maintenance (VACUUM, очистка media по квоте), checklist «первый запуск».
7. Production-smoke: tools/smoke-prod.mjs — против указанного URL: /health, создание тестовой сессии, join, действие, lock, commit (scripted AI), проверка WSS-сертификата, /metrics недоступен снаружи (assert 403/404), статика отдаётся с CSP.
8. Тесты: backup → restore round-trip на тестовой БД (данные совпадают побайтово после расшифровки); шифрование: файл бэкапа не является SQLite (магические байты отсутствуют); при отсутствии BACKUP_PASSPHRASE backup.mjs падает с внятным сообщением; restore drill проходит в CI на фикстурной БД (без systemd).
9. tools/verify/stage3.mjs: A3.7 (backup/restore round-trip + smoke-prod в режиме локального reverse-proxy через docker или caddy в dev-режиме).
10. Проверка: npm test; локальный прогон: caddy + сервер → wss://localhost → smoke-prod зелёный; backup + restore drill зелёные; регрессия stage1/stage2.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай (хостинг, домен, RPO/RTO — решения заказчика); игровой контракт не меняется; секреты только в env; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.11 — Финальный аудит расширяемости

```
Проверь главный вопрос v3 §X / v2 §61: «можно ли добавить новую функцию, не изменяя Game Core?» (критерий A3.5; подтверждает X.1–X.3 как исполняемые тесты).

1. tests/extensibility/scenario-1-new-ai-provider.test.ts: добавить infrastructure/ai/xai-adapter.ts (реализует AIPort, внутри — fixture, сеть не вызывается), зарегистрировать в capabilities.yaml chain вторым, contract-тест AIPort проходит, core/ не изменён (assert по core-manifest.json из 3.7), модули не изменены (assert по манифесту modules/).
2. tests/extensibility/scenario-2-new-media-provider.test.ts: добавить infrastructure/media/stability-adapter.ts (MediaProvider, fixture-replay), chain ComfyUI → Stability → Debug, contract-тест submit/poll проходит, core/ и modules/media-director не изменены.
3. tests/extensibility/scenario-3-new-module.test.ts: аудио-модуль из 3.7 — формальная проверка: регистрируется в modules-registry одной строкой, добавляет capability, подписывается на существующие события, предоставляет UI-панель через UIPanelContribution; core/, gateways/, modules/{turn,ai-director,media-director} не изменены.
4. tests/extensibility/manifest.test.ts — обобщение: хранит хэш-манифест «защищённых» каталогов (core/**, shared/contracts/** кроме разрешённых minor-изменений) и сверяет; любое изменение требует явного обновления манифеста с комментарием и записи D155+. Это механическая гарантия инвариантов 1–3 и 9.
5. Отчёт: docs/EXTENSIBILITY_AUDIT.md — таблица «сценарий / сколько файлов вне нового модуля изменено / какие / почему» (цель: 0 файлов в core, ≤ 5 строк в bootstrap, ≤ 1 строка в config). Расхождения — как backlog-задачи.
6. tools/verify/stage3.mjs: A3.5 (все три сценария зелёные).
7. Проверка: npm run test:arch && npm test; A3.5 PASS; регрессия stage1/stage2.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; игровой контракт не меняется; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.12 — Регрессия, release-чеклист, тег

```
Собери релиз (критерий A3.8). Основание: ROADMAP §5, v3 §IX.7.

1. npm run verify:all — последовательный прогон verify:stage1 (16), verify:stage2 (16), verify:stage3 (8) → единая таблица 40 критериев PASS/FAIL, ненулевой exit при любом FAIL. Это главный артефакт приёмки продукта.
2. CI: полный пайплайн v3 §IX.7 + этапы 2–3 (lint → typecheck → unit → integration → arch → contract → build → e2e stage1+stage2+stage3 → perf:smoke → docs:check → npm audit → gitleaks → license-check → verify:all) + nightly (soak, live-тесты по workflow_dispatch).
3. Версионирование: CHANGELOG.md (Keep a Changelog), версия пакета и CONTRACTS_VERSION, git tag vX.Y.Z; правило: мажор CONTRACTS_VERSION — только с записью о миграции клиента.
4. docs/RELEASE_CHECKLIST.md — чек-лист релиза: миграции применены, бэкап сделан, verify:all зелёный, smoke-prod пройден, ALERTS подключены, rollback-путь проверен, SECURITY-чеклист v3 §VIII.3 пройден (11 пунктов, фактические ссылки на тесты), документация сгенерирована, perf-бюджет в норме.
5. Прогнать SECURITY-чеклист v3 §VIII.3 буквально, каждый пункт — со ссылкой на конкретный тест; недостающие тесты дописать (обычно: «логи не содержат rawText с приватными ключами», «CORS ограничен доменом фронта», «секреты в env, не в git»).
6. Финальная приёмка: чистый клон → npm ci → db:migrate → verify:all → 40/40 PASS; деплой на stage по DEPLOYMENT.md → smoke-prod → restore drill. Отчёт приложить к сообщению.
7. Проверка: всё вышеперечисленное зелёное; A3.8 PASS.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; игровой контракт не меняется; секреты только в env; в конце typecheck+lint+test+test:arch и verify:all; решения — D145+.
```

---

## Промпт 3.13 — Export/import сессии

```
Реализуй перенос партии (закрывает UNKNOWN#8; backlog v3 §X.5). Основание: v3 §X.4 #8.

1. contracts: SessionBundleSchema {bundleVersion:'1', exportedAt, source:{serverVersion, contractsVersion}, session, players[], characters[], locations[], worldEvents[], rulesBundles[], gameState, turns[] (полные, с resolution), actions[], chatMessages[] (с visibility), journal[] (опционально, includeJournal:boolean), gmNotes[] (опционально, includeGmSecrets:boolean — по умолчанию false), snapshots[] (опционально), remaps[], mediaManifest[] (ссылки на файлы, без бинаря)}.
2. modules/session/src/export.ts — exportSession({sessionId, options}) → bundle (Zod-валиден); опции: includeJournal, includeGmSecrets, includeChat, mediaFiles:'none'|'manifest'|'archive' (archive → zip с файлами из file-store, размер ограничен bundleMaxBytes).
3. modules/session/src/import.ts — importSession({bundle, mode:'new'|'overwrite', idempotencyKey}):
   - валидация bundleVersion и contractsVersion (несовместимый major → отказ с ErrorCode BUNDLE_INCOMPATIBLE);
   - режим 'new': генерируются НОВЫЕ uuid для всех сущностей, remap применяется ко всем ссылкам (переиспользовать механизм из 2.3), sessionId новый;
   - проверка целостности: все ссылки резолвятся, FK не нарушены (транзакция, при ошибке — полный откат);
   - при D108 (одна активная сессия) импорт возможен только если текущая сессия ENDED или в архив (статус ARCHIVED — добавить в SessionStatus? НЕТ: не менять игровой контракт; использовать ENDED + флаг archived_at в таблице sessions) — решение D156;
   - медиа-файлы: из archive восстанавливаются в file-store с новыми jobId, url пересчитывается.
4. API: POST /gm/sessions/:id/export (auth GM) → bundle JSON или файл; POST /gm/sessions/import (multipart) → {sessionId}; WS-уведомление GM о результате. Добавить в contracts HTTP_ROUTES.
5. UI: GM-панель → Export/Import (выбор опций, скачивание файла, загрузка, предупреждение «секреты GM не включены» при includeGmSecrets=false).
6. Тесты: round-trip export→import→сверка GameState/turns/actions/chat (canonical JSON, кроме uuid); импорт с includeGmSecrets=false не содержит GM_ONLY-заметок (grep); битый bundle → отказ без частичной записи (assert по БД); импорт при активной сессии → отказ с понятной причиной; media archive round-trip (файлы совпадают по hash); bundleVersion несовместим → BUNDLE_INCOMPATIBLE.
7. tools/verify/stage3.mjs: пункт export/import round-trip.
8. Проверка: npm test && npm run test:e2e && npm run test:arch; регрессия verify:all.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; игровой контракт не меняется; ошибки — только ErrorCode; идемпотентность обязательна; секреты только в env; в конце typecheck+lint+test+test:arch и tools/verify/stage3.mjs; решения — D145+.
```

---

## Промпт 3.14 — Backlog-триаж и передача

```
Закрой этап и подготовь проект к дальнейшему развитию (закрывает F-11.1, F-11.5, UNKNOWN#7, UNKNOWN#10). Основание: v3 §X.4–X.5, ROADMAP §5.

1. Проведи аудит остатка: по `MNEMOSIN_v3_AUDIT.md` — для каждого F-*/B-* статус (closed в каком промпте / open / won't fix с причиной). Результат — docs/AUDIT_STATUS.md (таблица из 113 позиций + 12 блокеров). Цель: 0 открытых P0/P1, P2/P3 — в backlog с приоритетом.
2. UNKNOWN-реестр v3 §X.4 (10 пунктов) — фактический статус: #1 (OpenRouter structured output) закрыт в 2.6, #3 (LMStudio) — в 2.7, #5 (бюджеты) — в 2.8, #6 (snapshot) — в 3.1, #8 (export) — в 3.13, #9 (multi-session) — D108 (одна сессия, схема готова к расширению), #10 (миграции) — политика forward-only + down.sql + restore drill (3.10), #2 (CloudImageProvider) и #4 (TTS-провайдер) и #7 (storyFlags между партиями) — backlog с критериями готовности. Всё — в docs/UNKNOWN_STATUS.md.
3. Backlog v3 §X.5 → GitHub/GitLab issues (или docs/BACKLOG.md при отсутствии трекера): Analytics, Achievements, Video, Multi-session, Voice/TTS real-time, внешний API для GM-инструментов, drag-and-drop редактор локаций, OAuth. По каждому: ценность, оценка, зависимости, критерии приёмки (2–4 пункта), что нужно решить заранее.
4. Git flow (закрывает F-11.5): docs/CONTRIBUTING.md — ветки (main защищён, feature/*, release/*, hotfix/*), правила коммитов (Conventional Commits), PR-чеклист (типизация, тесты, verify, docs:check, контракты → CONTRACTS_CHANGELOG, решения → ARCHITECTURE D155+), релизный процесс (release/* → тег → deploy → rollback-путь), CODEOWNERS.
5. Передача: docs/HANDOVER.md — как устроен проект (карта пакетов + схема зависимостей), как запустить (dev/stage/prod), как проверять (verify:all), как добавлять провайдера/модуль (пошагово, со ссылкой на 3.11), как принимать решения (лог D101–D155+), где документация (индекс), что в backlog, кого спрашивать.
6. План v4: docs/ROADMAP_NEXT.md — что делать после этапа 3 (кандидат: реальный TTS-провайдер, multi-session, analytics-модуль, редактор world-pack'ов для GM), с теми же критериями приёмки и оценками; формат — как ROADMAP.md.
7. Финальный отчёт заказчику: сводка «40 критериев / 43 промпта / 113 дефектов аудита (закрыто N) / 10 UNKNOWN (закрыто M)», perf-факт, стоимость хода, что дальше.
8. Проверка: npm run verify:all → 40/40; npm run docs:check; все документы из п.2–п.6 существуют; git tag выставлен.

ОБЩИЕ ПРАВИЛА ЭТАПА 3: монорепо/ESM/TS strict Node>=22; источник истины — @mnemosin/contracts; не хватает данных — спроси, не изобретай; игровой контракт не меняется; решения — D145+.
```

---

## Приёмка этапа 3 (чек-лист для человека)

- [ ] `npm run verify:all` → **40/40 PASS** (A1.1–A1.16, A2.1–A2.16, A3.1–A3.8).
- [ ] `kill -9` во время commit → восстановление без потери и без дублей (A3.1); restore drill из бэкапа прошёл (A3.7).
- [ ] `/metrics` отдаёт все метрики, `docs/ALERTS.md` содержит правила, `traceId` проходит сквозь все слои (A3.2).
- [ ] Все 11 сценариев v3 §VIII.7 покрыты тестами и описаны в `docs/RUNBOOK.md` (A3.3).
- [ ] STRIDE-таблица v3 §VIII.2 полностью покрыта тестами; CI содержит `npm audit`, gitleaks, license-check (A3.4).
- [ ] **Audio Director добавлен без единого изменения в `core/`** — манифест-тест зелёный, отчёт в `docs/EXTENSIBILITY_AUDIT.md` (A3.5).
- [ ] `docs/PERFORMANCE.md`: p95 `resolveTurn` ≤ 200 мс, 100 WS-соединений × 10 msg/s без потерь, soak 30 мин без утечки (A3.6).
- [ ] 11 документов индекса v3 §IX.8 существуют, сгенерированы из contracts, `docs:check` зелёный (A3.7).
- [ ] Прод-развёртывание на stage: WSS, systemd, бэкап по расписанию, rollback проверен, Sentry подключён (A3.7).
- [ ] `docs/AUDIT_STATUS.md`: 0 открытых P0/P1; `docs/UNKNOWN_STATUS.md`: из 10 UNKNOWN закрыто ≥ 7.
- [ ] Релиз: CHANGELOG, тег `v1.0.0`, `docs/HANDOVER.md`, `docs/ROADMAP_NEXT.md`.
