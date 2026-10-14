import { PlayerActionSchema, TurnSchema, type PlayerAction, type Turn } from '@mnemosin/contracts';

import type { actions, turns } from '../schema.js';
import { asJson, assertMatches, parseBody } from './index.js';

type TurnRow = typeof turns.$inferSelect;
type ActionRow = typeof actions.$inferSelect;

export function turnFromRow(row: TurnRow): Turn {
  const body = parseBody(TurnSchema, row.bodyJson, 'turns');
  assertMatches('turn_id', row.turnId, body.turnId, 'turns');
  assertMatches('status', row.status, body.status, 'turns');
  assertMatches('number', row.number, body.number, 'turns');
  return body;
}

export function turnToRow(turn: Turn): TurnRow {
  return {
    turnId: turn.turnId,
    sessionId: turn.sessionId,
    number: turn.number,
    status: turn.status,
    lockedAt: turn.lockedAt,
    processingStartedAt: turn.processingStartedAt,
    reviewReadyAt: turn.reviewReadyAt,
    committedAt: turn.committedAt,
    createdAt: turn.createdAt,
    updatedAt: turn.updatedAt,
    bodyJson: asJson(turn as unknown, 'turns.insert'),
  };
}

export function actionFromRow(row: ActionRow): PlayerAction {
  const body = parseBody(PlayerActionSchema, row.bodyJson, 'actions');
  assertMatches('action_id', row.actionId, body.actionId, 'actions');
  assertMatches('idempotency_key', row.idempotencyKey, body.idempotencyKey, 'actions');
  return body;
}

export function actionToRow(action: PlayerAction): ActionRow {
  return {
    actionId: action.actionId,
    turnId: action.turnId,
    playerId: action.playerId,
    sequenceId: action.sequenceId,
    intent: action.meta.intent,
    idempotencyKey: action.idempotencyKey,
    createdAt: action.createdAt,
    bodyJson: asJson(action as unknown, 'actions.insert'),
  };
}
