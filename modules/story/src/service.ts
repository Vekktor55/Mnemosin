import { createHash } from 'node:crypto';

import { CoreError, type SessionId } from '@mnemosin/contracts';
import { newTraceId, runCommand, type CommandRunner, type StateService, type UnitOfWork } from '@mnemosin/core';

import {
  GrantKnowledgeInputSchema,
  GrantKnowledgeOutputSchema,
  ListKnownFactsInputSchema,
  ListKnownFactsOutputSchema,
  SetFlagInputSchema,
  SetFlagOutputSchema,
  type GrantKnowledgeInput,
  type GrantKnowledgeOutput,
  type ListKnownFactsInput,
  type ListKnownFactsOutput,
  type SetFlagInput,
  type SetFlagOutput,
} from './contract.js';

/**
 * StoryService (v3 §IV.10; промпт 1.9, п.3).
 *
 * D120 (F-8.4): запись состояния — ТОЛЬКО core/state-service.apply (version+1,
 * history, journal 'state_applied' при turnId, outbox STATE_COMMITTED — одной
 * транзакцией). Напрямую в StateRepository модуль не пишет.
 *
 * Идемпотентность — детерминированные серверные ключи (образец D217):
 *   setFlag        → `flag:{sha1(sessionId:key:value)}`
 *   grantKnowledge → `grant:{sha1(sessionId:playerId:key:value:source)}`
 * Повтор идентичной операции → replay прежнего результата, version НЕ растёт;
 * новое значение — новый ключ, version+1 ровно на 1 (тест промта 1.9 п.9).
 */

export interface StoryServiceDeps {
  readonly uow: UnitOfWork;
  readonly guard: CommandRunner;
  readonly state: StateService;
}

function sha1(text: string): string {
  return createHash('sha1').update(text).digest('hex');
}

export class StoryService {
  constructor(private readonly deps: StoryServiceDeps) {}

  async setFlag(rawInput: SetFlagInput): Promise<SetFlagOutput> {
    const input = SetFlagInputSchema.parse(rawInput);
    const traceId = input.traceId ?? newTraceId();
    const turnId = input.turnId ?? null;
    const key = `flag:${sha1(`${input.sessionId}:${input.key}:${JSON.stringify(input.value)}`)}`;

    const result = await runCommand(
      this.deps.guard,
      { key, command: 'setFlag', sessionId: input.sessionId, turnId, traceId },
      async (scope) => {
        const current = await scope.repos.state.findBySession(input.sessionId);
        if (current === null) {
          throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${input.sessionId} не найдено`, {
            entity: 'game_state',
          });
        }
        const applied = await this.deps.state.apply({
          sessionId: input.sessionId,
          mutations: [{ kind: 'SET_FLAG', key: input.key, value: input.value, setBy: input.setBy }],
          expectedVersion: current.version,
          turnId,
          traceId,
          scope,
        });
        return { sessionId: input.sessionId, version: applied.version, changedKeys: [...applied.changedKeys] };
      },
    );
    return SetFlagOutputSchema.parse({ ...result.value, replayed: result.replayed });
  }

  async grantKnowledge(rawInput: GrantKnowledgeInput): Promise<GrantKnowledgeOutput> {
    const input = GrantKnowledgeInputSchema.parse(rawInput);
    const traceId = input.traceId ?? newTraceId();
    const turnId = input.turnId ?? null;
    const key = `grant:${sha1(`${input.sessionId}:${input.playerId}:${input.key}:${JSON.stringify(input.value)}:${input.source}`)}`;

    const result = await runCommand(
      this.deps.guard,
      { key, command: 'grantKnowledge', sessionId: input.sessionId, turnId, traceId },
      async (scope) => {
        const player = await scope.repos.players.findById(input.playerId);
        if (player === null || player.sessionId !== input.sessionId) {
          throw new CoreError('CORE_NOT_FOUND', `игрок ${input.playerId} не принадлежит сессии ${input.sessionId}`, {
            entity: 'player',
          });
        }
        const current = await scope.repos.state.findBySession(input.sessionId);
        if (current === null) {
          throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${input.sessionId} не найдено`, {
            entity: 'game_state',
          });
        }
        const applied = await this.deps.state.apply({
          sessionId: input.sessionId,
          mutations: [
            {
              kind: 'GRANT_KNOWLEDGE',
              playerId: input.playerId,
              key: input.key,
              value: input.value,
              source: input.source,
            },
          ],
          expectedVersion: current.version,
          turnId,
          traceId,
          scope,
        });
        return { sessionId: input.sessionId as SessionId, version: applied.version };
      },
    );
    return GrantKnowledgeOutputSchema.parse({ ...result.value, replayed: result.replayed });
  }

  async listKnownFacts(rawInput: ListKnownFactsInput): Promise<ListKnownFactsOutput> {
    const input = ListKnownFactsInputSchema.parse(rawInput);
    const state = await this.deps.uow.repos().state.findBySession(input.sessionId);
    if (state === null) {
      throw new CoreError('CORE_NOT_FOUND', `состояние сессии ${input.sessionId} не найдено`, { entity: 'game_state' });
    }
    const facts = Object.values(state.playerKnowledge)
      .filter((knowledge) => knowledge !== undefined)
      .filter((knowledge) => input.playerId === undefined || knowledge.playerId === input.playerId)
      .flatMap((knowledge) =>
        knowledge.entries.map((entry) => ({
          playerId: knowledge.playerId,
          key: entry.key,
          value: entry.value,
          source: entry.source,
          learnedAtTurnId: entry.learnedAtTurnId,
        })),
      );
    return ListKnownFactsOutputSchema.parse(facts);
  }
}
