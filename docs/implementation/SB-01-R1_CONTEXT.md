# SB-01-R1 — Server Bootstrap Cleanup Context

## Current State

- **Branch**: `arch-v2`
- **HEAD**: `932d4eb031d402fbbfce0397874672d6c5dd0c65`
- **Server src files**: `main.ts`, `app.ts`, `health.ts`, `project-root.ts`, `index.ts` (5 files)
- **Deleted wiring files**: `ai.ts`, `core-services.ts`, `modules.ts`, `modules-registry.ts`, `projections.ts`

## Server Dependencies (actual imports)

- `@mnemosin/contracts` — `CONTRACTS_VERSION`, `AppConfig`
- `@mnemosin/config` — `loadConfigOrExit`, `readPackageVersion`, `AppConfig`
- `@mnemosin/logging` — `createLogger`
- `@mnemosin/database` — `bootstrapDatabase`, `BootstrapResult`, `ping`
- `@mnemosin/gateway-http` — `createHttpErrorHandler`, `registerHttpRoutes`, `HttpGatewayDeps`
- `@mnemosin/gateway-ws` — `registerWsGateway`, `WsGatewayDeps`, `WsGatewayHandle`
- `fastify`, `@fastify/cors`, `@fastify/rate-limit`, `@fastify/static`
- `pino` — `Logger` type

## TypeScript References

### apps/server/tsconfig.json (6 references)

- `../../shared/contracts`
- `../../infrastructure/config`
- `../../infrastructure/logging`
- `../../infrastructure/database`
- `../../gateways/http`
- `../../gateways/ws`

### Root tsconfig.json (15 references)

- `shared/contracts`, `core`, `modules/session`, `modules/chat`, `modules/story`, `modules/gm-audit`
- `infrastructure/config`, `infrastructure/logging`, `infrastructure/database`, `infrastructure/jobs`, `infrastructure/ai`
- `gateways/http`, `gateways/ws`, `apps/server`, `client`

## Build Results

- **Exit code**: 1 (3 errors in `core/`, not server)
- **Errors**: 3 TS2307 in `core/src/services.ts`, `core/src/session/session-service.ts`, `core/src/turns/index.ts` — all referencing deleted `turn-service.js`
- **Server code**: Clean

## Runtime Verification

- **Start**: ✅ Port 3000, DB opened, migrations applied
- **GET /health**: ✅ 200, `db:"ok"`, `phase:"ready"`
- **GET /version**: ✅ 200
- **Shutdown**: Code implemented correctly (`await app.close()` → `await persistence.close()`); manual Ctrl+C works; automated SIGINT on Windows requires console attachment
- **No game routes**: ✅ `/ws`, `/auth`, modules not registered

## Known Core Errors (out of SB-01 scope)

- `core/src/services.ts:3` — imports deleted `turn-service.js`
- `core/src/session/session-service.ts:25` — imports deleted `turn-service.js`
- `core/src/turns/index.ts:13` — exports deleted `turn-service.js`
- Documented in CORE-01A-R1; addressed in CORE-01B

## Next Stage Files (CORE-01B)

- `core/src/turns/index.ts` — remove TurnService exports, keep JournalService
- `core/src/services.ts` — remove TurnService from createCoreServices
- `core/src/session/session-service.ts` — remove this.turns.openTurn() in startSession
- `core/src/index.ts` — update barrel exports

## Boundaries (Do Not Cross)

- No changes to `core/**`, `shared/contracts/**`, `infrastructure/**`, `modules/**`, `gateways/**`, `client/**`
- No Match Lifecycle, HOT/COLD, new game rules
- No schema/migrations changes
- No version bumps in package.json
