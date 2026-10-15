import { describe, expect, it } from 'vitest';
import {
  CapabilitySchema,
  ProviderError,
  ProviderPolicySchema,
  CapabilityAvailabilitySchema,
  type AIResponse,
  type Capability,
} from '@mnemosin/contracts';
import { InMemoryMetricsSink, InProcessEventBus } from '@mnemosin/core';
import type { AIPort } from '@mnemosin/core';
import { CapabilityRegistry, backoffDelayMs, type PolicyAttemptContext } from '@mnemosin/ai';

/**
 * CapabilityRegistry (промпт 1.7, п.5): circuit breaker (порог, cooldown,
 * half-open), retry/backoff/jitter, таймаут из политики (F-7.2), fallback-
 * цепочка, healthProbe → CAPABILITY_CHANGED, snapshot() для /health (A1.13).
 * Время/сон/рандом инжектированы — тесты детерминированы и мгновенны.
 */

const VALID_RESPONSE: AIResponse = {
  narrative: 'Ответ тестового провайдера.',
  privateMessages: [],
  proposedEvents: [],
  proposedObjectChanges: [],
  visualSceneDescription: null,
};

interface FakeCall {
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

class FakeProvider implements AIPort {
  readonly capability = 'TEXT_AI' as const;
  readonly calls: FakeCall[] = [];
  available = true;
  /** null — успех; ProviderError — отказ; 'hang' — незавершающийся промис. */
  behavior: ((call: FakeCall) => Promise<AIResponse>) | null = null;
  private deferred: Array<{ resolve(v: AIResponse): void; reject(e: Error): void }> = [];

  constructor(readonly providerId: string) {}

  async isAvailable(): Promise<boolean> {
    return this.available;
  }

  async generate(input: {
    context: unknown;
    schema: unknown;
    deadline: { timeoutMs: number; attempt: number };
    signal?: AbortSignal;
  }): Promise<{
    response: AIResponse;
    usage: null;
    durationMs: number;
  }> {
    const call: FakeCall = {
      attempt: input.deadline.attempt,
      timeoutMs: input.deadline.timeoutMs,
      signal: input.signal ?? new AbortController().signal,
    };
    this.calls.push(call);
    if (this.behavior !== null) return { response: await this.behavior(call), usage: null, durationMs: 1 };
    return { response: VALID_RESPONSE, usage: null, durationMs: 1 };
  }

  /** Отложенное завершение «висящего» вызова (тест half-open single trial). */
  hang(): void {
    this.behavior = () =>
      new Promise<AIResponse>((resolve, reject) => {
        this.deferred.push({ resolve, reject });
      });
  }

  releaseHung(response: AIResponse = VALID_RESPONSE): void {
    const next = this.deferred.shift();
    next?.resolve(response);
  }
}

function alwaysFails(provider: FakeProvider, code: 'PROVIDER_RATE_LIMIT' | 'PROVIDER_TIMEOUT'): void {
  provider.behavior = async () => {
    throw new ProviderError(code, `${provider.providerId}: тестовый отказ`, provider.providerId);
  };
}

interface HarnessOptions {
  readonly chain?: readonly string[];
  readonly required?: boolean;
  readonly policies?: readonly unknown[];
  readonly probeIntervalMs?: number;
}

function makeHarness(options: HarnessOptions = {}) {
  const clock = { now: 0 };
  const delays: number[] = [];
  const bus = new InProcessEventBus();
  const metrics = new InMemoryMetricsSink();
  const events: Array<{ available: boolean; providers: readonly string[]; reason: string | null }> = [];
  bus.subscribe('CAPABILITY_CHANGED', (event) => {
    if (event.type === 'CAPABILITY_CHANGED') {
      events.push({
        available: event.payload.available,
        providers: event.payload.providers,
        reason: event.payload.reason,
      });
    }
  });

  const registry = new CapabilityRegistry({
    chains: { TEXT_AI: { required: options.required ?? true, chain: options.chain ?? [] } },
    policies: options.policies ?? [],
    probeIntervalMs: options.probeIntervalMs ?? 30_000,
    bus,
    metrics,
    now: () => clock.now,
    sleep: async (ms) => {
      delays.push(ms);
      clock.now += ms;
    },
    random: () => 0.5, // jitter-фактор ровно 1.0 — детерминированные задержки
  });

  return { registry, bus, metrics, events, delays, clock };
}

function policy(providerId: string, overrides: Record<string, unknown> = {}): unknown {
  return ProviderPolicySchema.parse({
    providerId,
    capability: 'TEXT_AI',
    timeoutMs: 5_000,
    retries: { max: 0, backoffMs: 100, jitter: false },
    circuitBreaker: { failureThreshold: 3, cooldownMs: 1_000 },
    costPer1kTokens: { input: null, output: null },
    ...overrides,
  });
}

describe('CapabilityRegistry · реестр и Zod-валидация записи (F-7.5)', () => {
  it('register принимает валидную запись, повтор — DUPLICATE, unregister идемпотентен', async () => {
    const { registry } = makeHarness({ chain: ['a'] });
    const provider = new FakeProvider('a');
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider });
    expect(registry.registeredProviderIds()).toEqual(['a']);
    expect(() => registry.register({ capability: 'TEXT_AI', providerId: 'a', provider })).toThrowError(
      /уже зарегистрирован/,
    );
    registry.unregister('a');
    registry.unregister('a'); // второй вызов — no-op
    expect(registry.registeredProviderIds()).toEqual([]);
    expect(await registry.resolve('TEXT_AI')).toEqual([]);
  });

