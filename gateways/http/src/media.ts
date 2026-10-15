import { createReadStream, existsSync, statSync } from 'node:fs';
import { resolve, sep, extname } from 'node:path';

import { AppError } from '@mnemosin/contracts';
import type { FastifyInstance } from 'fastify';

import { makeAuthHook } from './auth/middleware.js';
import type { HttpGatewayDeps } from './deps.js';

/**
 * /media/files/* — отдача media-файлов (промпт 1.10, п.6).
 *
 * Файлы появятся в этапе 2 (media-контур пишет в data/state/media); маршрут
 * объявлен сейчас c auth 'player' и защитой от path traversal: целевой путь
 * ОБЯЗАН оставаться внутри mediaDir.
 */

const MIME: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
};

export function registerMediaFilesRoute(app: FastifyInstance, deps: HttpGatewayDeps): void {
  const authHook = makeAuthHook({ jwt: deps.jwt, players: deps.players, isProduction: deps.isProduction });
  const root = resolve(deps.mediaDir);

  app.route({
    method: 'GET',
    url: '/media/files/*',
    preHandler: async (req) => {
      await authHook('player', req);
    },
    handler: (req, reply) => {
      const relative = (req.params as { '*'?: string })['*'] ?? '';
      const target = resolve(root, relative);
      if (target !== root && !target.startsWith(root + sep)) {
        throw new AppError('AUTH_FORBIDDEN', 'запрос вне каталога media', { reason: 'path_traversal' });
      }
      if (!existsSync(target) || !statSync(target).isFile()) {
        throw new AppError('NOT_FOUND', `media-файл не найден: ${relative}`, { reason: 'no_file' });
      }
      const mime = MIME[extname(target).toLowerCase()] ?? 'application/octet-stream';
      reply.header('content-type', mime);
      reply.header('cache-control', 'private, max-age=300');
      return reply.send(createReadStream(target));
    },
  });
}
