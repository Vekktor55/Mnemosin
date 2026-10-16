import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { rmSync } from 'node:fs';
import path from 'node:path';

/**
 * Хелперы e2e (промпт 1.12, п.8): жизненный цикл тестового сервера и HTTP-обвязка
 * сценария «2 игрока + GM, ход, commit, приватное сообщение».
 *
 * Поток — как в tools/verify/stage1.mjs (A1.1b2): POST /auth/session → join →
 * start → action → lock → REVIEW (scripted AI) → commit.
 *
 * Надёжность: каждому запуску — СВОЙ порт (pickPort) и СВОЯ БД (уникальное имя):
 * осиротевшие процессы прошлых прогонов не могут подменить сервер, а startServer
 * проверяет, что health отвечает ИМЕННО наш живой child (иначе ошибка).
 */

export const ROOT = path.resolve(import.meta.dirname, '..');

/**
 * Сервер для e2e — СКОМПИЛИРОВАННЫЙ (node apps/server/dist/main.js), а не tsx:
 * рантайм-транспиляция tsx съедает сотни МБ, которых не хватает в CI-песочницах
 * (V8 CodeRange OOM у рендереров браузера). dist собирает global-setup.ts
 * (npm run build + npm run build -w client).
 */
const SERVER_ENTRY = path.join(ROOT, 'apps', 'server', 'dist', 'main.js');

export const E2E_JWT_SECRET = 'e2e-mnemosin-secret-0123456789abcdef0123456789abcdef';

export interface TestServer {
  readonly port: number;
  readonly base: string;
  readonly child: ChildProcessWithoutNullStreams;
  /** Штатная остановка: SIGTERM → (5 с) → SIGKILL. */
  stop(): Promise<void>;
  /** kill -9 — для сценария реконнекта (A1.9). */
  kill9(): void;
}

/** Свободный порт: приватный диапазон, случайный на каждый прогон. */
export function pickPort(): number {
  return 20_000 + Math.floor(Math.random() * 20_000);
}

export interface StartServerOptions {
  readonly cleanDb?: boolean;
  readonly aiProvider?: 'scripted' | 'echo' | 'failing';
  readonly aiFailingMode?: 'timeout' | 'schema' | 'rate_limit' | 'unavailable';
  /** Каталог config/ (chain=[failing] нужен для сценариев деградации, A1.12). */
  readonly configDir?: string;
}

function serverEnv(port: number, dbName: string, options: StartServerOptions = {}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    NODE_ENV: 'test',
    PORT: String(port),
    DATABASE_URL: `file:./data/${dbName}`,
    DB_SEED: 'false',
    JWT_SECRET: E2E_JWT_SECRET,
    LOG_LEVEL: 'error',
    CONFIG_DIR: options.configDir ?? './config',
    STATE_DIR: './data/state',
    AI_PROVIDER: options.aiProvider ?? 'scripted',
    AI_SCRIPTED_FIXTURE: 'tools/fixtures/resolution.ok.json',
    ...(options.aiFailingMode === undefined ? {} : { AI_FAILING_MODE: options.aiFailingMode }),
    MEDIA_PROVIDER: 'none',
  };
}

export async function startServer(port: number, dbName: string, options: StartServerOptions = {}): Promise<TestServer> {
  const dbPath = path.join(ROOT, 'data', dbName);
  if (options.cleanDb !== false) {
    for (const suffix of ['', '-shm', '-wal']) {
      rmSync(`${dbPath}${suffix}`, { force: true });
    }
  }

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    cwd: ROOT,
    env: serverEnv(port, dbName, options),
    stdio: ['ignore', 'pipe', 'pipe'],
    // Сервер — одиночный процесс node; группа всё равно убивается целиком.
    detached: true,
  }) as ChildProcessWithoutNullStreams;
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });

  const base = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `сервер завершился до готовности (exit=${child.exitCode} signal=${child.signalCode}): ${stderr.slice(-2000)}`,
      );
    }
    try {
      const response = await fetch(`${base}/health`);
      if (response.ok) {
        // Health ответил — но точно ли ЭТОТ процесс? (защита от чужого сервера на порту)
        await sleep(300);
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`порт ${port} занят чужим процессом: наш child завершился (${stderr.slice(-500)})`);
        }
        break;
      }
    } catch (cause) {
      if (cause instanceof Error && cause.message.startsWith('порт')) throw cause;
      /* ещё не поднялся */
    }
    if (Date.now() > deadline) {
      child.kill('SIGKILL');
      throw new Error(`сервер не стал healthy за 60 с: ${stderr.slice(-2000)}`);
    }
    await sleep(250);
  }

  return {
    port,
    base,
    child,
    async stop(): Promise<void> {
      if (child.exitCode !== null || child.signalCode !== null) return;
      signalGroup(child, 'SIGTERM');
      const exited = await Promise.race([
        new Promise<boolean>((resolveExit) => child.on('exit', () => resolveExit(true))),
        sleep(5000).then(() => false),
      ]);
      if (!exited) {
        signalGroup(child, 'SIGKILL');
        await new Promise<void>((resolveExit) => child.on('exit', () => resolveExit()));
      }
    },
    kill9(): void {
      signalGroup(child, 'SIGKILL');
    },
  };
}

