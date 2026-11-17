# MNEMOSIN Repository Audit — P00

**Generated:** 2026-11-13  
**Branch:** `arch-v2`  
**Audited Baseline HEAD:** `eb15ccff58a49dc1854ad5b5672c5e1cca60084e` (commit message: "Выполнена доработка тестов")  
**First P00 Results Commit:** `a1491af7dbc138ec0b8087cbb09c070b78354f37` (child of `eb15ccf`; "Удалены старые тесты" + audit docs + test changes)  
**Audited Source-Tree Snapshot:** `55ddad6f6c53ae7baabc9c1f753f4c682aec51ea` (child of `a1491af`; audit/roadmap corrections)  
**P00 Documentation Correction Commit:** `9bd1448cf1c7c411e5f8d7d3ee50840bbf5518fc` (child of `55ddad6`; "Доработка docs"; modifies only the two audit/roadmap documents; does not change the audited source tree)  
**Auditor:** Coding Agent (P00 execution)

---

## 1. Git Baseline Snapshot & Chronology

| Property | Value |
|----------|-------|
| Current branch | `arch-v2` |
| **Audited baseline (P00 target)** | `eb15ccff58a49dc1854ad5b5672c5e1cca60084e` — "Выполнена доработка тестов" |
| **First P00 results commit** | `a1491af7dbc138ec0b8087cbb09c070b78354f37` — child of `eb15ccf`; contains: 19 deleted test files, 4 modified test files, 2 audit/roadmap documents |
| **Audited source-tree snapshot** | `55ddad6f6c53ae7baabc9c1f753f4c682aec51ea` — child of `a1491af`; audit/roadmap corrections only |
| **P00 documentation correction commit** | `9bd1448cf1c7c411e5f8d7d3ee50840bbf5518fc` — child of `55ddad6`; "Доработка docs"; modifies only the two audit/roadmap documents; does not change the audited source tree |
| `main` branch HEAD | `fc62c57` |
| Tag `stage1-final` | Points to `main` at `fc62c57` (commit message: "довел проект до стадии end_stage_1") |

**Archive point verified:** `main` branch at `fc62c57` with tag `stage1-final` preserves the complete Table MVP implementation (Stage 1 with GM-in-the-loop, Turn Engine, GM Review). This is a **confirmed Git rollback point** (tag object exists, commit SHA verified). **Full application restoration from this point has not been tested** — only the Git tree is confirmed.

**Git baseline attribution note:** The initial `git status --porcelain=v1` snapshot was **not saved** before P00 began.  
By history, commit `a1491af` records:
- 19 deleted test files (2 contract + 17 integration; full per-file list in §5)
- 4 modified test files: `tests/arch/boundaries.test.ts`, `tests/arch/core-manifest.json`, `tests/arch/state-service-access.test.ts`, `tests/integration/outbox.test.ts`
- 2 new/updated documents: `docs/implementation/REPOSITORY_AUDIT.md`, `docs/IMPLEMENTATION_ROADMAP.md`

Commit `a1491af` contains 19 test-file deletions. The origin of these changes relative to the start of P00 is unestablished, since the initial `git status` was not saved. This audit classifies their actual state and recommended fate, but does not attribute them to a specific actor. They may have already been present in the working tree/index before P00, or some may have been created during P00; either way their provenance is **unconfirmed**. This audit neither claims them as P00 actions nor asserts that they already existed before the audit.

Commit `55ddad6` modified **only** the two documents (`REPOSITORY_AUDIT.md`, `IMPLEMENTATION_ROADMAP.md`).

Commit `9bd1448` ("Доработка docs") likewise modifies **only** the two audit/roadmap documents and does **not** change the audited source tree (code, tests, contracts, CI, migrations remain at `55ddad6`).

---

## 2. CI Status — Full Baseline