  it('register отклоняет невалидные записи Zod-схемой (не unknown)', () => {
    const { registry } = makeHarness();
    // provider — не форма AIPort
    expect(() =>
      registry.register({
        capability: 'TEXT_AI',
        providerId: 'bad',
        provider: { providerId: 'bad' } as unknown as AIPort,
      }),
    ).toThrow();
    // расхождение providerId записи и провайдера
    expect(() =>
      registry.register({ capability: 'TEXT_AI', providerId: 'other', provider: new FakeProvider('a') }),
    ).toThrowError(/расходятся/);
    // AIPort обслуживает только TEXT_AI
    expect(() =>
      registry.register({
        capability: 'IMAGE_GENERATION' as Capability,
        providerId: 'a',
        provider: new FakeProvider('a'),
      }),
    ).toThrowError(/TEXT_AI/);
    // пустой providerId
    expect(() =>
      registry.register({ capability: 'TEXT_AI', providerId: '', provider: new FakeProvider('a') }),
    ).toThrow();
  });

  it('политики конструктора проходят ProviderPolicySchema; getPolicy возвращает конфиг или дефолт', () => {
    const { registry } = makeHarness({ chain: ['a', 'b'], policies: [policy('a', { timeoutMs: 1234 })] });
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: new FakeProvider('a') });
    registry.register({ capability: 'TEXT_AI', providerId: 'b', provider: new FakeProvider('b') });
    expect(registry.getPolicy('a')?.timeoutMs).toBe(1234);
    // 'b' зарегистрирован без политики — дефолт схемы (45s/2 ретрая/breaker 3×60s)
    expect(registry.getPolicy('b')?.timeoutMs).toBe(45_000);
    expect(registry.getPolicy('b')?.retries.max).toBe(2);
    expect(registry.getPolicy('нет-такого')).toBeUndefined();
    // невалидная политика в конструкторе — ошибка (F-7.5)
    expect(() => makeHarness({ policies: [{ providerId: 'x' }] })).toThrow();
  });
});

describe('CapabilityRegistry · resolve и fallback-цепочка', () => {
  it('resolve возвращает цепочку в порядке capabilities.yaml, отфильтрованную по isAvailable()', async () => {
    const { registry } = makeHarness({ chain: ['a', 'b', 'c'] });
    const a = new FakeProvider('a');
    const b = new FakeProvider('b');
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });
    registry.register({ capability: 'TEXT_AI', providerId: 'b', provider: b });
    // 'c' в цепочке, но не зарегистрирован — пропускается
    expect((await registry.resolve('TEXT_AI')).map((p) => p.providerId)).toEqual(['a', 'b']);

    a.available = false; // fallback: scripted→echo при unavailable (п.9 промта)
    expect((await registry.resolve('TEXT_AI')).map((p) => p.providerId)).toEqual(['b']);
    expect(await registry.isAvailable('TEXT_AI')).toBe(true);

    b.available = false;
    expect(await registry.resolve('TEXT_AI')).toEqual([]);
    expect(await registry.isAvailable('TEXT_AI')).toBe(false);
  });

  it('isAvailable() провайдера с исключением трактуется как false (зонд не падает)', async () => {
    const { registry } = makeHarness({ chain: ['a'] });
    const a = new FakeProvider('a');
    a.behavior = async () => VALID_RESPONSE;
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });
    // isAvailable бросает — через override метода
    (a as unknown as { isAvailable(): Promise<boolean> }).isAvailable = async () => {
      throw new Error('probe boom');
    };
    expect(await registry.resolve('TEXT_AI')).toEqual([]);
  });
});

