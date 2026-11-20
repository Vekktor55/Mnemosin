import { describe, expect, it } from 'vitest';

import { CapabilitySchema } from '@mnemosin/contracts';

import { PROBE_PROVIDER_ID, PROBE_CAPABILITY, PROBE_POLICY, probeValidateResponse } from '@mnemosin/ai';

describe('infrastructure/ai provider-probe', () => {
  describe('constants', () => {
    it('defines probe provider ID', () => {
      expect(PROBE_PROVIDER_ID).toBe('xai-probe');
    });

    it('defines probe capability as TEXT_AI', () => {
      expect(PROBE_CAPABILITY).toBe('TEXT_AI');
    });

    it('defines valid probe policy', () => {
      expect(PROBE_POLICY.providerId).toBe('xai-probe');
      expect(PROBE_POLICY.capability).toBe('TEXT_AI');
      expect(PROBE_POLICY.timeoutMs).toBe(40_000);
      expect(PROBE_POLICY.retries.max).toBe(2);
      expect(PROBE_POLICY.retries.backoffMs).toBe(1000);
      expect(PROBE_POLICY.retries.jitter).toBe(true);
      expect(PROBE_POLICY.circuitBreaker.failureThreshold).toBe(3);
      expect(PROBE_POLICY.circuitBreaker.cooldownMs).toBe(60_000);
      expect(PROBE_POLICY.costPer1kTokens.input).toBeNull();
      expect(PROBE_POLICY.costPer1kTokens.output).toBeNull();
    });
  });

  describe('probeValidateResponse', () => {
    it('validates correct AIResponse', () => {
      const validResponse = {
        narrative: 'Test narrative',
        privateMessages: [],
        proposedEvents: [],
        proposedObjectChanges: [],
        visualSceneDescription: null,
      };

      const result = probeValidateResponse(validResponse);
      expect(result.ok).toBe(true);
      expect(result.issues).toEqual([]);
    });

    it('rejects response with invalid narrative type', () => {
      const invalidResponse = {
        narrative: 123,
        privateMessages: [],
        proposedEvents: [],
        proposedObjectChanges: [],
        visualSceneDescription: null,
      };

      const result = probeValidateResponse(invalidResponse);
      expect(result.ok).toBe(false);
      expect(result.issues.length).toBeGreaterThan(0);
    });

    it('rejects missing required fields', () => {
      const invalidResponse = {
        privateMessages: [],
        proposedEvents: [],
        proposedObjectChanges: [],
        visualSceneDescription: null,
      };

      const result = probeValidateResponse(invalidResponse);
      expect(result.ok).toBe(false);
    });

    it('rejects wrong privateMessages type', () => {
      const invalidResponse = {
        narrative: 'test',
        privateMessages: 'not-array',
        proposedEvents: [],
        proposedObjectChanges: [],
        visualSceneDescription: null,
      };

      const result = probeValidateResponse(invalidResponse);
      expect(result.ok).toBe(false);
    });

    it('validates CapabilitySchema', () => {
      expect(() => CapabilitySchema.parse('TEXT_AI')).not.toThrow();
      expect(() => CapabilitySchema.parse('INVALID')).toThrow();
    });
  });
});
