import {
  EVENT_EMITTERS,
  EVENT_NAMES,
  EVENT_SUBSCRIBERS,
  ModuleIdSchema,
  defineModule,
  type DomainEvent,
  type ModuleContract,
  type ModuleId,
} from '@mnemosin/contracts';
import type { EventBus, Unsubscribe } from '@mnemosin/core';
import type { ChatService } from '@mnemosin/module-chat';
import type { GmAuditService } from '@mnemosin/module-gm-audit';
import type { GmService } from '@mnemosin/module-gm';

import { aiDirectorContract } from '@mnemosin/module-ai-director';
import { chatContract } from '@mnemosin/module-chat';
import { gmAuditContract } from '@mnemosin/module-gm-audit';
import { gmContract } from '@mnemosin/module-gm';
import { gmReviewContract } from '@mnemosin/module-gm-review';
import { sessionContract } from '@mnemosin/module-session';
import { storyContract } from '@mnemosin/module-story';
import { turnContract } from '@mnemosin/module-turn';

/**
 * Реестр модулей этапа 1 (промпт 1.9, п.8; F-8.3: «9 модулей»).
 *
 * Девять контрактов: session, turn, chat, story, gm, gm-review, gm-audit,
 * ai-director, media-director. Первые восемь реализованы в этапе 1; контракт
 * media-director объявлен ЗДЕСЬ декларативно (реализация — промпты 2.10–2.12,
 * тогда же контракт переедет в modules/media-director, D251).
 *
 * Валидация (исполнимая спецификация v3 §IV.1):
 *  - moduleId уникален и ∈ ModuleIdSchema;
 *  - emits/subscribes ⊆ каталога EVENT_NAMES (DomainEventSchema);
 *  - владелец emits совпадает с EVENT_EMITTERS[event];
 *  - подписчик входит в EVENT_SUBSCRIBERS[event];
 *  - dependencies ⊆ ModuleIdSchema, без само-зависимостей и ЦИКЛОВ;
 *  - idempotentCommands ⊆ commands (F-8.2);
 *  - ключи handlers ⊆ subscribes (нельзя обработать неподписанное).
 *
 * Boot-подписка: каждое объявленное событие подписывается на шину — реальным
 * обработчиком модуля либо log-only (декларативные подписки этапа 1).
 */

export type ModuleEventHandler = (event: DomainEvent) => void | Promise<void>;

export interface ModuleRegistration {
  readonly contract: ModuleContract;
  /** Обработчики подписок (ключи ⊆ contract.subscribes). */
  readonly handlers?: Readonly<Partial<Record<string, ModuleEventHandler>>>;
  /** false — контракт объявлен, реализация в будущем этапе (media-director). */
  readonly stage1Implemented: boolean;
}

export interface RegistryLog {
  info(obj: unknown, msg?: string): void;
  warn(obj: unknown, msg?: string): void;
  debug(obj: unknown, msg?: string): void;
}

/**
 * Контракт media-director — декларация этапа 1 (D251): события/подписки по
 * каталогам contracts; реализация и пакет — промпты 2.10–2.12.
 */
export const mediaDirectorContract = defineModule({
  moduleId: 'media-director',
  purpose:
    'Media Director (этап 2, промпты 2.10–2.12): визуальные сцены из TurnResolution → джобы провайдеров → MEDIA_READY. В этапе 1 — декларация для реестра (F-8.3)',
  version: '0.0.0-stage1-declaration',
  commands: {},
  queries: {},
  emits: ['VISUAL_SCENE_REQUESTED', 'MEDIA_JOB_QUEUED', 'MEDIA_GENERATION_STARTED', 'MEDIA_READY', 'MEDIA_FAILED'],
  subscribes: ['TURN_COMMITTED', 'LOCATION_CHANGED', 'WORLD_EVENT_FIRED'],
  ports: ['MediaPort'],
  dependencies: [],
  capabilities: ['IMAGE_GENERATION', 'IMAGE_EDITING'],
});

export interface Stage1Services {
  readonly chat: ChatService;
  readonly gm: GmService;
  readonly gmAudit: GmAuditService;
}

/** Девять регистраций этапа 1 с реальными обработчиками подписок. */
export function buildStage1Registrations(services: Stage1Services): ModuleRegistration[] {
  const { chat, gm, gmAudit } = services;
  return [
    { contract: sessionContract, stage1Implemented: true },
    { contract: turnContract, stage1Implemented: true },
    {
      contract: chatContract,
      stage1Implemented: true,
      handlers: {
        TURN_COMMITTED: (event) => chat.onTurnCommitted(event),
        WORLD_EVENT_FIRED: (event) => chat.onWorldEventFired(event),
        PLAYER_JOINED: (event) => chat.onPlayerJoined(event),
        PLAYER_LEFT: (event) => chat.onPlayerLeft(event),
        SESSION_STATUS_CHANGED: (event) => chat.onSessionStatusChanged(event),
      },
    },
    { contract: storyContract, stage1Implemented: true },
    {
      contract: gmContract,
      stage1Implemented: true,
      handlers: {
        // F-3.8: заметки PUBLIC_AFTER_COMMIT → системные сообщения чата.
        TURN_COMMITTED: (event) => gm.onTurnCommitted(event),
      },
    },
    { contract: gmReviewContract, stage1Implemented: true },
    {
      contract: gmAuditContract,
      stage1Implemented: true,
      handlers: {
        GM_ACTION_PERFORMED: (event) => gmAudit.onEvent(event),
        GM_REVIEW_DECIDED: (event) => gmAudit.onEvent(event),
      },
    },
    { contract: aiDirectorContract, stage1Implemented: true },
    { contract: mediaDirectorContract, stage1Implemented: false },
  ];
}