### CI #18 (PR Workflow) — SHA `eb15ccf` (head) / `5d263f5` (merge commit)
| Step | Status | Notes |
|------|--------|-------|
| `npm ci` | **PASS** | Dependencies install cleanly |
| `lint` (eslint + prettier) | **PASS** | No lint errors |
| `typecheck` (tsc -b) | **PASS** | **TypeScript compiles successfully** — `core/src/domain/ports/turn-service.ts` EXISTS at this SHA |
| `test:unit` | **95 PASS** | All unit tests pass |
| `test:integration` | **FAIL** | See failure classification below |
| `test:arch` | NOT RUN | Blocked by integration failure |
| `test:contract` | NOT RUN | Blocked by integration failure |
| `coverage` | NOT RUN | Blocked by integration failure |
| `build` (tsc -b + vite client) | NOT RUN | Blocked by integration failure |
| `test:e2e` | NOT RUN | Blocked by integration failure |
| `npm audit` | NOT RUN | Blocked by integration failure |
| `secret scanning` | NOT RUN | Blocked by integration failure |
| `verify:stage1` | NOT RUN | Blocked by integration failure |

**CI evidence used:** Workflow definition read; CI run #18 results for SHA `eb15ccf` (PR head) referenced. No fresh CI run executed per P00 constraints.

### CI #19 — SHA `a1491af`
| Step | Status | Notes |
|------|--------|-------|
| `npm ci` | **PASS** | |
| `lint` | **FAIL** | |
| `typecheck`, `test:*`, `build`, etc. | NOT RUN | Blocked by lint failure |

### CI #20 — SHA `55ddad6` (audited source-tree snapshot)
| Step | Status | Notes |
|------|--------|-------|
| `npm ci` | **PASS** | |
| `lint` | **FAIL** | 3 errors: `no-unsafe-finally` in `tests/integration/outbox.test.ts` (lines 248, 255, 259) |
| `typecheck`, `test:*`, `build`, etc. | NOT RUN | Blocked by lint failure |

### CI #21 — SHA `9bd1448` (PR workflow, head SHA)
| Step | Status | Notes |
|------|--------|-------|
| `npm ci` | **PASS** | |
| `lint` | **FAIL** | 3 errors: `no-unsafe-finally` in `tests/integration/outbox.test.ts` (lines 248, 255, 259) |
| `typecheck`, `test:*`, `build`, etc. | NOT RUN | Blocked by lint failure |

### CI #22 — SHA `5c3b6cd` (PR workflow, head SHA)
| Step | Status | Notes |
|------|--------|-------|
| `npm ci` | **PASS** | |
| `lint` | **FAIL** | 3 errors: `no-unsafe-finally` in `tests/integration/outbox.test.ts` (lines 248, 255, 259) |
| `typecheck`, `test:*`, `build`, etc. | NOT RUN | Blocked by lint failure |

**CI run references:** https://github.com/Vekktor55/Mnemosin/actions/runs/43489582778 (CI #21) and https://github.com/Vekktor55/Mnemosin/actions/runs/44047334921 (CI #22).

---

### Integration Test Failure Classification (CI #18)

| Failure | Files Affected | Classification | Rationale |
|---------|---------------|----------------|-----------|
| Missing `@mnemosin/module-turn` | Multiple integration test files | **stale test dependency** | Module deleted in commit `5debed6`; tests not updated |
| `services.turns.submitAction is not a function` | `tests/integration/session-service.test.ts` | **stale test dependency** | `TurnService` port interface changed; test uses old method name |
| `buildAIStack is not a function` | `tests/integration/ai-director.test.ts` | **stale test dependency** | Module deleted; test references removed factory |
| Missing fixture `locations.stage1.json` | `tests/integration/location-service.test.ts` | **missing fixture** | Fixture file not present in repo |
| Missing fixture `resolution.ok.json` | `tests/integration/location-service.test.ts` | **missing fixture** | Fixture file not present in repo |
| Location service: expected name `Шлюз`, got `Test Start Location` | `tests/integration/location-service.test.ts` | **test/fixture mismatch** (stale test or missing fixture) | Test expects hardcoded location name; actual data differs |
| Location service: missing expected exits | `tests/integration/location-service.test.ts` | **UNKNOWN** | Could be stale test expectation, missing fixture, or implementation defect — insufficient data to confirm |
| Location service: `undefined` passed to DB query | `tests/integration/location-service.test.ts` | **implementation defect** (likely) | `undefined` parameter suggests missing validation or incorrect test setup — needs code inspection to confirm |
| Location service: other assertion failures | `tests/integration/location-service.test.ts` | **UNKNOWN** | Insufficient CI log detail to classify precisely |

**No `contract mismatch` failures identified.**

---

## 3. Actual Repository Structure (Discovered, Not Assumed)

