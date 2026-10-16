# МНЕМОСИН — этап 1 «Стол» (Table MVP)

Мультиплеерная интерактивная игра с ведущим (GM-in-the-loop): игроки подают
действия, AI-Директор собирает черновик разрешения хода, GM ревьюит/правит и
коммитит его в мир. Этап 1 — полностью офлайн: все внешние зависимости
заменены стендами, прогон не требует ключей и сети.

- **Стек:** Node ≥ 22, TypeScript (strict), Fastify + нативный WebSocket,
  SQLite + Drizzle, npm workspaces (modular monolith, Ports & Adapters),
  клиент — Svelte 5 + Vite (MPA: `/player/` и `/gm/`), e2e — Playwright.
- **Источник истины типов и протоколов:** `@mnemosin/contracts` (Zod-схемы
  WS/HTTP-каталогов, доменные модели, ERROR_TABLE с clientAction).
- **Приёмка этапа:** `node tools/verify/stage1.mjs` → таблица **A1.1–A1.16,
  16/16 PASS** (ноль-код возврата только при полном PASS).

## Быстрый старт

```bash
cp .env.example .env          # заполнить JWT_SECRET (≥32 символа) и DATABASE_URL
npm install                   # npm workspaces
npm run db:migrate -- file:./data/mnemosin.sqlite   # миграции SQLite (CLI; bootstrap сервера применяет их и при старте, fail-fast)
npm run dev                   # сервер :3000 (tsx watch)
npm run dev -w client         # (опционально) vite dev :5173 c proxy /health и /ws → :3000
```

Генерация секрета: `node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"`.

Продакшен-сборка клиента: `npm run build -w client` — `client/dist` отдаётся
сервером статикой (same-origin: `/player/`, `/gm/`). В dev клиент ходит на
`:3000` напрямую (CORS для `localhost:5173` разрешён вне production).

Первый вход: GM — `http://localhost:3000/gm/` («Создать сессию» или токен),
игроки — `http://localhost:3000/player/?session=<id>` (displayName +
characterName, D157). Токены хранятся только в sessionStorage (D126).

## Режимы провайдеров (переключение — ТОЛЬКО env, A1.12)

