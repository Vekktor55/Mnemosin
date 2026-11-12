# CORE-01A-R1 — Audit Context (Reconciled)

## Current State

- **Branch**: `arch-v2`
- **HEAD**: `5debed68631c4b70285ea1a1f7aa3fb7dcb1a688`
- **P01 status**: **NOT PRESENT** in current `arch-v2` execution context. The earlier P01 report described a different branch state; `main.ts` still contains full Turn Engine wiring (`import { reconcileOnBoot } from '@mnemosin/module-turn'`, `import { TurnEngine, rulesStub } from '@mnemosin/module-turn'`, `reconcileOnBoot({turns: services.turns, ...})`).
- **Working tree**: Only the two CORE-01A-R1 report files (`docs/implementation/CORE-01_AUDIT_REPORT.md`, `docs/implementation/CORE-01_CONTEXT.md`) are new; no source files were modified.

## Problem (Reconciled)

TypeScript build `tsc -b apps/server/tsconfig.json` fails with **3 TS2307 errors** referencing deleted `core/src/turns/turn-service.ts`:

1. `core/src/turns/index.ts` lines 3-12: exports from non-existent `turn-service.js`
2. `core/src/services.ts` line 3: `import { TurnService } from './turns/turn-service.js'`
3. `core/src/session/session-service.ts` line 25: `import type { TurnService } from '../turns/turn-service.js'`

**Additional build failures expected** — the full server build fails due to Turn Engine dependencies in `main.ts`, `modules.ts`, and gateways that were not removed (P01 not applied to this branch).

**Why the contradiction:** The earlier CORE-01A report assumed P01 had been applied (clean separation of Turn Engine). In reality, `arch-v2` at `5debed6` has NOT undergone P01 — `main.ts` still has Turn Engine imports and calls, `modules.ts` imports and instantiates `TurnEngine`, and `core-services.ts` calls `createCoreServices()` which creates `TurnService`. The P01 report described a different execution context.

## Main Core Dependencies (Updated)

- `SessionService` — depends on `TurnService`, `LocationService`, `UnitOfWork`, `CommandRunner`, `WorldPackData`, and **explicitly calls `this.turns.openTurn()` in `startSession()`**
- `CoreServices` — factory creating `JournalService`, `StateService`, `TurnService`, `LocationService`, `SessionService`; **creates TurnService instance**
- `TurnService` — turn engine service, injected via `SessionServiceDeps.turns` and also created in `createCoreServices()`
- `JournalService` — **ADAPT** (was PRESERVE in original): API and storage model are turn-scoped (FK `turn_id`, `NOT NULL` on `journal_entries.turn_id`). Requires adaptation for v4 standalone use.
- `StateService` — domain state machine; **PRESERVE** — no Turn dependency
- `LocationService` — world pack locations; **PRESERVE** — no Turn dependency
- `CoreServices.turns` field — **ADAPT** — currently depends on TurnEngine; must be removed or replaced
- `SessionServiceDeps.turns` — **ADAPT** — dependency injection that needs v4 equivalent

## Files Audited

- `core/src/turns/index.ts` (13 lines) — found TurnService and turn-scoped type exports
- `core/src/services.ts` (68 lines) — found TurnService import and creation in `createCoreServices()`
- `core/src/session/session-service.ts` (596 lines) — found `this.turns.openTurn()` call at line 390 in `startSession()`
- `core/src/index.ts` (33 lines) — barrel exports; TurnService in public API
- `core/package.json` (37 lines) — dependencies: `@mnemosin/contracts`, `zod`
- `core/tsconfig.json` (14 lines) — references `shared/contracts`
- `apps/server/src/main.ts` (328 lines) — **confirmed NOT P01-clean**: has `reconcileOnBoot` import, `turns: services.turns` in gateways, `import { TurnEngine, rulesStub }`
- `apps/server/src/modules.ts` (130 lines) — **confirmed NOT P01-clean**: imports `TurnEngine`, creates `new TurnEngine({...services.turns...})`
- `apps/server/src/core-services.ts` (24 lines) — calls `createCoreServices()`, which creates `TurnService`

