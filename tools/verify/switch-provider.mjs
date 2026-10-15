#!/usr/bin/env node
/**
 * tools/verify/switch-provider.mjs — сценарий приёмки A1.12/A1.13/A1.14 (промпт 1.7).
 *
 * A1.12 — AI-стенды переключаются ТОЛЬКО через env/config:
 *   AI_PROVIDER=scripted → ход доходит до REVIEW с нарративом из фикстуры;
 *   AI_PROVIDER=echo     → нарратив содержит тексты действий игроков;
 *   AI_PROVIDER=failing (AI_FAILING_MODE=timeout, config-фикстура chain=[failing])
 *                        → отказ PROVIDER_TIMEOUT, breaker OPEN, ход FAILED.
 * A1.13 — Capability Registry: breaker + CAPABILITY_CHANGED + /health:
 *   после 3 провалов breaker OPEN и CAPABILITY_CHANGED{TEXT_AI,false};
 *   живой сервер: /health.capabilities показывает деградацию (failing/unavailable)
 *   и доступность (scripted).
 * A1.14 — переключаемость без правки кода: хэши core/ и modules/ и git-статус
 *   этих каталогов НЕ изменились за время сценариев; манифест core/ совпадает.
 *
 * Запуск: node tools/verify/switch-provider.mjs
 * Код возврата: 0 — все три критерия PASS; 1 — иначе.
 * Последняя строка stdout — JSON-отчёт (его разбирает tools/verify/stage1.mjs).
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');
const PORT = Number(process.env['VERIFY_AI_PORT'] ?? 3913);
const BASE = `http://127.0.0.1:${PORT}`;
const DB_FILE = 'verify-ai.sqlite';
const FAILING_CONFIG = './tools/verify/fixtures/config-failing';

// ── A1.14: «до» — хэши кода и git-статус core/ modules/ ─────────────────────

function hashDir(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of readdirSync(current).sort()) {
      const full = join(current, entry);
      if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
      if (statSync(full).isDirectory()) walk(full);
      else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
        out[full.slice(ROOT.length + 1)] = createHash('sha256').update(readFileSync(full, 'utf8')).digest('hex');
      }
    }
  };
  if (existsSync(resolve(ROOT, dir))) walk(resolve(ROOT, dir));
  return out;
}

function gitStatusOf(paths) {
  const result = spawnSync('git', ['status', '--porcelain', '--', ...paths], { cwd: ROOT, encoding: 'utf8' });
  return result.stdout ?? '';
}

const codeBefore = { core: hashDir('core'), modules: hashDir('modules') };
const gitBefore = gitStatusOf(['core', 'modules']);

// ── запуск проб и серверов ──────────────────────────────────────────────────

function baseEnv(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: `file:./data/${DB_FILE}`,
    JWT_SECRET: randomBytes(32).toString('hex'),
    LOG_LEVEL: 'error',
    CONFIG_DIR: './config',
    AI_SCRIPTED_FIXTURE: 'tools/fixtures/resolution.ok.json',
    MEDIA_PROVIDER: 'none',
    ...extra,
  };
}

function runProbe(scenario, env) {
  return new Promise((promiseResolve) => {
    const child = spawn(TSX, ['--conditions=development', 'tools/verify/ai-probe.ts', `--scenario=${scenario}`], {
      cwd: ROOT,
      env: baseEnv(env),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => (stdout += chunk));
    child.stderr.on('data', (chunk) => (stderr += chunk));
    child.on('close', (code) => {
      const lines = stdout.trim().split('\n').filter(Boolean);
      let report = null;
      try {
        report = JSON.parse(lines.at(-1) ?? 'null');
      } catch {
        report = null;
      }
      promiseResolve({ code, report, stderr: stderr.slice(-800) });
    });
  });
}

function startServer(env) {
  const child = spawn(TSX, ['--conditions=development', 'apps/server/src/main.ts'], {
    cwd: ROOT,
    env: baseEnv({ PORT: String(PORT), ...env }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => (stderr += chunk));
  return { child, getStderr: () => stderr };
}

async function waitForHealth(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) return await res.json();
      lastError = `HTTP ${res.status}`;
    } catch (cause) {
      lastError = cause.message;
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`server did not become healthy: ${lastError}`);
}

async function withServer(env, fn) {
  const { child, getStderr } = startServer(env);
  try {
    const health = await waitForHealth();
    return await fn(health);
  } catch (cause) {
    return { error: cause.message, stderr: getStderr().slice(-400) };
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('close', r));
  }
}

// ── сценарии ────────────────────────────────────────────────────────────────

const results = [];
function record(id, title, pass, note) {
  results.push({ id, title, status: pass ? 'PASS' : 'FAIL', note });
}

const details = {};

// 1) A1.12: scripted
const scripted = await runProbe('scripted', { AI_PROVIDER: 'scripted' });
details.scripted = scripted.report ?? { error: scripted.stderr || `exit ${scripted.code}` };

// 2) A1.12: echo — переключение ТОЛЬКО env (конфиг тот же)
const echo = await runProbe('echo', { AI_PROVIDER: 'echo' });
details.echo = echo.report ?? { error: echo.stderr || `exit ${echo.code}` };

// 3) A1.12/A1.13: failing(timeout) — env + config-фикстура chain=[failing]
const failing = await runProbe('failing', {
  AI_PROVIDER: 'failing',
  AI_FAILING_MODE: 'timeout',
  CONFIG_DIR: FAILING_CONFIG,
});
details.failing = failing.report ?? { error: failing.stderr || `exit ${failing.code}` };

// 4) A1.13: живой сервер — /health деградирует при failing(unavailable)
details.healthDegraded = await withServer(
  { AI_PROVIDER: 'failing', AI_FAILING_MODE: 'unavailable', CONFIG_DIR: FAILING_CONFIG },
  async (health) => {
    const textAi = health.capabilities?.capabilities?.TEXT_AI;
    return {
      ok: health.ok === true,
      textAiAvailable: textAi?.available ?? null,
      textAiRequired: textAi?.required ?? null,
      textAiProviders: textAi?.providers ?? null,
      failingProbe: health.capabilities?.providers?.find((p) => p.providerId === 'failing')?.available ?? null,
    };
  },
);

// 5) A1.13: живой сервер — /health показывает TEXT_AI available (scripted)
details.healthAvailable = await withServer({ AI_PROVIDER: 'scripted' }, async (health) => {
  const textAi = health.capabilities?.capabilities?.TEXT_AI;
  return {
    textAiAvailable: textAi?.available ?? null,
    textAiProviders: textAi?.providers ?? null,
    scriptedProbe: health.capabilities?.providers?.find((p) => p.providerId === 'scripted')?.available ?? null,
  };
});

// ── A1.14: «после» — код core/ и modules/ не изменился ───────────────────────

const codeAfter = { core: hashDir('core'), modules: hashDir('modules') };
const gitAfter = gitStatusOf(['core', 'modules']);
const manifestPath = resolve(ROOT, 'tests/arch/core-manifest.json');
const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;

// ── итоги ───────────────────────────────────────────────────────────────────

const sc = (name) => details[name]?.checks ?? {};
const allTrue = (obj, keys) => keys.every((key) => obj[key] === true);

const a112Checks = [
  [
    'scripted: ход до REVIEW, нарратив из фикстуры',
    allTrue(sc('scripted'), [
      'draftProposed',
      'turnReachedReview',
      'reviewReadyAtSet',
      'sourceAI',
      'allProposed',
      'narrativeFromFixture',
      'actionCountSubstituted',
      'privateMessagesRemapped',
      'objectChangeFromRemap',
      'visualScenePresent',
    ]) && sc('scripted').providerId === 'scripted',
  ],
  [
    'echo: нарратив из действий игроков',
    allTrue(sc('echo'), ['draftProposed', 'turnReachedReview', 'narrativeFromActions', 'emptyProposals']) &&
      sc('echo').providerId === 'echo',
  ],
  [
    'failing(timeout): 3 отказа → ход FAILED{PROVIDER_TIMEOUT}',
    allTrue(sc('failing'), [
      'threeRejectionsUnavailable',
      'failedEventEveryRound',
      'failedEventTurn',
      'turnFailedWithProviderTimeout',
      'decisionsTimeout',
    ]),
  ],
];
const a112Failed = a112Checks.filter(([, ok]) => !ok).map(([name]) => name);
record(
  'A1.12',
  'AI-стенды переключаются через env/config без правки кода',
  a112Failed.length === 0,
  a112Failed.length === 0
    ? 'scripted→REVIEW, echo→нарратив действий, failing→FAILED{PROVIDER_TIMEOUT}'
    : a112Failed.join('; '),
);

const a113Checks = [
  ['breaker OPEN после 3 провалов', sc('failing').breakerOpen === true && sc('failing').breakerFailures === 3],
  ['CAPABILITY_CHANGED{TEXT_AI,false} опубликовано', sc('failing').capabilityChangedFalse === true],
  [
    'resolve()/snapshot() показывают деградацию',
    sc('failing').textAiUnavailableNow === true && sc('failing').healthSnapshotDegraded === true,
  ],
  [
    '/health живого сервера: TEXT_AI unavailable (failing)',
    details.healthDegraded?.textAiAvailable === false &&
      details.healthDegraded?.textAiRequired === true &&
      Array.isArray(details.healthDegraded?.textAiProviders) &&
      details.healthDegraded.textAiProviders.length === 0 &&
      details.healthDegraded?.failingProbe === false,
  ],
  [
    '/health живого сервера: TEXT_AI available (scripted)',
    details.healthAvailable?.textAiAvailable === true &&
      Array.isArray(details.healthAvailable?.textAiProviders) &&
      details.healthAvailable.textAiProviders.includes('scripted'),
  ],
];
const a113Failed = a113Checks.filter(([, ok]) => !ok).map(([name]) => name);
record(
  'A1.13',
  'Capability Registry: breaker + CAPABILITY_CHANGED + /health',
  a113Failed.length === 0,
  a113Failed.length === 0
    ? 'breaker OPEN, CAPABILITY_CHANGED{false}, /health деградирует и восстанавливается'
    : a113Failed.join('; '),
);

const a114Checks = [
  ['хэши core/ не изменились за время сценариев', JSON.stringify(codeBefore.core) === JSON.stringify(codeAfter.core)],
  [
    'хэши modules/ не изменились за время сценариев',
    JSON.stringify(codeBefore.modules) === JSON.stringify(codeAfter.modules),
  ],
  ['git-статус core/ и modules/ не изменился', gitBefore === gitAfter],
  [
    'манифест core/ совпадает с фактическими файлами',
    manifest !== null && JSON.stringify(manifest) === JSON.stringify(codeAfter.core),
  ],
];
const a114Failed = a114Checks.filter(([, ok]) => !ok).map(([name]) => name);
record(
  'A1.14',
  'Переключение провайдера не меняет core/ и modules/',
  a114Failed.length === 0,
  a114Failed.length === 0
    ? `core: ${Object.keys(codeAfter.core).length} файл(ов), modules: ${Object.keys(codeAfter.modules).length} — без изменений`
    : a114Failed.join('; '),
);

// ── вывод ───────────────────────────────────────────────────────────────────

process.stdout.write('\n=== МНЕМОСИН · switch-provider — A1.12 / A1.13 / A1.14 ===\n\n');
for (const r of results) {
  const mark = r.status === 'PASS' ? '✅ PASS' : '❌ FAIL';
  process.stdout.write(`${r.id.padEnd(7)} ${mark}  ${r.title}  ${r.note}\n`);
}
const fail = results.filter((r) => r.status === 'FAIL').length;
process.stdout.write(`\nИтого: PASS ${results.length - fail} · FAIL ${fail}\n`);

process.stdout.write(
  `${JSON.stringify({
    A1_12: results.find((r) => r.id === 'A1.12').status,
    A1_13: results.find((r) => r.id === 'A1.13').status,
    A1_14: results.find((r) => r.id === 'A1.14').status,
    details,
  })}\n`,
);

for (const name of [DB_FILE, `${DB_FILE}-wal`, `${DB_FILE}-shm`]) {
  try {
    rmSync(resolve(ROOT, 'data', name), { force: true });
  } catch {
    /* уже удалён */
  }
}

process.exit(fail === 0 ? 0 : 1);
