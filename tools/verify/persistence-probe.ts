import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';

import { nowIso, type GameState, type IdempotencyRecord } from '@mnemosin/contracts';
import { bootstrapDatabase } from '@mnemosin/database';

/**
 * tools/verify/persistence-probe.ts — проба для приёмки A1.4 и A1.5 (промпт 1.4).
 *
 * Зачем отдельный процесс: ROADMAP §5 требует, чтобы идемпотентность и оптимистичная
 * блокировка были продемонстрированы НА ЖИВОМ ПРОЦЕССЕ с настоящей БД на диске,
 * а не только в vitest. Проба печатает одну JSON-строку с результатами — verify:stage1
 * разбирает её и ставит PASS/FAIL.
 *
 * Запуск: npx tsx --conditions=development tools/verify/persistence-probe.ts
 */

const dir = mkdtempSync(join(tmpdir(), 'mnemosin-verify-'));
const url = `file:${join(dir, 'probe.sqlite')}`;

const boot = await bootstrapDatabase({ url, seed: true });
const repos = boot.uow.repos();

// ── A1.4 · идемпотентность ────────────────────────────────────────────────
const PARALLEL = 50;
const key = 'verify-submit-action-0001' as IdempotencyRecord['key'];
const at = nowIso();

const acquireRecord: IdempotencyRecord = {
  key: 'verify-raw-acquire-0001' as IdempotencyRecord['key'],
  turnId: null,
  sessionId: null,
  command: 'submitAction',
  status: 'IN_FLIGHT',
  resultJson: null,
  resultHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  errorCode: null,
  traceId: 'verify-probe',
  createdAt: at,
  expiresAt: at,
};

const rawResults = await Promise.all(
  Array.from({ length: PARALLEL }, () => repos.idempotency.tryAcquire(acquireRecord)),
);
const rawProceed = rawResults.filter((r) => r.kind === 'proceed').length;

let executions = 0;
const outcomes = await Promise.all(
  Array.from({ length: PARALLEL }, (_, i) =>
    boot.idempotency.run(
      { key, command: 'submitAction', sessionId: null, turnId: null, traceId: `verify-${i}` },
      async () => {
        executions += 1;
        await new Promise((r) => setTimeout(r, 2));
        return { executedBy: i };
      },
    ),
  ),
);
const tally = outcomes.reduce<Record<string, number>>((acc, o) => {
  acc[o.kind] = (acc[o.kind] ?? 0) + 1;
  return acc;
}, {});

const replay = await boot.idempotency.run(
  { key, command: 'submitAction', sessionId: null, turnId: null, traceId: 'verify-replay' },
  async () => {
    executions += 1;
    return { executedBy: -1 };
  },
);

// ── A1.5 · оптимистичная блокировка ───────────────────────────────────────
const session = await repos.sessions.findActive();
if (!session) throw new Error('проба: нет активной сессии после посева');
const state = await repos.state.findBySession(session.sessionId);
if (!state) throw new Error('проба: нет состояния сессии');

const withWeather = (source: GameState, weather: string): GameState => ({
  ...source,
  version: source.version + 1,
  updatedAt: nowIso(),
  worldState: { ...source.worldState, weather },
});

const [left, right] = await Promise.all([
  repos.state.updateWithVersion(withWeather(state, 'первый'), state.version),
  repos.state.updateWithVersion(withWeather(state, 'второй'), state.version),
]);
const lockKinds = [left.kind, right.kind].sort();
const conflict = [left, right].find((r) => r.kind === 'conflict');
const stored = await repos.state.findBySession(session.sessionId);

// последовательная запись после конфликта — retry-loop работает
const retry = await repos.state.updateWithVersion(withWeather(stored!, 'третий'), stored!.version);

// ── A1.11 · данные переживают процесс (проверяется отдельно в stage1.mjs перезапуском сервера) ──
const persisted = {
  sessions: (await repos.sessions.listAll()).length,
  players: (await repos.players.listBySession(session.sessionId)).length,
  locations: await repos.locations.count(),
  stateVersion: stored?.version ?? null,
  migrations: boot.version.applied,
  lastMigration: boot.version.lastTag,
};

const report = {
  probe: 'persistence',
  parallel: PARALLEL,
  idempotency: {
    rawProceed,
    rawInFlight: rawResults.filter((r) => r.kind === 'in_flight').length,
    serviceExecuted: executions,
    tally,
    replayKind: replay.kind,
    replayResultJson: replay.kind === 'replayed' ? replay.resultJson : null,
  },
  optimisticLock: {
    kinds: lockKinds,
    conflictActualVersion: conflict?.kind === 'conflict' ? conflict.actualVersion : null,
    storedVersion: stored?.version ?? null,
    retryKind: retry.kind,
  },
  persisted,
  url,
};

await boot.close();
rmSync(dir, { recursive: true, force: true });
process.stdout.write(`${JSON.stringify(report)}\n`);