describe('CapabilityRegistry · withPolicy: таймаут и ретраи из политики (F-7.2)', () => {
  it('deadline.timeoutMs берётся ИЗ ПОЛИТИКИ, а не из аргументов вызова', async () => {
    const { registry } = makeHarness({ chain: ['a'], policies: [policy('a', { timeoutMs: 1234 })] });
    const a = new FakeProvider('a');
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });

    const result = await registry.withPolicy('a', async (ctx: PolicyAttemptContext) => {
      expect(ctx.timeoutMs).toBe(1234);
      expect(ctx.attempt).toBe(1);
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      return a.generate({
        context: null,
        schema: null,
        deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
        signal: ctx.signal,
      });
    });
    expect(result.response).toEqual(VALID_RESPONSE);
  });

  it('висящий провайдер прерывается по timeoutMs политики: PROVIDER_TIMEOUT + abort сигнала', async () => {
    const { registry } = makeHarness({ chain: ['a'], policies: [policy('a', { timeoutMs: 30 })] });
    const a = new FakeProvider('a');
    a.hang();
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });

    const error = await registry
      .withPolicy('a', (ctx) =>
        a.generate({
          context: null,
          schema: null,
          deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
          signal: ctx.signal,
        }),
      )
      .catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).code).toBe('PROVIDER_TIMEOUT');
    expect(a.calls[0]?.signal.aborted).toBe(true); // провайдеру отправлен abort
  });

  it('ретраи: retries.max=2 → 3 попытки, backoffMs*2^i, jitter-фактор [0.5,1.5)', async () => {
    const { registry, delays } = makeHarness({
      chain: ['a'],
      policies: [policy('a', { retries: { max: 2, backoffMs: 100, jitter: true } })],
    });
    const a = new FakeProvider('a');
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });

    let failures = 0;
    a.behavior = async (call) => {
      if (call.attempt < 3) {
        failures += 1;
        throw new ProviderError('PROVIDER_RATE_LIMIT', 'лимит', 'a');
      }
      return VALID_RESPONSE;
    };

    const result = await registry.withPolicy('a', (ctx) =>
      a.generate({
        context: null,
        schema: null,
        deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
        signal: ctx.signal,
      }),
    );
    expect(result.response).toEqual(VALID_RESPONSE);
    expect(failures).toBe(2);
    expect(a.calls.map((call) => call.attempt)).toEqual([1, 2, 3]);
    // random()=0.5 → jitter-фактор 1.0: задержки 100, 200 (экспоненциальный backoff)
    expect(delays).toEqual([100, 200]);
  });

  it('исчерпанные ретраи → последняя ошибка пробрасывается', async () => {
    const { registry, delays } = makeHarness({
      chain: ['a'],
      policies: [policy('a', { retries: { max: 1, backoffMs: 50, jitter: false } })],
    });
    const a = new FakeProvider('a');
    alwaysFails(a, 'PROVIDER_RATE_LIMIT');
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });

    const error = await registry
      .withPolicy('a', (ctx) =>
        a.generate({
          context: null,
          schema: null,
          deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
          signal: ctx.signal,
        }),
      )
      .catch((cause: unknown) => cause);
    expect((error as ProviderError).code).toBe('PROVIDER_RATE_LIMIT');
    expect(a.calls).toHaveLength(2);
    expect(delays).toEqual([50]); // jitter=false → точный backoffMs
  });

  it('withPolicy для незарегистрированного провайдера → PROVIDER_UNAVAILABLE', async () => {
    const { registry } = makeHarness();
    const error = await registry.withPolicy('ghost', async () => VALID_RESPONSE).catch((cause: unknown) => cause);
    expect((error as ProviderError).code).toBe('PROVIDER_UNAVAILABLE');
  });

  it('backoffDelayMs: экспонента и границы jitter', () => {
    const base = ProviderPolicySchema.parse({
      providerId: 'x',
      capability: 'TEXT_AI',
      retries: { max: 3, backoffMs: 1000, jitter: true },
    });
    expect(backoffDelayMs(base, 1, () => 0)).toBe(500);
    expect(backoffDelayMs(base, 2, () => 0.5)).toBe(2000);
    expect(backoffDelayMs(base, 3, () => 0.999)).toBeLessThanOrEqual(6000);
    const noJitter = ProviderPolicySchema.parse({
      providerId: 'x',
      capability: 'TEXT_AI',
      retries: { max: 1, backoffMs: 250, jitter: false },
    });
    expect(backoffDelayMs(noJitter, 2, Math.random)).toBe(500);
  });
});

