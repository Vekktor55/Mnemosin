import type { CommandRunner, UnitOfWork } from './domain/ports/index.js';
import { JournalService } from './turns/journal.js';
import { TurnService } from './turns/turn-service.js';
import { StateService } from './state/state-service.js';
import { LocationService, type WorldPackData } from './locations/location-service.js';
import { SessionService } from './session/session-service.js';

/**
 * Сборка доменных сервисов core (промпт 1.6).
 *
 * Одна точка wiring'а для apps/server, проб (tools/verify) и интеграционных
 * тестов: зависимости (UnitOfWork, CommandRunner=IdempotencyService, pack,
 * лимиты) инжектируются снаружи — core не создаёт инфраструктуру сам
 * (инварианты 1–3, D216/D221).
 *
 * Граф зависимостей сервисов (ациклический):
 *   JournalService ← StateService ← LocationService ← SessionService → TurnService
 */

export interface CoreLimits {
  /** Лимит участников партии (limits.yaml: maxPlayersPerSession, ≤12 по SessionSchema). */
  readonly maxPlayersPerSession: number;
  /** Лимит действий одного игрока за ход (limits.yaml: actionsPerPlayerPerTurn). */
  readonly actionsPerPlayerPerTurn: number;
}

export interface CreateCoreServicesOptions {
  readonly uow: UnitOfWork;
  /** «withIdempotency» из 1.4: порт CommandRunner, реализация — IdempotencyService (D216). */
  readonly guard: CommandRunner;
  /** Данные world-pack (этап 1: фикстуры locations.stage1.json, D204/D221). */
  readonly pack: WorldPackData;
  readonly limits: CoreLimits;
}

export interface CoreServices {
  readonly journal: JournalService;
  readonly state: StateService;
  readonly turns: TurnService;
  readonly locations: LocationService;
  readonly sessions: SessionService;
}

export function createCoreServices(options: CreateCoreServicesOptions): CoreServices {
  const journal = new JournalService(options.uow);
  const state = new StateService({ uow: options.uow, journal });
  const turns = new TurnService({
    uow: options.uow,
    guard: options.guard,
    journal,
    limits: { actionsPerPlayerPerTurn: options.limits.actionsPerPlayerPerTurn },
  });
  const locations = new LocationService({
    uow: options.uow,
    guard: options.guard,
    state,
    pack: options.pack,
  });
  const sessions = new SessionService({
    uow: options.uow,
    guard: options.guard,
    turns,
    locations,
    pack: options.pack,
    limits: { maxPlayersPerSession: options.limits.maxPlayersPerSession },
  });
  return { journal, state, turns, locations, sessions };
}