## Audit Results Summary

- **DELETE CANDIDATE**: TurnService exports from index.ts, Turn-scoped types (TurnServiceDeps, TurnCommandResult, CancelTurnResult, CancelTurnInput, SubmitActionInput, SubmitActionResult, TransitionInput)
- **ADAPT**: SessionService (remove openTurn call, adapt StartSessionOutputSchema), CoreServices (stop creating TurnService, make turns field optional), JournalService (adapt API for v4 standalone use), CoreServices.turns field, StartSessionOutputSchema returning turnId/turnNumber
- **PRESERVE**: StateService (no Turn dependency), LocationService (no Turn dependency)
- **DEFER**: SessionStatus, currentTurnId, TurnId types — semantics changing in v4, but still present in contracts and DB schema
- **OUT OF SCOPE for CORE-01A**: Full module Turn Engine (`@mnemosin/module-turn`), main.ts and modules.ts TurnEngine wiring (P01 not applied), reconcileOnBoot, gm/gmReview/gmAudit module dependencies on TurnService

## Open Decisions (require owner input)

1. `startSession()`: remove `TurnService.openTurn()` call entirely, or replace with v4 equivalent? `StartSessionOutputSchema` returns `turnId`/`turnNumber` — who decides these?
2. `CoreServices.turns` field: remove, make optional, or replace abstraction?
3. `currentTurnId` in DB/schema: remove now (requires migration) or keep nullable indefinitely?
4. `openTurn` in `shared/contracts/src/domain/turn.ts`: remove, keep for backward compat, or replace with v4 equivalent?
5. `reconcileOnBoot` in `main.ts`: keep (P01 not applied, still needed for crash recovery) or remove?
6. Module Turn Engine (`@mnemosin/module-turn`): full removal or gradual replacement across modules?
7. `StartSessionOutputSchema` `turnId`/`turnNumber`: keep in contract, remove, or replace with match/progression info?

## What Must Not Be Changed (CORE-01A-R1 constraints)

- No edits to `core/src/`, `shared/contracts/`, `infrastructure/database/`, `apps/server/`, `gateways/`, `modules/`, `client/`
- No file deletions, import/export changes, API changes, SessionService removal
- No business logic changes, Turn-related contract field removal, Drizzle schema changes
- No package.json, tsconfig, or lock file changes; no new dependency installs
- **No assumptions that P01 was applied** — this is the key reconciliation point

## Next Stage Files (Immediate priorities since P01 not applied)

- `apps/server/src/main.ts` — remove `reconcileOnBoot` import, remove `reconcileOnBoot({turns: services.turns, ...})` call, remove `turns: services.turns` from HTTP/WS gateway deps
- `apps/server/src/modules.ts` — remove `import { TurnEngine, rulesStub }`, remove `new TurnEngine({...services.turns...})`, remove `turns: services.turns` from GmService deps
- `core/src/turns/index.ts` — remove TurnService exports; keep only JournalService
- `core/src/services.ts` — remove TurnService import/creation; make `turns` field optional or remove from `CoreServices`
- `core/src/session/session-service.ts` — remove `this.turns.openTurn()` call in `startSession()`; adjust `startSession()` return type
- `core/src/index.ts` — update barrel exports; remove TurnService from public API

## Key Reconciliation Notes

- **P01 was NOT applied** to the `arch-v2` branch at `5debed6`. The earlier CORE-01A report described a different state.
- **3 TS2307 errors** confirmed from core TurnService imports of deleted `turn-service.ts`
- **Additional build failures** expected from main.ts and modules.ts Turn Engine dependencies
- **JournalService reclassified** from PRESERVE to ADAPT — its API/storage are turn-scoped (FK turn_id, NOT NULL)
- **Component classifications updated** based on actual findings, not assumptions
- **Two report files created**: `CORE-01_AUDIT_REPORT.md` and `CORE-01_CONTEXT.md`
- **Zero source files modified** — only the two documentation files were created/updated
