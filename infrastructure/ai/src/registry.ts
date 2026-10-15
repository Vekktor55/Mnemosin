import { randomUUID } from 'node:crypto';

import { z } from 'zod';
import {
  CapabilityAvailabilitySchema,
  CapabilitySchema,
  ConflictError,
  ProviderError,
  ProviderPolicySchema,
  nowIso,
  type Capability,
  type CapabilityAvailability,
  type DomainEvent,
  type ProviderPolicy,
} from '@mnemosin/contracts';
import type { AIPort, EventBus, MetricsSink } from '@mnemosin/core/domain/ports';

/**
 * CapabilityRegistry (v3 §V.11 + патч аудита §8.9/§8.10; промпт 1.7, F-7.2/F-7.5).
 *
 * Обязанности:
 *  - реестр провайдеров: register/unregister с Zod-валидацией записи (F-7.5 —
 *    «не unknown» на границе);
 *  - resolve(capability): упорядоченная цепочка из config/capabilities.yaml,
 *    отфильтрованная по isAvailable() и состоянию circuit breaker'а;
 *  - withPolicy(providerId, fn): таймаут, ретраи и backoff — ЕДИНСТВЕННЫЙ
 *    источник истины ProviderPolicy (F-7.2: не аргументы порта);
 *  - circuit breaker на провайдера: failureThreshold → OPEN на cooldownMs;
 *    в OPEN resolve() пропускает провайдера; после cooldown — HALF_OPEN,
 *    одна пробная попытка;
 *  - healthProbe: по расписанию capabilityProbeMs опрашивает isAvailable()
 *    зарегистрированных провайдеров и при изменении доступности эмитит
 *    CAPABILITY_CHANGED через EventBus (шина из 1.5). Дополнительно событие
 *    эмитится СРАЗУ при переходе breaker'а (OPEN→деградация видна без ожидания
 *    следующего зонда — сценарий приёмки A1.13);
 *  - snapshot(): синхронный срез для GET /health (A1.13) и диагностики.
 *
 * Границы: пакет импортирует только @mnemosin/contracts и
 * @mnemosin/core/domain/ports (правило слоя 1.3, D211) — ядро не знает
 * о регистре; регистр знает порт AIPort.
 */

/** Структурный логгер: infrastructure/ai не импортирует pino (как EventBus в core). */
export interface RegistryLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  error(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

export interface RegistryEntry {
  readonly capability: Capability;
  readonly providerId: string;
  readonly provider: AIPort;
}

/** Форма AIPort проверяется структурно (instanceof невозможен — порт структурный). */
function isAIPortShape(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate['providerId'] === 'string' &&
    candidate['providerId'].length > 0 &&
    candidate['capability'] === 'TEXT_AI' &&
    typeof candidate['isAvailable'] === 'function' &&
    typeof candidate['generate'] === 'function'
  );
}

/** F-7.5: запись реестра валидна Zod-схемой, а не «доверенным unknown». */
export const RegistryEntrySchema = z
  .object({
    capability: CapabilitySchema,
    providerId: z.string().min(1).max(64),
    provider: z.custom<AIPort>(isAIPortShape, { message: 'provider не соответствует форме AIPort' }),
  })
  .refine((entry) => entry.capability === 'TEXT_AI', {
    message: 'AIPort обслуживает только TEXT_AI (media/audio — отдельные порты этапов 2–3)',
    path: ['capability'],
  })
  .refine((entry) => entry.provider.providerId === entry.providerId, {
    message: 'providerId записи и provider.providerId расходятся',
    path: ['providerId'],
  });

const ChainsSchema = z.record(
  CapabilitySchema,
  z.object({
    required: z.boolean().default(false),
    chain: z.array(z.string().min(1).max(64)).default([]),
  }),
);
type Chains = z.infer<typeof ChainsSchema>;

/** Контекст одной попытки для fn в withPolicy: политику даёт регистр (F-7.2). */
export interface PolicyAttemptContext {
  readonly attempt: number;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}

