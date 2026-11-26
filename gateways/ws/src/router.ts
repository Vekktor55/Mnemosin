import type { WsClientEnvelope, WsErrorCode } from '@mnemosin/contracts';

import type { WsConnectionRecord } from './connection-registry.js';
import type { WsHotRuntimePort } from './deps.js';
import type { SceneReplicationService } from './replication.js';

export interface WsRouterContext {
  readonly runtime: WsHotRuntimePort;
  readonly replication: SceneReplicationService;
  readonly now: () => number;
  readonly inputRatePerSecond: number;
  sendError(record: WsConnectionRecord, code: WsErrorCode, messageKey: string, retryable: boolean): void;
}

/** P05-A lifecycle + P06 async COLD-backed keyframe. Turn/GM/Chat handlers удалены. */
export async function routeWsMessage(
  record: WsConnectionRecord,
  message: WsClientEnvelope,
  context: WsRouterContext,
): Promise<void> {
  switch (message.type) {
    case 'connection:ping':
      context.replication.sendReliable(
        record,
        context.replication.envelope('connection:pong', {
          pingId: message.payload.pingId,
          serverTimeMs: Math.max(0, Math.trunc(context.now())),
          simulationTick: context.runtime.getState().simulationTick,
        }),
      );
      return;
    case 'connection:client-ready':
      if (record.state !== 'awaiting_client_ready') {
        context.sendError(record, 'PROTOCOL_INVALID_MESSAGE', 'connection.unexpected_client_ready', false);
        return;
      }
      record.state = 'syncing';
      if (await context.replication.sendKeyframe(record)) record.state = 'ready';
      if (record.state === 'ready') {
        context.replication.sendReliable(record, context.replication.envelope('connection:ready', {}));
      }
      return;
    case 'scene:input': {
      if (record.state !== 'ready') {
        context.sendError(record, 'CONNECTION_NOT_READY', 'connection.not_ready', false);
        return;
      }
      if (record.context.actorType !== 'player' || !record.context.permissions.includes('scene:input')) {
        context.sendError(record, 'INPUT_NOT_CONTROLLING_ACTOR', 'input.not_controller', false);
        return;
      }
      const now = context.now();
      if (now - record.rateWindowStartedAt >= 1_000) {
        record.rateWindowStartedAt = now;
        record.inputCount = 0;
      }
      record.inputCount += 1;
      if (record.inputCount > context.inputRatePerSecond) {
        context.sendError(record, 'RATE_LIMITED', 'input.rate_limited', true);
        return;
      }
      const receipt = context.runtime.receiveInput(record.context.actorId, message.payload);
      if (receipt.accepted) return;
      const errors: Record<typeof receipt.reason, { code: WsErrorCode; key: string; retryable: boolean }> = {
        invalid_message: { code: 'INPUT_INVALID', key: 'input.invalid', retryable: false },
        unknown_player: { code: 'INPUT_NOT_CONTROLLING_ACTOR', key: 'input.unknown_player', retryable: false },
        inactive_stream: { code: 'INPUT_INACTIVE_STREAM', key: 'input.inactive_stream', retryable: false },
        stale_sequence: { code: 'INPUT_STALE', key: 'input.stale_sequence', retryable: false },
      };
      const error = errors[receipt.reason];
      context.sendError(record, error.code, error.key, error.retryable);
      return;
    }
    case 'scene:resync':
      if (record.state !== 'ready') {
        context.sendError(record, 'CONNECTION_NOT_READY', 'connection.not_ready', false);
        return;
      }
      await context.replication.requestResync(record);
      return;
  }
}
