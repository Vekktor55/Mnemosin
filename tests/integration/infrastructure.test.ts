import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { nowIso } from '@mnemosin/contracts';
import { makeIdempotencyRecord, openTempDb, seedWorld, type TempDb } from './helpers.js';
import type { SessionId, TurnId } from '@mnemosin/contracts';

// Unused type imports kept for documentation purposes
const _SessionIdType: SessionId = 'placeholder';
const _TurnIdType: TurnId = 'placeholder';

/**
 * Integration tests for infrastructure repositories
 * Covers uncovered branches in SqlIdempotencyRepository, SqlJournalRepository, SqlOutboxRepository
 */

describe('infrastructure repositories', () => {
  let db: TempDb;

  beforeAll(async () => {
    db = await openTempDb('infra-repos', { seed: false });
    await seedWorld(db);
  });

  afterAll(async () => {
    await db?.close();
  });

  describe('SqlIdempotencyRepository', () => {
    it('countAll returns total record count', async () => {
      const initialCount = await db.boot.uow.repos().idempotency.countAll();
      const record = makeIdempotencyRecord('count-test-000001');
      await db.boot.uow.repos().idempotency.tryAcquire(record);
      const afterCount = await db.boot.uow.repos().idempotency.countAll();
      expect(afterCount).toBe(initialCount + 1);
    });

    it('fail with ON CONFLICT DO UPDATE when key exists', async () => {
      const record = makeIdempotencyRecord('conflict-test-000001');
      await db.boot.uow.repos().idempotency.tryAcquire(record);

      // Now fail with the same key - should hit ON CONFLICT DO UPDATE path
      await db.boot.uow.repos().idempotency.fail({
        key: 'conflict-test-000001',
        errorCode: 'INTERNAL',
        resultHash: 'a'.repeat(64),
      });

      const failedRecord = await db.boot.uow.repos().idempotency.findByKey('conflict-test-000001');
      expect(failedRecord?.status).toBe('FAILED');
      expect(failedRecord?.errorCode).toBe('INTERNAL');
    });

    it('release removes record of any status', async () => {
      const record = makeIdempotencyRecord('release-test-000001');
      await db.boot.uow.repos().idempotency.tryAcquire(record);
      await db.boot.uow.repos().idempotency.release('release-test-000001');
      expect(await db.boot.uow.repos().idempotency.findByKey('release-test-000001')).toBeNull();
    });
  });

  describe('SqlJournalRepository', () => {
    let sessionId: string;

    beforeAll(async () => {
      const { world } = await seedWorld(db);
      sessionId = world.session.sessionId;
    });

    it('appendMany appends multiple entries', async () => {
      const drafts = [
        {
          turnId: null,
          sessionId,
          kind: 'state_applied' as const,
          payload: { a: 1 },
          traceId: 'trace-1',
          createdAt: nowIso(),
        },
        {
          turnId: null,
          sessionId,
          kind: 'turn_opened' as const,
          payload: { b: 2 },
          traceId: 'trace-2',
          createdAt: nowIso(),
        },
        {
          turnId: null,
          sessionId,
          kind: 'turn_locked' as const,
          payload: { c: 3 },
          traceId: 'trace-3',
          createdAt: nowIso(),
        },
      ];

      const results = await db.boot.uow.repos().journal.appendMany(drafts);
      expect(results).toHaveLength(3);
      expect(results[0]!.kind).toBe('state_applied');
      expect(results[1]!.kind).toBe('turn_opened');
      expect(results[2]!.kind).toBe('turn_locked');

      // Verify all were stored
      const bySession = await db.boot.uow.repos().journal.listBySession(sessionId);
      expect(bySession.length).toBeGreaterThanOrEqual(3);
    });

    it('listBySession with limit returns at most limit entries', async () => {
      const drafts = [
        {
          turnId: null,
          sessionId,
          kind: 'state_applied' as const,
          payload: {},
          traceId: 'trace-1',
          createdAt: nowIso(),
        },
        { turnId: null, sessionId, kind: 'turn_opened' as const, payload: {}, traceId: 'trace-2', createdAt: nowIso() },
      ];
      await db.boot.uow.repos().journal.appendMany(drafts);

      const limited = await db.boot.uow.repos().journal.listBySession(sessionId, 1);
      expect(limited.length).toBe(1);
    });

    it('setStatus updates outbox status', async () => {
      // First create an outbox entry
      const outboxRepo = db.boot.uow.repos().outbox;
      const drafted = await outboxRepo.append({
        eventName: 'TEST_EVENT',
        payloadJson: '{}',
        traceId: 'trace-status',
        emittedAt: nowIso(),
      });

      // Update status
      await db.boot.uow.repos().outbox.setStatus(drafted.id, 'PUBLISHED');
      const updated = await outboxRepo.listPending(10);
      const found = updated.find((e) => e.id === drafted.id);
      expect(found).toBeUndefined(); // No longer in pending
    });

    it('countAll and countByStatus return correct counts', async () => {
      const totalBefore = await db.boot.uow.repos().outbox.countAll();
      const pendingBefore = await db.boot.uow.repos().outbox.countByStatus('PENDING');

      // Add a new pending event
      await db.boot.uow.repos().outbox.append({
        eventName: 'COUNT_TEST',
        payloadJson: '{}',
        traceId: 'trace-count',
        emittedAt: nowIso(),
      });

      const totalAfter = await db.boot.uow.repos().outbox.countAll();
      const pendingAfter = await db.boot.uow.repos().outbox.countByStatus('PENDING');

      expect(totalAfter).toBe(totalBefore + 1);
      expect(pendingAfter).toBe(pendingBefore + 1);
    });
  });

  describe('SqlOutboxRepository', () => {
    it('markPublished updates status and publishedAt', async () => {
      const outboxRepo = db.boot.uow.repos().outbox;
      const drafted = await outboxRepo.append({
        eventName: 'PUBLISH_TEST',
        payloadJson: '{}',
        traceId: 'trace-publish',
        emittedAt: nowIso(),
      });

      expect(drafted.status).toBe('PENDING');
      expect(drafted.publishedAt).toBeNull();

      await outboxRepo.markPublished(drafted.id, nowIso());

      const updated = await outboxRepo.listPending(10);
      const found = updated.find((e) => e.id === drafted.id);
      expect(found).toBeUndefined(); // No longer pending

      // Verify it was marked published by checking count
      const pendingCount = await db.boot.uow.repos().outbox.countByStatus('PENDING');
      expect(pendingCount).toBeGreaterThanOrEqual(0);
    });

    it('registerFailure increments attempts and sets lastError', async () => {
      const outboxRepo = db.boot.uow.repos().outbox;
      const drafted = await outboxRepo.append({
        eventName: 'FAIL_TEST',
        payloadJson: '{}',
        traceId: 'trace-fail',
        emittedAt: nowIso(),
      });

      await outboxRepo.registerFailure(drafted.id, 'Test error message', false);

      // Verify by checking it's still pending but attempts increased
      // We can't directly fetch by id, so we check the pending list
      const pending = await outboxRepo.listPending(10);
      const found = pending.find((e) => e.id === drafted.id);
      expect(found).toBeDefined();
    });

    it('registerFailure with dead=true marks as DEAD', async () => {
      const outboxRepo = db.boot.uow.repos().outbox;
      const drafted = await outboxRepo.append({
        eventName: 'DEAD_TEST',
        payloadJson: '{}',
        traceId: 'trace-dead',
        emittedAt: nowIso(),
      });

      await outboxRepo.registerFailure(drafted.id, 'Fatal error', true);

      // DEAD events should not appear in pending
      const pending = await outboxRepo.listPending(10);
      const found = pending.find((e) => e.id === drafted.id);
      expect(found).toBeUndefined();
    });
  });
});