export interface ProviderSnapshot {
  readonly providerId: string;
  readonly capability: Capability;
  /** Состоение circuit breaker'а (контракт BreakerState). */
  readonly breaker: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  readonly failures: number;
  /** Последний известный результат isAvailable(); null — ещё не проверялся. */
  readonly available: boolean | null;
  readonly lastError: string | null;
  readonly lastCheckedAt: string | null;
  /** Входит ли провайдер в цепочку fallback своей capability. */
  readonly inChain: boolean;
}

/**
 * Срез реестра для GET /health (A1.13). Type-алиас (не interface): HealthPayload
 * объявляет capabilities как Record<string, unknown>, а алиасу TS даёт
 * неявную index-сигнатуру — snapshot() передаётся без кастов.
 */
export type RegistrySnapshot = {
  readonly generatedAt: string;
  readonly capabilities: Readonly<Record<string, CapabilityAvailability>>;
  readonly providers: readonly ProviderSnapshot[];
};

export interface CapabilityRegistryOptions {
  /** config/capabilities.yaml → capabilities (цепочки fallback). */
  readonly chains?: Readonly<Partial<Record<Capability, { required?: boolean; chain?: readonly string[] }>>>;
  /** config/provider-policies.yaml → policies. */
  readonly policies?: readonly unknown[];
  /** Шина событий для CAPABILITY_CHANGED (опциональна в тестах). */
  readonly bus?: EventBus;
  readonly logger?: RegistryLog;
  readonly metrics?: MetricsSink;
  /** Интервал healthProbe, default 30000 (limits.capabilityProbeMs). */
  readonly probeIntervalMs?: number;
  /** Инъекция времени/сна/рандома — детерминированные тесты breaker'а. */
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
}

interface BreakerRuntime {
  state: 'CLOSED' | 'OPEN' | 'HALF_OPEN';
  failures: number;
  openedAt: number | null;
  /** HALF_OPEN: пробная попытка уже выполняется (вторая не допускается). */
  trialInFlight: boolean;
  lastAvailable: boolean | null;
  lastError: string | null;
  lastCheckedAt: string | null;
  /** Политика: из config либо дефолт ProviderPolicySchema (provider без записи). */
  policy: ProviderPolicy | null;
}

const DEFAULT_PROBE_INTERVAL_MS = 30_000;

function freshRuntime(): BreakerRuntime {
  return {
    state: 'CLOSED',
    failures: 0,
    openedAt: null,
    trialInFlight: false,
    lastAvailable: null,
    lastError: null,
    lastCheckedAt: null,
    policy: null,
  };
}

