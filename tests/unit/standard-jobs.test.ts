import { describe, expect, it, vi, beforeEach } from 'vitest';

import { JOB_NAMES, JOB_INTERVALS_MS, registerStandardJobs } from '@mnemosin/jobs';

describe('infrastructure/jobs standard-jobs', () => {
  let mockScheduler: { register: ReturnType<typeof vi.fn> };
  let mockHandlers: {
    cleanupIdempotency: ReturnType<typeof vi.fn>;
    outboxPublisher: ReturnType<typeof vi.fn>;
    presenceSweep: ReturnType<typeof vi.fn>;
    capabilityProbe: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    mockScheduler = {
      register: vi.fn(),
    };

    mockHandlers = {
      cleanupIdempotency: vi.fn(),
      outboxPublisher: vi.fn(),
      presenceSweep: vi.fn(),
      capabilityProbe: vi.fn(),
    };
  });

  describe('JOB_NAMES', () => {
    it('defines expected job names', () => {
      expect(JOB_NAMES.cleanupIdempotency).toBe('cleanupIdempotency');
      expect(JOB_NAMES.outboxPublisher).toBe('outboxPublisher');
      expect(JOB_NAMES.presenceSweep).toBe('presenceSweep');
      expect(JOB_NAMES.capabilityProbe).toBe('capabilityProbe');
    });
  });

  describe('JOB_INTERVALS_MS', () => {
    it('defines expected intervals', () => {
      expect(JOB_INTERVALS_MS.cleanupIdempotency).toBe(60 * 60 * 1000);
      expect(JOB_INTERVALS_MS.presenceSweep).toBe(10 * 1000);
    });
  });

  describe('registerStandardJobs', () => {
    it('registers all three mandatory jobs', () => {
      registerStandardJobs(mockScheduler, mockHandlers, { outboxPollMs: 250 });

      // 3 mandatory jobs + 1 capabilityProbe (handler is provided in beforeEach)
      expect(mockScheduler.register).toHaveBeenCalledTimes(4);
      expect(mockScheduler.register).toHaveBeenCalledWith(
        'cleanupIdempotency',
        60 * 60 * 1000,
        mockHandlers.cleanupIdempotency,
      );
      expect(mockScheduler.register).toHaveBeenCalledWith('outboxPublisher', 250, mockHandlers.outboxPublisher);
      expect(mockScheduler.register).toHaveBeenCalledWith('presenceSweep', 10 * 1000, mockHandlers.presenceSweep);
    });

    it('registers capabilityProbe when handler provided', () => {
      // Create fresh mock scheduler for this test
      const scheduler = { register: vi.fn() };
      const handlers = {
        cleanupIdempotency: vi.fn(),
        outboxPublisher: vi.fn(),
        presenceSweep: vi.fn(),
        capabilityProbe: vi.fn(),
      };

      registerStandardJobs(scheduler, handlers, {
        outboxPollMs: 250,
        capabilityProbeMs: 5000,
      });

      expect(scheduler.register).toHaveBeenCalledTimes(4);
      expect(scheduler.register).toHaveBeenCalledWith('capabilityProbe', 5000, expect.any(Function));
    });

    it('uses default capabilityProbeMs when not provided', () => {
      const scheduler = { register: vi.fn() };
      const handlers = {
        cleanupIdempotency: vi.fn(),
        outboxPublisher: vi.fn(),
        presenceSweep: vi.fn(),
        capabilityProbe: vi.fn(),
      };

      registerStandardJobs(scheduler, handlers, {
        outboxPollMs: 250,
      });

      expect(scheduler.register).toHaveBeenCalledTimes(4);
    });

    it('does not register capabilityProbe when handler undefined', () => {
      const scheduler = { register: vi.fn() };
      const handlers = {
        cleanupIdempotency: vi.fn(),
        outboxPublisher: vi.fn(),
        presenceSweep: vi.fn(),
      };

      registerStandardJobs(scheduler, handlers, {
        outboxPollMs: 250,
      });

      expect(scheduler.register).toHaveBeenCalledTimes(3);
    });
  });
});
