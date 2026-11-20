# CORE-01A-R1 — Audit Report: Remaining Turn Engine Dependencies (Reconciled)

## 1. Executive Summary (Reconciled)

The `core` package contains Turn Engine dependencies, but the critical discovery is that **P01 was NOT applied** to the `arch-v2` branch at HEAD `5debed6`. The `main.ts` and `modules.ts` still contain full Turn Engine wiring. This reconciles the contradictory reports: P01 changes exist only in a different context, not in the current `arch-v2` state.

**Actual state:** `arch-v2` branch, HEAD `5debed6`, with Turn Engine still fully wired in `main.ts`, `modules.ts`, `core/src/services.ts`, and `core/src/session/session-service.ts`. The `core-services.ts` file exists and calls `createCoreServices()`, which creates `TurnService`.

Three TypeScript TS2307 errors reference deleted `turn-service.ts`, but these are the least of the concerns — the entire server bootstrap still depends on Turn Engine.

**Why the contradiction arose:** The earlier CORE-01A report assumed P01 had been applied (clean separation of Turn Engine). In reality, `arch-v2` at `5debed6` has NOT undergone P01 — `main.ts` still contains `import { reconcileOnBoot } from '@mnemosin/module-turn'`, `import { TurnEngine, rulesStub } from '@mnemosin/module-turn'`, and `reconcileOnBoot({turns: services.turns, ...})`. The P01 report described a different execution context.

## 2. Verified Repository State (R1)

- **Branch**: `arch-v2`
- **HEAD**: `5debed68631c4b70285ea1a1f7aa3fb7dcb1a688`
- **P01 status**: **NOT PRESENT** in current `arch-v2` state. The P01 report described a different branch/execution context; the `main.ts` still contains Turn Engine wiring.
- **Uncommitted changes**: Only the two CORE-01A-R1 report files (`docs/implementation/CORE-01_AUDIT_REPORT.md`, `docs/implementation/CORE-01_CONTEXT.md`)
- **Created in CORE-01A-R1**: `docs/implementation/CORE-01_AUDIT_REPORT.md` (reconciled version), `docs/implementation/CORE-01_CONTEXT.md`

**Critical discrepancy resolved:** The earlier CORE-01A report assumed P01 had been applied (clean separation of Turn Engine). In reality, `arch-v2` at `5debed6` has NOT undergone P01 — `main.ts`, `modules.ts`, and core files still contain Turn Engine references. The P01 report described a different branch/state.

## 3. Confirmed TypeScript Errors

Three TS2307 errors from `apps/server/tsconfig.json` referencing deleted `core/src/turns/turn-service.ts`:

- `core/src/turns/index.ts` lines 3-12: exports from non-existent `turn-service.js`
- `core/src/services.ts` line 3: `import { TurnService } from './turns/turn-service.js'`
- `core/src/session/session-service.ts` line 25: `import type { TurnService } from '../turns/turn-service.js'`

**Additional errors expected** — the full server build will fail due to Turn Engine dependencies in `main.ts`, `modules.ts`, and gateways (e.g., `reconcileOnBoot` import, `TurnEngine` instantiation, `turns: services.turns` in gateway deps).

## 4. Dependency Map (Updated)

```
Core APIs → SessionService / CoreServices
  → TurnService (via createCoreServices() in core)
    ← core/src/turns/index.ts exports TurnService and turn-scoped types
    ← core/src/services.ts imports TurnService and creates it
    ← core/src/session/session-service.ts receives TurnService deps, calls this.turns.openTurn()
    ← apps/server/src/core-services.ts calls createCoreServices()
    ← apps/server/src/modules.ts imports TurnEngine from '@mnemosin/module-turn'
    ← apps/server/src/modules.ts creates new TurnEngine({turns: services.turns, ...})
    ← apps/server/src/main.ts imports reconcileOnBoot from @mnemosin/module-turn
    ← apps/server/src/main.ts calls reconcileOnBoot({turns: services.turns, ...})
    ← apps/server/src/main.ts uses turns: services.turns in HTTP and WS gateways
    ← gateways/ws/src/deps.ts, gateways/ws/src/router.ts use openTurn
    ← gateways/http/src/routes.ts uses openTurn
    ← shared/contracts/src/domain/turn.ts defines openTurn command
    ← shared/contracts/src/domain/jobs.ts references openTurn
```

**Important:** `SessionService` and `CoreServices` are only part of a much larger Turn Engine integration that spans core, apps/server, gateways, and modules.

## 5. Component Classification (Updated)

