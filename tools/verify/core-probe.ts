import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import process from 'node:process';

import type { LocationDefinition, LocationId, PlayerId, TurnId } from '@mnemosin/contracts';
import { createCoreServices, moveIdempotencyKey } from '@mnemosin/core';
import { bootstrapDatabase, loadLocationFixtures } from '@mnemosin/database';

/**
 * tools/verify/core-probe.ts — проба для приёмки A1.6 и A1.15 (промпт 1.6).
 *
 * Прогоняет доменные сервисы core НА ЖИВОМ ПРОЦЕССЕ с настоящей БД на диске
 * (ROADMAP §5): сессия → лобби → старт → полный цикл хода (submit/lock/unlock/
 * cancel) → полный путь машины состояний OPEN→LOCKED→PROCESSING→REVIEW→COMMITTED
 * → moveGroup (счастливый путь, replay, locked exit, exit not found).
 * Печатает одну JSON-строку отчёта — verify:stage1 разбирает её и ставит PASS/FAIL.
 *
 * Запуск: npx tsx --conditions=development tools/verify/core-probe.ts
 */

const dir = mkdtempSync(join(tmpdir(), 'mnemosin-core-probe-'));
const boot = await bootstrapDatabase({ url: `file:${join(dir, 'probe.sqlite')}`, seed: false });
const pack = loadLocationFixtures();
const services = createCoreServices({
  uow: boot.uow,
  guard: boot.idempotency,
  pack,
  limits: { maxPlayersPerSession: 12, actionsPerPlayerPerTurn: 5 },
});

const traceId = 'verify-core-1.6';
let keySeq = 0;
const key = (prefix: string): string => {
  keySeq += 1;
  return `${prefix}-${keySeq}-${randomUUID()}`.slice(0, 128);
};

/** Код ошибки или null, если вызов прошёл. */
async function codeOf(fn: () => Promise<unknown>): Promise<string | null> {
  try {
    await fn();
    return null;
  } catch (cause) {
    const code = (cause as { code?: unknown }).code;
    return typeof code === 'string' ? code : 'UNKNOWN';
  }
}

