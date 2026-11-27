import { once } from 'node:events';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ParticipantId } from '@mnemosin/contracts';
import { parseWorldPack } from '@mnemosin/core';
import { registerWsGateway, type RealtimeNetworkConfig, type WsAuthenticationResult } from '@mnemosin/gateway-ws';
import { createPrototypeWsGateway } from '@mnemosin/server';
import Fastify, { type FastifyInstance } from 'fastify';
import WebSocket from 'ws';
import { afterEach, describe, expect, it } from 'vitest';

const playerOne = ParticipantId.parse('00000000-0000-4000-8000-000000000101');
const playerTwo = ParticipantId.parse('00000000-0000-4000-8000-000000000102');
const pack = parseWorldPack(readFileSync(resolve(process.cwd(), 'tests/fixtures/worldpack.v4.test.json'), 'utf8'));
const sockets: WebSocket[] = [];
const apps: FastifyInstance[] = [];

interface ServerOptions {
  readonly limits: Partial<RealtimeNetworkConfig>;
  readonly authenticate?: (token: string) => Promise<WsAuthenticationResult>;
}

async function startServer(options: ServerOptions): Promise<string> {
  const gateway = createPrototypeWsGateway({
    pack,
    players: [
      { participantId: playerOne, spawnPointId: 'player-1' },
      { participantId: playerTwo, spawnPointId: 'player-2' },
    ],
    serverVersion: 'test',
    contractsVersion: 'test',
    limits: options.limits,
    authenticate:
      options.authenticate ??
      (() =>
        new Promise<WsAuthenticationResult>(() => {
          // Намеренно pending: тесты проверяют deadline и per-IP budget до auth settle.
        })),
  });
  // Даже при ошибочном trust-all gateway обязан использовать socket peer, не request.ip.
  const app = Fastify({ logger: false, trustProxy: true });
  const handle = await registerWsGateway(app, gateway);
  app.addHook('onClose', async () => {
    handle.closeAll();
  });
  apps.push(app);
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  return `${address.replace('http:', 'ws:')}/ws`;
}

async function connect(url: string, forwardedFor?: string): Promise<WebSocket> {
  const socket = new WebSocket(url, 'mnemosin.v1.pending', {
    ...(forwardedFor === undefined ? {} : { headers: { 'x-forwarded-for': forwardedFor } }),
  });
  socket.on('error', () => undefined);
  sockets.push(socket);
  await once(socket, 'open');
  return socket;
}

async function waitForClose(socket: WebSocket): Promise<{ code: number; reasonCode: string }> {
  const [code, reason] = (await Promise.race([
    once(socket, 'close'),
    new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error('WebSocket close timeout')), 2_000).unref();
    }),
  ])) as [number, Buffer];
  return { code, reasonCode: (JSON.parse(reason.toString()) as { code: string }).code };
}

afterEach(async () => {
  for (const socket of sockets) socket.terminate();
  sockets.length = 0;
  while (apps.length > 0) await apps.pop()?.close();
});

describe('P05-A connection resource limits', () => {
  it('закрывает never-resolving authentication по configured timeout', async () => {
    const url = await startServer({ limits: { wsAuthTimeoutMs: 40 } });
    const socket = await connect(url);
    await expect(waitForClose(socket)).resolves.toEqual({ code: 4408, reasonCode: 'AUTH_TIMEOUT' });
  });

  it('лимитирует pending и active соединения по IP и освобождает слот после close', async () => {
    const url = await startServer({ limits: { wsMaxConnectionsPerIp: 2, wsAuthTimeoutMs: 1_000 } });
    const first = await connect(url);
    const second = await connect(url);
    const rejected = await connect(url);
    await expect(waitForClose(rejected)).resolves.toEqual({ code: 4429, reasonCode: 'RATE_LIMIT' });
    expect(first.readyState).toBe(WebSocket.OPEN);
    expect(second.readyState).toBe(WebSocket.OPEN);

    first.close();
    await once(first, 'close');
    const replacement = await connect(url);
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 50));
    expect(replacement.readyState).toBe(WebSocket.OPEN);
  });

  it('не позволяет обойти per-IP budget через spoofed X-Forwarded-For даже при trustProxy=true', async () => {
    const url = await startServer({ limits: { wsMaxConnectionsPerIp: 1, wsAuthTimeoutMs: 1_000 } });
    const first = await connect(url, '203.0.113.10');
    const rejected = await connect(url, '203.0.113.11');

    await expect(waitForClose(rejected)).resolves.toEqual({ code: 4429, reasonCode: 'RATE_LIMIT' });
    expect(first.readyState).toBe(WebSocket.OPEN);
  });
});