/** Валидация реестра: бросает Error со списком ВСЕХ нарушений (fail-fast при старте). */
export function validateModulesRegistry(registrations: readonly ModuleRegistration[]): void {
  const problems: string[] = [];
  const seen = new Set<string>();
  const edges = new Map<ModuleId, readonly ModuleId[]>();

  for (const registration of registrations) {
    const contract = registration.contract;
    const moduleId = contract.moduleId;
    if (seen.has(moduleId)) problems.push(`${moduleId}: дублирующая регистрация`);
    seen.add(moduleId);
    if (!ModuleIdSchema.safeParse(moduleId).success) problems.push(`${moduleId}: нет в ModuleIdSchema`);

    for (const eventName of contract.emits) {
      if (!EVENT_NAMES.includes(eventName as (typeof EVENT_NAMES)[number])) {
        problems.push(`${moduleId}: emits '${eventName}' отсутствует в каталоге событий`);
      } else if (EVENT_EMITTERS[eventName as keyof typeof EVENT_EMITTERS] !== moduleId) {
        problems.push(
          `${moduleId}: emits '${eventName}', но владелец по EVENT_EMITTERS — ${EVENT_EMITTERS[eventName as keyof typeof EVENT_EMITTERS]}`,
        );
      }
    }
    for (const eventName of contract.subscribes) {
      if (!EVENT_NAMES.includes(eventName as (typeof EVENT_NAMES)[number])) {
        problems.push(`${moduleId}: subscribes '${eventName}' отсутствует в каталоге событий`);
        continue;
      }
      const subscribers = EVENT_SUBSCRIBERS[eventName as keyof typeof EVENT_SUBSCRIBERS] ?? [];
      if (!subscribers.includes(moduleId)) {
        problems.push(`${moduleId}: subscribes '${eventName}', но в EVENT_SUBSCRIBERS модуля нет`);
      }
      // Подписка без обработчика допустима (log-only); обратное проверяется ниже.
    }
    for (const handlerEvent of Object.keys(registration.handlers ?? {})) {
      if (!contract.subscribes.includes(handlerEvent)) {
        problems.push(`${moduleId}: обработчик '${handlerEvent}' без объявленной подписки`);
      }
    }
    for (const dependency of contract.dependencies) {
      if (!ModuleIdSchema.safeParse(dependency).success)
        problems.push(`${moduleId}: зависимость '${dependency}' вне ModuleIdSchema`);
      if (dependency === moduleId) problems.push(`${moduleId}: само-зависимость`);
    }
    for (const command of contract.idempotentCommands) {
      if (!(command in contract.commands))
        problems.push(`${moduleId}: idempotentCommands ссылается на неизвестную команду '${command}'`);
    }
    edges.set(moduleId, contract.dependencies);
  }

  // Циклы в dependencies — DFS по всем вершинам.
  const state = new Map<ModuleId, 'visiting' | 'done'>();
  const visit = (node: ModuleId, path: ModuleId[]): void => {
    const marker = state.get(node);
    if (marker === 'done') return;
    if (marker === 'visiting') {
      problems.push(`цикл зависимостей: ${[...path, node].join(' → ')}`);
      return;
    }
    state.set(node, 'visiting');
    for (const dependency of edges.get(node) ?? []) visit(dependency, [...path, node]);
    state.set(node, 'done');
  };
  for (const moduleId of edges.keys()) visit(moduleId, []);

  if (problems.length > 0) {
    throw new Error(`modules-registry невалиден (F-8.3):\n- ${problems.join('\n- ')}`);
  }
}

/** Boot-подписка subscribes→bus: реальный обработчик либо log-only (декларация). */
export function attachModulesRegistry(
  registrations: readonly ModuleRegistration[],
  bus: EventBus,
  logger?: RegistryLog,
): Unsubscribe[] {
  const detach: Unsubscribe[] = [];
  for (const registration of registrations) {
    for (const eventName of registration.contract.subscribes) {
      const handler = registration.handlers?.[eventName];
      const moduleId = registration.contract.moduleId;
      detach.push(
        bus.subscribe(eventName as (typeof EVENT_NAMES)[number], async (event) => {
          if (handler !== undefined) {
            await handler(event);
            return;
          }
          logger?.debug(
            { moduleId, type: event.type, traceId: event.traceId, event: 'module_subscription_stub' },
            'module_subscription_stub',
          );
        }),
      );
    }
  }
  logger?.info(
    {
      modules: registrations.map((registration) => registration.contract.moduleId),
      subscriptions: detach.length,
      event: 'modules_attached',
    },
    'modules_attached',
  );
  return detach;
}
