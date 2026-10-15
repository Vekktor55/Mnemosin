import { randomUUID } from 'node:crypto';

import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { AppError, type PlayerId, type SessionId } from '@mnemosin/contracts';

/**
 * JWT HS256 (v3 §VI.1, §VIII.8; промпт 1.10, п.1; блокер B-12).
 *
 * Claims: {sub: playerId, sid: sessionId, gm: boolean, typ: 'access'|'refresh',
 * exp, iat, jti}. TTL access = JWT_TTL_SECONDS (12ч), refresh = 30 дней.
 * Отзыв (B-12.3): players.revoked_before — токен недействителен, если
 * iat < revokedBefore (проверяет auth-hook по PlayerRepository).
 *
 * jose (D252): готовая аудированная библиотека вместо ручной реализации
 * HMAC-подписи; добавлена в разрешённые внешние зависимости gateways.
 */

export type TokenType = 'access' | 'refresh';

export interface TokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly gm: boolean;
  readonly typ: TokenType;
  readonly jti: string;
  readonly iat: number;
  readonly exp: number;
}

export interface JwtConfig {
  readonly secret: string;
  readonly accessTtlSeconds: number;
  readonly refreshTtlSeconds: number;
}

export interface IssuedTokens {
  readonly token: string;
  readonly refreshToken: string;
}

export class JwtService {
  private readonly key: Uint8Array;
  private readonly accessTtlSeconds: number;
  private readonly refreshTtlSeconds: number;

  constructor(config: JwtConfig) {
    if (config.secret.length < 32) {
      throw new AppError('INTERNAL', 'JWT_SECRET короче 32 символов', { reason: 'weak_secret' });
    }
    this.key = new TextEncoder().encode(config.secret);
    this.accessTtlSeconds = config.accessTtlSeconds;
    this.refreshTtlSeconds = config.refreshTtlSeconds;
  }

  async issue(identity: { playerId: PlayerId; sessionId: SessionId; isGM: boolean }): Promise<IssuedTokens> {
    const token = await this.sign(identity, 'access', this.accessTtlSeconds);
    const refreshToken = await this.sign(identity, 'refresh', this.refreshTtlSeconds);
    return { token, refreshToken };
  }

  /** Новый access-токен (использует /auth/refresh). */
  async issueAccess(identity: { playerId: PlayerId; sessionId: SessionId; isGM: boolean }): Promise<string> {
    return this.sign(identity, 'access', this.accessTtlSeconds);
  }

  /** Подпись access-токена с явным TTL (тесты выпускают истёкший токен ttl<0). */
  async signAccessToken(
    identity: { playerId: PlayerId; sessionId: SessionId; isGM: boolean },
    ttlSeconds: number,
  ): Promise<string> {
    return this.sign(identity, 'access', ttlSeconds);
  }

  private async sign(
    identity: { playerId: PlayerId; sessionId: SessionId; isGM: boolean },
    typ: TokenType,
    ttlSeconds: number,
  ): Promise<string> {
    const iat = Math.floor(Date.now() / 1000);
    return new SignJWT({ gm: identity.isGM, typ, sid: identity.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(identity.playerId)
      .setJti(randomUUID())
      .setIssuedAt(iat)
      .setExpirationTime(iat + ttlSeconds)
      .sign(this.key);
  }

  /** Проверка подписи и сроков. Истёк → AUTH_EXPIRED; прочее → AUTH_INVALID. */
  async verify(token: string, expectedType: TokenType): Promise<TokenClaims> {
    let payload: Record<string, unknown>;
    try {
      const result = await jwtVerify(token, this.key, { algorithms: ['HS256'] });
      payload = result.payload as Record<string, unknown>;
    } catch (cause) {
      if (cause instanceof joseErrors.JWTExpired) {
        throw new AppError('AUTH_EXPIRED', 'срок действия токена истёк — обновите через /auth/refresh', {
          reason: 'expired',
        });
      }
      throw new AppError('AUTH_INVALID', 'токен недействителен', { reason: 'verify_failed' });
    }
    const claims: TokenClaims = {
      sub: String(payload['sub'] ?? ''),
      sid: String(payload['sid'] ?? ''),
      gm: payload['gm'] === true,
      typ: payload['typ'] === 'refresh' ? 'refresh' : 'access',
      jti: String(payload['jti'] ?? ''),
      iat: Number(payload['iat'] ?? 0),
      exp: Number(payload['exp'] ?? 0),
    };
    if (claims.sub.length === 0 || claims.sid.length === 0 || claims.typ !== expectedType) {
      throw new AppError('AUTH_INVALID', `ожидается токен типа ${expectedType}`, { reason: 'wrong_type' });
    }
    return claims;
  }
}
