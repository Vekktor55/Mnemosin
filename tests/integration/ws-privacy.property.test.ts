import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { resolve as resolvePath } from 'node:path';

import { describe, expect, it } from 'vitest';
import fc from 'fast-check';

import { WS_PRIVACY_POLICY, WSServerMessageSchema, type WSServerType } from '@mnemosin/contracts';
import { findForbiddenKey } from '@mnemosin/gateway-ws';

import { bootWsWorld, waitForTurnStatusWs, type TestWsClient } from './ws-helpers.js';

/**
 * Property-based тест приватности WS-broadcast (промпт 1.11, п.8; критерий A1.7).
 *
 * Генерируется случайная партия: 2–4 игрока, случайные личные сообщения,
 * GM-заметки всех visibility, knowledge на каждого игрока, флаги; прогоняется
 * полный цикл хода (действия → lock → auto-resolve → commit). Все исходящие
 * envelope перехватываются клиентами-снифферами и проверяются инварианты:
 *
 *  P1. каждое сообщение валидно по WSServerMessageSchema (инвариант 16, A1.3);
 *  P2. BROADCAST-payload не содержит ключей FORBIDDEN_IN_BROADCAST
 *      (privateMessages/gmNotes/knowledge/diagnostics/... — B-10);
 *  P3. GM_ONLY-сообщения не приходят игрокам (A1.8);
 *  P4. TARGETED-получатель совпадает с адресатом (STATE_PROJECTION_PRIVATE,
 *      CHAT_PRIVATE, TURN_PRIVATE_RESOLUTION);
 *  P5. SENDER_ONLY приходит только инициатору (requestId ∈ отправленные им);
 *  P6. маркеры личных чатов видны ТОЛЬКО адресату;
 *  P7. GM-заметки GM_ONLY/AI_DIRECTOR не видны игрокам; PUBLIC_AFTER_COMMIT —
 *      видны всем после commit;
 *  P8. knowledge игрока — только в ЕГО STATE_PROJECTION_PRIVATE (значения
 *      совпадают с выданными).
 */

const ROOT = process.cwd();
const FIXTURE = JSON.parse(readFileSync(resolvePath(ROOT, 'tools/fixtures/resolution.ok.json'), 'utf8')) as {
  privateMessages: Array<{ text: string }>;
};

const idem = (): string => `idem-${randomUUID()}`;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const scenarioArb = fc.record({
  playerCount: fc.integer({ min: 2, max: 4 }),
  privateCount: fc.integer({ min: 1, max: 4 }),
  noteVisibilities: fc.array(
    fc.constantFrom('GM_ONLY' as const, 'AI_DIRECTOR' as const, 'PUBLIC_AFTER_COMMIT' as const),
    {
      minLength: 1,
      maxLength: 3,
    },
  ),
  knowledgeCount: fc.integer({ min: 1, max: 4 }),
  flagCount: fc.integer({ min: 0, max: 2 }),
});

type Scenario = {
  playerCount: number;
  privateCount: number;
  noteVisibilities: Array<'GM_ONLY' | 'AI_DIRECTOR' | 'PUBLIC_AFTER_COMMIT'>;
  knowledgeCount: number;
  flagCount: number;
};

interface Sniffer {
  readonly client: TestWsClient;
  readonly playerId: string;
  readonly isGM: boolean;
  /** Индекс в списке игроков; у GM = -1. */
  readonly index: number;
}