describe('CapabilityRegistry · circuit breaker (порог, cooldown, half-open)', () => {
  async function trippedRegistry(failureThreshold = 2, cooldownMs = 1_000) {
    const harness = makeHarness({
      chain: ['a'],
      policies: [policy('a', { circuitBreaker: { failureThreshold, cooldownMs } })],
    });
    const a = new FakeProvider('a');
    alwaysFails(a, 'PROVIDER_RATE_LIMIT');
    harness.registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });
    for (let i = 0; i < failureThreshold; i++) {
      await harness.registry
        .withPolicy('a', (ctx) =>
          a.generate({
            context: null,
            schema: null,
            deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
            signal: ctx.signal,
          }),
        )
        .catch(() => undefined);
    }
    return { ...harness, provider: a };
  }

  it('failureThreshold провалов → OPEN: resolve() пропускает провайдера, withPolicy не вызывает fn', async () => {
    const { registry, provider } = await trippedRegistry(2);
    expect(registry.snapshot().providers[0]?.breaker).toBe('OPEN');
    expect(await registry.resolve('TEXT_AI')).toEqual([]);
    expect(await registry.isAvailable('TEXT_AI')).toBe(false);

    const callsBefore = provider.calls.length;
    const error = await registry.withPolicy('a', async () => VALID_RESPONSE).catch((cause: unknown) => cause);
    expect((error as ProviderError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((error as ProviderError).meta['breaker']).toBe('OPEN');
    expect(provider.calls).toHaveLength(callsBefore); // fn НЕ вызывалась
  });

  it('cooldown истёк → HALF_OPEN: одна пробная попытка; успех → CLOSED, провал → снова OPEN', async () => {
    const { registry, provider, clock } = await trippedRegistry(2, 1_000);

    clock.now += 999; // cooldown ещё не истёк
    expect(await registry.resolve('TEXT_AI')).toEqual([]);

    clock.now += 1; // ровно 1000 мс — half-open
    expect((await registry.resolve('TEXT_AI')).map((p) => p.providerId)).toEqual(['a']);

    provider.behavior = null; // снова успешен
    const result = await registry.withPolicy('a', (ctx) =>
      provider.generate({
        context: null,
        schema: null,
        deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
        signal: ctx.signal,
      }),
    );
    expect(result.response).toEqual(VALID_RESPONSE);
    expect(registry.snapshot().providers[0]?.breaker).toBe('CLOSED');
    expect(registry.snapshot().providers[0]?.failures).toBe(0);

    // После восстановления счётчик CLOSED копится заново: 1 провал < порога(2) — закрыт,
    // 2-й провал — OPEN. (Провал именно В half-open → мгновенный OPEN — отдельный тест ниже.)
    alwaysFails(provider, 'PROVIDER_TIMEOUT');
    clock.now += 1_000;
    expect(registry.snapshot().providers[0]?.breaker).toBe('CLOSED');
    await registry
      .withPolicy('a', (ctx) =>
        provider.generate({
          context: null,
          schema: null,
          deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
          signal: ctx.signal,
        }),
      )
      .catch(() => undefined);
    expect(registry.snapshot().providers[0]?.breaker).toBe('CLOSED');
    await registry
      .withPolicy('a', (ctx) =>
        provider.generate({
          context: null,
          schema: null,
          deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
          signal: ctx.signal,
        }),
      )
      .catch(() => undefined);
    expect(registry.snapshot().providers[0]?.breaker).toBe('OPEN');
  });

  it('half-open допускает ОДНУ пробную попытку: конкурентный вызов отклоняётся', async () => {
    const { registry, provider, clock } = await trippedRegistry(1, 500);
    clock.now += 500; // HALF_OPEN
    provider.hang();

    const first = registry
      .withPolicy('a', (ctx) =>
        provider.generate({
          context: null,
          schema: null,
          deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
          signal: ctx.signal,
        }),
      )
      .catch((cause: unknown) => cause);
    await new Promise((resolve) => setTimeout(resolve, 10)); // первая попытка занимает trial

    const second = await registry.withPolicy('a', async () => VALID_RESPONSE).catch((cause: unknown) => cause);
    expect(second).toBeInstanceOf(ProviderError);
    expect((second as ProviderError).code).toBe('PROVIDER_UNAVAILABLE');
    expect((second as ProviderError).meta['breaker']).toBe('HALF_OPEN');

    provider.releaseHung(); // завершаем первую — успех закрывает breaker
    await first;
    expect(registry.snapshot().providers[0]?.breaker).toBe('CLOSED');
  });
});