async function main(): Promise<void> {
  // ── сессия и лобби ─────────────────────────────────────────────────────
  const created = await services.sessions.createSession({
    title: 'МНЕМОСИН · приёмка 1.6',
    gmDisplayName: 'Ведущий',
    idempotencyKey: key('create'),
    traceId,
  });
  const sessionId = created.sessionId;
  const playerIds: PlayerId[] = [];
  for (const name of ['Игрок А', 'Игрок Б', 'Игрок В']) {
    const joined = await services.sessions.joinSession({
      sessionId,
      displayName: name,
      idempotencyKey: key('join'),
      traceId,
    });
    playerIds.push(joined.playerId);
  }
  const started = await services.sessions.startSession({ sessionId, idempotencyKey: key('start'), traceId });
  const turn1 = started.turnId as TurnId;

  // ── ход №1: действия → lock → unlock → lock ────────────────────────────
  await services.turns.submitAction({
    turnId: turn1,
    playerId: playerIds[0]!,
    rawText: 'Осматриваюсь в шлюзе',
    idempotencyKey: key('act'),
    traceId,
  });
  await services.turns.submitAction({
    turnId: turn1,
    playerId: playerIds[1]!,
    rawText: 'Слушаю гул вентиляции',
    idempotencyKey: key('act'),
    traceId,
  });
  const lockKey = key('lock');
  const locked = await services.turns.lockTurn({ turnId: turn1, idempotencyKey: lockKey, traceId });
  const lockReplay = await services.turns.lockTurn({ turnId: turn1, idempotencyKey: lockKey, traceId });
  const lockWhileLocked = await codeOf(() =>
    services.turns.lockTurn({ turnId: turn1, idempotencyKey: key('lock-x'), traceId }),
  );
  const submitWhileLocked = await codeOf(() =>
    services.turns.submitAction({
      turnId: turn1,
      playerId: playerIds[2]!,
      rawText: 'Не успеваю',
      idempotencyKey: key('late'),
      traceId,
    }),
  );
  const cancelWhileLocked = await codeOf(() =>
    services.turns.cancelTurn({ turnId: turn1, reason: 'нельзя', idempotencyKey: key('cancel-x'), traceId }),
  );
  const unlocked = await services.turns.unlockTurn({ turnId: turn1, idempotencyKey: key('unlock'), traceId });
  const unlockWhileOpen = await codeOf(() =>
    services.turns.unlockTurn({ turnId: turn1, idempotencyKey: key('unlock-x'), traceId }),
  );
  await services.turns.lockTurn({ turnId: turn1, idempotencyKey: key('lock2'), traceId });

  // ── A1.6: полный путь машины состояний ─────────────────────────────────
  const pathStatuses: string[] = ['OPEN', 'LOCKED'];
  for (const trigger of ['startProcessing', 'draftReady', 'commitTurn'] as const) {
    const step = await services.turns.transition({ turnId: turn1, trigger, traceId });
    pathStatuses.push(step.status);
  }
  const transitionInvalid = await codeOf(() => services.turns.transition({ turnId: turn1, trigger: 'retry', traceId }));

  // ── ходы №2 и №3: лимит действий, гонка openTurn, cancel ───────────────
  const turn2 = await services.turns.openTurn({ sessionId, idempotencyKey: key('open2'), traceId });
  const openRace = await Promise.all(
    [1, 2, 3].map(() => codeOf(() => services.turns.openTurn({ sessionId, idempotencyKey: key('race'), traceId }))),
  );
  for (let i = 0; i < 5; i += 1) {
    await services.turns.submitAction({
      turnId: turn2.turnId,
      playerId: playerIds[0]!,
      rawText: `Действие ${i + 1} из 5`,
      idempotencyKey: key('burst'),
      traceId,
    });
  }
  const overLimit = await codeOf(() =>
    services.turns.submitAction({
      turnId: turn2.turnId,
      playerId: playerIds[0]!,
      rawText: 'Шестое действие сверх лимита',
      idempotencyKey: key('over'),
      traceId,
    }),
  );
  const cancelled = await services.turns.cancelTurn({
    turnId: turn2.turnId,
    reason: 'GM отменил ход',
    idempotencyKey: key('cancel'),
    traceId,
  });
  const turn3 = await services.turns.openTurn({ sessionId, idempotencyKey: key('open3'), traceId });
  const turnNumbers = (await services.turns.listTurns(sessionId)).map((t) => t.number).sort((a, b) => a - b);

  // ── A1.15: moveGroup — счастливый путь и replay ────────────────────────
  const locations = await services.locations.list(sessionId);
  const byName = new Map(locations.map((l) => [l.name, l.locationId]));
  const lobbyId = byName.get('Холл')!;
  const stateBefore = await services.state.get(sessionId);
  const moved = await services.locations.moveGroup({
    sessionId,
    playerIds,
    toLocationId: lobbyId,
    turnId: turn3.turnId,
    traceId,
  });
  const movedAgain = await services.locations.moveGroup({
    sessionId,
    playerIds,
    toLocationId: lobbyId,
    turnId: turn3.turnId,
    idempotencyKey: key('transport-other'), // намеренно другой транспортный ключ
    traceId,
  });
  const stateAfter = await services.state.get(sessionId);
  const deterministicKey = moveIdempotencyKey({
    sessionId,
    turnId: turn3.turnId,
    playerIds: [...playerIds].reverse(),
    toLocationId: lobbyId,
  });

  // ── A1.15: locked exit → RULE_REJECTED; нет выхода; неизвестная цель ───
  const corridorId = randomUUID() as LocationId;
  const techId = randomUUID() as LocationId;
  const base = locations[0]!;
  const corridor: LocationDefinition = {
    ...base,
    locationId: corridorId,
    sessionId,
    templateSlug: null,
    name: 'Технический коридор',
    exits: [
      {
        kind: 'LOCATION',
        toLocationId: techId,
        label: 'Гермодверь в техотсек',
        description: null,
        oneWay: false,
        hidden: false,
        via: 'door',
        locked: true,
        lock: { type: 'keycard', keyRequired: 'card.tech', requiresFlag: null, reason: 'Нужна ключ-карта' },
      },
    ],
    updatedAt: base.updatedAt,
  };
  const tech: LocationDefinition = {
    ...base,
    locationId: techId,
    sessionId,
    templateSlug: null,
    name: 'Техотсек',
    exits: [],
    updatedAt: base.updatedAt,
  };
  await boot.uow.runInTx(async (scope) => {
    await scope.repos.locations.upsert(corridor);
    await scope.repos.locations.upsert(tech);
  });
  await services.state.apply({
    sessionId,
    mutations: [{ kind: 'WORLD_PATCH', currentLocationId: corridorId }],
    expectedVersion: stateAfter.version,
    traceId,
  });
  const lockedExit = await codeOf(() =>
    services.locations.moveGroup({ sessionId, playerIds, toLocationId: techId, turnId: turn3.turnId, traceId }),
  );
  const noExit = await codeOf(() =>
    services.locations.moveGroup({
      sessionId,
      playerIds,
      toLocationId: lobbyId,
      turnId: randomUUID() as TurnId,
      traceId,
    }),
  );
  const unknownTarget = await codeOf(() =>
    services.locations.moveGroup({
      sessionId,
      playerIds,
      toLocationId: randomUUID() as LocationId,
      turnId: randomUUID() as TurnId,
      traceId,
    }),
  );

  // ── события (публикатор не запущен — всё в outbox PENDING) ─────────────
  const outbox = await boot.uow.repos().outbox.listPending(1000);
  const events: Record<string, number> = {};
  for (const record of outbox) events[record.eventName] = (events[record.eventName] ?? 0) + 1;

  const journalKinds = (await services.journal.list(turn1)).map((e) => e.kind);

  const report = {
    session: {
      status: (await services.sessions.getSession(sessionId)).status,
      players: (await services.sessions.listPlayers(sessionId)).length,
      locations: locations.length,
    },
    turnCycle: {
      lockActionIds: locked.actionIds.length,
      lockReplayed: lockReplay.replayed,
      unlockStatus: unlocked.status,
      lockWhileLocked,
      submitWhileLocked,
      cancelWhileLocked,
      unlockWhileOpen,
      cancelStatus: cancelled.status,
      cancelFailedCode: cancelled.failed.code,
      turnNumbers,
      openRaceRejected: openRace.every((c) => c === 'CORE_INVALID_STATE_TRANSITION'),
      overLimit,
    },
    stateMachine: {
      pathStatuses,
      transitionInvalid,
      journalKinds,
    },
    moveGroup: {
      fromIsStart: moved.fromLocationId === pack.startLocationId,
      versionBump: moved.version === stateBefore.version + 1,
      replayed: movedAgain.replayed,
      versionUnchanged: stateAfter.version === moved.version,
      currentIsTarget: stateAfter.worldState.currentLocationId === lobbyId,
      deterministicKeyStable:
        deterministicKey === moveIdempotencyKey({ sessionId, turnId: turn3.turnId, playerIds, toLocationId: lobbyId }),
      lockedExit,
      noExit,
      unknownTarget,
    },
    events,
  };

  process.stdout.write(`${JSON.stringify(report)}\n`);
}

try {
  await main();
} finally {
  await boot.close();
  rmSync(dir, { recursive: true, force: true });
}
