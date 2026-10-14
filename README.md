# МНЕМОСИН

Веб-платформа мультиплеерной интерактивной игры (6+ игроков и GM). Партию ведёт AI Director, GM ревьюит и коммитит ход.
Архитектура: **Modular Monolith + Ports & Adapters + Domain Events**.

> Статус: **этап 1 «Стол»**, выполнен промпт **1.6** (доменные сервисы core: машины состояний Turn/Session, StateService, LocationService/moveGroup; 252 теста; `verify:stage1` = 10 PASS / 0 FAIL).
> План — `docs/`; приёмка — `npm run verify:stage1`.

## Быстрый старт

```bash
node --version          # цель: Node 22 LTS+ (.nvmrc); проверено также на 20.20.2 — см. docs/ARCHITECTURE.md D159
npm install
cp .env.example .env    # и заполнить JWT_SECRET + DATABASE_URL
npm run dev             # http://localhost:3000/health
```

Сгенерировать секрет:

```bash
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Без `JWT_SECRET` (или при длине < 32) процесс завершается с сообщением `CONFIG_INVALID: …` — значение секрета при этом не выводится (критерий A1.1).

## Проверки

```bash
npm run typecheck        # tsc -b: типы и сборка всех пакетов
npm run lint             # eslint + prettier
npm test                 # vitest (unit | integration | arch | contract)
npm run verify:stage1    # приёмка этапа 1: A1.1–A1.16 (PASS / FAIL / N/A)
```

## Документация

| Файл                        | Что                                                                                       |
| --------------------------- | ----------------------------------------------------------------------------------------- |
| `docs/ROADMAP.md`           | три этапа, границы, 40 критериев приёмки, ворота, риски, D101–D112                        |
| `docs/SPEC_STAGE1.md`       | спецификация этапа 1: роли, машины состояний, WS/HTTP-каталоги, модель данных, A1.1–A1.16 |
| `docs/DEV_PLAN_STAGE1.md`   | 13 промптов этапа 1                                                                       |
| `docs/DEV_PLAN_STAGE2.md`   | 16 промптов этапа 2 «Мир и AI»                                                            |
| `docs/DEV_PLAN_STAGE3.md`   | 14 промптов этапа 3 «Прод и расширяемость»                                                |
| `docs/ARCHITECTURE.md`      | лог решений (D101+), структура, правила зависимостей, вопросы заказчику                   |
| `docs/MNEMOSIN_v3_AUDIT.md` | реестр из 113 дефектов baseline-документа v3                                              |

## Режимы провайдеров (этап 1)

Внешние сервисы не нужны: `AIPort` реализован офлайн-стендами.

| `AI_PROVIDER` | Поведение                                                                               |
| ------------- | --------------------------------------------------------------------------------------- |
| `scripted`    | детерминированный ответ из `tools/fixtures/resolution.ok.json` (появится в промпте 1.7) |
| `echo`        | нарратив собирается из действий игроков                                                 |
| `failing`     | имитация отказа: `AI_FAILING_MODE=timeout\|schema\|rate_limit\|unavailable`             |

`MEDIA_PROVIDER=none` в этапе 1 (визуал — этап 2: `debug`, затем `comfyui` через HostBridge).

## Правила разработки

1. Источник истины — `@mnemosin/contracts`; ни один пакет не объявляет доменные схемы у себя (D112).
2. Не хватает данных или решения — остановиться и спросить, не изобретать.
3. Любое принятое решение — следующей записью в `docs/ARCHITECTURE.md` (D113+).
4. Долгие операции (AI, media) — никогда внутри транзакции; доменные события — после COMMIT через outbox.
5. Промпт завершён, только когда `typecheck + lint + test` зелёные и критерии продемонстрированы на живом процессе.
