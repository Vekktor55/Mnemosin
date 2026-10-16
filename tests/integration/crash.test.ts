import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { sql } from 'drizzle-orm';

import { nowIso, type TurnId } from '@mnemosin/contracts';
import { bootstrapDatabase } from '@mnemosin/database';

import { makeAction, makeChat, seedWorld, rmSafe } from './helpers.js';

/**
 * Промпт 1.4 · критерий A1.11: персистентность и восстановление после сбоя.
 *
 * Здесь не имитация: дочерний процесс РЕАЛЬНО убивается SIGKILL в середине транзакции,
 * после чего БД открывается заново и проверяется, что
 *   (а) зафиксированные данные на месте,
 *   (б) незафиксированных нет (WAL-откат при восстановлении),
 *   (в) `PRAGMA integrity_check` = ok,
 *   (г) БД снова пишется и FK по-прежнему enforced.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = resolve(ROOT, 'node_modules/.bin', process.platform === 'win32' ? 'tsx.cmd' : 'tsx');
const CHILD = resolve(ROOT, 'tests/integration/crash-child.ts');

interface ChildRun {
  readonly pid: number;
  readonly signal: NodeJS.Signals | null;
  readonly committedLine: string;
}

async function runChildUntil(url: string, mode: 'mid-tx' | 'big-tx', marker: string): Promise<ChildRun> {
  // detached: true — ребёнок получает СОБСТВЕННУЮ группу процессов. Это не украшение:
  // `tsx` поднимает вложенный node-процесс, и обычный child.kill('SIGKILL') убивает только
  // обёртку, оставляя настоящий процесс живым — он дописывает транзакцию и держит блокировку
  // БД (измерено: журнал оказался 2001 строкой вместо 0, а рестарт получил SQLITE_BUSY).
  // Поэтому убиваем всю группу: process.kill(-pid, 'SIGKILL').
  const child: ChildProcessWithoutNullStreams = spawn(TSX, ['--conditions=development', CHILD, url, mode], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
  });

  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const markerSeen = new Promise<void>((resolveMarker, rejectMarker) => {
    const timeout = setTimeout(
      () => rejectMarker(new Error(`маркер ${marker} не дождались. stderr: ${stderr.slice(-500)}`)),
      60_000,
    );
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      if (stdout.includes(marker)) {
        clearTimeout(timeout);
        resolveMarker();
      }
    });
    child.on('exit', () => {
      clearTimeout(timeout);
      rejectMarker(
        new Error(
          `дочерний процесс завершился раньше маркера. stdout: ${stdout.slice(-300)} stderr: ${stderr.slice(-500)}`,
        ),
      );
    });
  });

  await markerSeen;
  const committedLine = stdout.split('\n').find((l) => l.startsWith('COMMITTED')) ?? '';
  const pid = child.pid;
  if (pid === undefined) throw new Error('не получен pid дочернего процесса');

  const exited = new Promise<NodeJS.Signals | null>((r) => child.on('exit', (_code, sig) => r(sig)));
  try {
    process.kill(-pid, 'SIGKILL'); // минус = вся группа процессов
  } catch {
    child.kill('SIGKILL'); // запасной путь, если группа не создалась
  }
  const signal = await exited;
  return { pid, signal, committedLine };
}

describe('crash-consistency: SIGKILL в середине транзакции', () => {
  it('зафиксированное survives, незафиксированное откатывается, БД цела и пишется', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemosin-crash-'));
    const dbPath = join(dir, 'crash.sqlite');
    const url = `file:${dbPath}`;

    const run = await runChildUntil(url, 'mid-tx', 'MID_TX');
    expect(run.signal).toBe('SIGKILL');
    const [, sessionId, turnId] = run.committedLine.split(' ');
    expect(sessionId).toBeTruthy();
    expect(turnId).toBeTruthy();

    // Рестарт: миграции применяются поверх «грязной» WAL — это и есть восстановление после сбоя.
    const boot = await bootstrapDatabase({ url, seed: false });
    const repos = boot.uow.repos();

    // (а) зафиксированные данные на месте
    const session = await repos.sessions.findById(sessionId as never);
    expect(session).not.toBeNull();
    const turn = await repos.turns.findById(turnId as never);
    expect(turn).not.toBeNull();
    expect(await repos.actions.countByTurn(turnId as never)).toBe(1);
    expect(await repos.chat.listBySession(sessionId as never)).toHaveLength(1);

    // (б) незафиксированного нет
    const allChat = await repos.chat.listBySession(sessionId as never);
    expect(allChat.some((m) => m.text.includes('НЕ ДОЛЖНО СОХРАНИТЬСЯ'))).toBe(false);
    expect((await repos.turns.listBySession(sessionId as never)).map((t) => t.number)).toEqual([1]);

    // (в) целостность файла. Колонка результата называется как сама pragma, а не 'ok' —
    // поэтому берём первое значение строки, а не поле по имени.
    const integrity = await boot.handle.db.all<Record<string, string>>(sql`PRAGMA integrity_check`);
    expect(String(Object.values(integrity[0] ?? {})[0])).toBe('ok');
    const fkCheck = await boot.handle.db.all<{ ok: string }>(sql`PRAGMA foreign_key_check`);
    expect(fkCheck).toHaveLength(0);

    // (г) БД снова пишется, FK по-прежнему enforced
    const players = await repos.players.listBySession(session!.sessionId);
    await boot.uow.runInTx(async (scope) => {
      await scope.repos.chat.insert(makeChat(session!.sessionId, players[1]!.playerId, nowIso()));
    });
    expect(await repos.chat.listBySession(session!.sessionId)).toHaveLength(2);

    await expect(
      boot.uow.runInTx(async (scope) => {
        // действие на несуществующий ход — после восстановления FK по-прежнему работает
        await scope.repos.actions.insert(makeAction(randomUUID() as TurnId, players[1]!.playerId, 99));
      }),
    ).rejects.toThrow();

    await boot.close();
    rmSafe(dir);
  });

  it('большая транзакция (2000 строк журнала) при убийстве не оставляет частичных данных', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemosin-crash-big-'));
    const dbPath = join(dir, 'crash-big.sqlite');
    const url = `file:${dbPath}`;

    const run = await runChildUntil(url, 'big-tx', 'PROGRESS 200');
    expect(run.signal).toBe('SIGKILL');
    const [, sessionId, turnId] = run.committedLine.split(' ');

    const boot = await bootstrapDatabase({ url, seed: false });
    const repos = boot.uow.repos();

    // всё, что писала незафиксированная транзакция, исчезло целиком — не «200 строк из 2000»
    expect(await repos.journal.lastId(sessionId as never)).toBe(0);
    expect(await repos.journal.listByTurn(turnId as never)).toHaveLength(0);

    const integrity = await boot.handle.db.all<Record<string, string>>(sql`PRAGMA integrity_check`);
    expect(String(Object.values(integrity[0] ?? {})[0])).toBe('ok');

    // и после этого журнал снова пишется
    await boot.uow.runInTx(async (scope) => {
      await scope.repos.journal.append({
        turnId: turnId as never,
        sessionId: sessionId as never,
        traceId: 'trace-after-crash',
        kind: 'reconciled_on_boot',
        payload: { recovered: true },
        createdAt: nowIso(),
      });
    });
    expect(await repos.journal.lastId(sessionId as never)).toBe(1);
    await boot.close();
    rmSafe(dir);
  });

  it('данные, записанные до рестарта процесса, читаются после него (A1.11)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mnemosin-restart-'));
    const url = `file:${join(dir, 'restart.sqlite')}`;

    // «процесс №1»: сид мира и запись чата
    const first = await bootstrapDatabase({ url, seed: false });
    const world = await seedWorld({ boot: first, url, dir, path: join(dir, 'restart.sqlite'), close: async () => {} });
    await first.uow.runInTx(async (scope) => {
      await scope.repos.chat.insert(makeChat(world.session.sessionId, world.players[3]!.playerId));
    });
    await first.close();

    // «процесс №2»: тот же файл, новое соединение
    const second = await bootstrapDatabase({ url, seed: false });
    const repos = second.uow.repos();
    expect((await repos.sessions.listAll()).map((s) => s.sessionId)).toEqual([world.session.sessionId]);
    expect(await repos.locations.count()).toBe(3);
    const state = await repos.state.findBySession(world.session.sessionId);
    expect(state).toEqual(world.state);
    const chat = await repos.chat.listBySession(world.session.sessionId);
    expect(chat).toHaveLength(1);
    expect(chat[0]?.text).toBe('Проверка связи');
    await second.close();

    rmSafe(dir);
  });
});
