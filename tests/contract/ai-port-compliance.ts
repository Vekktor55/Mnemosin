import { randomUUID } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';
import {
  AIResponseSchema,
  ProviderError,
  nowIso,
  type ActionId,
  type AIResponse,
  type DirectorContext,
  type IdempotencyKey,
  type LocationId,
  type ObjectId,
  type PlayerId,
  type SessionId,
  type TurnId,
} from '@mnemosin/contracts';
import type { AIPort } from '@mnemosin/core';

/**
 * Contract-тест «любой AIPort-провайдер» (промпт 1.7, п.9).
 *
 * Общий набор инвариантов порта, прогоняемый для всех стендов этапа 1.
 * В этапе 2 этот же шаблон запускается для OpenRouter (2.6) и LM Studio (2.7)
 * с offline:false — новые провайдеры обязаны удовлетворять ТОЙ ЖЕ спецификации
 * AIPort (критерий A1.14: добавление провайдера не меняет ни порт, ни тесты).
 */

export const MINIMAL_VALID_RESPONSE: AIResponse = {
  narrative: 'Минимальный валидный ответ провайдера.',
  privateMessages: [],
  proposedEvents: [],
  proposedObjectChanges: [],
  visualSceneDescription: null,
};

export interface StandSpec {
  readonly title: string;
  readonly providerId: string;
  /** Ожидаемый результат isAvailable(). */
  readonly available: boolean;
  /** Поведение generate(): валидный ответ / невалидный ответ / ProviderError. */
  readonly outcome: 'valid' | 'invalid' | 'error';
  /** Для outcome='error' — ожидаемый код ProviderError. */
  readonly errorCode?: string;
  /** Два вызова с одним входом дают идентичный ответ (детерминированный стенд). */
  readonly deterministic?: boolean;
  /** Провайдер обязан реагировать на pre-aborted signal (ProviderError TIMEOUT). */
  readonly respectsAbort?: boolean;
  /** Провайдер не делает сетевых вызовов (offline-стенды этапа 1). */
  readonly offline?: boolean;
  /**
   * deadline.timeoutMs для вызовов generate() в этом наборе тестов.
   * Малое значение для стенда 'timeout' (он ждёт timeoutMs+1s): 10 → ~1с на тест.
   */
  readonly generateTimeoutMs?: number;
  create(): AIPort;
}

/** Минимальный валидный DirectorContext (проходит DirectorContextSchema.parse). */
export function makeTestDirectorContext(overrides: Partial<DirectorContext> = {}): DirectorContext {
  const sessionId = randomUUID() as SessionId;
  const turnId = randomUUID() as TurnId;
  const locationId = randomUUID() as LocationId;
  const objectId = randomUUID() as ObjectId;
  const playerIds = [randomUUID() as PlayerId, randomUUID() as PlayerId];

  const base: DirectorContext = {
    sessionId,
    turnId,
    turnNumber: 1,
    currentLocation: {
      locationId,
      name: 'Тестовый тамбур',
      description: 'Тесное помещение с одной дверью.',
      atmosphere: 'Холодный металл.',
      objects: [{ objectId, name: 'Рычаг', description: 'Ржавый рычаг.', interactive: true, takeable: false }],
      exits: [
        {
          kind: 'LOCATION',
          toLocationId: randomUUID() as LocationId,
          label: 'Дверь наружу',
          description: null,
          via: 'door',
          locked: false,
          lockReason: null,
          oneWay: false,
        },
      ],
      hazards: [],
      tags: ['test'],
      hiddenExits: [],
      narrativeNotes: '',
      aiGuidance: null,
      secretRestrictions: [],
      floorTruth: null,
      allObjects: [
        { objectId, name: 'Рычаг', description: 'Ржавый рычаг.', interactive: true, takeable: false, visible: true },
      ],
    },
    visiblePlayerActions: playerIds.map((playerId, index) => ({
      actionId: randomUUID() as ActionId,
      turnId,
      playerId,
      sequenceId: index + 1,
      rawText: index === 0 ? 'Осматриваю рычаг' : 'Дёргаю рычаг',
      meta: { targetObjectId: null, targetPlayerId: null, intent: 'ACT', customLabel: null },
      idempotencyKey: `test-key-${randomUUID()}` as IdempotencyKey,
      createdAt: nowIso(),
    })),
    relevantState: {
      timeOfDay: 'NIGHT',
      weather: null,
      activeFlags: {},
      objectStates: [{ objectId, locationId, visible: true, taken: false, state: {} }],
    },
    allowedEventIds: [],
    allowedEvents: [],
    storyFacts: ['Флаг партии: lights_on = false'],
    gmNotesForAI: ['Держать тон тревожным.'],
    directorInstructions: 'Тестовые указания Директору.',
    characterNames: [
      { playerId: playerIds[0] as PlayerId, name: 'Игрок Один' },
      { playerId: playerIds[1] as PlayerId, name: 'Игрок Два' },
    ],
    namePolicy: 'ALL',
    tokensEstimate: null,
    ...overrides,
  };
  return base;
}

