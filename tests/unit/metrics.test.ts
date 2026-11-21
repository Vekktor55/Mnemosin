import { describe, expect, it } from 'vitest';

import { metricKey, InMemoryMetricsSink } from '@mnemosin/core';

/**
 * Unit tests for core/events/metrics.ts
 * Covers uncovered branches in metrics.ts
 */

describe('core/events/metrics', () => {
  describe('metricKey', () => {
    it('returns name without labels when labels is undefined', () => {
      const result = metricKey('test.metric');
      expect(result).toBe('test.metric');
    });

    it('returns name without labels when labels is empty object', () => {
      const result = metricKey('test.metric', {});
      expect(result).toBe('test.metric');
    });

    it('returns name with sorted labels', () => {
      const result = metricKey('test.metric', { b: '2', a: '1' });
      expect(result).toBe('test.metric{a=1,b=2}');
    });

    it('handles multiple labels', () => {
      const result = metricKey('test', { c: '3', a: '1', b: '2' });
      expect(result).toBe('test{a=1,b=2,c=3}');
    });

    it('handles numeric label values', () => {
      const result = metricKey('test', { count: 5, rate: 1.5 });
      expect(result).toBe('test{count=5,rate=1.5}');
    });

    it('handles boolean label values', () => {
      const result = metricKey('test', { success: true, failed: false });
      expect(result).toBe('test{failed=false,success=true}');
    });

    it('handles special characters in label values', () => {
      const result = metricKey('test', { path: '/api/v1', method: 'GET' });
      expect(result).toBe('test{method=GET,path=/api/v1}');
    });

    it('handles empty string label value', () => {
      const result = metricKey('test', { empty: '' });
      expect(result).toBe('test{empty=}');
    });
  });

  describe('InMemoryMetricsSink', () => {
    it('increments counter by default value', () => {
      const sink = new InMemoryMetricsSink();
      sink.counter('test.counter');
      expect(sink.counterOf('test.counter')).toBe(1);
    });

    it('increments counter by specified value', () => {
      const sink = new InMemoryMetricsSink();
      sink.counter('test.counter', 5);
      expect(sink.counterOf('test.counter')).toBe(5);
    });

    it('increments counter multiple times', () => {
      const sink = new InMemoryMetricsSink();
      sink.counter('test');
      sink.counter('test', 2);
      sink.counter('test', 3);
      expect(sink.counterOf('test')).toBe(6);
    });

    it('handles counter with labels', () => {
      const sink = new InMemoryMetricsSink();
      sink.counter('test', 1, { label: 'a' });
      sink.counter('test', 1, { label: 'b' });
      expect(sink.counterOf('test', { label: 'a' })).toBe(1);
      expect(sink.counterOf('test', { label: 'b' })).toBe(1);
      expect(sink.counterOf('test', { label: 'c' })).toBe(0);
    });

    it('records timing', () => {
      const sink = new InMemoryMetricsSink();
      sink.timing('test.timing', 100);
      const snap = sink.snapshot();
      expect(snap.timings['test.timing'].count).toBe(1);
      expect(snap.timings['test.timing'].sumMs).toBe(100);
      expect(snap.timings['test.timing'].maxMs).toBe(100);
    });

    it('accumulates multiple timings', () => {
      const sink = new InMemoryMetricsSink();
      sink.timing('test', 100);
      sink.timing('test', 200);
      sink.timing('test', 50);
      const snap = sink.snapshot();
      expect(snap.timings['test'].count).toBe(3);
      expect(snap.timings['test'].sumMs).toBe(350);
      expect(snap.timings['test'].maxMs).toBe(200);
    });

    it('records timing with labels', () => {
      const sink = new InMemoryMetricsSink();
      sink.timing('test', 100, { endpoint: '/api' });
      sink.timing('test', 200, { endpoint: '/api' });
      sink.timing('test', 50, { endpoint: '/other' });
      const snap = sink.snapshot();
      expect(snap.timings['test{endpoint=/api}'].count).toBe(2);
      expect(snap.timings['test{endpoint=/api}'].maxMs).toBe(200);
      expect(snap.timings['test{endpoint=/other}'].count).toBe(1);
    });

    it('returns 0 for unknown counter', () => {
      const sink = new InMemoryMetricsSink();
      expect(sink.counterOf('unknown')).toBe(0);
    });

    it('returns 0 for unknown counter with labels', () => {
      const sink = new InMemoryMetricsSink();
      expect(sink.counterOf('test', { label: 'missing' })).toBe(0);
    });

    it('snapshot returns counters and timings', () => {
      const sink = new InMemoryMetricsSink();
      sink.counter('a');
      sink.counter('b', 2);
      sink.timing('t', 100);
      const snap = sink.snapshot();
      expect(snap.counters).toEqual({ a: 1, b: 2 });
      expect(snap.timings).toHaveProperty('t');
    });

    it('reset clears all data', () => {
      const sink = new InMemoryMetricsSink();
      sink.counter('test');
      sink.timing('test', 100);
      sink.reset();
      expect(sink.counterOf('test')).toBe(0);
      expect(sink.snapshot().timings).toEqual({});
    });
  });
});
