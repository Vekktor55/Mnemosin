# @mnemosin/contracts — Change Log

Все изменения публичных контрактов фиксируются здесь. При любом изменении схем повышается версия набора публичных контрактов (`CONTRACTS_VERSION`), а не версия private workspace package.

## Versioning policy

`shared/contracts` помечен `private: true` и не публикуется в npm registry.

Разграничиваются два независимых номера:

| Номер                         | Источник                                       | Назначение                                                                                                                                                                                                 |
| ----------------------------- | ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Workspace package version** | `shared/contracts/package.json` (`0.4.0`)      | Идентификатор npm-воркспейс-пакета; не публикуется, меняется по правилам npm-версионирования только при необходимости сборки/публикации                                                                    |
| **Public contracts version**  | `CONTRACTS_VERSION` в `src/index.ts` (`1.0.0`) | Версия набора публичных контрактов (schemas/types/IDs), передаваемая в `HELLO`/`connection:welcome` и используемая для проверки совместимости клиент/сервер. Повышается при любом изменении публичных схем |

**Правила повышения `CONTRACTS_VERSION`:**

- **Major** (`X+1.0.0`) — breaking changes: удаление/переименование полей, изменение типа, удаление message type.
- **Minor** (`X.Y+1.0`) — добавление новых схем/типов без изменения существующих.
- **Patch** (`X.Y.Z+1`) — уточнение валидации без изменения формы.

**Текущее состояние:** `package.json` `0.4.0` отстаёт от `CONTRACTS_VERSION` `1.0.0` —
это **pre-existing mismatch**, не требующий исправления, пока пакет `private` и не публикуется.
`CONTRACTS_VERSION` `1.0.0` синхронизирован с записью `## 1.0.0` ниже.

---

## 1.0.0 — 2026-11-25 (P06 durable bridge corrections)

### Breaking

- `scene:durable-event` теперь содержит полный строгий `HotGameplayEventEnvelope` с discriminated payload (`prototype.item.acquired`, `prototype.filter.depleted`, `prototype.capture.recorded`); неструктурированный `payload: unknown` удалён.
- Удалён мёртвый compatibility-export `ColdToHotCommandEnvelopeSchema` / `ColdToHotCommandEnvelope` (потребителей в репозитории нет). Канонические имена — `ColdToHotCommandSchema` / `ColdToHotCommand` в `transport/hot-event.ts`.

### Added

- `ColdToHotJournalPayloadSchema` и `JournalKind += cold_to_hot_committed`: журнал хранит саму revisioned COLD→HOT команду для восстановления, а не вычисляет ревизию из GameState.version.
- `CommandName += processColdToHotCommand` для durable idempotency COLD-команд через существующий `IdempotencyService`.
- `SceneObject.taken?: boolean` — публичный committed COLD-факт в keyframe/projection после reconnect.

### Compatibility notes

- Существующие HOT movement input/ACK, scene:keyframe/delta/resync и handshake не изменены.
- HOT↔COLD схемы вынесены в `transport/hot-event.ts`; прежние exports через `transport/envelope.ts` сохранены, кроме удалённого compatibility-alias `ColdToHotCommandEnvelopeSchema`.
- Production durability guarantees HC-06…HC-10 этим версионированием не закрываются.

---

## 0.7.0 — 2026-11-20 (Zod 4.6.7 compatibility)

### Changed

- Все 11 workspace-пакетов с прямой Zod-зависимостью обновлены с `^3.25.76` до `^4.6.7`; в дереве остаётся одна версия `zod@4.6.7`.
- Объектные defaults переведены на `.prefault()`, чтобы вложенные поля по-прежнему нормализовались парсером (provider retries/circuit breaker, action metadata, config limits).
- Для необязательных capability chains используется `z.partialRecord()` вместо exhaustive `z.record()` с enum-ключами.
- Типы `ZodType`, discriminated envelope и transform-default в env адаптированы к Zod 4.
- Добавлен общий `zodIssuesToMeta()` для HTTP и WS: наружу выходят только `path`, `code`, `message`; максимум 10 issues и 80 символов на сообщение. Внутренние поля Zod 4 (`expected`, `received`, `format`, `pattern`) не передаются.
- Добавлены contract-регрессии [errors.test.ts](../tests/contract/errors.test.ts) для формата ошибок и её лимитов.
- Тестовые UUID в `worldpack.test.json` приведены к RFC-совместимым v4/variant-представлениям; production-ограничение UUID не ослаблено.

### Compatibility notes

- Форма доменных схем и transport envelope не изменена.
- Текст ошибок валидации может отличаться от Zod 3; стабильная публичная форма issues и лимиты сохранены.
- Private workspace package version остаётся `0.4.0`; повышается только `CONTRACTS_VERSION` согласно политике выше.

---

## 0.6.0 — 2026-11-19 (P02: Shared Contracts Foundation)

### Added

**Common identifiers (ids.ts):**

