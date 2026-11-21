import { describe, expect, it, vi } from 'vitest';

import { AppError } from '@mnemosin/contracts';
import { parseIdempotencyKey, runCommand, newTraceId } from '@mnemosin/core';
import type { CommandRunner } from '@mnemosin/core/domain/ports';

/**
 * Unit tests for core/domain/command.ts
 * Covers runCommand, parseIdempotencyKey, newTraceId
 */

// Mock CommandRunner
const createMockGuard = (outcome: { kind: string; value?: unknown; resultJson?: string; errorCode?: string }) => ({
  run: vi.fn().mockResolvedValue(outcome),
});

describe('core/domain/command', () => {
  describe('runCommand', () => {
    it('returns value with replayed=false when outcome is executed', async () => {
      const guard = createMockGuard({ kind: 'executed', value: { ok: true } });
      const ctx = { command: 'test', idempotencyKey: 'test-key-1234567890123456', traceId: 'trace-1' };
      const fn = vi.fn().mockResolvedValue({ ok: true });

      const result = await runCommand(guard as unknown as CommandRunner, ctx, fn);

      expect(result).toEqual({ value: { ok: true }, replayed: false });
      expect(guard.run).toHaveBeenCalledWith(ctx, fn);
    });

    it('returns parsed value with replayed=true when outcome is replayed', async () => {
      const guard = createMockGuard({
        kind: 'replayed',
        resultJson: JSON.stringify({ cached: true, data: 42 }),
      });
      const ctx = { command: 'test', idempotencyKey: 'test-key-1234567890123456', traceId: 'trace-1' };
      const fn = vi.fn();

      const result = await runCommand(guard as unknown as CommandRunner, ctx, fn);

      expect(result).toEqual({ value: { cached: true, data: 42 }, replayed: true });
      expect(guard.run).toHaveBeenCalledWith(ctx, fn);
    });

    it('throws AppError with IDEMPOTENCY_IN_FLIGHT when outcome is in_flight', async () => {
      const guard = createMockGuard({ kind: 'in_flight' });
      const ctx = { command: 'test', idempotencyKey: 'test-key-1234567890123456', traceId: 'trace-1' };
      const fn = vi.fn();

      await expect(runCommand(guard as unknown as CommandRunner, ctx, fn)).rejects.toThrow(AppError);
      await expect(runCommand(guard as unknown as CommandRunner, ctx, fn)).rejects.toMatchObject({
        code: 'IDEMPOTENCY_IN_FLIGHT',
      });
    });

    it('throws AppError with previous errorCode when outcome is failed_before', async () => {
      const guard = createMockGuard({ kind: 'failed_before', errorCode: 'VALIDATION' });
      const ctx = { command: 'test', idempotencyKey: 'test-key-1234567890123456', traceId: 'trace-1' };
      const fn = vi.fn();

      await expect(runCommand(guard as unknown as CommandRunner, ctx, fn)).rejects.toThrow(AppError);
      await expect(runCommand(guard as unknown as CommandRunner, ctx, fn)).rejects.toMatchObject({
        code: 'VALIDATION',
      });
    });

    it('passes command context to guard', async () => {
      const guard = createMockGuard({ kind: 'executed', value: {} });
      const ctx = { command: 'createSession', idempotencyKey: 'test-key-1234567890123456', traceId: 'trace-1' };
      const fn = vi.fn().mockResolvedValue({});

      await runCommand(guard as unknown as CommandRunner, ctx, fn);

      expect(guard.run).toHaveBeenCalledWith(
        expect.objectContaining({ command: 'createSession' }),
        expect.any(Function),
      );
    });
  });

  describe('parseIdempotencyKey', () => {
    it('returns branded IdempotencyKey for valid 16-char string', () => {
      const key = 'valid-key-1234567890123456';
      const result = parseIdempotencyKey(key);
      expect(result).toBe(key);
    });

    it('returns branded IdempotencyKey for valid 128-char string', () => {
      const key = 'a'.repeat(128);
      const result = parseIdempotencyKey(key);
      expect(result).toBe(key);
    });

    it('throws AppError with VALIDATION for too short key', () => {
      expect(() => parseIdempotencyKey('short')).toThrowError(AppError);
      expect(() => parseIdempotencyKey('short')).toThrowError(/idempotencyKey: ожидается строка 16–128 символов/);
    });

    it('throws AppError with VALIDATION for too long key', () => {
      const longKey = 'a'.repeat(129);
      expect(() => parseIdempotencyKey(longKey)).toThrowError(AppError);
      expect(() => parseIdempotencyKey(longKey)).toThrowError(/idempotencyKey: ожидается строка 16–128 символов/);
    });

    it('throws AppError with VALIDATION for empty string', () => {
      expect(() => parseIdempotencyKey('')).toThrowError(AppError);
    });

    it('includes length in error meta', () => {
      let caughtError: Error | null = null;
      try {
        parseIdempotencyKey('short');
      } catch (e) {
        caughtError = e as Error;
      }
      expect(caughtError).toBeInstanceOf(Error);
      const appError = caughtError as unknown as AppError;
      expect(appError.meta?.length).toBe(5);
    });
  });

  describe('newTraceId', () => {
    it('returns a valid UUID v4', () => {
      const id = newTraceId();
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    });

    it('generates unique IDs on each call', () => {
      const id1 = newTraceId();
      const id2 = newTraceId();
      expect(id1).not.toBe(id2);
    });

    it('returns string of correct length', () => {
      const id = newTraceId();
      expect(id.length).toBe(36);
    });
  });
});