```
Mnemosin/
├── apps/
│   └── server/
│       └── src/
│           ├── main.ts          # SB-01: minimal bootstrap (/health, /version only)
│           └── app.ts           # Fastify app setup (imports core services)
├── client/
│   └── src/
│       ├── player/              # Player UI (PlayerApp.svelte, etc.)
│       ├── shell/               # GameShell.svelte (renders TurnPanel - DELETED)
│       ├── stores/              # Svelte stores
│       ├── net/                 # WSClient (subprotocol mnemosin.v1.<jwt>)
│       ├── lib/                 # Utilities
│       └── styles/
├── config/                      # Configuration files
├── content/                     # Game content / World Packs
├── core/
│   └── src/
│       ├── turns/
│       │   ├── index.ts         # Exports JournalService ONLY
│       │   └── journal.ts       # JournalService — append-only turn/session journal (STANDALONE, no TurnService dep)
│       ├── session/
│       │   └── session-service.ts  # Calls this.turns.openTurn() — BROKEN (TurnServicePort still wired)
│       ├── domain/
│       │   └── ports/
│       │       └── turn-service.ts  # TurnServicePort interface (minimal: openTurn only)
│       ├── locations/
│       │   └── location-service.js  # Location loading, state management
│       ├── state/
│       │   └── state-service.js     # StateService
│       ├── domain/
│       │   ├── command.js, transition.js, ports/
│       │   └── outbox.js
│       └── services.ts          # createCoreServices() — receives TurnServicePort from outside (does NOT create it)
├── data/                        # Database related
├── docs/
│   ├── SYSTEM_ARCHITECTURE.md   # v4 target architecture
│   ├── IMPLEMENTATION_ROADMAP.md # P00–P15 phases
│   ├── REUSE_AUDIT_v4.md        # Migration matrix (written against main@5debed6)
│   ├── HOT_COLD_DESIGN.md
│   ├── WORLD_SIMULATION.md
│   ├── NETWORK_PROTOCOL.md
│   ├── DOLL_AI.md
│   ├── MATCH_LIFECYCLE.md
│   ├── ANDREY_AI.md
│   └── implementation/
│       ├── CORE-01_AUDIT_REPORT.md
│       ├── CORE-01A-R1_CONTEXT.md
│       ├── SB-01_SERVER_BOOTSTRAP_REPORT.md
│       ├── SB-01_CONTEXT.md
│       └── REPOSITORY_AUDIT.md  # THIS FILE
├── gateways/
│   └── ws-gateway/
│       └── src/                 # Declares WsTurnOps, WsGmOps, WsGmReviewOps deps
├── infrastructure/              # Database, logging, etc.
├── modules/                     # ONLY 4 REMAIN:
│   ├── chat/
│   ├── gm-audit/
│   ├── session/
│   └── story/
│   # DELETED in arch-v2 (commit 5debed6): turn/, gm/, gm-review/, ai-director/
├── shared/
│   └── contracts/               # Full Zod schema catalog:
│       ├── domain/
│       │   ├── turn.ts          # Turn Engine schemas (STILL PRESENT)
│       │   ├── gm.ts            # GM schemas (STILL PRESENT)
│       │   ├── gm-review.ts     # GM Review schemas (STILL PRESENT)
│       │   └── ...              # v4 target schemas also present
│       └── ...
├── tests/
│   ├── unit/
│   ├── integration/             # 19 test files deleted in commit a1491af; pre-P00 provenance unconfirmed (full per-file list in §5)
│   ├── arch/
│   └── contract/
└── tools/
```

---

## 4. Component Migration Mapping