- `MatchId` — идентификатор матча/партии (отделен от SessionId для будущего Match aggregate)
- `ParticipantId` — идентификатор участника матча (player/observer/developer в контексте матча)
- `WorldId` — идентификатор игрового мира/комплекса
- `FloorId` — идентификатор этажа
- `WorldEpoch` — поколение активного пространственного состояния (инкрементируется при переходе/сбросе мира); НЕ версия World Pack (см. `worldPackVersion` в scene keyframe)
- `CommandId` — идентификатор COLD команды (для идемпотентности и корреляции)
- `InputStreamId` — идентификатор потока ввода движения (connection epoch)
- `InputSequence` — порядковый номер ввода в пределах одного input stream
- `SceneSequence` — порядковый номер scene replication update
- `SimulationTick` — номер HOT simulation tick
- `ProjectionRevision` — ревизия COLD projection / read model
- `EventSequence` — порядковый номер durable event
- `ConnectionEpoch` — поколение соединения

**Transport envelopes (transport/envelope.ts):**

- `WSEnvelopeSchema` — общий message envelope для WebSocket v4
- `WSClientMessageType` / `WSServerMessageType` — минимальный каталог типов сообщений v4 (per NETWORK_PROTOCOL.md §6)
- `HotGameplayEventEnvelopeSchema` — HOT→COLD durable event envelope (per HOT_COLD_DESIGN.md §7.2)
- `ColdToHotCommandEnvelopeSchema` — COLD→HOT command envelope (per HOT_COLD_DESIGN.md §7.3)
- `SceneKeyframePayloadSchema` / `SceneDeltaPayloadSchema` — scene replication payloads (per NETWORK_PROTOCOL.md §9)
- `InteractionCommandPayloadSchema` — interaction command (per NETWORK_PROTOCOL.md §11)
- `ChatSendPayloadSchema` — chat send (per NETWORK_PROTOCOL.md §12)
- `AndrewAskPayloadSchema` — andrew ask (per NETWORK_PROTOCOL.md §14)
- `DomainCommandPayloadSchema` / `ObserverCommandPayloadSchema` — domain/observer commands (per NETWORK_PROTOCOL.md §13, §15)

**Spatial primitives (transport/spatial.ts):**

- `WorldPositionSchema` / `GridCellSchema` / `SpatialPositionSchema` — базовые пространственные типы (G2 coordinate convention)
- `MovementInputSchema` — movement input (G1: held direction, not target position)
- `SceneInputMessageSchema` / `SceneResyncMessageSchema` — scene input/resync
- `ConnectionWelcomeMessageSchema` / `ConnectionReadyMessageSchema` / `ConnectionPongMessageSchema` / `ConnectionErrorMessageSchema` — connection lifecycle
- `SceneInputAckMessageSchema` / `SceneResyncRequiredMessageSchema` — scene ack/resync
- `CommandResultMessageSchema` / `DomainEventMessageSchema` / `MatchProjectionMessageSchema` / `ObserverProjectionMessageSchema` / `DeveloperDiagnosticMessageSchema` — server→client message payloads

**v4 Projections (transport/views.ts):**

- `PlayerProjectionSchema` — Player projection (NETWORK_PROTOCOL.md §10.2): только публичные данные + знания игрока
- `ObserverProjectionSchema` — Observer projection (NETWORK_PROTOCOL.md §10.3): полная видимость скрытого игрового состояния
- `DeveloperProjectionSchema` — Developer projection (NETWORK_PROTOCOL.md §10.4): техническая диагностика

### Changed

**Legacy projections marked for migration:**

- `PublicGameStateViewSchema` / `PlayerGameStateViewSchema` / `GMStateViewSchema` — сохранены для обратной совместимости (Stage 1), помечены как LEGACY, будут удалены/мигрированы в P02/P05

**Contract exports (index.ts):**

- Добавлены экспорты `transport/envelope.js` и `transport/spatial.js`

### Migration mapping (old WS messages → v4)

> Категории v4: `scene:keyframe`/`scene:delta` — ПРОСТРАНСТВЕННОЕ состояние
> (replication, NETWORK_PROTOCOL.md §9); `match:projection`/`observer:projection` —
> ИГРОВОЕ состояние (COLD read model, §10). Старые `STATE_PROJECTION`/`GM_STATE` —
> игровые проекции, а НЕ эквивалент scene replication. GM-команды НЕ переносятся
> в `observer:command` автоматически (God Actions не утверждены — P11, OWNER INPUT REQUIRED).