| Component                                                  | Classification            | Reasoning                                                                                 |
| ---------------------------------------------------------- | ------------------------- | ----------------------------------------------------------------------------------------- |
| `TurnService` exports (index.ts)                           | DELETE CANDIDATE          | Exported types from module that can be removed once Turn Engine is separated              |
| `CoreServices.turns`                                       | ADAPT                     | Must be removed or replaced; currently depends on TurnEngine                              |
| `SessionService`                                           | ADAPT                     | Calls `this.turns.openTurn()` in `startSession()` — needs replacement                     |
| `TurnServiceDeps`, `TurnCommandResult`, etc.               | DELETE CANDIDATE          | Turn-scoped types from removed engine                                                     |
| `JournalService`                                           | ADAPT (was PRESERVE)      | API and storage model are turn-scoped (FK turn_id, NOT NULL). Requires adaptation for v4. |
| `StateService`                                             | PRESERVE                  | Core domain service; no Turn dependency                                                   |
| `LocationService`                                          | PRESERVE                  | No Turn dependency                                                                        |
| `CoreServices` factory                                     | ADAPT                     | Creates TurnService; needs v4 replacement                                                 |
| `modules/session` contract                                 | ADAPT                     | Returns `turnId` in `StartSessionOutput` — Turn-dependent                                 |
| `modules/` (turn, gm, gm-audit, chat, story)               | OUT OF SCOPE for CORE-01A | Full module restructuring needed                                                          |
| `main.ts` Turn references                                  | OUT OF SCOPE for CORE-01A | P01 not applied; main.ts still has full TurnEngine wiring                                 |
| `reconcileOnBoot`                                          | OUT OF SCOPE for CORE-01A | P01 not applied; Turn Engine boot logic still present in main.ts                          |
| `StartSessionOutputSchema` returning `turnId`/`turnNumber` | ADAPT                     | Directly couples session start to Turn Engine; requires v4 decision                       |

## 6. Session-to-Match Migration Analysis (Updated)

| Old Entity/Operation                            | Current Purpose                                              | Target v4 Entity/Operation          | Status          | Note                                                                    |
| ----------------------------------------------- | ------------------------------------------------------------ | ----------------------------------- | --------------- | ----------------------------------------------------------------------- |
| `Session`                                       | Session state machine (LOBBY/ACTIVE/PAUSED/ENDED)            | `Match` (Match Lifecycle Status)    | DEFER           | Full migration requires module restructuring                            |
| `startSession()`                                | LOBBY→ACTIVE, checks GM, ≥1 player, `TurnService.openTurn()` | Match creation + Floor Phase        | ADAPT (partial) | Must remove `this.turns.openTurn()` call; status transition kept        |
| `currentTurnId`                                 | Tracks active turn in Session                                | Part of Match progression state     | DEFER           | Retained in schema but semantics changing; also used in gateways        |
| `TurnId`                                        | Turn identifier                                              | Match/Phase identifier              | DEFER           | Type kept but usage changing across core, contracts, gateways           |
| `SessionStatus`                                 | LOBBY/ACTIVE/PAUSED/ENDED                                    | Match Lifecycle Status              | DEFER           | Transition logic kept, semantics evolving                               |
| `openTurn` command                              | Turn Engine API                                              | Match floor phase command           | OPEN DECISION   | No v4 equivalent defined; requires owner decision                       |
| `Journal`                                       | Turn-scoped journal entries (FK turn_id, NOT NULL)           | Event history with turn association | ADAPT           | JournalService API is turn-scoped; needs adaptation for stand-alone use |
| `reconcileOnBoot`                               | Fixes PROCESSING→FAILED turns after crash                    | Match crash recovery                | OPEN DECISION   | P01 not applied; Turn Engine boot logic present in main.ts              |
| `StartSessionOutputSchema` (turnId, turnNumber) | Returns turn info on session start                           | Match progression info              | ADAPT           | Explicitly couples session start to Turn Engine                         |

**Key incompatibility:** `startSession()` calls `this.turns.openTurn()` which is a Turn Engine method. In v4, this must be replaced or removed. The `StartSessionOutputSchema` also returns `turnId` and `turnNumber`, directly coupling session start to Turn Engine.

## 7. Database and Contract Impact (Updated)

- **`infrastructure/database/src/schema.ts`**: Has `currentTurnId` column on sessions table, `turn_id` as primary key on turns table, and `turn_id` FK on journal_entries. All retained but semantically stale after partial P01.
- **`shared/contracts/src/domain/session.ts`**: Contains `SessionStatus`, `SESSION_TRANSITIONS`, `SessionSchema` with `currentTurnId: TurnId.nullable()`. Used by `SessionService` and modules.
- **`shared/contracts/src/domain/turn.ts`**: Defines `openTurn` command — still referenced in `shared/contracts/src/domain/jobs.ts` and gateway router.
- **`modules/session/src/contract.ts`**: `StartSessionOutputSchema` returns `sessionId`, `status`, `turnId`, `turnNumber`, `replayed` — directly depends on Turn Engine.
- **Risk**: Removing `currentTurnId` from schema would require data migration; keeping it nullable poses no immediate harm but is semantically stale. The `StartSessionOutput` contract explicitly couples session start to Turn Engine.

## 8. Recommended Implementation Sequence (Updated)

Given that P01 was NOT applied to `arch-v2`:

- **CORE-01B**: Full audit of actual Turn Engine dependencies — this report identified that P01 claims don't match reality. Need to assess what actually needs removing vs. what's still needed.
- **CORE-01C**: Remove Turn Engine from `main.ts` — remove `reconcileOnBoot` import, `turns: services.turns` in gateways, `import { TurnEngine, rulesStub }` from modules.ts. This is the real starting point.
- **CORE-01D**: Refactor `core/src/services.ts` to remove `TurnService` creation; make `turns` field optional/remove from `CoreServices`.
- **CORE-01E**: Refactor `core/src/session/session-service.ts` to remove `this.turns.openTurn()` call in `startSession()`. Replace with match/floor phase initialization logic (deferred to later stage).
- **CORE-02**: Decide on `SessionService` and `CoreServices` fate — preserve session mechanics without Turn Engine, or transition fully to Match Lifecycle.
- Subsequent: Integrate Match Lifecycle (P03+), replace `currentTurnId` semantics, remove Turn-related DB columns, adapt `JournalService`.

**Revised sequence:** Since P01 wasn't applied, the first task is CORE-01B: verify actual state and remove obvious Turn Engine references from main.ts and modules.ts.

## 9. Open Decisions (Updated)

- **`startSession()`**: Should it remove `TurnService.openTurn()` call entirely, or replace with v4 equivalent? `StartSessionOutputSchema` returns `turnId`/`turnNumber` — who decides these?
- **`CoreServices.turns` field**: Remove, make optional, or replace abstraction?
- **`currentTurnId` in DB/schema**: Remove now (requires migration) or keep nullable indefinitely?
- **`openTurn` in contracts**: Remove from `shared/contracts`, keep for backward compat, or replace with v4 equivalent?
- **`reconcileOnBoot`**: P01 not applied — keep or remove from `main.ts`?
- **Module Turn Engine** (`@mnemosin/module-turn`): Full removal or gradual replacement?
- **`StartSessionOutputSchema` `turnId`/`turnNumber`**: Keep in contract, remove, or replace with match/progression info?

## 10. Files to Change in Next Stage (Updated)

Given P01 NOT applied, the immediate files to change are:

| File                                  | Change                                                                                                                                                                                      | Reason                                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/server/src/main.ts`             | Remove `import { reconcileOnBoot } from '@mnemosin/module-turn'`; remove `reconcileOnBoot({turns: services.turns, ...})` call; remove `turns: services.turns` from HTTP and WS gateway deps | P01 not applied — Turn Engine still wired in server boot            |
| `apps/server/src/modules.ts`          | Remove `import { TurnEngine, rulesStub } from '@mnemosin/module-turn'`; remove `new TurnEngine({...services.turns...})` creation; remove `turns: services.turns` from GmService deps        | P01 not applied — TurnEngine module still imported and instantiated |
| `core/src/turns/index.ts`             | Remove TurnService exports; keep only JournalService                                                                                                                                        | Turn Engine exports from core                                       |
| `core/src/services.ts`                | Remove TurnService import/creation; make `turns` field optional or remove from `CoreServices`                                                                                               | Eliminate direct Turn dependency in core                            |
| `core/src/session/session-service.ts` | Remove `this.turns.openTurn()` call in `startSession()`; adjust return type of `startSession()`                                                                                             | Session no longer depends on Turn Engine                            |
| `core/src/index.ts`                   | Update barrel exports — remove TurnService from public API                                                                                                                                  | Public API cleanup                                                  |

## 11. Verification (Updated)

- Confirmed on `arch-v2` branch, HEAD `5debed68631c4b70285ea1a1f7aa3fb7dcb1a688`
- P01 **NOT** present in current `arch-v2` — `main.ts` still has `import { reconcileOnBoot } from '@mnemosin/module-turn'`, `import { TurnEngine, rulesStub } from '@mnemosin/module-turn'`, and `reconcileOnBoot({turns: services.turns, ...})`
- Grep searches found TurnService, openTurn, createCoreServices references across core, apps/server, gateways, modules
- Three TS2307 errors confirmed from `core/src/turns/index.ts` and `core/src/services.ts` import of deleted `turn-service.ts`
- Third TS2307 error from `core/src/session/session-service.ts` import of deleted `turn-service.ts`
- `apps/server/src/core-services.ts` exists and calls `createCoreServices()` — creates TurnService
- **No source files modified** during this R1 reconciliation (only the two doc files)

### What Changed from Original CORE-01A Report

1. **P01 status**: Was "present, changes preserved" — now confirmed "NOT present in arch-v2"
2. **Discrepancy resolved**: P01 report described different execution context; actual `arch-v2` at `5debed6` has full Turn Engine wiring
3. **JournalService classification**: Changed from `PRESERVE` to `ADAPT` — API and storage are turn-scoped (FK turn_id, NOT NULL)
4. **Session-to-Match mappings**: Many "NO APPROVED MAPPING" instead of assumed correspondences
5. **Open decisions expanded**: Added `reconcileOnBoot`, module Turn Engine, `StartSessionOutputSchema` `turnId`/`turnNumber`
6. **Files to change**: Added `main.ts`, `modules.ts` as immediate priorities since P01 wasn't applied
7. **Dependency map**: Expanded to show full Turn Engine integration across core, apps/server, gateways, modules
