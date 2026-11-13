# MNEMOSIN Repository Audit — P00

**Generated:** 2026-11-13  
**Branch:** `arch-v2`  
**HEAD:** `eb15ccff58a49dc1854ad5b5672c5e1cca60084e`  
**Auditor:** Coding Agent (P00 execution)

---

## 1. Git Baseline Snapshot

| Property | Value |
|----------|-------|
| Current branch | `arch-v2` |
| HEAD commit | `eb15ccff58a49dc1854ad5b5672c5e1cca60084e` |
| `main` branch HEAD | `fc62c57` |
| Tag `stage1-final` | Points to `main` at `fc62c57` (Table MVP archive) |
| Staged changes | 19 modified/deleted test files (integration tests for removed modules) |
| Unstaged changes | None |
| Untracked files | None |

**Archive point verified:** `main` branch at `fc62c57` with tag `stage1-final` preserves the complete Table MVP implementation (Stage 1 with GM-in-the-loop, Turn Engine, GM Review). This is a valid rollback point.

---

## 2. CI Status

| Workflow | Status at HEAD `eb15ccf` | Notes |
|----------|--------------------------|-------|
| `ci.yml` (Stage 1 Table MVP) | **Not re-run at current HEAD** | Last successful run was against `main`/`stage1-final`. Current `arch-v2` HEAD has known TypeScript errors (TS2307 from deleted `turn-service.ts` + expected build failures from Turn Engine deps in core/services). Running full CI would likely fail and is not required for P00 audit. |

**CI evidence used:** Workflow definition read; no fresh run executed per P00 constraints (no `npm ci`, no mass build).

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
│       │   ├── index.ts         # Exports JournalService ONLY (TurnService DELETED)
│       │   └── turn-service.ts  # DELETED (referenced in services.ts, session-service.ts)
│       ├── session/
│       │   └── session-service.ts  # Calls this.turns.openTurn() — BROKEN
│       ├── domain/
│       │   └── ports/
│       │       └── turn-service.ts  # TurnServicePort interface (KEPT)
│       └── services.ts          # createCoreServices() — creates TurnService (DELETED)
├── data/                        # Database related
├── docs/
│   ├── SYSTEM_ARCHITECTURE.md   # v4 target architecture
│   ├── IMPLEMENTATION_ROADMAP.md # P00–P15 phases
│   ├── REUSE_AUDIT_v4.md        # Migration matrix (written against main@5debed6)
│   ├── HOT_COLD_DESIGN.md
│   ├── WORLD_SIMULATION.md
│   ├── NETWORK_PROTOCOL.md
│   ├── DOLL_AI.md
│   └── implementation/
│       ├── CORE-01_AUDIT_REPORT.md
│       ├── CORE-01A-R1_CONTEXT.md
│       ├── SB-01_SERVER_BOOTSTRAP_REPORT.md
│       └── SB-01_CONTEXT.md
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
| `core/src/services.ts` | Creates `TurnService` (DELETED) + other services | Core service factory (Ports & Adapters) | **REPLACE** | `turn-service.ts` (deleted), session-service | Remove TurnService creation; wire v4 ports in P02 |
| `core/src/turns/index.ts` | Exports `JournalService` only | Domain module for journal/story | **KEEP** (as Journal) | None | Rename/refactor in P02 |
| `core/src/turns/turn-service.ts` | **DELETED** | N/A | **REMOVE** (already gone) | Referenced in services.ts, session-service | Clean up references in P02 |
| `core/src/domain/ports/turn-service.ts` | `TurnServicePort` interface | Legacy port | **REMOVE** | Core services | Delete in P02 |
| `core/src/session/session-service.ts` | Calls `this.turns.openTurn()` | Session orchestration (v4: Match aggregate) | **REPLACE** | TurnService (deleted) | Rewrite for v4 Match lifecycle in P10 |
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
| `data/migrations/0000_init.sql` | Tables: `turns`, `actions.turn_id`, `journal_entries.turn_id`, `sessions.currentTurnId` | v4 schema (Match, Participant, World, etc.) | **REPLACE** | All DB code | New migrations in P02/P10 |
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
| **P00** Repository Audit | PARTIAL (Steps 1-5 done) | READY | Git baseline, docs read, inventory complete, this report in progress |
| **P01** Architecture & Contracts Foundation | NOT STARTED | BLOCKED BY DECISION | Turn Engine still wired in core/services.ts, session-service.ts, contracts, DB schema. Must complete P01 before any v4 module can compile. |
| **P02** World Pack & Coordinate Model | NOT STARTED | READY | No World Pack code exists. Schema design needed. Depends on P01 contracts. |
| **P03** Minimal HOT Runtime & Server Movement | NOT STARTED | READY | No HOT runtime exists. Depends on P01/P02. |
| **P04** Network Protocol & First Realtime Client | NOT STARTED | READY | Legacy WS gateway/client exist but use v1 subprotocol and Turn/GM ops. Depends on P01/P03. |
| **P05** HOT/COLD Bridge & Recovery | NOT STARTED | READY | No bridge exists. Depends on P03/P04. |
| **P06** Spatial Game Mechanics | NOT STARTED | READY | No spatial mechanics. Depends on P03/P05. |
| **P07** Doll AI Baseline (P08A) | NOT STARTED | READY | No Doll AI. Depends on P03–P06 (perception, navigation). |
| **P08** Capture Integration (P08B) | NOT STARTED | BLOCKED BY DECISION | Requires P10 Participant states (Captured/Stasis) and contracts. |
| **P09** COLD Gameplay Domains | NOT STARTED | READY | Modules `chat`, `story`, `gm-audit` exist as partial bases. Depends on P01 contracts. |
| **P10** Match Lifecycle | NOT STARTED | BLOCKED BY DECISION | Requires P01 contracts, P02 World Pack, P09 COLD domains. Session module exists but uses Turn Engine. |
| **P11** Observer & Developer Tooling | NOT STARTED | READY | `gm-audit` module is a partial base. Depends on P05 (projections), P10 (states). |
| **P12** Andrey & LLM | NOT STARTED | READY WITH PROVISIONAL DETAILS | No Andrey code. Scripted fallback first (per master plan). Depends on P10 narrative triggers. |
| **P13** Finale & Ending Resolver | NOT STARTED | DEFERRED | Requires P10 Match completion, P12 Andrey narrative triggers. |
| **P14** Art & Content Pipeline (Parallel) | NOT STARTED | READY WITH PROVISIONAL DETAILS | Can start after P02 World Pack schema stabilizes + resource IDs + client display interfaces. No Doll AI/Match/Andrey/Finale wait needed. |
| **P15** End-to-End Integration & Playable Alpha | NOT STARTED | DEFERRED | Requires all prior phases. First vertical slice = P03–P05. |

