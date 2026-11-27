import { AppError, WS_CLOSE_CODE, type PlayerId, type SessionId, type WsErrorCode } from '@mnemosin/contracts';
import type { WebSocket } from '@fastify/websocket';

import type { WsGatewayLog } from './deps.js';
import type { PlayerRepository } from '@mnemosin/core/domain/ports';

export interface WsJwtVerifier {
  verify(
    token: string,
    expectedType: 'access',
  ): Promise<{ readonly sub: string; readonly sid: string; readonly gm: boolean; readonly iat: number }>;
}

export interface WsTokenVerificationDeps {
  readonly jwt: WsJwtVerifier;
  readonly players: PlayerRepository;
}

/**
 * Авторизация WS-handshake (промпт 1.11, п.1; v3 §VI.5, §VIII.2; блокер B-12).
 *
 * P05-A: сохраняется только существующий subprotocol `mnemosin.v1.<jwt>`.
 * Query-token не принимается: NETWORK_PROTOCOL запрещает секреты в URL.
 * Токен и полный subprotocol никогда не логируются. Невалидный/истёкший
 * токен → close 4401 немедленно; NET-01 остаётся открытым.
 */

export const WS_SUBPROTOCOL_PREFIX = 'mnemosin.v1.';

export interface HandshakeToken {
  readonly token: string;
  readonly source: 'subprotocol';
}

/** Только существующий subprotocol; URL/query никогда не читаются как credentials. */
export function extractHandshakeToken(protocol: string | undefined): HandshakeToken | null {
  if (typeof protocol !== 'string' || !protocol.startsWith(WS_SUBPROTOCOL_PREFIX)) return null;
  const token = protocol.slice(WS_SUBPROTOCOL_PREFIX.length);
  return token.length > 0 ? { token, source: 'subprotocol' } : null;
}

export interface WsIdentity {
  readonly playerId: PlayerId;
  readonly sessionId: SessionId;
  readonly isGM: boolean;
}

/**
 * Проверка access-токена и игрока — те же правила, что HTTP auth-hook
 * (промпт 1.10): подпись/срок, существование, совпадение сессии, отзыв
 * (B-12.3: iat < revokedBefore), статус LEFT.
 */
export async function verifyWsToken(deps: WsTokenVerificationDeps, token: string): Promise<WsIdentity> {
  const claims = await deps.jwt.verify(token, 'access'); // AUTH_EXPIRED / AUTH_INVALID
  const player = await deps.players.findById(claims.sub as PlayerId);
  if (player === null || player.sessionId !== claims.sid) {
    throw new AppError('AUTH_INVALID', 'токен: игрок или сессия не найдены', { reason: 'unknown_subject' });
  }
  if (player.revokedBefore !== null && claims.iat * 1000 < Date.parse(player.revokedBefore)) {
    throw new AppError('AUTH_INVALID', 'токен отозван', { reason: 'revoked' });
  }
  if (player.status === 'LEFT') {
    throw new AppError('AUTH_INVALID', 'игрок покинул сессию', { reason: 'left' });
  }
  return { playerId: player.playerId, sessionId: player.sessionId, isGM: player.isGM };
}

/** Payload close-кадра (≤123 байт по RFC 6455 — reason string). */
export interface WsClosePayload {
  readonly code: WsErrorCode | 'AUTH_TIMEOUT' | 'IDLE_TIMEOUT' | 'RATE_LIMIT' | 'INTERNAL';
  readonly message?: string;
}

export function closeWithCode(
  socket: WebSocket,
  closeCode: number,
  payload: WsClosePayload,
  logger?: WsGatewayLog,
): void {
  let reason: string;
  try {
    reason = JSON.stringify(payload).slice(0, 123);
  } catch {
    reason = `{"code":"${payload.code}"}`.slice(0, 123);
  }
  logger?.debug({ closeCode, reasonCode: payload.code, event: 'ws_close' }, 'ws_close');
  try {
    socket.close(closeCode, reason);
  } catch {
    // Соединение уже закрывается — игнорируем (close идемпотентен на уровне ws).
    try {
      socket.terminate();
    } catch {
      /* уже мёртво */
    }
  }
}

/** AppError → close-код/payload для авторизационных отказов. */
export function authClosePayloadOf(cause: unknown): { closeCode: number; payload: WsClosePayload } {
  if (cause instanceof AppError && cause.code === 'AUTH_EXPIRED') {
    return {
      closeCode: WS_CLOSE_CODE.AUTH_INVALID,
      payload: { code: 'AUTH_EXPIRED', message: 'срок действия токена истёк' },
    };
  }
  return { closeCode: WS_CLOSE_CODE.AUTH_INVALID, payload: { code: 'AUTH_INVALID', message: 'токен недействителен' } };
}