| Component | Actual State | Target v4 Role | Decision | Dependencies | Next Action |
|-----------|--------------|----------------|----------|--------------|-------------|
| `apps/server/src/main.ts` | SB-01 minimal bootstrap (`/health`, `/version`) | Production server entry | **KEEP** (as minimal base) | None | Extend with v4 bootstrap in P02 |
| `apps/server/src/app.ts` | Fastify setup, imports core | Production app factory | **KEEP** | Core services | Update imports in P02 |
| `core/src/services.ts` | Receives `TurnServicePort` from outside (DI); does NOT create TurnService | Core service factory (Ports & Adapters) | **ADAPT** | `TurnServicePort` (legacy), session-service | Remove TurnServicePort param; wire v4 ports in P02 |
| `core/src/turns/index.ts` | Exports `JournalService` only | Domain module for journal/story | **KEEP** (as Journal) | None | Keep as `journal/` module; do NOT rename whole `turns/` dir |
| `core/src/turns/journal.ts` | Standalone `JournalService` — appends journal entries with turnId/sessionId; no TurnEngine dep | Journal/story audit trail (COLD domain) | **KEEP** | None | Integrate in P09 COLD domains |
| `core/src/domain/ports/turn-service.ts` | `TurnServicePort` interface (minimal: `openTurn` only) | Legacy port | **REMOVE** | Core services | Delete in P02 |
| `core/src/session/session-service.ts` | Calls `this.turns.openTurn()` in `startSession()` | Session orchestration (v4: Match aggregate) | **REPLACE** | `TurnServicePort` (legacy) | Rewrite for v4 Match lifecycle in P10 |
| `core/src/domain/` (other ports) | Various ports | v4 Ports & Adapters boundaries | **ADAPT** | None | Align with v4 contracts in P02 |
| `modules/chat` | Functional module | Chat/Whisper (COLD domain) | **KEEP** | None | Integrate in P09 |
| `modules/gm-audit` | Functional module | Observer/Developer tooling | **KEEP** | None | Repurpose for P11 |
| `modules/session` | Functional module | Match/Session management | **ADAPT** | Session service | Rewrite for v4 in P10 |
| `modules/story` | Functional module | Journal/Story (COLD domain) | **KEEP** | None | Integrate in P09 |
| `modules/turn` | **DELETED** | N/A | **REMOVE** (done) | Was core dependency | Verify no references remain |
| `modules/gm` | **DELETED** | N/A | **REMOVE** (done) | Was core/gateway dependency | Verify no references remain |
| `modules/gm-review` | **DELETED** | N/A | **REMOVE** (done) | Was core/gateway dependency | Verify no references remain |
| `modules/ai-director` | **DELETED** | N/A | **REMOVE** (done) | Was core dependency | Verify no references remain |
| `shared/contracts/domain/turn.ts` | Turn Engine Zod schemas | Legacy contracts | **REMOVE** | Gateway, client, tests | Delete in P02 |
| `shared/contracts/domain/gm.ts` | GM Zod schemas | Legacy contracts | **REMOVE** | Gateway, tests | Delete in P02 |
| `shared/contracts/domain/gm-review.ts` | GM Review Zod schemas | Legacy contracts | **REMOVE** | Gateway, tests | Delete in P02 |
| `shared/contracts/` (v4 schemas) | World, Match, Command, Event, Projection schemas | v4 canonical contracts | **KEEP** | All v4 work | Extend in P02 |
| `gateways/ws-gateway` | WS transport with Turn/GM ops | v4 WebSocket transport | **ADAPT** | Turn/GM ops (legacy) | Strip legacy ops; add v4 envelopes in P05 |
| `client/src/net/WSClient.ts` | Subprotocol `mnemosin.v1.<jwt>`, offline queue | v4 WS client | **ADAPT** | Legacy subprotocol | Update for v4 protocol in P05 |
| `client/src/shell/GameShell.svelte` | Renders `TurnPanel` (DELETED) | v4 Player shell | **REPLACE** | TurnPanel (gone) | Rewrite for P05 vertical slice |
| `client/src/player/PlayerApp.svelte` | Imports `TurnPanel` (DELETED) | v4 Player app | **REPLACE** | TurnPanel (gone) | Rewrite for P05 vertical slice |
| `client/src/player/VisualPanel.svelte` | Placeholder for Stage 2 | v4 PixiJS scene | **REPLACE** | None | Implement in P05 |
| `infrastructure/database/migrations/0000_init.sql` | Tables: `turns`, `actions.turn_id`, `journal_entries.turn_id`, `sessions.currentTurnId` | v4 schema (Match, Participant, World, etc.) | **REPLACE** | All DB code | New migrations in P02/P10 |
| `infrastructure/database/` | Drizzle setup, repositories | v4 Database adapter | **KEEP** | Schema | Align with v4 schema in P02 |

---

## 5. Test Classification

**Audited Source-Tree Snapshot (55ddad6).** Deleted files confirmed via `git diff eb15ccf..55ddad6 -- tests/`.

