import { describe, expect, it } from 'vitest';

import { CoreError } from '@mnemosin/contracts';
import { allowedTransitions, assertTransition } from '@mnemosin/core';
import type { SessionStatus } from '@mnemosin/contracts';

/**
 * Unit tests for core/domain/transition.ts
 * Covers allowedTransitions and assertTransition
 */

describe('core/domain/transition', () => {
  describe('allowedTransitions', () => {
    it('returns allowed transitions for LOBBY', () => {
      const result = allowedTransitions('LOBBY');
      expect(result).toEqual(['ACTIVE', 'ENDED']);
    });

    it('returns allowed transitions for ACTIVE', () => {
      const result = allowedTransitions('ACTIVE');
      expect(result).toEqual(['PAUSED', 'ENDED']);
    });

    it('returns allowed transitions for PAUSED', () => {
      const result = allowedTransitions('PAUSED');
      expect(result).toEqual(['ACTIVE', 'ENDED']);
    });

    it('returns empty array for ENDED', () => {
      const result = allowedTransitions('ENDED');
      expect(result).toEqual([]);
    });

    it('returns empty array for unknown status', () => {
      const result = allowedTransitions('UNKNOWN' as unknown as SessionStatus);
      expect(result).toEqual([]);
    });
  });

  describe('assertTransition', () => {
    it('allows LOBBY → ACTIVE', () => {
      expect(() => assertTransition('LOBBY', 'ACTIVE')).not.toThrow();
    });

    it('allows LOBBY → ENDED', () => {
      expect(() => assertTransition('LOBBY', 'ENDED')).not.toThrow();
    });

    it('allows ACTIVE → PAUSED', () => {
      expect(() => assertTransition('ACTIVE', 'PAUSED')).not.toThrow();
    });

    it('allows ACTIVE → ENDED', () => {
      expect(() => assertTransition('ACTIVE', 'ENDED')).not.toThrow();
    });

    it('allows PAUSED → ACTIVE', () => {
      expect(() => assertTransition('PAUSED', 'ACTIVE')).not.toThrow();
    });

    it('allows PAUSED → ENDED', () => {
      expect(() => assertTransition('PAUSED', 'ENDED')).not.toThrow();
    });

    it('throws CoreError for LOBBY → PAUSED (not allowed)', () => {
      expect(() => assertTransition('LOBBY', 'PAUSED')).toThrowError(CoreError);
      expect(() => assertTransition('LOBBY', 'PAUSED')).toThrowError(/session: переход LOBBY → PAUSED запрещён/);
    });

    it('throws CoreError for ACTIVE → LOBBY (not allowed)', () => {
      expect(() => assertTransition('ACTIVE', 'LOBBY')).toThrowError(CoreError);
      expect(() => assertTransition('ACTIVE', 'LOBBY')).toThrowError(/session: переход ACTIVE → LOBBY запрещён/);
    });

    it('throws CoreError for PAUSED → LOBBY (not allowed)', () => {
      expect(() => assertTransition('PAUSED', 'LOBBY')).toThrowError(CoreError);
      expect(() => assertTransition('PAUSED', 'LOBBY')).toThrowError(/session: переход PAUSED → LOBBY запрещён/);
    });

    it('throws CoreError for ENDED → ACTIVE (not allowed)', () => {
      expect(() => assertTransition('ENDED', 'ACTIVE')).toThrowError(CoreError);
      expect(() => assertTransition('ENDED', 'ACTIVE')).toThrowError(/session: переход ENDED → ACTIVE запрещён/);
    });

    it('throws CoreError with correct meta for invalid transition', () => {
      let caughtError: Error | null = null;
      try {
        assertTransition('LOBBY', 'PAUSED');
      } catch (e) {
        caughtError = e as Error;
      }
      expect(caughtError).toBeInstanceOf(CoreError);
      const coreError = caughtError as unknown as CoreError;
      expect(coreError.code).toBe('CORE_INVALID_STATE_TRANSITION');
      expect(coreError.meta).toMatchObject({
        entity: 'session',
        from: 'LOBBY',
        to: 'PAUSED',
        allowed: ['ACTIVE', 'ENDED'],
      });
    });
  });
});