| Env                   | Значения                              | Смысл                                                                                                                                                                                                                                                                                                                                       |
| --------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AI_PROVIDER`         | `scripted` \| `echo` \| `failing`     | Этап 1: офлайн-стенды. `scripted` — детерминированный JSON из фикстуры `tools/fixtures/resolution.ok.json`; `echo` — нарратив из текстов действий; `failing` — отказ (`AI_FAILING_MODE`: `timeout`/`schema`/`rate_limit`/`unavailable`) для проверок деградации (A1.12/A1.13). Этап 2 добавит `openrouter`/`lmstudio` одним файлом (A1.14). |
| `AI_SCRIPTED_FIXTURE` | путь к фикстуре                       | Для `scripted`.                                                                                                                                                                                                                                                                                                                             |
| `AI_FAILING_MODE`     | см. выше                              | Для `failing`.                                                                                                                                                                                                                                                                                                                              |
| `MEDIA_PROVIDER`      | `none` \| `debug` (этап 2: `comfyui`) | Этап 1 не регистрирует media-провайдеров; `CAPABILITY_CHANGED` сообщает «нет провайдера».                                                                                                                                                                                                                                                   |

Capability Registry с circuit breaker: после `failureThreshold` провалов
публикуется `CAPABILITY_CHANGED{available:false}`, `/health` отражает
деградацию (A1.13). Сценарий деградации: `tools/verify/switch-provider.mjs`
и `e2e/degraded.spec.ts` (config-фикстура `tools/verify/fixtures/config-failing`).

## Проверки

```bash
npm run lint              # eslint (границы слоёв) + prettier --check
npm run typecheck         # tsc -b по всему монорепо
npm test                  # vitest: unit + integration + arch + contract
npm run test:unit         #   домен и сервисы
npm run test:integration  #   БД/транспорт (SQLite, WS, HTTP)
npm run test:arch         #   архитектурные границы (инвариант 15 и др.)
npm run test:contract     #   Zod-схемы и модульные контракты
npx vitest run --coverage #   покрытие + пороги v3 §IX.5 (core ≥90%, modules ≥75%, adapters/gateways ≥60%)
npm run arch:cruiser      # dependency-cruiser по графу пакетов
npm run test:e2e          # Playwright: e2e/*.spec.ts (сервер поднимается сам)
npm run test:e2e -- e2e/player.spec.ts   # один файл
npm run verify:stage1     # ПРИЁМКА: A1.1–A1.16 на живом сервере, таблица PASS/FAIL
```

`npm run verify:stage1` — главный артефакт приёмки этапа: поднимает серверы,
гоняет HTTP/WS/БД-assert'ы и браузерный сценарий «Стол» (7 контекстов),
печатает таблицу 16 критериев и возвращает ненулевой код при любом FAIL.
E2E требуют установленных браузеров: `npx playwright install chromium`.

## Карта пакетов и правила зависимостей

```text
shared/contracts   ←  core  ←  modules/*  ←  infrastructure/*, gateways/*  ←  apps/server
client  ←  shared/contracts   (ТОЛЬКО контракты + svelte* + zod; инвариант 15)
```

| Пакет                          | Назначение                                                                                                                                                             |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/contracts`             | Zod-схемы: WS-каталог (28 c→s / 35 s→c) с матрицей приватности, HTTP-каталог (45 маршрутов), домен, ERROR_TABLE, DSL. Leaf-пакет.                                      |
| `core`                         | Домен: машины состояний Turn/Session, StateService (единственный путь мутации GameState), LocationService, журнал, шина событий, порты. Без инфраструктуры.            |
| `modules/*`                    | Прикладные модули: session, turn (Turn Engine), chat, story, gm, gm-review, gm-audit, ai-director. Общаются через порты core; wiring — только в apps/server (D161).    |
| `infrastructure/*`             | Адаптеры: config (env+yaml), logging (pino, traceId, redact), database (SQLite+Drizzle, репозитории, идемпотентность, outbox), ai (стенды+registry), jobs (scheduler). |
| `gateways/http`, `gateways/ws` | Транспорт: JWT-auth, маршруты ИЗ contracts, единый error handler; WS-handshake (subprotocol `mnemosin.v1.<jwt>`, D123), проекции и приватность (ws/projections.ts).    |
| `apps/server`                  | Composition root: bootstrap БД, шина+outbox, reconcileOnBoot (D127), wiring модулей, listen, graceful shutdown.                                                        |
| `client`                       | Svelte 5 + Vite: WSClient (reconnect/offline-queue/heartbeat), stores (svelte/store, D125), UI игрока и GM, privacy (D126).                                            |
| `e2e`, `tests`, `tools`        | Playwright-сценарии, vitest-проекты (unit/integration/arch/contract), verify-скрипты и фикстуры.                                                                       |

Границы контролируются на трёх уровнях: eslint `no-restricted-imports`,
dependency-cruiser (`.dependency-cruiser.cjs`), arch-тесты
(`tests/arch/*`, манифест core). Нарушение ловится до запуска.

## Документация

- `docs/ROADMAP.md` — 3 этапа, границы «входит/не входит», 40 критериев приёмки, ворота.
- `docs/SPEC_STAGE1.md` — спецификация этапа 1 по факту реализации (протоколы, модели, A1.1–A1.16, D113–D127).
- `docs/ARCHITECTURE.md` — журнал решений (D113–D287+), структура, правила зависимостей, отличия от v3.
- `docs/DEV_PLAN_STAGE1..3.md` — промпты разработки; `docs/AUDIT.md`, `docs/CONTRACTS_CHANGELOG.md`.
- `docs/RUN_ON_YOUR_PC.md` — подробный локальный прогон.

## Лицензия и статус

Этап 1 завершён: `verify:stage1` = 16/16 PASS, e2e зелёные, CI
(`.github/workflows/ci.yml`) повторяет приёмку на каждый push/PR.
