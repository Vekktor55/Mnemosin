/**
 * E2E server (Playwright webServer): поднимает реальный Fastify + prototype WS
 * gateway на P03-фикстуре с fake-auth (token === 'player-one'|'player-two') и
 * раздаёт собранный `client/dist` same-origin. Без HTTP-login: браузер получает
 * identity через sessionStorage (see e2e/realtime.spec.ts).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

import { CONTRACTS_VERSION, MatchId, ParticipantId, SessionId } from '@mnemosin/contracts';
import { loadConfig } from '@mnemosin/config';
import { parseWorldPack } from '@mnemosin/core';
import { createLogger } from '@mnemosin/logging';
import { buildApp, createPrototypeWsGateway } from '@mnemosin/server';

// Корень монорепо (e2e/server.ts → ..), независимо от cwd Playwright webServer.
const repoRoot = fileURLToPath(new URL('..', import.meta.url));

const playerOne = ParticipantId.parse('00000000-0000-4000-8000-000000000101');
const playerTwo = ParticipantId.parse('00000000-0000-4000-8000-000000000102');
const matchId = MatchId.parse('00000000-0000-4000-8000-000000000103');
const sessionId = SessionId.parse(matchId);

const pack = parseWorldPack(readFileSync(resolve(repoRoot, 'tests/fixtures/worldpack.v4.test.json'), 'utf8'));
const port = Number(process.env['E2E_PORT'] ?? 4173);

const config = loadConfig({
  cwd: repoRoot,
  ignoreDotenv: true,
  version: '0.0.0-e2e',
  env: {
    NODE_ENV: 'test',
    DATABASE_URL: 'file:./data/e2e-not-opened.sqlite',
    JWT_SECRET: 'e2e-secret-0123456789abcdef0123456789abcdef',
    LOG_LEVEL: 'silent',
  },
});

const gateway = createPrototypeWsGateway({
  pack,
  players: [
    { participantId: playerOne, spawnPointId: 'player-1' },
    { participantId: playerTwo, spawnPointId: 'player-2' },
  ],
  serverVersion: config.version,
  contractsVersion: CONTRACTS_VERSION,
  async authenticate(token) {
    const actorId = token === 'player-one' ? playerOne : token === 'player-two' ? playerTwo : null;
    if (actorId === null) return { ok: false, code: 'AUTH_INVALID' };
    return {
      ok: true,
      actor: {
        actorId,
        actorType: 'player',
        matchId,
        sessionId,
        projectionKind: 'player',
        permissions: ['scene:input', 'scene:resync'],
      },
    };
  },
});

const app = await buildApp({
  config,
  logger: createLogger({ config, name: 'mnemosin-e2e' }),
  cwd: repoRoot,
  wsGateway: gateway,
});

await app.listen({ host: '127.0.0.1', port });

process.stdout.write(`E2E server listening on http://127.0.0.1:${port}\n`);

async function shutdown(): Promise<void> {
  await app.close();
  process.exit(0);
}
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
