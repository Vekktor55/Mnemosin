import type { FastifyInstance } from 'fastify';
import type { PlayerId, SessionId } from '@mnemosin/contracts';

/**
 * DEV-ONLY быстрый вход (локальное тестирование рендера).
 *
 * Маршрут `GET /dev/quick-join` существует ТОЛЬКО при `!isProduction`:
 * в production маршрут вообще не регистрируется → Fastify отдаёт 404.
 * Механизм авторизации не меняется: выпускаются обычные access-токены
 * существующим `JwtService` с теми же claims (`sub`, `sid`, `gm`, `typ`),
 * которые проверяет `verifyWsToken` → WS handshake `mnemosin.v1.<jwt>`.
 */

/** Структурный порт `JwtService.issueAccess` (существующий gateway-http сервис). */
export interface DevAccessTokenIssuer {
  issueAccess(identity: {
    readonly playerId: PlayerId;
    readonly sessionId: SessionId;
    readonly isGM: boolean;
  }): Promise<string>;
}

export interface DevQuickJoinPlayer {
  readonly playerId: PlayerId;
  readonly displayName: string;
  readonly characterName: string | null;
}

/** Контекст seeded-сессии; `null` — seed недоступен (ответ 503). */
export interface DevQuickJoinContext {
  readonly sessionId: SessionId;
  readonly players: readonly DevQuickJoinPlayer[];
  readonly jwt: DevAccessTokenIssuer;
}

export interface DevQuickJoinOptions {
  readonly isProduction: boolean;
  readonly context: DevQuickJoinContext | null;
}

export interface DevQuickJoinPlayerPayload {
  readonly label: string;
  readonly playerId: string;
  readonly displayName: string;
  readonly characterName: string;
  readonly token: string;
}

export interface DevQuickJoinResponse {
  readonly sessionId: string;
  readonly players: readonly DevQuickJoinPlayerPayload[];
}

/**
 * Зарегистрировать dev-маршрут. Возвращает `true`, если маршрут зарегистрирован.
 *
 * - production → `false`, маршрута нет (404);
 * - dev + seed → 200 с двумя игроками и их access-токенами;
 * - dev без seed → 503 `{ error: 'dev_seed_unavailable' }`.
 */
export function registerDevQuickJoinRoute(app: FastifyInstance, options: DevQuickJoinOptions): boolean {
  if (options.isProduction) return false;

  app.get('/dev/quick-join', async (_request, reply) => {
    const context = options.context;
    if (context === null || context.players.length !== 2) {
      return reply.status(503).send({ error: 'dev_seed_unavailable' });
    }

    const players: DevQuickJoinPlayerPayload[] = [];
    for (const [index, player] of context.players.entries()) {
      const label = `Player ${index + 1}`;
      const token = await context.jwt.issueAccess({
        playerId: player.playerId,
        sessionId: context.sessionId,
        isGM: false,
      });
      players.push({
        label,
        playerId: player.playerId,
        displayName: player.displayName,
        characterName: player.characterName ?? player.displayName ?? label,
        token,
      });
    }

    const body: DevQuickJoinResponse = { sessionId: context.sessionId, players };
    return reply.send(body);
  });

  return true;
}
