import { AppError, CoreError, type PlayerId, type SessionId } from '@mnemosin/contracts';
import type { UnitOfWork } from '@mnemosin/core';

/**
 * Доступ к командам GM (защита в глубине, B-12): транспорт авторизует токен
 * (1.10/1.11), сервис проверяет, что gmPlayerId — участник ЭТОЙ сессии и isGM.
 */
export async function assertGmPlayer(uow: UnitOfWork, sessionId: SessionId, gmPlayerId: PlayerId): Promise<void> {
  const player = await uow.repos().players.findById(gmPlayerId);
  if (player === null || player.sessionId !== sessionId) {
    throw new CoreError('CORE_NOT_FOUND', `игрок ${gmPlayerId} не принадлежит сессии ${sessionId}`, {
      entity: 'player',
    });
  }
  if (!player.isGM) {
    throw new AppError('AUTH_FORBIDDEN', 'команда доступна только ведущему партии', { reason: 'not_gm' });
  }
}
