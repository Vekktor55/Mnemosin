import { AppError, type PlayerId, type SessionId } from '@mnemosin/contracts';
import type { PlayerRepository } from '@mnemosin/core/domain/ports';
import type { FastifyRequest } from 'fastify';

import type { AuthLevel } from '@mnemosin/contracts';
import type { JwtService } from './jwt.js';

/**
 * Auth-middleware (промпт 1.10, п.1): requireAuth('none'|'player'|'gm'|'internal').
 *
 * Проверки для аутентифицированных маршрутов:
 *  1. Authorization: Bearer <access-token> — иначе AUTH_INVALID (401);
 *  2. подпись/срок (JwtService) — AUTH_EXPIRED / AUTH_INVALID;
 *  3. игрок существует и sid токена совпадает с его сессией — AUTH_INVALID;
 *  4. отзыв (B-12.3): iat < players.revoked_before → AUTH_INVALID;
 *  5. статус LEFT → AUTH_INVALID;
 *  6. уровень 'gm': isGM !== true → AUTH_FORBIDDEN (403).
 * 'internal' (/metrics): в production — только loopback-адрес (D146), в dev/test открыт.
 */

export interface RequestAuth {
  readonly playerId: PlayerId;
  readonly sessionId: SessionId;
  readonly isGM: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    auth?: RequestAuth;
  }
}

export interface AuthDeps {
  readonly jwt: JwtService;
  readonly players: PlayerRepository;
  readonly isProduction: boolean;
}

function isLoopback(ip: string): boolean {
  return ip === '127.0.0.1' || ip === '::1' || ip === 'localhost' || ip.startsWith('::ffff:127.');
}

export function makeAuthHook(deps: AuthDeps) {
  return async function requireAuth(level: AuthLevel, req: FastifyRequest): Promise<void> {
    if (level === 'none') return;
    if (level === 'internal') {
      if (deps.isProduction && !isLoopback(req.ip)) {
        throw new AppError('AUTH_FORBIDDEN', 'метрики доступны только с localhost (D146)', { reason: 'internal_only' });
      }
      return;
    }

    const header = req.headers.authorization;
    if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
      throw new AppError('AUTH_INVALID', 'ожидается заголовок Authorization: Bearer <token>', { reason: 'no_bearer' });
    }
    const claims = await deps.jwt.verify(header.slice('Bearer '.length), 'access');

    const player = await deps.players.findById(claims.sub as PlayerId);
    if (player === null || player.sessionId !== claims.sid) {
      throw new AppError('AUTH_INVALID', 'токен: игрок или сессия не найдены', { reason: 'unknown_subject' });
    }
    if (player.revokedBefore !== null && claims.iat * 1000 < Date.parse(player.revokedBefore)) {
      // B-12.3: kickPlayer/leaveSession выставляют revoked_before=now.
      throw new AppError('AUTH_INVALID', 'токен отозван', { reason: 'revoked' });
    }
    if (player.status === 'LEFT') {
      throw new AppError('AUTH_INVALID', 'игрок покинул сессию', { reason: 'left' });
    }
    req.auth = { playerId: player.playerId, sessionId: player.sessionId, isGM: player.isGM };

    if (level === 'gm' && !player.isGM) {
      throw new AppError('AUTH_FORBIDDEN', 'маршрут доступен только ведущему партии', { reason: 'not_gm' });
    }
  };
}

/** Проверка, что ресурс относится к сессии токена (защита от кросс-сессий). */
export function assertSameSession(auth: RequestAuth, sessionId: SessionId): void {
  if (auth.sessionId !== sessionId) {
    throw new AppError('AUTH_FORBIDDEN', 'ресурс принадлежит другой сессии', { reason: 'session_mismatch' });
  }
}

export function requireAuthOf(req: FastifyRequest): RequestAuth {
  if (req.auth === undefined) {
    throw new AppError('AUTH_INVALID', 'маршрут требует аутентификации', { reason: 'no_auth' });
  }
  return req.auth;
}