### 5.1 Deleted Test Files (19 — commit `a1491af`)

#### Contract (2)

| File | Actual State | Functional Area | Related Module / Boundary | Decision | v4 Replacement | Rationale |
|------|-------------|-----------------|---------------------------|----------|----------------|-----------|
| `tests/contract/ai-port.test.ts` | DELETED in `a1491af` | AI Director port contract | `modules/ai-director` (deleted) | **DELETE** | None yet — Doll AI (P08A) uses a different, LLM-free port | Module removed; contract no longer valid |
| `tests/contract/module-contracts.test.ts` | DELETED in `a1491af` | Module contract boundaries | `modules/turn`, `gm`, `gm-review`, `ai-director` (deleted) | **DELETE** | P02 will define new module contracts | Modules removed; contract superseded |

#### Integration (17)

| File | Actual State | Functional Area | Related Module / Boundary | Decision | v4 Replacement | Rationale |
|------|-------------|-----------------|---------------------------|----------|----------------|-----------|
| `tests/integration/ai-director.test.ts` | DELETED in `a1491af` | AI Director orchestration | `modules/ai-director` (deleted) | **DELETE** | P08A Doll AI (deterministic, no LLM) | Module removed |
| `tests/integration/chat.test.ts` | DELETED in `a1491af` | Chat/whisper | `modules/chat` (**KEEP**) | **ADAPT** | P09 chat/whisper COLD domain | Module kept but test deleted — re-author test for v4 |
| `tests/integration/story.test.ts` | DELETED in `a1491af` | Story/Journal | `modules/story` (**KEEP**) | **ADAPT** | P09 story/journal COLD domain | Module kept but test deleted — re-author test for v4 |
| `tests/integration/gm-audit.test.ts` | DELETED in `a1491af` | GM audit trail | `modules/gm-audit` (**KEEP** as P11 base) | **ADAPT** | P11 Observer/Developer audit trail | Module kept as P11 base but test deleted — re-author for v4 |
| `tests/integration/gm.test.ts` | DELETED in `a1491af` | GM orchestration | `modules/gm` (deleted) | **DELETE** | P11 Observer role (read-only + god actions) | Module removed |
| `tests/integration/gm-review.test.ts` | DELETED in `a1491af` | GM review | `modules/gm-review` (deleted) | **DELETE** | None — GM review removed from v4 | Module removed |
| `tests/integration/location-service.test.ts` | DELETED in `a1491af` | Location loading/state | `core/src/locations` | **DELETE** | P03 World Pack loader/validator tests | Location model replaced by World Pack; had fixture mismatches (CI #18) |
| `tests/integration/persistence.test.ts` | DELETED in `a1491af` | Database persistence | `infrastructure/database` | **ADAPT** | P02/P10 v4 schema + migration tests | DB schema being replaced; persistence logic still relevant |
| `tests/integration/http-gateway.test.ts` | DELETED in `a1491af` | HTTP gateway | `apps/server` HTTP bootstrap | **ADAPT** | P02 HTTP bootstrap (Fastify) | HTTP transport retained; test needs v4 update |
| `tests/integration/ws-gateway.test.ts` | DELETED in `a1491af` | WebSocket gateway | `gateways/ws-gateway` | **ADAPT** | P05 WebSocket protocol | WS transport retained; test needs v4 update |
| `tests/integration/ws-privacy.property.test.ts` | DELETED in `a1491af` | WS privacy isolation (property test) | `gateways/ws-gateway` projections | **ADAPT** | P05/P11 projection privacy | Privacy property is a v4 invariant; re-author after projections defined |
| `tests/integration/crash.test.ts` | DELETED in `a1491af` | Crash recovery | `core` runtime | **DEFER** | P06 crash/restart harness | Recovery semantics not yet defined (HC-06–HC-10) |
| `tests/integration/reconcile-boot.test.ts` | DELETED in `a1491af` | Reconciliation boot | `core` state | **INVESTIGATE** | P06 recovery/snapshot | Unclear which reconciliation semantics it covers — inspect before deciding |
| `tests/integration/http-helpers.ts` | DELETED in `a1491af` | **Helper (support file, not a suite)** | HTTP gateway tests | **ADAPT** (tied to `http-gateway.test.ts`) | P02 HTTP test helpers | Helper for deleted `http-gateway.test.ts` |
| `tests/integration/ws-helpers.ts` | DELETED in `a1491af` | **Helper (support file, not a suite)** | WS gateway tests | **ADAPT** (tied to `ws-gateway.test.ts`) | P05 WS test helpers | Helper for deleted `ws-gateway.test.ts` |
| `tests/integration/modules-helpers.ts` | DELETED in `a1491af` | **Helper (support file, not a suite)** | Module tests | **DELETE** | P02 module test helpers | Helper for deleted module tests |
| `tests/integration/crash-child.ts` | DELETED in `a1491af` | **Helper (child-process fixture, not a suite)** | Crash recovery tests | **DEFER** (tied to `crash.test.ts`) | P06 crash harness | Helper for deferred `crash.test.ts` |

### 5.2 Present Test Files (at audited source-tree snapshot)

| File | Actual State | Decision | Rationale |
|------|-------------|----------|-----------|
| `tests/unit/turn-transitions.test.ts` | **PRESENT** (not deleted; passed in CI #18) | **DELETE** (after confirming no v4 equivalent) | Turn Engine logic — currently exists and passes in CI #18 |
| `tests/arch/boundaries.test.ts` | Modified in `a1491af` | **ADAPT** | Update for v4 boundaries in P02 |
| `tests/arch/core-manifest.json` | Modified in `a1491af` | **ADAPT** | Update for v4 core manifest in P02 |
| `tests/arch/state-service-access.test.ts` | Modified in `a1491af` | **ADAPT** | Update for v4 state service in P02 |
| `tests/integration/outbox.test.ts` | Modified in `a1491af`; lint errors (`no-unsafe-finally`) at 248, 255, 259 | **ADAPT** | Fix lint; align with v4 outbox in P02 |
| `tests/contract/ai-port-compliance.ts`, `catalogs.test.ts`, `real-content.test.ts`, `schemas.test.ts` | Present | **ADAPT** | Align with v4 contracts in P02 |
| `tests/unit/` (other) | Present | **KEEP** | Pure logic tests reusable |
| E2E tests | Not found | **DEFER** | Create with P05 vertical slice |

**Note on test deletions:** Commit `a1491af` contains 19 test-file deletions. The origin of these changes relative to the start of P00 is unestablished, since the initial `git status` was not saved. This audit classifies their actual state and recommended fate, but does not attribute them to a specific actor. No tests were restored or deleted during this audit.

---

## 6. P00–P15 Dual-Status Matrix

**Status Definitions:**
- **Actual State:** NOT STARTED / PARTIAL / IMPLEMENTED / VERIFIED / UNKNOWN
- **Readiness:** READY / READY WITH PROVISIONAL DETAILS / BLOCKED BY DECISION / DEFERRED / UNKNOWN
- **VERIFIED requires runtime evidence** (not just interfaces/docs/tests)

| Phase | Actual State | Readiness | Evidence / Justification |
|-------|--------------|-----------|--------------------------|
| **P00** Repository Audit | **PARTIAL** — audit deliverables are complete, but the initial working-tree provenance was not captured and cannot be independently verified | READY | Git baseline, CI verified at audited SHA, docs validated, inventory complete, report delivered |
| **P01** Decision Register & ADR | NOT STARTED | **READY WITH PROVISIONAL DETAILS** | Original roadmap: collect open decisions, classify BLOCKER/PROTOTYPE/CONTENT/DEFERRED. No separate blocker found by audit beyond existing open questions in specs. |
| **P02** Contracts & Architecture Foundation | NOT STARTED | READY WITH PROVISIONAL DETAILS | No World Pack code exists. Schema design needed. Depends on P01 contracts. |
| **P03** World Pack & Coordinate Model | NOT STARTED | READY WITH PROVISIONAL DETAILS | No World Pack code. Depends on P02 contracts. |
| **P04** Minimal HOT Runtime & Server Movement | NOT STARTED | READY WITH PROVISIONAL DETAILS | No HOT runtime exists. Depends on P02/P03. |
| **P05** Network Protocol & First Realtime Client | NOT STARTED | READY WITH PROVISIONAL DETAILS | Legacy WS gateway/client exist but use v1 subprotocol and Turn/GM ops. Depends on P02/P04. |
| **P06** HOT/COLD Bridge & Recovery | NOT STARTED | READY (prototype) / BLOCKED BY DECISION (production) | Durability decisions HC-06–HC-10 open. Prototype acceptable. |
| **P07** Spatial Game Mechanics | NOT STARTED | READY WITH PROVISIONAL DETAILS | No spatial mechanics. Depends on P03–P06. |
| **P08A** Doll AI Baseline | NOT STARTED | READY WITH PROVISIONAL DETAILS | Sensor model undecided (DOLL-OPEN-01–03). Prototype patrol acceptable. |
| **P08B** Capture Integration | NOT STARTED | **BLOCKED BY DECISION** | Requires P10 Participant states (Captured/Stasis) and contracts. |
| **P09** COLD Gameplay Domains | NOT STARTED | READY WITH PROVISIONAL DETAILS | Modules `chat`, `story`, `gm-audit` exist as partial bases. Depends on P01/P02 contracts. |
| **P10** Match Lifecycle | NOT STARTED | **BLOCKED BY DECISION** | Role distribution (7–10), progression rules ML-01–ML-20 open. Requires P01/P02/P09. |
| **P11** Observer & Developer Tooling | NOT STARTED | READY (read-only) / BLOCKED BY DECISION (actions) | `gm-audit` module is a partial base. Depends on P05/P10. |
| **P12** Andrey & LLM | NOT STARTED | READY WITH PROVISIONAL DETAILS | No Andrey code. Scripted fallback first (per master plan). Depends on P10 narrative triggers. |
| **P13** Finale & Ending Resolver | NOT STARTED | DEFERRED | Requires P10 Match completion, P12 Andrey narrative triggers. Ending conditions open. |
| **P14** Art & Content Pipeline (Parallel) | NOT STARTED | READY WITH PROVISIONAL DETAILS | **Formal dependencies:** P03, P05, P07. P02 is a prerequisite for stabilizing the common contracts/schemas. **Start conditions:** (1) World Pack schema stabilized, (2) resource IDs/references defined, (3) client display interfaces stable, (4) production World Packs use server-authoritative geometry. **Does NOT wait for P08/P10/P12/P13.** |
| **P15** End-to-End Integration & Playable Alpha | NOT STARTED | DEFERRED | Requires all prior phases. First vertical slice = P03–P05. |

---

## 7. Key Blockers & Open Decisions

| Blocker | Affected Phases | Required Resolution |
|---------|-----------------|---------------------|
| `core/src/session/session-service.ts` calls `this.turns.openTurn()` | P01, P10 | Rewrite session service for v4 Match aggregate (P10) or stub in P02 |
| Database schema has turn-scoped columns (`turns`, `actions.turn_id`, `journal_entries.turn_id`, `sessions.currentTurnId`) | P02, P10 | New migrations for v4 schema (Match, Participant, WorldEpoch, etc.) |
| `shared/contracts` retains turn/GM/gm-review schemas | P02, P05, P09 | Delete legacy schemas; finalize v4 contracts in P02 |
| WS Gateway declares `WsTurnOps`, `WsGmOps`, `WsGmReviewOps` | P02, P05 | Strip legacy ops; implement v4 command/event envelopes in P05 |
| Client `GameShell.svelte` / `PlayerApp.svelte` reference deleted `TurnPanel` | P04, P05 | Rewrite Player shell for PixiJS scene in P05 |
| No World Pack schema / loader / validator | P02, P03, P14 | Design schema per `WORLD_SIMULATION.md` |
| No HOT Runtime (fixed-step, deterministic input, collisions) | P03, P04, P05 | Implement per `HOT_COLD_DESIGN.md` |
| No HOT/COLD bridge (events, idempotency, snapshots) | P05, P06 | Implement per `HOT_COLD_DESIGN.md` |
| Doll AI perception/sensor model not decided | P08A | Decision needed (BLOCKER for production P08A) |
| Participant states (Captured/Stasis) not defined | P08B, P10 | Decision needed in P10 |
| Ending conditions / priority table not decided | P13 | Decision needed (can defer until P10/P12) |
| Role distribution rules for 7–10 players | P10 | Decision needed (ML-01–ML-20) |

---

## 8. Implementation Report Validity Check

| Report | Branch | Commit SHA | Date | Valid for Audited HEAD `eb15ccf`? |
|--------|--------|------------|------|-----------------------------------|
| `CORE-01_AUDIT_REPORT.md` | `arch-v2` | `5debed6` | Earlier | **NO** — Assumed P01 applied; Turn Engine fully wired in `main.ts`, `modules.ts`, `core/services.ts` at that SHA. Audited source-tree snapshot has SB-01 minimal `main.ts` but Core receives `TurnServicePort` via DI. |
| `CORE-01A-R1_CONTEXT.md` | `arch-v2` | `5debed6` | Earlier | **PARTIAL** — Correctly identifies that `turn-service.ts` was deleted and `services.ts`/`session-service.ts` reference it. Audited source-tree snapshot has `turn-service.ts` as a Port interface (not deleted at `eb15ccf`). |
| `SB-01_SERVER_BOOTSTRAP_REPORT.md` | `arch-v2` | `5740ada` | Earlier | **YES** — `apps/server/src/main.ts` at the audited source-tree snapshot matches SB-01 minimal bootstrap exactly. |
| `SB-01_CONTEXT.md` | `arch-v2` | `5740ada` | Earlier | **YES** — Context accurate for SB-01 changes. |
| `REUSE_AUDIT_v4.md` | `main` | `5debed6` | Earlier | **PARTIAL** — Written against `main` at `5debed6` (before SB-01). Current `arch-v2` has further test deletions. Component statuses need re-verification against actual files. |

**Conclusion:** No old report is proof of current state. All key findings re-verified against actual files at `eb15ccf`.

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| P01 scope creep (trying to fix all legacy wiring at once) | High | Delays vertical slice | Strict P01 scope: only decision register, ADR for confirmed decisions. No code changes. |
| Database migration complexity (turn-scoped → v4 schema) | Medium | Data loss risk / downtime | Plan migrations in P02; use Drizzle migration API; test on copy. |
| Client rewrite scope (GameShell, PlayerApp, VisualPanel) | High | P05 vertical slice delay | Minimal viable PixiJS scene in P05; defer polish to P14. |
| Doll AI sensor model undecided | High | P08A cannot reach VERIFIED | Prototype with provisional model (P08A READY WITH PROVISIONAL DETAILS); finalize before VERIFIED. |
| LLM integration for Andrey over-engineered | Medium | Unnecessary complexity | Enforce scripted fallback first (P12); LLM only for permitted speech. |
| CI not re-run at the audited source-tree snapshot | Medium | False confidence | Re-run CI after P01 fixes; require green at each phase commit. |

---

## 10. Next Step Recommendation

**Proceed to P01: Decision Register & ADR**

**Correct P01 scope (per original roadmap):**
1. Survey open questions in all architectural docs (`SYSTEM_ARCHITECTURE`, `HOT_COLD_DESIGN`, `WORLD_SIMULATION`, `DOLL_AI`, `ANDREY_AI`, `NETWORK_PROTOCOL`, `MATCH_LIFECYCLE`)
2. Deduplicate, preserve original IDs
3. For each question: formulation, variants, impact, blocked phases, prototype viability, decision owner
4. Classify: **BLOCKER** / **PROTOTYPE** / **CONTENT** / **DEFERRED**
5. Prepare ADR **only for already-confirmed decisions**; do not convert proposals to ADRs
6. Deliver: `docs/implementation/DECISION_REGISTER.md`

**Do NOT in P01:**
- Remove `TurnServicePort` from `core/src/domain/ports/turn-service.ts`
- Rewrite `core/src/session/session-service.ts`
- Delete legacy schemas from `shared/contracts/domain/`
- Plan database migrations
- Any code changes

**P02 (Contracts & Architecture Foundation) will then:**
- Remove `TurnServicePort` and legacy contracts
- Finalize v4 contract catalog
- Define Ports & Adapters boundaries
- Plan DB migrations
- Update `core/src/services.ts` DI

---

## 11. Files Changed by This Audit

| File | Change Type |
|------|-------------|
| `docs/implementation/REPOSITORY_AUDIT.md` | **CREATED** (this document; updated at `55ddad6`) |
| `docs/IMPLEMENTATION_ROADMAP.md` | **UPDATED** (compact status summary + link to this audit; updated at `55ddad6`) |

No other files modified. Git diff verified clean except for these two documents (created/updated in commits `a1491af` and `55ddad6`).