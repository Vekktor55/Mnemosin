# SB-01 — Server Bootstrap Cleanup Context

## Current State
- **Branch**: `arch-v2`
- **HEAD**: `5740ada`
- **P01 status**: Not applicable (P01 described different execution context)
- **SB-01 documents**: `SB-01_SERVER_BOOTSTRAP_REPORT.md`, `SB-01_CONTEXT.md` created

## Problem
`arch-v2` at `5740ada` had full server Composition Root with Turn Engine, AI Stack, Module Stack, reconcileOnBoot, Core Services, Module Registry, and Gateway dependencies all wired in `main.ts`. The earlier P01 report claimed this was completed, but the actual state required re-cleaning.

## Changes Made (SB-01)

### `apps/server/src/main.ts` — Removed ~60% of imports and ~40% of function body:
- All Turn Engine imports removed (`@mnemosin/module-turn`, `reconcileOnBoot`, `services.turns`)
- All AI Stack imports removed (`./ai.js`, `buildAIStack`, `ai.registry.probeOnce()`)
- All Module Stack imports removed (`./modules.js`, `buildModules`, `attachModulesRegistry`, `validateModulesRegistry`)
- All Core Services removed (`./core-services.js`, `buildCoreServices`, `services`)
- All Gateway dependencies removed (`@mnemosin/gateway-http`, `@mnemosin/gateway-ws`, JwtService, HttpGatewayDeps, WsGatewayDeps)
- OutboxPublisher, EventBus, Scheduler, metrics — all removed
- Simplified shutdown to `app.close()` + `persistence.close()` only
- `buildApp()` call simplified to `buildApp({config, logger, cwd: root, persistence})`

### `apps/server/src/index.ts` — Pruned public API:
- Removed: `buildAIStack`, `buildModules`, module-registry exports, `buildProjectionProvider`
- Kept: `buildApp`, `resolveProjectRoot`, health/version payloads

## Key SB-01 Constraints Honored
- `core/**` — unchanged
- `shared/contracts/**` — unchanged
- `infrastructure/database/**` — unchanged (bootstrapDatabase preserved)
- `modules/**` — unchanged
- `package.json` versions — unchanged
- `tsconfig.json` — unchanged
- `SessionService`, `JournalService`, `StateService`, `LocationService` — unchanged
- No new game rules implemented
- No Match Lifecycle implemented
- No Turn Engine removal from Core

## What SB-01 Achieves
- Minimal server bootstrap with only `/health` and `/version`
- SQLite initialization via `bootstrapDatabase()`
- Fastify app creation via `buildApp()`
- Graceful SIGINT/SIGTERM shutdown (simplified)
- All old Composition Root wiring removed from server entry point
- Server does NOT load: Turn Engine, AI, GM, modules, modules registry, gateway deps

## Remaining Turn Engine Dependencies (by design, out of SB-01 scope)
- `core/src/turns/index.ts` — exports `TurnService` and turn-scoped types
- `core/src/services.ts` — creates `TurnService` in `createCoreServices()`
- `core/src/session/session-service.ts` — calls `this.turns.openTurn()` in `startSession()`
- These are addressed in CORE-01B/C stages

## Files Modified
- `apps/server/src/main.ts` — rewritten minimal bootstrap
- `apps/server/src/index.ts` — pruned public API

## Files NOT Modified (protected)
All `core/`, `shared/contracts/`, `infrastructure/`, `modules/`, `gateways/`, `client/` directories and their contents. No source files outside `apps/server/src/` were changed.

## Next Stage
SB-01 stopped per instructions. Next stage (CORE-01B) would address remaining Turn Engine dependencies in Core, but requires separate assignment.