async function runScenario(runId: number, scenario: Scenario): Promise<void> {
  const world = await bootWsWorld(`prop${runId}`);
  const sniffers: Sniffer[] = [];
  try {
    const n = scenario.playerCount;
    const session = await world.seedSession(n);

    const gmClient = await world.connect(session.gm.token, { label: `run${runId}-gm` });
    await gmClient.waitFor('AUTH_OK', 8000);
    sniffers.push({ client: gmClient, playerId: session.gm.playerId, isGM: true, index: -1 });

    const playerClients: TestWsClient[] = [];
    for (let i = 0; i < n; i += 1) {
      const client = await world.connect(session.players[i]!.token, { label: `run${runId}-p${i}` });
      await client.waitFor('AUTH_OK', 8000);
      playerClients.push(client);
      sniffers.push({ client, playerId: session.players[i]!.playerId, isGM: false, index: i });
    }

    // --- knowledge на каждого игрока (маркеры значений) ----------------------
    const knowledgeByIndex = new Map<number, Map<string, string | number | boolean>>();
    for (let k = 0; k < scenario.knowledgeCount; k += 1) {
      const index = k % n;
      const key = `prop_secret_${k}`;
      const value = `KNOW-${runId}-${k}-only-${index}`;
      const granted = knowledgeByIndex.get(index) ?? new Map<string, string | number | boolean>();
      granted.set(key, value);
      knowledgeByIndex.set(index, granted);
      await world.story.grantKnowledge({
        sessionId: session.sessionId as never,
        playerId: session.players[index]!.playerId as never,
        key,
        value,
        source: 'GM',
      });
    }

    // --- флаги (D124: значения публичны — маркеры НЕ приватные) --------------
    for (let f = 0; f < scenario.flagCount; f += 1) {
      await world.story.setFlag({
        sessionId: session.sessionId as never,
        key: `prop_flag_${f}` as never,
        value: f,
        setBy: 'GM',
      });
    }

    // --- личные сообщения между игроками (маркеры) ---------------------------
    const privateMarkers: Array<{ from: number; to: number; text: string }> = [];
    for (let k = 0; k < scenario.privateCount; k += 1) {
      const from = k % n;
      const to = (k + 1) % n;
      const text = `PRIV-${runId}-${k}-${from}to${to}`;
      const requestId = `req-${randomUUID()}`;
      playerClients[from]!.send(
        'CHAT_PRIVATE',
        { toPlayerId: session.players[to]!.playerId, text, requestId },
        { requestId, sessionId: session.sessionId },
      );
      await playerClients[from]!.waitForRequestId('CHAT_ACK', requestId, 8000);
      privateMarkers.push({ from, to, text });
    }

    // --- публичное сообщение --------------------------------------------------
    const pubText = `PUB-${runId}-marker`;
    const pubReq = `req-${randomUUID()}`;
    playerClients[0]!.send('CHAT_PUBLIC', { text: pubText, requestId: pubReq }, { requestId: pubReq });
    await playerClients[0]!.waitForRequestId('CHAT_ACK', pubReq, 8000);

    // --- GM-заметки всех visibility -------------------------------------------
    const noteMarkers: Array<{ visibility: string; text: string }> = [];
    for (let k = 0; k < scenario.noteVisibilities.length; k += 1) {
      const visibility = scenario.noteVisibilities[k]!;
      const text = `NOTE-${runId}-${k}`;
      const requestId = `req-${randomUUID()}`;
      gmClient.send('GM_ADD_NOTE', { sessionId: session.sessionId, visibility, text, requestId }, { requestId });
      await gmClient.waitForRequestId('GM_NOTE_ACK', requestId, 8000);
      noteMarkers.push({ visibility, text });
    }

    // --- действия каждого игрока ----------------------------------------------
    for (let i = 0; i < n; i += 1) {
      const requestId = `req-${randomUUID()}`;
      playerClients[i]!.send(
        'ACTION_SUBMIT',
        { turnId: session.turnId, rawText: `Действие ${runId}-${i}`, idempotencyKey: idem(), requestId },
        { requestId },
      );
      await playerClients[i]!.waitForRequestId('ACTION_ACK', requestId, 8000);
    }

    // --- цикл хода: lock → auto-resolve → commit -------------------------------
    const lockReq = `req-${randomUUID()}`;
    gmClient.send(
      'GM_LOCK_TURN',
      { turnId: session.turnId, idempotencyKey: idem(), requestId: lockReq },
      { requestId: lockReq },
    );
    await gmClient.waitForRequestId('GM_ACTION_ACK', lockReq, 8000);
    await waitForTurnStatusWs(world, session.turnId, ['REVIEW'], 20_000);

    // Ожидаемые приватные тексты хода: ScriptedAI маппит privateMessages
    // фикстуры на characterNames из контекста round-robin (индекс % imena).
    const context = await world.gm.inspectAIContext({ turnId: session.turnId as never });
    const names = context.characterNames;
    const expectedPrivateByPlayer = new Map<string, string[]>();
    FIXTURE.privateMessages.forEach((message, index) => {
      const target = names[index % names.length];
      if (target === undefined) return;
      const list = expectedPrivateByPlayer.get(target.playerId) ?? [];
      list.push(message.text);
      expectedPrivateByPlayer.set(target.playerId, list);
    });

    const commitReq = `req-${randomUUID()}`;
    gmClient.send(
      'GM_COMMIT_TURN',
      { turnId: session.turnId, idempotencyKey: idem(), requestId: commitReq },
      { requestId: commitReq },
    );
    await gmClient.waitForRequestId('GM_ACTION_ACK', commitReq, 8000);

    // Двойной drain: TURN_COMMITTED → обработчики chat/gm пишут НОВЫЕ события
    // (D238/F-3.8), которые публикуются вторым циклом outbox.
    await world.drain();
    await world.drain();
    for (const client of playerClients) await client.waitFor('TURN_COMMITTED', 10_000);
    await sleep(250);

    // =========================== ИНВАРИАНТЫ ==================================
    for (const sniffer of sniffers) {
      const { client } = sniffer;
      const allJson = JSON.stringify(client.messages.map((m) => m.payload));

      for (const message of client.messages) {
        const type = message.type as WSServerType;
        const policy = WS_PRIVACY_POLICY[type];
        expect(policy, `неизвестный server-тип ${message.type}`).toBeDefined();

        // P1: инвариант 16 — исходящее валидно.
        const parsed = WSServerMessageSchema.safeParse({
          type: message.type,
          payload: message.payload,
          ts: message.ts,
          ...(message.requestId === undefined ? {} : { requestId: message.requestId }),
          ...(message.sessionId === undefined ? {} : { sessionId: message.sessionId }),
        });
        if (!parsed.success)
          throw new Error(
            `run${runId} ${client.label}: невалидный ${message.type}: ${parsed.error.message.slice(0, 200)}`,
          );

        // P2: BROADCAST без приватных полей (B-10).
        if (policy === 'BROADCAST') {
          expect(
            findForbiddenKey(message.payload),
            `run${runId} ${client.label}: ${message.type} — приватное в broadcast`,
          ).toBeNull();
        }

        // P3: GM_ONLY — только GM (A1.8).
        if (policy === 'GM_ONLY') {
          expect(sniffer.isGM, `run${runId}: игрок получил GM_ONLY ${message.type}`).toBe(true);
        }

        // P4: TARGETED — получатель совпадает с адресатом.
        if (policy === 'TARGETED') {
          if (message.type === 'STATE_PROJECTION_PRIVATE') {
            expect(message.payload['playerId']).toBe(sniffer.playerId);
            // P8: knowledge — только своё и только выданное.
            const granted = knowledgeByIndex.get(sniffer.index) ?? new Map();
            const entries = message.payload['knowledge'] as Array<{ key: string; value: unknown }>;
            for (const entry of entries) {
              expect(
                granted.has(entry.key),
                `run${runId}: чужое knowledge ${entry.key} у игрока ${sniffer.index}`,
              ).toBe(true);
              expect(entry.value).toBe(granted.get(entry.key));
            }
          } else if (message.type === 'CHAT_PRIVATE') {
            expect(message.payload['toPlayerId']).toBe(sniffer.playerId);
          } else if (message.type === 'TURN_PRIVATE_RESOLUTION') {
            const expected = (expectedPrivateByPlayer.get(sniffer.playerId) ?? []).join('\n\n').slice(0, 1500);
            expect(message.payload['text']).toBe(expected);
          }
        }

        // P5: SENDER_ONLY — только инициатору (по requestId).
        if (policy === 'SENDER_ONLY' && message.requestId !== undefined) {
          expect(client.sentRequestIds.has(message.requestId), `run${runId}: чужой requestId у ${client.label}`).toBe(
            true,
          );
        }
      }

      // P6: маркеры личных чатов — только адресату (и никому больше, включая GM).
      for (const marker of privateMarkers) {
        const isAddressee = !sniffer.isGM && sniffer.index === marker.to;
        if (!isAddressee) {
          expect(allJson.includes(marker.text), `run${runId}: утечка личного ${marker.text} к ${client.label}`).toBe(
            false,
          );
        } else {
          expect(allJson.includes(marker.text), `run${runId}: адресат не получил личное ${marker.text}`).toBe(true);
        }
      }

      // P7: заметки GM_ONLY/AI_DIRECTOR игрокам не видны; PUBLIC_AFTER_COMMIT — видны после commit.
      for (const note of noteMarkers) {
        if (sniffer.isGM) continue;
        if (note.visibility === 'PUBLIC_AFTER_COMMIT') {
          expect(allJson.includes(note.text), `run${runId}: PUBLIC_AFTER_COMMIT не доехала до ${client.label}`).toBe(
            true,
          );
        } else {
          expect(allJson.includes(note.text), `run${runId}: утечка заметки ${note.visibility} к ${client.label}`).toBe(
            false,
          );
        }
      }

      // P6b: чужие knowledge-маркеры не встречаются нигде, кроме своего PRIVATE-вида.
      for (const [index, granted] of knowledgeByIndex) {
        if (index === sniffer.index) continue;
        for (const value of granted.values()) {
          expect(allJson.includes(String(value)), `run${runId}: чужое knowledge-значение у ${client.label}`).toBe(
            false,
          );
        }
      }
    }

    // Санити: приватные части хода действительно доставлены адресатам (не пусто).
    for (let i = 0; i < n; i += 1) {
      const expected = expectedPrivateByPlayer.get(session.players[i]!.playerId) ?? [];
      const received = playerClients[i]!.messages.filter((m) => m.type === 'TURN_PRIVATE_RESOLUTION');
      expect(received.length).toBe(expected.length > 0 ? 1 : 0);
    }
  } finally {
    for (const sniffer of sniffers) sniffer.client.terminate();
    await world.close();
  }
}

describe('WS: property-based приватность broadcast (A1.7)', () => {
  it('случайные партии: приватное никогда не уходит в broadcast и чужим адресатам', async () => {
    let runId = 0;
    await fc.assert(
      fc.asyncProperty(scenarioArb, async (scenario) => {
        runId += 1;
        await runScenario(runId, scenario);
      }),
      { numRuns: 4, endOnFailure: true },
    );
  }, 600_000);
});