describe('CapabilityRegistry · healthProbe и CAPABILITY_CHANGED (A1.13)', () => {
  /** publish() в шине диспетчеризует обработчики через микрозадачи — даём им исполниться. */
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it('register → начальная эмиссия; смена доступности через probeOnce → событие; повтор без изменений — тихий', async () => {
    const { registry, events } = makeHarness({ chain: ['a'], policies: [policy('a')] });
    const a = new FakeProvider('a');
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });
    await flush();
    // register эмитит начальное состояние (оптимистично: ещё не зондирован)
    expect(events).toEqual([{ available: true, providers: ['a'], reason: null }]);

    await registry.probeOnce(); // доступность не изменилась — дедуп, без события
    await flush();
    expect(events).toHaveLength(1);

    a.available = false;
    await registry.probeOnce();
    await flush();
    expect(events.at(-1)).toEqual({ available: false, providers: [], reason: 'unavailable' });

    await registry.probeOnce(); // без изменений — тихо
    await flush();
    expect(events).toHaveLength(2);

    a.available = true;
    await registry.probeOnce();
    await flush();
    expect(events.at(-1)).toEqual({ available: true, providers: ['a'], reason: null });
    expect(events).toHaveLength(3);
  });

  it('breaker OPEN эмитит CAPABILITY_CHANGED{available:false, reason:error_rate} СРАЗУ (без ожидания зонда)', async () => {
    const { registry, events, clock } = makeHarness({
      chain: ['a'],
      policies: [policy('a', { circuitBreaker: { failureThreshold: 1, cooldownMs: 10_000 } })],
    });
    const a = new FakeProvider('a');
    alwaysFails(a, 'PROVIDER_TIMEOUT');
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });

    await registry
      .withPolicy('a', (ctx) =>
        a.generate({
          context: null,
          schema: null,
          deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
          signal: ctx.signal,
        }),
      )
      .catch(() => undefined);
    await flush();

    expect(events.at(-1)).toEqual({ available: false, providers: [], reason: 'error_rate' });

    // восстановление после cooldown + успех → available:true
    clock.now += 10_000;
    a.behavior = null;
    await registry.withPolicy('a', (ctx) =>
      a.generate({
        context: null,
        schema: null,
        deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
        signal: ctx.signal,
      }),
    );
    await flush();
    expect(events.at(-1)).toEqual({ available: true, providers: ['a'], reason: null });
  });

  it('провал пробной попытки в HALF_OPEN → сразу OPEN (openedAt сбрасывается)', async () => {
    const { registry, provider, clock } = await trippedRegistryForProbe();
    expect(registry.snapshot().providers[0]?.breaker).toBe('OPEN');
    clock.now += 1_000; // cooldown истёк
    // провайдер всё ещё отказывает → пробная попытка в half-open провалена
    await registry
      .withPolicy('a', (ctx) =>
        provider.generate({
          context: null,
          schema: null,
          deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
          signal: ctx.signal,
        }),
      )
      .catch(() => undefined);
    const snapshot = registry.snapshot();
    expect(snapshot.providers[0]?.breaker).toBe('OPEN');
    // следующий допуск — не раньше нового cooldown
    expect(await registry.resolve('TEXT_AI')).toEqual([]);
  });

  it('startHealthProbe/stopHealthProbe идемпотентны (таймер unref, повторный старт — no-op)', async () => {
    const { registry } = makeHarness({ chain: [], probeIntervalMs: 60_000 });
    registry.startHealthProbe();
    registry.startHealthProbe(); // второй старт не создаёт второй таймер
    registry.stopHealthProbe();
    registry.stopHealthProbe(); // остановка без таймера — no-op
    await new Promise((resolve) => setTimeout(resolve, 10));
  });
});

