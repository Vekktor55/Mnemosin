import { AppError, WS_CLOSE_CODE, type PlayerId, type SessionId } from '@mnemosin/contracts';
import type { WebSocket } from '@fastify/websocket';

import type { WsGatewayDeps, WsGatewayLog } from './deps.js';

/**
 * Авторизация WS-handshake (промпт 1.11, п.1; v3 §VI.5, §VIII.2; блокер B-12).
 *
 * D123: токен передаётся через subprotocol `mnemosin.v1.<jwt>` (ОСНОВНОЙ
 * способ — не попадает в URL и, следовательно, в access-логи) ИЛИ через
 * query-параметр `?token=` (совместимость). Приоритет: subprotocol > query.
 * Токен НИКОГДА не логируется (LOG_REDACT_PLAYER_TEXT/D163 — значение не
 * попадает ни в один лог-контекст).
 *
 * D267: отсутствует токен в handshake — соединение НЕ закрывается сразу:
 * открывается окно wsAuthTimeoutMs, в течение которого клиент обязан
 * прислать AUTH{token} (тип AUTH есть в протоколе WSClientMessage именно
 * для этого сценария). Промедление → close 4408. Невалидный/истёкший токен
 * (в handshake или в AUTH) → close 4401 немедленно.
 */

export const WS_SUBPROTOCOL_PREFIX = 'mnemosin.v1.';

export interface HandshakeToken {
  readonly token: string;
  readonly source: 'subprotocol' | 'query';
}

/** D123: subprotocol приоритетнее query. Возвращает null, если токена нет. */
export function extractHandshakeToken(protocol: string | undefined, url: string): HandshakeToken | null {
  if (typeof protocol === 'string' && protocol.startsWith(WS_SUBPROTOCOL_PREFIX)) {
    const token = protocol.slice(WS_SUBPROTOCOL_PREFIX.length);
    if (token.length > 0) return { token, source: 'subprotocol' };
  }
  try {
    const query = new URL(url, 'http://mnemosin.internal').searchParams.get('token');
    if (query !== null && query.length > 0) return { token: query, source: 'query' };
  } catch {
    // Неразбираемый URL — токена нет (соединение продолжит путь AUTH-окна).
  }
  return null;
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
export async function verifyWsToken(deps: Pick<WsGatewayDeps, 'jwt' | 'players'>, token: string): Promise<WsIdentity> {
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
  readonly code:
    'AUTH_INVALID' | 'AUTH_EXPIRED' | 'AUTH_FORBIDDEN' | 'AUTH_TIMEOUT' | 'IDLE_TIMEOUT' | 'RATE_LIMIT' | 'INTERNAL';
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
