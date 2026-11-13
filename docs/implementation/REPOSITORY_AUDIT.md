# MNEMOSIN Repository Audit — P00

**Generated:** 2026-11-13  
**Branch:** `arch-v2`  
**HEAD:** `a1491af` (parent of `eb15ccf` — the audit was performed against `eb15ccff58a49dc1854ad5b5672c5e1cca60084e`, see Git baseline below)  
**Auditor:** Coding Agent (P00 execution)

---

## 1. Git Baseline Snapshot

| Property | Value |
|----------|-------|
| Current branch | `arch-v2` |
| HEAD commit (audited) | `eb15ccff58a49dc1854ad5b5672c5e1cca60084e` (commit message: "Выполнена доработка тестов") |
| Current HEAD (after staged deletions committed) | `a1491af` ("Удалены старые тесты") |
| `main` branch HEAD | `fc62c57` |
| Tag `stage1-final` | Points to `main` at `fc62c57` (commit message: "довел проект до стадии end_stage_1") |
| Staged changes (before P00, at `eb15ccf`) | 19 modified/deleted test files (integration tests for removed modules: turn, gm, gm-review, ai-director) |
| Unstaged changes (before P00, at `eb15ccf`) | None |
| Untracked files (before P00, at `eb15ccf`) | None |

**Archive point verified:** `main` branch at `fc62c57` with tag `stage1-final` preserves the complete Table MVP implementation (Stage 1 with GM-in-the-loop, Turn Engine, GM Review). This is a **confirmed Git rollback point** (tag object exists, commit SHA verified). **Full application restoration from this point has not been tested** — only the Git tree is confirmed.

**Git baseline attribution note:** The initial `git status --porcelain=v1` snapshot was **not saved** before P00 began. The 19 staged test deletions are **pre-existing changes** from prior work (commits `7cc4e99` through `a1491af`), not created by this audit. This audit created only two new/updated files: `docs/implementation/REPOSITORY_AUDIT.md` (new) and `docs/IMPLEMENTATION_ROADMAP.md` (updated).

---

## 2. CI Status at SHA `eb15ccff58a49dc1854ad5b5672c5e1cca60084e`

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

**CI evidence used:** Workflow definition read; CI run #18 results for SHA `eb15ccf` referenced. No fresh CI run executed per P00 constraints.

### Integration Test Failure Classification

| Failure | Files Affected | Classification | Rationale |
|---------|---------------|----------------|-----------|
| Missing `@mnemosin/module-turn` | Multiple integration test files | **stale test dependency** | Module deleted in commit `5debed6`; tests not updated |
| `services.turns.submitAction is not a function` | `tests/integration/session-service.test.ts` | **stale test dependency** | `TurnService` port interface changed; test uses old method name |
| `buildAIStack is not a function` | `tests/integration/ai-director*.test.ts` | **stale test dependency** | Module deleted; test references removed factory |
| Missing fixture `locations.stage1.json` | `tests/integration/location-service.test.ts` | **missing fixture** | Fixture file not present in repo |
| Missing fixture `resolution.ok.json` | `tests/integration/location-service.test.ts` | **missing fixture** | Fixture file not present in repo |
| Location service test errors | `tests/integration/location-service.test.ts` | **implementation defect** | Service logic errors unrelated to deleted modules |

**No `contract mismatch` or `unknown` failures identified.**

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
│   ├── integration/             # 19 files STAGED FOR DELETION (turn/gm/ai-director)
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

| Test Suite / File | Current State | Classification | Rationale |
|-------------------|---------------|----------------|-----------|
| `tests/integration/turn*` | Staged for deletion | **DELETE** | Turn Engine removed; no v4 equivalent yet |
| `tests/integration/gm*` | Staged for deletion | **DELETE** | GM module removed; Observer/Dev tooling is P11 |
| `tests/integration/ai-director*` | Staged for deletion | **DELETE** | AI Director removed; Doll AI is P08A |
| `tests/integration/gm-review*` | Staged for deletion | **DELETE** | GM Review removed; not in v4 |
| `tests/unit/turn-transitions.test.ts` | Staged for deletion | **DELETE** | Turn Engine logic |
| `tests/arch/boundaries.test.ts` | Modified (staged) | **ADAPT** | Update for v4 boundaries in P02 |
| `tests/arch/core-manifest.json` | Modified (staged) | **ADAPT** | Update for v4 core manifest in P02 |
| `tests/contract/*` | Exist | **ADAPT** | Align with v4 contracts in P02 |
| `tests/unit/` (other) | Exist | **KEEP** | Pure logic tests reusable |
| E2E tests | Not found | **DEFER** | Create with P05 vertical slice |

**Note:** No test deletions performed in P00 — only classification. Actual deletion is a post-audit task.

---

## 6. P00–P15 Dual-Status Matrix

**Status Definitions:**
- **Actual State:** NOT STARTED / PARTIAL / IMPLEMENTED / VERIFIED / UNKNOWN
- **Readiness:** READY / READY WITH PROVISIONAL DETAILS / BLOCKED BY DECISION / DEFERRED / UNKNOWN
- **VERIFIED requires runtime evidence** (not just interfaces/docs/tests)

| Phase | Actual State | Readiness | Evidence / Justification |
|-------|--------------|-----------|--------------------------|
| **P00** Repository Audit | PARTIAL (Steps 1-5 done) | READY | Git baseline, docs validated, inventory complete, this report in progress |
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
| **P14** Art & Content Pipeline (Parallel) | NOT STARTED | READY WITH PROVISIONAL DETAILS | **Explicit start conditions:** (1) World Pack schema stabilized, (2) resource IDs/references defined, (3) client display interfaces stable, (4) production World Packs use server-authoritative geometry. Can start after P02/P03; does NOT wait for P08/P10/P12/P13. |
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

| Report | Branch | Commit SHA | Date | Valid for Current HEAD `eb15ccf`? |
|--------|--------|------------|------|-----------------------------------|
| `CORE-01_AUDIT_REPORT.md` | `arch-v2` | `5debed6` | Earlier | **NO** — Assumed P01 applied; Turn Engine fully wired in `main.ts`, `modules.ts`, `core/services.ts` at that SHA. Current HEAD has SB-01 minimal `main.ts` but Core receives `TurnServicePort` via DI. |
| `CORE-01A-R1_CONTEXT.md` | `arch-v2` | `5debed6` | Earlier | **PARTIAL** — Correctly identifies that `turn-service.ts` was deleted and `services.ts`/`session-service.ts` reference it. Current HEAD has `turn-service.ts` as a Port interface (not deleted at `eb15ccf`). |
| `SB-01_SERVER_BOOTSTRAP_REPORT.md` | `arch-v2` | `5740ada` | Earlier | **YES** — `apps/server/src/main.ts` at current HEAD matches SB-01 minimal bootstrap exactly. |
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
| CI not re-run at current HEAD | Medium | False confidence | Re-run CI after P01 fixes; require green at each phase commit. |

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
| `docs/implementation/REPOSITORY_AUDIT.md` | **CREATED** (this document) |
| `docs/IMPLEMENTATION_ROADMAP.md` | **UPDATED** (compact status summary + link to this audit) |

No other files modified. Git diff verified clean except for these two documents.