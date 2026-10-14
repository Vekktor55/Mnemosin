import process from 'node:process';

import { randomUUID } from 'node:crypto';

import { nowIso, type TurnId } from '@mnemosin/contracts';
import { bootstrapDatabase } from '@mnemosin/database';

import { makeAction, makeChat, makeTurn, seedWorld } from './helpers.js';

/**
 * Дочерний процесс для теста crash-consistency (промпт 1.4, критерий A1.11).
 *
 * Сценарий выбирается аргументом:
 *   mid-tx  — фиксирует «мир», затем открывает транзакцию, пишет в неё и ЗАВИСАЕТ.
 *             Родитель убивает процесс SIGKILL в середине транзакции.
 *   big-tx  — то же, но в транзакции 2000 строк журнала: убийство гарантированно
 *             попадает на середину пакета записи.
 *
 * Протокол с родителем — строки в stdout: COMMITTED / MID_TX / PROGRESS n / DONE.
 */

const url = process.argv[2];
const mode = process.argv[3] ?? 'mid-tx';
if (!url) {
  process.stderr.write('нужен <dbUrl>\n');
  process.exit(2);
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const boot = await bootstrapDatabase({ url, seed: false });
/** seedWorld принимает TempDb; здесь достаточно его uow. */
const world = await seedWorld({ boot, url, dir: '', path: '', close: async () => {} }, nowIso());
const turn = makeTurn(world.session.sessionId, 1);

await boot.uow.runInTx(async (scope) => {
  await scope.repos.turns.insert(turn);
  await scope.repos.actions.insert(makeAction(turn.turnId, world.players[1]!.playerId, 1));
  await scope.repos.chat.insert(makeChat(world.session.sessionId, world.players[1]!.playerId));
});
process.stdout.write(`COMMITTED ${world.session.sessionId} ${turn.turnId}\n`);

if (mode === 'mid-tx') {
  // Транзакция, которая НЕ должна зафиксироваться: процесс будет убит внутри неё.
  void boot.uow.runInTx(async (scope) => {
    await scope.repos.chat.insert({
      ...makeChat(world.session.sessionId, world.players[2]!.playerId),
      text: 'ЭТО СООБЩЕНИЕ НЕ ДОЛЖНО СОХРАНИТЬСЯ',
    });
    await scope.repos.turns.insert({ ...makeTurn(world.session.sessionId, 2), turnId: randomUUID() as TurnId });
    process.stdout.write('MID_TX\n');
    await sleep(120_000);
  });
} else {
  void boot.uow.runInTx(async (scope) => {
    for (let i = 1; i <= 2000; i += 1) {
      await scope.repos.journal.append({
        turnId: turn.turnId,
        sessionId: world.session.sessionId,
        traceId: 'trace-crash',
        kind: 'rules_evaluated',
        payload: { i },
        createdAt: nowIso(),
      });
      if (i % 200 === 0) process.stdout.write(`PROGRESS ${i}\n`);
    }
    process.stdout.write('DONE\n');
  });
}

await sleep(180_000);
