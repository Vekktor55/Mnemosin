import { randomUUID } from 'node:crypto';

import {
  WsClientEnvelopeSchema,
  WsServerEnvelopeSchema,
  type WsClientEnvelope,
  type WsServerEnvelope,
} from '@mnemosin/contracts';
import WebSocket from 'ws';

export type ServerMessage<T extends WsServerEnvelope['type']> = Extract<WsServerEnvelope, { type: T }>;

/** Минимальный строгий WS-клиент для integration-тестов, без browser prediction. */
export class TestWsClient {
  readonly messages: WsServerEnvelope[] = [];
  private readonly waiters = new Set<() => void>();
  private protocolError: unknown = null;
  private readonly closed: Promise<number>;

  private constructor(readonly socket: WebSocket) {
    socket.on('message', (raw) => {
      try {
        this.messages.push(WsServerEnvelopeSchema.parse(JSON.parse(raw.toString())));
      } catch (error) {
        this.protocolError = error;
      }
      this.notify();
    });
    this.closed = new Promise((resolveClose) => socket.once('close', (code) => resolveClose(code)));
  }

  static async connect(url: string, token: string): Promise<TestWsClient> {
    const socket = new WebSocket(url, `mnemosin.v1.${token}`);
    const client = new TestWsClient(socket);
    await new Promise<void>((resolveOpen, rejectOpen) => {
      const timer = setTimeout(() => rejectOpen(new Error('WS open timeout')), 3_000);
      socket.once('open', () => {
        clearTimeout(timer);
        resolveOpen();
      });
      socket.once('error', (error) => {
        clearTimeout(timer);
        rejectOpen(error);
      });
    });
    return client;
  }

  get messageCount(): number {
    return this.messages.length;
  }

  send<T extends WsClientEnvelope['type']>(type: T, payload: Extract<WsClientEnvelope, { type: T }>['payload']): void {
    const message = WsClientEnvelopeSchema.parse({
      protocolVersion: 'v1',
      schemaVersion: 1,
      messageId: randomUUID(),
      type,
      payload,
    });
    this.socket.send(JSON.stringify(message));
  }

  async waitFor<T extends WsServerEnvelope['type']>(
    type: T,
    predicate: (message: ServerMessage<T>) => boolean = () => true,
    timeoutMs = 4_000,
  ): Promise<ServerMessage<T>> {
    const existing = this.messages.find(
      (message): message is ServerMessage<T> => message.type === type && predicate(message as ServerMessage<T>),
    );
    if (existing !== undefined) return existing;
    return new Promise<ServerMessage<T>>((resolveMessage, rejectMessage) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        rejectMessage(
          new Error(`WS message timeout: ${type}; received ${this.messages.map((message) => message.type).join(', ')}`),
        );
      }, timeoutMs);
      const check = (): void => {
        if (this.protocolError !== null) {
          clearTimeout(timer);
          this.waiters.delete(check);
          rejectMessage(this.protocolError);
          return;
        }
        const found = this.messages.find(
          (message): message is ServerMessage<T> => message.type === type && predicate(message as ServerMessage<T>),
        );
        if (found === undefined) return;
        clearTimeout(timer);
        this.waiters.delete(check);
        resolveMessage(found);
      };
      this.waiters.add(check);
    });
  }

  async waitForClose(): Promise<number> {
    return this.closed;
  }

  async close(): Promise<void> {
    if (this.socket.readyState === WebSocket.CLOSED) return;
    this.socket.close();
    await Promise.race([
      this.closed,
      new Promise<void>((resolveClose) =>
        setTimeout(() => {
          this.socket.terminate();
          resolveClose();
        }, 500),
      ),
    ]);
  }

  private notify(): void {
    for (const check of [...this.waiters]) check();
  }
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 4_000): Promise<void> {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) throw new Error('Condition timeout');
    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 10));
  }
}
