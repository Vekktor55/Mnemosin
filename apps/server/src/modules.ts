import type { Logger } from 'pino';

import type { AppConfig } from '@mnemosin/config';
import type { CoreServices } from '@mnemosin/core';
import { ChatService } from '@mnemosin/module-chat';
import { GmAuditService } from '@mnemosin/module-gm-audit';
import { GmService } from '@mnemosin/module-gm';
import { GmReviewService } from '@mnemosin/module-gm-review';
import { StoryService } from '@mnemosin/module-story';
import { TurnEngine, rulesStub } from '@mnemosin/module-turn';
import type { BootstrapResult } from '@mnemosin/database';

import type { AIStack } from './ai.js';
import { buildStage1Registrations, type ModuleRegistration } from './modules-registry.js';

/**
 * Сборка прикладных модулей этапа 1 (промпты 1.8–1.9; wiring-точка D161).
 *
 * Модули не импортируют друг друга — все связи инъекции структурных портов:
 *  - turn ← ai-director (DraftGeneratorPort, D115/D227);
 *  - gm-review ← turn (TurnEnginePort, D119);
 *  - gm ← chat (ChatSystemPort: системные сообщения и публикация заметок
 *    PUBLIC_AFTER_COMMIT, F-3.8);
 *  - правила — rulesStub (D116).
 * Регистрации модулей (9 контрактов, F-8.3) собираются для modules-registry;
 * валидацию и boot-подписку выполняет main.ts.
 */

export interface ModuleStack {
  readonly chat: ChatService;
  readonly story: StoryService;
  readonly gm: GmService;
  readonly gmAudit: GmAuditService;
  readonly turn: TurnEngine;
  readonly gmReview: GmReviewService;
  readonly registrations: ModuleRegistration[];
}

export interface BuildModulesDeps {
  readonly config: AppConfig;
  readonly persistence: BootstrapResult;
  readonly services: CoreServices;
  readonly ai: AIStack;
  readonly logger: Logger;
}

export function buildModules(deps: BuildModulesDeps): ModuleStack {
  const { config, persistence, services, ai, logger } = deps;

  const chat = new ChatService({
    uow: persistence.uow,
    guard: persistence.idempotency,
    limits: {
      maxMessageLen: config.limits.maxMessageLen,
      publicPerSecond: config.limits.chat.publicPerSecond,
      burstSeconds: config.limits.chat.burstSeconds,
    },
    logger: logger.child({ component: 'chat' }),
  });

  const story = new StoryService({
    uow: persistence.uow,
    guard: persistence.idempotency,
    state: services.state,
  });

  const turn = new TurnEngine({
    uow: persistence.uow,
    guard: persistence.idempotency,
    services: {
      turns: services.turns,
      state: services.state,
      journal: services.journal,
    },
    // D115: вызов Директора КОМАНДОЙ (структурный порт DraftGeneratorPort).
    aiDirector: ai.director,
    // D116: rulesStub — PASS для всех subject; интерфейс RulesPort полный.
    rules: rulesStub,
    limits: {
      // F-9.4: allowlist ключей objectStates для AI-правок (этап 1: ['*']).
      aiMutableObjectKeys: config.limits.aiMutable.objectStateKeys,
    },
    logger: logger.child({ component: 'turn-engine' }),
    idempotencyTtlMs: config.limits.idempotencyTtlHours * 60 * 60 * 1000,
  });

  const gm = new GmService({
    uow: persistence.uow,
    guard: persistence.idempotency,
    services: {
      sessions: services.sessions,
      turns: services.turns,
      locations: services.locations,
      journal: services.journal,
      state: services.state,
    },
    // Структурный порт: gm не импортирует модуль chat (D161).
    chat,
    logger: logger.child({ component: 'gm' }),
    // D253: после успешного lockTurn запускаем resolveTurn КОМАНДОЙ (D115) —
    // fire-and-forget: HTTP-lock не ждёт AI; сбой → TURN_FAILED + FAILED-ход.
    afterLock: ({ turnId, traceId }) => {
      void turn
        .resolveTurn({ turnId, traceId })
        .then(() => undefined)
        .catch((cause: unknown) => {
          logger
            .child({ component: 'turn-engine' })
            .warn({ err: cause, turnId, traceId, event: 'auto_resolve_failed' }, 'auto_resolve_failed');
        });
    },
  });

  const gmAudit = new GmAuditService({
    uow: persistence.uow,
    logger: logger.child({ component: 'gm-audit' }),
  });

  const gmReview = new GmReviewService({
    uow: persistence.uow,
    guard: persistence.idempotency,
    journal: services.journal,
    turnEngine: turn,
    logger: logger.child({ component: 'gm-review' }),
  });

  const registrations = buildStage1Registrations({ chat, gm, gmAudit });

  return { chat, story, gm, gmAudit, turn, gmReview, registrations };
}