export function makeGenerateInput(context: DirectorContext, timeoutMs = 5_000, attempt = 1, signal?: AbortSignal) {
  return {
    context,
    schema: AIResponseSchema,
    deadline: { timeoutMs, attempt },
    ...(signal === undefined ? {} : { signal }),
  };
}

function isProviderErrorWith(cause: unknown, code: string, providerId: string): boolean {
  return cause instanceof ProviderError && cause.code === code && cause.providerId === providerId;
}

export function describeAIPortCompliance(specs: readonly StandSpec[]): void {
  for (const spec of specs) {
    describe(`AIPort-контракт · ${spec.title}`, () => {
      const context = makeTestDirectorContext();

      it('providerId совпадает со спецификацией, capability = TEXT_AI', () => {
        const port = spec.create();
        expect(port.providerId).toBe(spec.providerId);
        expect(port.capability).toBe('TEXT_AI');
      });

      it('isAvailable() → boolean из спецификации', async () => {
        const port = spec.create();
        await expect(port.isAvailable()).resolves.toBe(spec.available);
      });

      it('generate() соответствует заявленному поведению (outcome)', async () => {
        const port = spec.create();
        const input = makeGenerateInput(context, spec.generateTimeoutMs ?? 5_000);
        if (spec.outcome === 'error') {
          await expect(port.generate(input)).rejects.toSatisfy((cause: unknown) =>
            isProviderErrorWith(cause, spec.errorCode ?? 'PROVIDER_UNAVAILABLE', spec.providerId),
          );
          return;
        }
        const result = await port.generate(input);
        const validity = AIResponseSchema.safeParse(result.response);
        expect(
          validity.success,
          spec.outcome === 'valid' ? 'ответ обязан быть валидным' : 'ответ обязан быть невалидным',
        ).toBe(spec.outcome === 'valid');
        expect(Number.isInteger(result.durationMs)).toBe(true);
        expect(result.durationMs).toBeGreaterThanOrEqual(0);
        if (result.usage !== null) {
          expect(result.usage.inputTokens).toBeGreaterThanOrEqual(0);
          expect(result.usage.outputTokens).toBeGreaterThanOrEqual(0);
          expect(result.usage.model.length).toBeGreaterThan(0);
        }
      });

      if (spec.deterministic === true) {
        it('детерминирован: два вызова с одним входом → идентичный ответ', async () => {
          const port = spec.create();
          const first = await port.generate(makeGenerateInput(context));
          const second = await port.generate(makeGenerateInput(context));
          expect(JSON.stringify(second.response)).toBe(JSON.stringify(first.response));
        });
      }

      if (spec.respectsAbort === true) {
        it('pre-aborted signal → ProviderError(PROVIDER_TIMEOUT) без ожидания', async () => {
          const port = spec.create();
          const controller = new AbortController();
          controller.abort();
          const startedAt = Date.now();
          await expect(port.generate(makeGenerateInput(context, 60_000, 1, controller.signal))).rejects.toSatisfy(
            (cause: unknown) => isProviderErrorWith(cause, 'PROVIDER_TIMEOUT', spec.providerId),
          );
          expect(Date.now() - startedAt).toBeLessThan(2_000);
        });
      }

      if (spec.offline !== false) {
        it('офлайн: generate() не выполняет сетевых вызовов (fetch)', async () => {
          const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('network-forbidden'));
          try {
            const port = spec.create();
            await port.generate(makeGenerateInput(context, spec.generateTimeoutMs ?? 5_000)).catch(() => undefined);
            expect(fetchSpy).not.toHaveBeenCalled();
          } finally {
            fetchSpy.mockRestore();
          }
        });
      }
    });
  }
}
