# @mnemosin/contracts — Change Log

Все изменения публичных контрактов фиксируются здесь. Версия пакета повышается при любом изменении схем.

## 0.6.0 — 2026-11-19 (P02: Shared Contracts Foundation)

### Added

**Common identifiers (ids.ts):**

- `MatchId` — идентификатор матча/партии (отделен от SessionId для будущего Match aggregate)
- `ParticipantId` — идентификатор участника матча (player/observer/developer в контексте матча)
- `WorldId` — идентификатор игрового мира/комплекса
- `FloorId` — идентификатор этажа
- `WorldEpoch` — версия/эпоха активного экземпляра игрового мира
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

| Old message type                                                  | Target Action | Migration Status                                                                                                                          | v4 equivalent                                                          |
| ----------------------------------------------------------------- | ------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `TURN_*` family (OPEN_TURN, LOCK_TURN, COMMIT_TURN, etc.)         | REMOVE        | **Deferred** — старые схемы сохранены в domain/turn.ts, domain/gm.js, domain/resolution.js до переноса потребителей и безопасной миграции | Turn Engine удалён в v4; заменяется `domain:command` + HOT/COLD events |
| `GM_*` family (GM_OPEN_TURN, GM_LOCK_TURN, GM_EDIT_APPROVE, etc.) | REMOVE        | **Deferred** — GM workflow сообщения сохранены в WS каталоге; перенос потребителей требуется                                              | GM workflow только в development; production v4 без GM                 |
| `GM_MOVE_GROUP`                                                   | REPLACE       | **Deferred** — схема сохранена, потребует переноса потребителей                                                                           | `interaction:command` (action=move_group) или `domain:command`         |
| `GM_SET_FLAG`                                                     | REPLACE       | **Deferred** — схема сохранена, потребует переноса потребителей                                                                           | `domain:command` (action=set_story_flag)                               |
| `GM_KICK_PLAYER` / `GM_END_SESSION` / `GM_PAUSE` / `GM_RESUME`    | REPLACE       | **Deferred** — сохранены, потребуют миграции в Observer/Domain commands                                                                   | `observer:command` (God Actions) / `domain:command`                    |
| `GM_SYSTEM_MESSAGE` / `GM_ADD_NOTE` / `GM_ACTIVATE_EVENT`         | REPLACE       | **Deferred** — сохранены, потребуют миграции                                                                                              | `domain:command` / `observer:command`                                  |
| `GM_REQUEST_SCENE` / `GM_CANCEL_MEDIA_JOB`                        | REPLACE       | **Deferred** — сохранены                                                                                                                  | `domain:command` / `observer:command`                                  |
| `ACTION_SUBMIT`                                                   | REPLACE       | **Deferred** — схема сохранена в WS каталоге                                                                                              | `scene:input` (movement) + `interaction:command` + `domain:command`    |
| `CHAT_PUBLIC` / `CHAT_PRIVATE`                                    | REPLACE       | **Deferred** — схемы сохранены                                                                                                            | `chat:send` с mode enum                                                |
| `STATE_PROJECTION` / `STATE_PROJECTION_PRIVATE`                   | REPLACE       | **Deferred** — схемы сохранены в views.ts (legacy)                                                                                        | `scene:keyframe` / `scene:delta` с PlayerProjection                    |
| `GM_STATE`                                                        | REPLACE       | **Deferred** — схема сохранена в views.ts (legacy)                                                                                        | `observer:projection` (Observer получает полную)                       |
| `TURN_DRAFT_READY` / `TURN_RESOLUTION_GM` / `TURN_COMMITTED`      | REMOVE        | **Deferred** — legacy turn resolution схемы сохранены                                                                                     | Legacy turn resolution flow                                            |
| `TURN_PRIVATE_RESOLUTION` / `TURN_FAILED`                         | REMOVE        | **Deferred** — legacy turn resolution схемы сохранены                                                                                     | Legacy turn resolution flow                                            |
| `GM_ACTION_ACK` / `GM_NOTE_ACK` / `GM_AI_CONTEXT`                 | REMOVE        | **Deferred** — legacy GM workflow схемы сохранены                                                                                         | Legacy GM workflow                                                     |
| `CAPABILITY_CHANGED` / `BUDGET_WARNING` / `BUDGET_EXCEEDED`       | PRESERVE      | Active                                                                                                                                    | Остаются (provider capabilities)                                       |
| `MEDIA_*` / `AUDIO_*`                                             | PRESERVE      | Active                                                                                                                                    | Остаются (media generation)                                            |
| `ERROR`                                                           | PRESERVE      | Active                                                                                                                                    | Остаётся (transport errors)                                            |
| `PING` / `PONG`                                                   | REPLACE       | **Deferred** — старые схемы сохранены                                                                                                     | `connection:ping` / `connection:pong` с timing metadata                |

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