| Old message type                                                      | Target Action | Migration Status                                                                 | v4 equivalent                                                                  |
| --------------------------------------------------------------------- | ------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `TURN_*` family (OPEN_TURN, LOCK_TURN, COMMIT_TURN, etc.)             | REMOVE        | **Deferred** — схемы сохранены (domain/turn.ts, ws.ts)                           | Turn Engine удалён в v4; заменяется `domain:command` + HOT/COLD events         |
| `GM_OPEN_TURN` / `GM_LOCK_TURN` / `GM_UNLOCK_TURN` / `GM_COMMIT_TURN` | REMOVE        | **Deferred** — сохранены (ws.ts)                                                 | Turn Engine flow — development only                                            |
| `GM_EDIT_APPROVE` / `GM_REJECT_TURN` / `GM_RETRY_AI`                  | REMOVE        | **Deferred** — сохранены (ws.ts)                                                 | GM Review — development only                                                   |
| `GM_MOVE_GROUP`                                                       | REPLACE       | **Deferred** — схема сохранена                                                   | `domain:command` (move_group), НЕ `observer:command`                           |
| `GM_SET_FLAG`                                                         | REPLACE       | **Deferred** — схема сохранена                                                   | `domain:command` (set_story_flag), НЕ `observer:command`                       |
| `GM_KICK_PLAYER` / `GM_END_SESSION` / `GM_PAUSE` / `GM_RESUME`        | REPLACE       | **OWNER INPUT REQUIRED** — session management; роль GM vs Observer не определена | DEFERRED (P10 Match lifecycle) — НЕ `observer:command`                         |
| `GM_SYSTEM_MESSAGE` / `GM_ADD_NOTE` / `GM_ACTIVATE_EVENT`             | REPLACE       | **OWNER INPUT REQUIRED** — GM-only действия                                      | DEFERRED (P09/P11) — НЕ `observer:command`                                     |
| `GM_REQUEST_SCENE` / `GM_CANCEL_MEDIA_JOB`                            | REPLACE       | **OWNER INPUT REQUIRED** — GM-only действия                                      | DEFERRED (P12 media) — НЕ `observer:command`                                   |
| `ACTION_SUBMIT`                                                       | REPLACE       | **Deferred** — схема сохранена (ws.ts)                                           | `scene:input` (movement) + `domain:command` (P09+)                             |
| `CHAT_PUBLIC` / `CHAT_PRIVATE`                                        | REPLACE       | **Deferred** — схемы сохранены (ws.ts)                                           | `chat:send` (P09)                                                              |
| `STATE_PROJECTION` / `STATE_PROJECTION_PRIVATE`                       | REPLACE       | **Deferred** — схемы сохранены (views.ts, legacy)                                | `match:projection` (PlayerProjection) — игровая проекция, НЕ scene replication |
| `GM_STATE`                                                            | REPLACE       | **Deferred** — схема сохранена (views.ts, legacy)                                | `observer:projection` (ObserverProjection) — read-only omniscient view         |
| `TURN_DRAFT_READY` / `TURN_RESOLUTION_GM` / `TURN_COMMITTED`          | REMOVE        | **Deferred** — legacy turn resolution сохранены                                  | Legacy turn resolution flow                                                    |
| `TURN_PRIVATE_RESOLUTION` / `TURN_FAILED`                             | REMOVE        | **Deferred** — legacy turn resolution сохранены                                  | Legacy turn resolution flow                                                    |
| `GM_ACTION_ACK` / `GM_NOTE_ACK` / `GM_AI_CONTEXT`                     | REMOVE        | **Deferred** — legacy GM workflow сохранены                                      | Legacy GM workflow                                                             |
| `CAPABILITY_CHANGED` / `BUDGET_WARNING` / `BUDGET_EXCEEDED`           | PRESERVE      | Active                                                                           | Остаются (provider capabilities)                                               |
| `MEDIA_*` / `AUDIO_*`                                                 | PRESERVE      | Active                                                                           | Остаются (media generation)                                                    |
| `ERROR`                                                               | PRESERVE      | Active                                                                           | Остаётся (transport errors)                                                    |
| `PING` / `PONG`                                                       | REPLACE       | **Deferred** — старые схемы сохранены                                            | `connection:ping` / `connection:pong` с timing metadata                        |

### Notes

- `EventId` уже существовал — используется для `eventId` в envelopes
- `IdempotencyKey` уже существовал — используется для COLD команд
- `RequestIdSchema` уже существовал — используется для transport-level correlation
- Старые Zod-схемы domain/turn.ts, domain/gm.js, domain/resolution.js, ai.js сохранены но помечены deprecated; удаление в P02 после завершения миграции потребителей
- Protocol version `v1` в WSEnvelope; breaking changes требуют major version bump
- Schema version в envelope для эволюции payload без breaking transport contract

## 0.5.0 — 2026-11-08 (Prompt 1.8–1.9)

- JournalKind += 'ending_reached' (D237)
- CommandName += sendPublicMessage/sendPrivateMessage/sendSystemMessage/sendGMMessage/addNote/grantKnowledge (D246)
- EVENT_SUBSCRIBERS.TURN_COMMITTED += 'gm' (D245, F-3.8)

## 0.2.1 — 2026-11-07 (Prompt 1.2 fixes)

- 14-й ключ narrative_guidance (conditionNote, D191)
- env-идентификаторы провайдеров как строки вместо enum (D192, A1.14)

## 0.2.0 — 2026-11-06 (Prompt 1.2)

- Полный набор схем + поправки K1–K16 по данным мира v1

## 0.1.0 — 2026-11-05 (Prompt 1.1)

- Каркас пакета контрактов