export class CapabilityRegistry {
  private readonly entries = new Map<string, RegistryEntry>();
  private readonly runtimes = new Map<string, BreakerRuntime>();
  private readonly chains: Chains;
  private readonly policies = new Map<string, ProviderPolicy>();
  private readonly bus: EventBus | undefined;
  private readonly logger: RegistryLog | undefined;
  private readonly metrics: MetricsSink | undefined;
  private readonly probeIntervalMs: number;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  /** Последнее ОПУБЛИКОВАННОЕ состояние доступности (дедупликация эмиссии). */
  private readonly lastEmitted = new Map<Capability, { available: boolean; providers: readonly string[] }>();
  private probeTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: CapabilityRegistryOptions = {}) {
    this.chains = ChainsSchema.parse(options.chains ?? {});
    for (const raw of options.policies ?? []) {
      const policy = ProviderPolicySchema.parse(raw); // F-7.5: политика только валидная
      this.policies.set(policy.providerId, policy);
    }
    this.bus = options.bus;
    this.logger = options.logger;
    this.metrics = options.metrics;
    this.probeIntervalMs = options.probeIntervalMs ?? DEFAULT_PROBE_INTERVAL_MS;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.random = options.random ?? Math.random;
  }

  // ------------------------------------------------------------ реестр

  /** Регистрация провайдера. Запись проходит Zod-валидацию (F-7.5). */
  register(input: RegistryEntry): void {
    const entry = RegistryEntrySchema.parse(input);
    if (this.entries.has(entry.providerId)) {
      throw new ConflictError('DUPLICATE', `провайдер ${entry.providerId} уже зарегистрирован`, {
        providerId: entry.providerId,
      });
    }
    this.entries.set(entry.providerId, entry);
    this.runtimes.set(entry.providerId, freshRuntime());
    this.logger?.info(
      { providerId: entry.providerId, capability: entry.capability, event: 'provider_registered' },
      'provider_registered',
    );
    this.emitIfChanged(entry.capability);
  }

  unregister(providerId: string): void {
    const entry = this.entries.get(providerId);
    if (entry === undefined) return; // идемпотентно
    this.entries.delete(providerId);
    this.runtimes.delete(providerId);
    this.logger?.info({ providerId, event: 'provider_unregistered' }, 'provider_unregistered');
    this.emitIfChanged(entry.capability);
  }

  registeredProviderIds(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * Политика провайдера: запись из provider-policies.yaml либо дефолт схемы
   * (провайдер зарегистрирован без политики — сценический стенд в тестах).
   */
  getPolicy(providerId: string): ProviderPolicy | undefined {
    const entry = this.entries.get(providerId);
    return entry === undefined ? this.policies.get(providerId) : this.policyFor(entry);
  }

  private policyFor(entry: RegistryEntry): ProviderPolicy {
    const configured = this.policies.get(entry.providerId);
    if (configured !== undefined) return configured;
    const runtime = this.runtimes.get(entry.providerId);
    if (runtime?.policy !== null && runtime !== undefined) return runtime.policy;
    const fallback = ProviderPolicySchema.parse({ providerId: entry.providerId, capability: entry.capability });
    if (runtime !== undefined) runtime.policy = fallback;
    return fallback;
  }

  // ------------------------------------------------------------ resolve

  /**
   * Упорядоченная цепочка провайдеров capability из capabilities.yaml,
   * отфильтрованная по: регистрация → breaker (OPEN пропускается; cooldown
   * истёк → HALF_OPEN) → isAvailable().
   */
  async resolve(capability: Capability): Promise<AIPort[]> {
    const chain = this.chains[capability]?.chain ?? [];
    const resolved: AIPort[] = [];
    for (const providerId of chain) {
      const entry = this.entries.get(providerId);
      if (entry === undefined || entry.capability !== capability) continue;
      const runtime = this.runtimeOf(providerId);
      if (!this.breakerAdmits(runtime, providerId)) continue;
      const available = await this.checkAvailability(entry, runtime);
      if (!available) continue;
      resolved.push(entry.provider);
    }
    return resolved;
  }

  async isAvailable(capability: Capability): Promise<boolean> {
    return (await this.resolve(capability)).length > 0;
  }

  /** OPEN + cooldown не истёк → false; OPEN + истёк → HALF_OPEN (пробный допуск). */
  private breakerAdmits(runtime: BreakerRuntime, providerId: string): boolean {
    if (runtime.state === 'CLOSED') return true;
    if (runtime.state === 'OPEN') {
      const policy = this.policyOfRuntime(providerId, runtime);
      const elapsed = this.now() - (runtime.openedAt ?? this.now());
      if (elapsed < policy.circuitBreaker.cooldownMs) return false;
      runtime.state = 'HALF_OPEN';
      runtime.trialInFlight = false;
      this.logger?.warn({ providerId, event: 'breaker_half_open' }, 'breaker_half_open');
      return true;
    }
    // HALF_OPEN: допускаем, если пробная попытка не занята.
    return !runtime.trialInFlight;
  }

  private policyOfRuntime(providerId: string, runtime: BreakerRuntime): ProviderPolicy {
    if (runtime.policy !== null) return runtime.policy;
    const configured = this.policies.get(providerId);
    if (configured !== undefined) {
      runtime.policy = configured;
      return configured;
    }
    const entry = this.entries.get(providerId);
    const fallback = ProviderPolicySchema.parse({
      providerId,
      capability: entry?.capability ?? 'TEXT_AI',
    });
    runtime.policy = fallback;
    return fallback;
  }

  private async checkAvailability(entry: RegistryEntry, runtime: BreakerRuntime): Promise<boolean> {
    let available = false;
    try {
      available = await entry.provider.isAvailable();
    } catch (cause) {
      runtime.lastError = cause instanceof Error ? cause.message : String(cause);
      this.logger?.warn(
        { providerId: entry.providerId, err: cause, event: 'probe_isavailable_failed' },
        'probe_isavailable_failed',
      );
    }
    runtime.lastAvailable = available;
    runtime.lastCheckedAt = nowIso();
    return available;
  }

  // ------------------------------------------------------------ withPolicy

  /**
   * Выполнение fn под политикой провайдера (F-7.2): таймаут из ProviderPolicy
   * (НЕ из аргументов порта), ретраи max/backoffMs/jitter, учёт breaker'а.
   * Таймаут принудительный: Promise.race + abort сигнала (даже если провайдер
   * игнорирует signal, попытка не длится дольше timeoutMs).
   */
  async withPolicy<T>(providerId: string, fn: (ctx: PolicyAttemptContext) => Promise<T>): Promise<T> {
    const entry = this.entries.get(providerId);
    if (entry === undefined) {
      throw new ProviderError('PROVIDER_UNAVAILABLE', `провайдер ${providerId} не зарегистрирован`, providerId);
    }
    const policy = this.policyFor(entry);
    const runtime = this.runtimeOf(providerId);
    const maxAttempts = policy.retries.max + 1;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      const trialMarked = this.admitOrThrow(runtime, policy, providerId);
      const controller = new AbortController();
      const startedAt = this.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const result = await Promise.race<T>([
          fn({ attempt, timeoutMs: policy.timeoutMs, signal: controller.signal }),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => {
              controller.abort();
              reject(
                new ProviderError('PROVIDER_TIMEOUT', `провайдер не ответил за ${policy.timeoutMs} мс`, providerId, {
                  timeoutMs: policy.timeoutMs,
                  attempt,
                }),
              );
            }, policy.timeoutMs);
          }),
        ]);
        this.recordSuccess(runtime, entry);
        this.metrics?.timing('ai.provider.duration_ms', this.now() - startedAt, { providerId });
        return result;
      } catch (cause) {
        const error =
          cause instanceof Error
            ? cause
            : new ProviderError('PROVIDER_BAD_GATEWAY', String(cause), providerId, { attempt });
        this.recordFailure(runtime, policy, entry, error);
        lastError = error;
        this.metrics?.counter('ai.provider.errors_total', 1, { providerId, code: codeOf(error) });
        if (attempt < maxAttempts) {
          await this.sleep(backoffDelayMs(policy, attempt, this.random));
          continue;
        }
        throw error;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        // Сбрасываем пробную попытку, только если ЭТОТ вызов её занял:
        // иначе конкурентный withPolicy снял бы флаг чужого half-open trial.
        if (trialMarked) runtime.trialInFlight = false;
      }
    }
    // Недостижимо: цикл возвращает результат или бросает последнюю ошибку.
    throw lastError ?? new ProviderError('PROVIDER_BAD_GATEWAY', 'withPolicy: попытки исчерпаны', providerId);
  }

  /**
   * Допуск к попытке: OPEN без истёкшего cooldown и занятый HALF_OPEN — отказ.
   * Возвращает true, если вызов ЗАНЯЛ пробную попытку half-open (сброс — в finally
   * только при trialMarked, иначе конкуренты снимали бы чужой флаг).
   */
  private admitOrThrow(runtime: BreakerRuntime, policy: ProviderPolicy, providerId: string): boolean {
    if (runtime.state === 'OPEN') {
      const elapsed = this.now() - (runtime.openedAt ?? this.now());
      if (elapsed < policy.circuitBreaker.cooldownMs) {
        throw new ProviderError(
          'PROVIDER_UNAVAILABLE',
          `circuit breaker OPEN, до half-open ${policy.circuitBreaker.cooldownMs - elapsed} мс`,
          providerId,
          { breaker: 'OPEN', failures: runtime.failures },
        );
      }
      runtime.state = 'HALF_OPEN';
      runtime.trialInFlight = false;
      this.logger?.warn({ providerId, event: 'breaker_half_open' }, 'breaker_half_open');
    }
    if (runtime.state === 'HALF_OPEN') {
      if (runtime.trialInFlight) {
        throw new ProviderError('PROVIDER_UNAVAILABLE', 'half-open: пробная попытка уже выполняется', providerId, {
          breaker: 'HALF_OPEN',
        });
      }
      runtime.trialInFlight = true;
      return true;
    }
    return false;
  }

  private recordSuccess(runtime: BreakerRuntime, entry: RegistryEntry): void {
    const recovered = runtime.state !== 'CLOSED';
    runtime.state = 'CLOSED';
    runtime.failures = 0;
    runtime.openedAt = null;
    runtime.trialInFlight = false;
    runtime.lastError = null;
    if (recovered) {
      this.logger?.info({ providerId: entry.providerId, event: 'breaker_closed' }, 'breaker_closed');
      this.metrics?.counter('capability.breaker_closed_total', 1, { providerId: entry.providerId });
      this.emitIfChanged(entry.capability);
    }
  }

  private recordFailure(runtime: BreakerRuntime, policy: ProviderPolicy, entry: RegistryEntry, error: Error): void {
    runtime.failures += 1;
    runtime.lastError = `${codeOf(error)}: ${error.message}`.slice(0, 200);
    const mustOpen =
      runtime.state === 'HALF_OPEN' ||
      (runtime.state === 'CLOSED' && runtime.failures >= policy.circuitBreaker.failureThreshold);
    if (!mustOpen) return;
    runtime.state = 'OPEN';
    runtime.openedAt = this.now();
    runtime.trialInFlight = false;
    this.logger?.warn(
      {
        providerId: entry.providerId,
        failures: runtime.failures,
        cooldownMs: policy.circuitBreaker.cooldownMs,
        event: 'breaker_open',
      },
      'breaker_open',
    );
    this.metrics?.counter('capability.breaker_open_total', 1, { providerId: entry.providerId });
    this.emitIfChanged(entry.capability);
  }

  private runtimeOf(providerId: string): BreakerRuntime {
    let runtime = this.runtimes.get(providerId);
    if (runtime === undefined) {
      runtime = freshRuntime();
      this.runtimes.set(providerId, runtime);
    }
    return runtime;
  }

  // ------------------------------------------------------------ healthProbe

  /** Запуск healthProbe по расписанию (capabilityProbeMs). Таймер unref — процесс не держит. */
  startHealthProbe(): void {
    if (this.probeTimer !== null) return; // идемпотентно
    void this.probeOnce(); // базовая линия доступности сразу (A1.13: /health честен со старта)
    this.probeTimer = setInterval(() => {
      void this.probeOnce();
    }, this.probeIntervalMs);
    this.probeTimer.unref();
  }

  stopHealthProbe(): void {
    if (this.probeTimer === null) return;
    clearInterval(this.probeTimer);
    this.probeTimer = null;
  }

  /** Один цикл зонда: isAvailable() у всех зарегистрированных + эмиссия изменений. */
  async probeOnce(): Promise<void> {
    for (const [providerId, entry] of this.entries) {
      const runtime = this.runtimeOf(providerId);
      // OPEN с истёкшим cooldown переводим в HALF_OPEN, чтобы зонд/снапшот
      // видели восстановление без ожидания боевого вызова.
      if (runtime.state === 'OPEN') {
        const policy = this.policyOfRuntime(providerId, runtime);
        if (this.now() - (runtime.openedAt ?? this.now()) >= policy.circuitBreaker.cooldownMs) {
          runtime.state = 'HALF_OPEN';
          runtime.trialInFlight = false;
        }
      }
      await this.checkAvailability(entry, runtime);
    }
    for (const capability of Object.keys(this.chains) as Capability[]) {
      this.emitIfChanged(capability);
    }
    this.metrics?.counter('capability.probe_total', 1);
  }

  // ------------------------------------------------------------ snapshot / events

  /** Синхронный срез для GET /health (A1.13) и payload'ов CAPABILITY_CHANGED. */
  snapshot(): RegistrySnapshot {
    const capabilities: Record<string, CapabilityAvailability> = {};
    for (const capability of CapabilitySchema.options) {
      const chainConfig = this.chains[capability];
      const sync = this.syncAvailability(capability);
      capabilities[capability] = CapabilityAvailabilitySchema.parse({
        capability,
        available: sync.ids.length > 0,
        required: chainConfig?.required ?? false,
        providers: sync.ids,
        reason: sync.ids.length > 0 ? null : sync.reason,
        checkedAt: sync.checkedAt,
      });
    }
    const providers: ProviderSnapshot[] = [];
    for (const [providerId, entry] of this.entries) {
      const runtime = this.runtimeOf(providerId);
      providers.push({
        providerId,
        capability: entry.capability,
        breaker: runtime.state,
        failures: runtime.failures,
        available: runtime.lastAvailable,
        lastError: runtime.lastError,
        lastCheckedAt: runtime.lastCheckedAt,
        inChain: (this.chains[entry.capability]?.chain ?? []).includes(providerId),
      });
    }
    return { generatedAt: nowIso(), capabilities, providers };
  }

  /**
   * Доступность capability СИНХРОННО (по кэшу lastAvailable и breaker'у) —
   * для snapshot() и эмиссии событий. Оптимистично: провайдер ещё не зондирован
   * (lastAvailable=null) и breaker закрыт → считается доступным.
   */
  private syncAvailability(capability: Capability): {
    ids: string[];
    reason: 'unavailable' | 'error_rate' | null;
    checkedAt: string | null;
  } {
    const chain = this.chains[capability]?.chain ?? [];
    const ids: string[] = [];
    let breakerOpen = false;
    let checkedAt: string | null = null;
    for (const providerId of chain) {
      const entry = this.entries.get(providerId);
      if (entry === undefined || entry.capability !== capability) continue;
      const runtime = this.runtimeOf(providerId);
      if (runtime.lastCheckedAt !== null && (checkedAt === null || runtime.lastCheckedAt > checkedAt)) {
        checkedAt = runtime.lastCheckedAt;
      }
      if (runtime.state === 'OPEN') {
        breakerOpen = true;
        continue;
      }
      if (runtime.lastAvailable === false) continue;
      ids.push(providerId);
    }
    return { ids, reason: ids.length > 0 ? null : breakerOpen ? 'error_rate' : 'unavailable', checkedAt };
  }

  /** Эмиссия CAPABILITY_CHANGED при изменении доступности (дедуп по lastEmitted). */
  private emitIfChanged(capability: Capability): void {
    const sync = this.syncAvailability(capability);
    const available = sync.ids.length > 0;
    const last = this.lastEmitted.get(capability);
    if (last !== undefined && last.available === available && sameStrings(last.providers, sync.ids)) return;
    this.lastEmitted.set(capability, { available, providers: sync.ids });

    const reason = available ? null : (sync.reason ?? 'unavailable');
    const event: DomainEvent = {
      type: 'CAPABILITY_CHANGED',
      payload: {
        capability,
        available,
        providers: sync.ids,
        reason,
        sessionId: null,
      },
      emittedAt: nowIso(),
      traceId: `cap-${randomUUID()}`.slice(0, 64),
    };
    this.logger?.info(
      { capability, available, providers: sync.ids, reason, event: 'capability_changed' },
      'capability_changed',
    );
    this.metrics?.counter('capability.changed_total', 1, { capability, available });
    if (this.bus === undefined) return;
    this.bus.publish(event).catch((cause: unknown) => {
      this.logger?.error(
        { err: cause, capability, event: 'capability_changed_publish_failed' },
        'capability_changed_publish_failed',
      );
    });
  }
}

/** Задержка ретрая: backoffMs * 2^(attempt-1); jitter → множитель [0.5, 1.5). */
export function backoffDelayMs(policy: ProviderPolicy, attempt: number, random: () => number): number {
  const base = policy.retries.backoffMs * 2 ** (attempt - 1);
  const factor = policy.retries.jitter ? 0.5 + random() : 1;
  return Math.max(0, Math.round(base * factor));
}

function codeOf(error: Error): string {
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? code : error.name;
}

function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}
