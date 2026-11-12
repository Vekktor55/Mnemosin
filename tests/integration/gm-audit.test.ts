import { afterAll, describe, expect, it } from 'vitest';
import { nowIso, type DomainEvent } from '@mnemosin/contracts';

import { bootStage1World, type Stage1World } from './modules-helpers.js';
import { testKey } from './helpers.js';

/**
 * gm-audit (промпт 1.9, п.7/9): append-only лента gm_audit.
 *
 * Запись на каждое GM-действие (GM_ACTION_PERFORMED) и решение ревью
 * (GM_REVIEW_DECIDED); повторная доставка события дедуплицируется (D250);
 * модуль НИЧЕГО не мутирует в GameState (version неизменна).
 */

const worlds: Stage1World[] = [];
async function world(label: string): Promise<Stage1World> {
  const created = await bootStage1World(label);
  worlds.push(created);
  return created;
}

afterAll(async () => {
  for (const entry of worlds) await entry.close();
});

async function auditRows(w: Stage1World) {
  return w.db.boot.uow.repos().gmAudit.listBySession(w.sessionId, 500);
}

describe('gm-audit · append-only лента', () => {
  it('строка на каждое GM-действие: action/gmPlayerId/traceId/idempotencyKey/at', async () => {
    const w = await world('audit-actions');
    const key = testKey('pause-audit');
    await w.gm.pauseSession({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, idempotencyKey: key });
    await w.gm.resumeSession({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      idempotencyKey: testKey('resume-audit'),
    });
    await w.drain();

    const rows = await auditRows(w);
    const pause = rows.find((row) => row.action === 'pauseSession');
    const resume = rows.find((row) => row.action === 'resumeSession');
    expect(pause).toBeDefined();
    expect(resume).toBeDefined();
    expect(pause?.gmPlayerId).toBe(w.gmPlayerId);
    expect(pause?.idempotencyKey).toBe(key);
    expect(pause?.traceId.length).toBeGreaterThan(0);
    expect(pause?.at.length).toBeGreaterThan(0);
  });

  it('GM_REVIEW_DECIDED → строка approve с meta {turnId, decision}', async () => {
    const w = await world('audit-review');
    await w.turn.resolveTurn({ turnId: w.turnId });
    await w.gmReview.approve({ turnId: w.turnId, gmPlayerId: w.gmPlayerId, idempotencyKey: testKey('approve-audit') });
    await w.drain();
    const rows = await auditRows(w);
    const approve = rows.find((row) => row.action === 'approve');
    expect(approve).toBeDefined();
    expect(approve?.meta).toMatchObject({ turnId: w.turnId, decision: 'APPROVE' });
  });

  it('повторная доставка события НЕ создаёт вторую строку (D250, at-least-once)', async () => {
    const w = await world('audit-dedupe');
    await w.gm.pauseSession({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, idempotencyKey: testKey('pause-d') });
    await w.drain();
    expect((await auditRows(w)).filter((row) => row.action === 'pauseSession')).toHaveLength(1);

    // имитация републикации outbox: то же событие ещё раз напрямую в шину
    const pauseEvent = w.captured.findLast(
      (entry) => entry.type === 'GM_ACTION_PERFORMED' && entry.payload['action'] === 'pauseSession',
    );
    expect(pauseEvent).toBeDefined();
    await w.redeliver({
      type: 'GM_ACTION_PERFORMED',
      payload: pauseEvent!.payload,
      emittedAt: nowIso(),
      traceId: pauseEvent!.traceId,
    } as DomainEvent);
    expect((await auditRows(w)).filter((row) => row.action === 'pauseSession')).toHaveLength(1);
  });

  it('модуль не мутирует GameState: version до и после аудита одинакова', async () => {
    const w = await world('audit-no-state');
    const before = await w.services.state.get(w.sessionId);
    await w.gm.pauseSession({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, idempotencyKey: testKey('pause-ns') });
    await w.gm.addNote({
      sessionId: w.sessionId,
      gmPlayerId: w.gmPlayerId,
      visibility: 'GM_ONLY',
      text: 'заметка',
      idempotencyKey: testKey('note-ns'),
    });
    await w.drain();
    const rows = await auditRows(w);
    expect(rows.length).toBeGreaterThan(0);
    const after = await w.services.state.get(w.sessionId);
    expect(after.version).toBe(before.version); // аудит не трогает состояние
  });

  it('listAudit: свежие сверху, limit ограничивает', async () => {
    const w = await world('audit-list');
    await w.gm.pauseSession({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, idempotencyKey: testKey('p-l') });
    await w.gm.resumeSession({ sessionId: w.sessionId, gmPlayerId: w.gmPlayerId, idempotencyKey: testKey('r-l') });
    await w.drain();
    const all = await w.gmAudit.listAudit({ sessionId: w.sessionId });
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all[0]!.auditId).toBeGreaterThan(all[all.length - 1]!.auditId); // DESC
    const limited = await w.gmAudit.listAudit({ sessionId: w.sessionId, limit: 1 });
    expect(limited).toHaveLength(1);
  });
});