---

## 7. Key Blockers & Open Decisions

| Blocker | Affected Phases | Required Resolution |
|---------|-----------------|---------------------|
| **Turn Engine wired in `core/src/services.ts`** (creates deleted `TurnService`) | P01, P02, P03, P10 | Remove TurnService creation; define v4 Ports & Adapters |
| **`core/src/session/session-service.ts` calls `this.turns.openTurn()`** | P01, P10 | Rewrite session service for v4 Match aggregate |
| **Database schema has turn-scoped columns** (`turns`, `actions.turn_id`, `journal_entries.turn_id`, `sessions.currentTurnId`) | P01, P10 | New migrations for v4 schema (Match, Participant, WorldEpoch, etc.) |
| **`shared/contracts` retains turn/GM/gm-review schemas** | P01, P02, P05, P09 | Delete legacy schemas; finalize v4 contracts |
| **WS Gateway declares `WsTurnOps`, `WsGmOps`, `WsGmReviewOps`** | P01, P05 | Strip legacy ops; implement v4 command/event envelopes |
| **Client `GameShell.svelte` renders deleted `TurnPanel`** | P04, P05 | Rewrite Player shell for PixiJS scene |
| **Client `PlayerApp.svelte` imports deleted `TurnPanel`** | P04, P05 | Rewrite Player app |
| **No World Pack schema / loader / validator** | P02, P03, P14 | Design schema per `WORLD_SIMULATION.md` |
| **No HOT Runtime (fixed-step, deterministic input, collisions)** | P03, P04, P05 | Implement per `HOT_COLD_DESIGN.md` |
| **No HOT/COLD bridge (events, idempotency, snapshots)** | P05, P06 | Implement per `HOT_COLD_DESIGN.md` |
| **Doll AI perception/sensor model not decided** | P07 (P08A) | Decision needed (BLOCKER for production P08A) |
| **Participant states (Captured/Stasis) not defined** | P08B, P10 | Decision needed in P10 |
| **Ending conditions / priority table not decided** | P13 | Decision needed (can defer until P10/P12) |