/** Сигнал всей группе процессов (tsx-обёртка + сервер-ребёнок). */
function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  try {
    if (child.pid !== undefined) process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* уже мертвы */
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ------------------------------------------------------------------- HTTP API

export interface CreateSessionResult {
  sessionId: string;
  playerId: string;
  token: string;
  refreshToken: string;
}

export interface JoinResult {
  playerId: string;
  characterId: string;
  token: string;
  refreshToken: string;
}

async function request<T>(base: string, method: string, urlPath: string, body?: unknown, token?: string): Promise<T> {
  const response = await fetch(`${base}${urlPath}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token !== undefined ? { authorization: `Bearer ${token}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const json = (await response.json().catch(() => null)) as
    (T & { error?: { code?: string; message?: string } }) | null;
  if (!response.ok) {
    throw new Error(
      `${method} ${urlPath} → ${response.status}: ${json?.error?.code ?? ''} ${json?.error?.message ?? ''}`,
    );
  }
  return json as T;
}

export function createSession(base: string, displayName = 'Ведущий E2E'): Promise<CreateSessionResult> {
  return request<CreateSessionResult>(base, 'POST', '/auth/session', {
    displayName,
    characterName: 'Архивариус',
    title: 'E2E партия',
  });
}

export function joinSession(
  base: string,
  sessionId: string,
  displayName: string,
  characterName?: string,
): Promise<JoinResult> {
  return request<JoinResult>(base, 'POST', `/sessions/${sessionId}/join`, {
    displayName,
    characterName: characterName ?? displayName,
  });
}

export function startSessionTurn(base: string, sessionId: string, gmToken: string): Promise<{ turnId: string }> {
  return request<{ turnId: string }>(
    base,
    'POST',
    `/sessions/${sessionId}/start`,
    { idempotencyKey: `e2e-start-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` },
    gmToken,
  );
}

export function submitActionHttp(
  base: string,
  turnId: string,
  token: string,
  rawText: string,
): Promise<{ actionId: string; sequenceId: number }> {
  return request<{ actionId: string; sequenceId: number }>(
    base,
    'POST',
    `/turns/${turnId}/action`,
    { rawText, idempotencyKey: `e2e-act-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` },
    token,
  );
}

export function lockTurn(base: string, turnId: string, gmToken: string): Promise<Record<string, never>> {
  return request<Record<string, never>>(
    base,
    'POST',
    `/turns/${turnId}/lock`,
    { idempotencyKey: `e2e-lock-${Date.now()}-${Math.random().toString(16).slice(2, 8)}` },
    gmToken,
  );
}

export function commitTurn(base: string, turnId: string, gmToken: string): Promise<{ version: number }> {
  return commitTurnWithKey(base, turnId, gmToken, `e2e-commit-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`);
}

/** Commit с ЯВНЫМ idempotencyKey — для проверок повтора (A1.4). */
export function commitTurnWithKey(
  base: string,
  turnId: string,
  gmToken: string,
  idempotencyKey: string,
): Promise<{ version: number }> {
  return request<{ version: number }>(base, 'POST', `/turns/${turnId}/commit`, { idempotencyKey }, gmToken);
}

/** GM-заметка через HTTP (POST /gm/note) — для проверок приватности заметок. */
export function gmAddNoteHttp(
  base: string,
  sessionId: string,
  gmToken: string,
  visibility: 'GM_ONLY' | 'AI_DIRECTOR' | 'PUBLIC_AFTER_COMMIT',
  text: string,
): Promise<{ noteId: string }> {
  return request<{ noteId: string }>(base, 'POST', '/gm/note', { sessionId, visibility, text }, gmToken);
}

export interface TurnViewDto {
  turnId: string;
  number: number;
  status: string;
  actionCount: number;
  failed: { code: string; message: string } | null;
}

/** Универсальные GET/POST под токеном — для assert'ов вне каталога хелперов. */
export function apiGet<T>(base: string, path: string, token: string): Promise<T> {
  return request<T>(base, 'GET', path, undefined, token);
}

export function apiPost<T>(base: string, path: string, body: unknown, token: string): Promise<T> {
  return request<T>(base, 'POST', path, body, token);
}

export function getTurn(base: string, turnId: string, token: string): Promise<TurnViewDto> {
  return request<TurnViewDto>(base, 'GET', `/turns/${turnId}`, undefined, token);
}

export async function waitTurnStatus(
  base: string,
  turnId: string,
  token: string,
  statuses: string[],
  timeoutMs = 30_000,
): Promise<TurnViewDto> {
  const deadline = Date.now() + timeoutMs;
  let last: TurnViewDto | null = null;
  while (Date.now() < deadline) {
    last = await getTurn(base, turnId, token);
    if (statuses.includes(last.status)) return last;
    await sleep(400);
  }
  throw new Error(`ход не достиг ${statuses.join('|')} за ${timeoutMs} мс (последний: ${last?.status ?? 'null'})`);
}
