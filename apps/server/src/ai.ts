import { resolve } from 'node:path';

import type { Logger } from 'pino';

import type { AppConfig } from '@mnemosin/config';
import { CapabilityRegistry, EchoAI, FailingAI, ScriptedAI } from '@mnemosin/ai';
import { AiDirectorService } from '@mnemosin/module-ai-director';
import type { AIPort, EventBus, MetricsSink, UnitOfWork } from '@mnemosin/core';

/**
 * Сборка AI-контура (промпт 1.7, D226): wiring-точка, где env/config решают,
 * КАКОЙ стенд (этап 1) или боевой провайдер (этап 2) регистрируется в
 * CapabilityRegistry. Переключение провайдера — ТОЛЬКО env/config (A1.12):
 * код core/ и modules/ при этом не меняется.
 *
 * D192/A1.14: новый провайдер = 1 файл адаптера (infrastructure/ai) + 1 строка
 * в config/capabilities.yaml + 1 case в этой фабрике. Фабрика живёт в apps
 * (wiring-слой), а не в ядре: core/ и modules/ остаются неизменными — это и
 * проверяет tools/verify/switch-provider.mjs (хэши каталогов до/после).
 */

export interface AIStack {
  readonly registry: CapabilityRegistry;
  readonly director: AiDirectorService;
  /** Зарегистрированный провайдер TEXT_AI (null — неизвестный AI_PROVIDER). */
  readonly providerId: string | null;
}

export interface BuildAIStackDeps {
  readonly config: AppConfig;
  readonly uow: UnitOfWork;
  readonly bus: EventBus;
  readonly metrics: MetricsSink;
  readonly logger: Logger;
  /** Корень проекта: AI_SCRIPTED_FIXTURE может быть относительным путём. */
  readonly root: string;
}

export function buildAIStack(deps: BuildAIStackDeps): AIStack {
  const { config, bus, metrics, logger } = deps;

  const registry = new CapabilityRegistry({
    chains: config.capabilities.capabilities,
    policies: config.providerPolicies.policies,
    bus,
    metrics,
    logger: logger.child({ component: 'capability-registry' }),
    probeIntervalMs: config.limits.capabilityProbeMs,
  });

  const providerId = config.env.AI_PROVIDER;
  const stand = createTextAIStand(providerId, config, deps.root, logger);
  if (stand === null) {
    // D192: неизвестный идентификатор — не ошибка старта (deny-list проверяет
    // только production-заглушки в config); адаптер этапа 2 регистрируется здесь.
    logger.warn({ providerId, event: 'ai_provider_unknown' }, 'ai_provider_unknown');
  } else {
    registry.register({ capability: 'TEXT_AI', providerId, provider: stand });
  }

  const chain = config.capabilities.capabilities.TEXT_AI?.chain ?? [];
  if (!chain.includes(providerId)) {
    logger.warn(
      { providerId, chain, event: 'ai_provider_not_in_chain' },
      'AI_PROVIDER отсутствует в цепочке TEXT_AI (capabilities.yaml) — resolve() вернёт пусто',
    );
  }

  const director = new AiDirectorService({
    uow: deps.uow,
    registry,
    bus,
    metrics,
    logger: logger.child({ component: 'ai-director' }),
    directorInstructions: config.limits.aiDirectorInstructions,
    schemaRepairAttempts: config.limits.aiSchemaRepairAttempts,
  });

  return { registry, director, providerId: stand === null ? null : providerId };
}

/**
 * Фабрика TEXT_AI-адаптеров. Этап 1: три офлайн-стенда (F-7.3).
 * Этап 2 добавит case 'openrouter' (2.6) и 'lmstudio' (2.7) — по одному файлу
 * адаптера каждый, без изменения core/modules (A1.14).
 */
function createTextAIStand(providerId: string, config: AppConfig, root: string, logger: Logger): AIPort | null {
  switch (providerId) {
    case 'scripted': {
      const fixturePath = resolve(root, config.env.AI_SCRIPTED_FIXTURE);
      logger.info({ fixturePath, event: 'ai_stand_scripted' }, 'ai_stand_scripted');
      return new ScriptedAI({ fixturePath });
    }
    case 'echo':
      return new EchoAI();
    case 'failing':
      return new FailingAI({ mode: config.env.AI_FAILING_MODE });
    default:
      return null;
  }
}