/** Общий стенд: провайдер 'a' с порогом 1 и cooldown 1000, доведённый до OPEN. */
async function trippedRegistryForProbe() {
  const harness = makeHarness({
    chain: ['a'],
    policies: [policy('a', { circuitBreaker: { failureThreshold: 1, cooldownMs: 1_000 } })],
  });
  const provider = new FakeProvider('a');
  alwaysFails(provider, 'PROVIDER_RATE_LIMIT');
  harness.registry.register({ capability: 'TEXT_AI', providerId: 'a', provider });
  await harness.registry
    .withPolicy('a', (ctx) =>
      provider.generate({
        context: null,
        schema: null,
        deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
        signal: ctx.signal,
      }),
    )
    .catch(() => undefined);
  return { ...harness, provider };
}

describe('CapabilityRegistry · snapshot() для /health (A1.13)', () => {
  it('срез покрывает ВСЕ capability контракта, валиден CapabilityAvailabilitySchema, провайдеры — с breaker-статусом', async () => {
    const { registry } = makeHarness({ chain: ['a', 'ghost'], policies: [policy('a')] });
    const a = new FakeProvider('a');
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });
    await registry.probeOnce();

    const snapshot = registry.snapshot();
    expect(typeof snapshot.generatedAt).toBe('string');
    for (const capability of CapabilitySchema.options) {
      const entry = snapshot.capabilities[capability];
      expect(entry, `snapshot обязан содержать ${capability}`).toBeDefined();
      expect(CapabilityAvailabilitySchema.safeParse(entry).success).toBe(true);
    }
    expect(snapshot.capabilities['TEXT_AI']).toMatchObject({
      capability: 'TEXT_AI',
      available: true,
      required: true,
      providers: ['a'],
      reason: null,
    });
    expect(snapshot.capabilities['IMAGE_GENERATION']).toMatchObject({
      available: false,
      required: false,
      providers: [],
    });

    expect(snapshot.providers).toHaveLength(1);
    expect(snapshot.providers[0]).toMatchObject({
      providerId: 'a',
      capability: 'TEXT_AI',
      breaker: 'CLOSED',
      failures: 0,
      available: true,
      inChain: true,
    });
    // JSON-безопасность (health отдаёт срез как есть)
    expect(() => JSON.stringify(snapshot)).not.toThrow();
  });

  it('метрики: ошибки провайдеров и длительности учитываются MetricsSink', async () => {
    const { registry, metrics } = makeHarness({ chain: ['a'], policies: [policy('a')] });
    const a = new FakeProvider('a');
    registry.register({ capability: 'TEXT_AI', providerId: 'a', provider: a });
    await registry.withPolicy('a', (ctx) =>
      a.generate({
        context: null,
        schema: null,
        deadline: { timeoutMs: ctx.timeoutMs, attempt: ctx.attempt },
        signal: ctx.signal,
      }),
    );
    await registry.probeOnce();
    const snapshot = metrics.snapshot();
    expect(snapshot.timings['ai.provider.duration_ms{providerId=a}']).toBeDefined();
    expect(snapshot.counters['capability.probe_total']).toBe(1);
  });
});