---

## 8. Implementation Report Validity Check

| Report | Branch | Commit SHA | Date | Valid for Current HEAD `eb15ccf`? |
|--------|--------|------------|------|-----------------------------------|
| `CORE-01_AUDIT_REPORT.md` | `arch-v2` | `5debed6` | Earlier | **NO** — Assumed P01 applied; Turn Engine fully wired in `main.ts`, `modules.ts`, `core/services.ts` at that SHA. Current HEAD has SB-01 minimal `main.ts` but Core Turn deps persist. |
| `CORE-01A-R1_CONTEXT.md` | `arch-v2` | `5debed6` | Earlier | **PARTIAL** — Correctly identifies TS2307 errors from deleted `turn-service.ts` and expected build failures. Current HEAD matches this diagnosis. |
| `SB-01_SERVER_BOOTSTRAP_REPORT.md` | `arch-v2` | `5740ada` | Earlier | **YES** — `apps/server/src/main.ts` at current HEAD matches SB-01 minimal bootstrap exactly. |
| `SB-01_CONTEXT.md` | `arch-v2` | `5740ada` | Earlier | **YES** — Context accurate for SB-01 changes. |
| `REUSE_AUDIT_v4.md` | `main` | `5debed6` | Earlier | **PARTIAL** — Written against `main` at `5debed6` (before SB-01). Current `arch-v2` has further test deletions. Component statuses need re-verification against actual files. |

**Conclusion:** No old report is proof of current state. All key findings re-verified against actual files at `eb15ccf`.

---

## 9. Risks

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| P01 scope creep (trying to fix all legacy wiring at once) | High | Delays vertical slice | Strict P01 scope: only contracts, Ports & Adapters boundaries, migration plan. No business logic. |
| Database migration complexity (turn-scoped → v4 schema) | Medium | Data loss risk / downtime | Plan migrations in P02; use Drizzle migration API; test on copy. |
| Client rewrite scope (GameShell, PlayerApp, VisualPanel) | High | P05 vertical slice delay | Minimal viable PixiJS scene in P05; defer polish to P14. |
| Doll AI sensor model undecided | High | P08A cannot reach VERIFIED | Prototype with provisional model (P08A READY WITH PROVISIONAL DETAILS); finalize before VERIFIED. |
| LLM integration for Andrey over-engineered | Medium | Unnecessary complexity | Enforce scripted fallback first (P12); LLM only for permitted speech. |
| CI not re-run at current HEAD | Medium | False confidence | Re-run CI after P01 fixes; require green at each phase commit. |

---

## 10. Next Step Recommendation

**Proceed to P01: Architecture & Contracts Foundation**

**Concrete tasks for P01:**
1. Remove `TurnService` creation from `core/src/services.ts`
2. Remove `TurnServicePort` from `core/src/domain/ports/turn-service.ts`
3. Rewrite `core/src/session/session-service.ts` to not call `this.turns.openTurn()` (stub for v4 Match aggregate)
4. Delete legacy schemas: `shared/contracts/domain/turn.ts`, `gm.ts`, `gm-review.ts`
5. Define v4 Ports & Adapters boundaries in `core/src/domain/ports/`
6. Finalize v4 contract catalog in `shared/contracts/` (World, Match, Participant, Command, Event, Projection, WorldEpoch)
7. Plan database migrations for v4 schema (new migration files)
8. Update `core/src/turns/index.ts` — rename to `journal/` or `story/` module
9. Verify TypeScript compiles (`npm run typecheck`)

**Do NOT:** Implement HOT runtime, World Pack, PixiJS client, Doll AI, or any gameplay logic in P01.

---

## 11. Files Changed by This Audit

| File | Change Type |
|------|-------------|
| `docs/implementation/REPOSITORY_AUDIT.md` | **CREATED** (this document) |
| `docs/IMPLEMENTATION_ROADMAP.md` | **UPDATED** (compact status summary + link to this audit — see below) |

No other files modified. Git diff verified clean except for these two documents.