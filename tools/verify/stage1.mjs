#!/usr/bin/env node
/**
 * tools/verify/stage1.mjs — приёмка этапа 1 «Стол».
 *
 * Прогоняет критерии A1.1–A1.16 (docs/SPEC_STAGE1.md §12, ROADMAP.md §2.3)
 * против ЖИВОГО процесса и печатает таблицу PASS/FAIL.
 *
 * Промпт 1.1 реализует A1.1. Остальные пункты помечаются NOT_IMPLEMENTED
 * и становятся PASS по мере выполнения промптов 1.2–1.13.
 *
 * Запуск: npm run verify:stage1
 * Код возврата: 0 — если все реализованные критерии PASS; 1 — иначе.
 */

import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env['VERIFY_PORT'] ?? 3911);
const BASE = `http://127.0.0.1:${PORT}`;
const TSX = resolve(ROOT, 'node_modules/.bin/tsx');

/** @type {Array<{id:string, title:string, status:'PASS'|'FAIL'|'NOT_IMPLEMENTED', note?:string}>} */
const results = [];

function record(id, title, status, note) {
  results.push({ id, title, status, note });
}

function serverEnv(extra = {}) {
  return {
    ...process.env,
    NODE_ENV: 'test',
    PORT: String(PORT),
    DATABASE_URL: 'file:./data/verify.sqlite',
    JWT_SECRET: randomBytes(32).toString('hex'),
    LOG_LEVEL: 'error',
    CONFIG_DIR: './config',
    STATE_DIR: './data/state',
    AI_PROVIDER: 'scripted',
    MEDIA_PROVIDER: 'none',
    ...extra,
  };
}

function startServer(extra = {}) {
  const child = spawn(TSX, ['--conditions=development', 'apps/server/src/main.ts'], {
    cwd: ROOT,
    env: serverEnv(extra),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
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

async function a1_1_serverStarts() {
  const { child, getStderr } = startServer();
  try {
    const health = await waitForHealth();
    const version = await (await fetch(`${BASE}/version`)).json();

    const checks = [
      ['ok === true', health.ok === true],
      ['version present', typeof version.version === 'string' && version.version.length > 0],
      ['contractsVersion present', typeof version.contractsVersion === 'string'],
      ['capabilities stub = {}', JSON.stringify(health.capabilities) === '{}'],
      // промпт 1.4: БД подключена — /health показывает db и номер применённых миграций
      ['db = ok (промпт 1.4)', health.db === 'ok'],
      ['schemaVersion >= 1', typeof health.schemaVersion === 'number' && health.schemaVersion >= 1],
      ['phase = seeded|ready', health.phase === 'seeded' || health.phase === 'ready'],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);

    if (failed.length > 0) {
      record('A1.1', 'Сервер стартует, /health отвечает', 'FAIL', `не выполнено: ${failed.join(', ')}`);
    } else {
      record('A1.1', 'Сервер стартует, /health отвечает', 'PASS', `port ${PORT}, env=${health.env}`);
    }
  } catch (cause) {
    record('A1.1', 'Сервер стартует, /health отвечает', 'FAIL', cause.message);
  } finally {
    child.kill('SIGTERM');
    await new Promise((r) => child.on('exit', r));
    if (getStderr().length > 0) process.stderr.write(getStderr());
  }
}

async function a1_1_failFast() {
  const secret = randomBytes(32).toString('hex');
  const { child, getStderr } = startServer({ JWT_SECRET: '', MNEMOSIN_VERIFY_SECRET: secret });
  const exitCode = await new Promise((r) => child.on('exit', (code) => r(code ?? -1)));
  const stderr = getStderr();

  const checks = [
    ['process exited non-zero', exitCode !== 0],
    ['stderr contains CONFIG_INVALID', stderr.includes('CONFIG_INVALID')],
    ['stderr names JWT_SECRET', stderr.includes('JWT_SECRET')],
    ['stderr has no secret value', !stderr.includes(secret)],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);

  if (failed.length > 0) {
    record('A1.1b', 'Fail-fast при невалидном env (без утечки секрета)', 'FAIL', `не выполнено: ${failed.join(', ')}`);
    if (stderr) process.stderr.write(stderr);
  } else {
    record('A1.1b', 'Fail-fast при невалидном env (без утечки секрета)', 'PASS', `exit=${exitCode}`);
  }
}

/** A1.2: границы зависимостей — dependency-cruiser + arch-тесты. */
async function a1_2_boundaries() {
  const cruiser = spawnSync(
    resolve(ROOT, 'node_modules/.bin/depcruise'),
    [
      '--config',
      '.dependency-cruiser.cjs',
      '--validate',
      'shared',
      'core',
      'modules',
      'infrastructure',
      'gateways',
      'apps',
      'client',
    ],
    { cwd: ROOT, encoding: 'utf8' },
  );
  const archTests = spawnSync(
    resolve(ROOT, 'node_modules/.bin/vitest'),
    ['run', '--project', 'arch', '--reporter=basic'],
    {
      cwd: ROOT,
      encoding: 'utf8',
    },
  );
  const checks = [
    ['dependency-cruiser: 0 нарушений', cruiser.status === 0],
    ['vitest --project arch: все тесты зелёные', archTests.status === 0],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  if (failed.length > 0) {
    record('A1.2', 'Границы зависимостей (cruiser + arch-тесты)', 'FAIL', failed.join('; '));
    process.stderr.write(`${cruiser.stdout ?? ''}${archTests.stdout ?? ''}`.slice(-1200));
  } else {
    const m = /(\d+) modules, (\d+) dependencies/.exec(cruiser.stdout ?? '');
    record(
      'A1.2',
      'Границы зависимостей (cruiser + arch-тесты)',
      'PASS',
      m ? `${m[1]} модулей, ${m[2]} зависимостей, 0 нарушений` : '0 нарушений',
    );
  }
}

/** A1.14: расширяемость — новый провайдер без изменения core. */
async function a1_14_extensibility() {
  const hashDir = (dir) => {
    const out = {};
    const walk = (current) => {
      for (const entry of readdirSync(current).sort()) {
        const full = resolve(current, entry);
        if (entry === 'node_modules' || entry === 'dist' || entry.startsWith('.')) continue;
        if (statSync(full).isDirectory()) walk(full);
        else if (full.endsWith('.ts') && !full.endsWith('.d.ts')) {
          out[full.slice(ROOT.length + 1)] = createHash('sha256').update(readFileSync(full, 'utf8')).digest('hex');
        }
      }
    };
    if (existsSync(resolve(ROOT, dir))) walk(resolve(ROOT, dir));
    return out;
  };

  const manifestPath = resolve(ROOT, 'tests/arch/core-manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
  const coreNow = hashDir('core');

  const fixturePath = resolve(ROOT, 'tests/fixtures/config-extensible/capabilities.yaml');
  const fixtureText = existsSync(fixturePath) ? readFileSync(fixturePath, 'utf8') : '';

  const providers = ['scripted', 'echo', 'failing', 'openrouter', 'lmstudio', 'comfyui', 'debug'];
  let enumLeak = false;
  for (const file of Object.keys(hashDir('shared/contracts'))) {
    const source = readFileSync(resolve(ROOT, file), 'utf8');
    for (const block of source.match(/z\.enum\(\[[\s\S]*?\]\)/g) ?? []) {
      if (providers.some((p) => block.includes(`'${p}'`))) enumLeak = true;
    }
  }

  const probePath = resolve(ROOT, 'infrastructure/ai/src/provider-probe.ts');
  const probeText = existsSync(probePath) ? readFileSync(probePath, 'utf8') : '';
  const probeImports = [...probeText.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);

  const checks = [
    [
      'манифест core/ совпадает с фактическими файлами',
      manifest !== null && JSON.stringify(manifest) === JSON.stringify(coreNow),
    ],
    ['фикстура config-extensible содержит xai-probe', fixtureText.includes('xai-probe')],
    ['в contracts нет enum со списком провайдеров (D192)', !enumLeak],
    [
      'зонд-адаптер импортирует только @mnemosin/contracts',
      probeImports.length > 0 && probeImports.every((i) => i === '@mnemosin/contracts'),
    ],
  ];
  const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
  record(
    'A1.14',
    'Расширяемость: провайдер = 1 файл + 1 строка конфига, core не меняется',
    failed.length === 0 ? 'PASS' : 'FAIL',
    failed.length === 0
      ? `${checks.length} проверки, core: ${Object.keys(coreNow).length} файл(ов) по манифесту`
      : failed.join('; '),
  );
}

/** Запускает tsx-скрипт и возвращает последнюю строку stdout, разобранную как JSON. */
async function runProbe(args, timeoutMs = 120000) {
  const child = spawn(TSX, ['--conditions=development', ...args], {
    cwd: ROOT,
    env: serverEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => {
    stdout += c;
  });
  child.stderr.on('data', (c) => {
    stderr += c;
  });
  const code = await new Promise((r) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      r(-1);
    }, timeoutMs);
    child.on('exit', (c) => {
      clearTimeout(timer);
      r(c ?? -1);
    });
  });
  const lines = stdout.trim().split('\n').filter(Boolean);
  const line = lines[lines.length - 1];
  if (code !== 0 || !line) {
    throw new Error(`проба завершилась кодом ${code}: ${(stderr || stdout).slice(-400)}`);
  }
  return JSON.parse(line);
}

/** A1.4 и A1.5 — одним прогоном пробы (обе работают с одной и той же временной БД). */
async function a1_4_a1_5_persistenceGuarantees() {
  let report;
  try {
    report = await runProbe(['tools/verify/persistence-probe.ts']);
  } catch (cause) {
    record('A1.4', 'Идемпотентность commit (повтор и параллельные вызовы)', 'FAIL', cause.message);
    record('A1.5', 'Optimistic lock: вторая запись → VERSION_CONFLICT', 'FAIL', cause.message);
    return;
  }

  const n = report.parallel;
  const idem = report.idempotency;
  const idemChecks = [
    [`из ${n} параллельных tryAcquire ровно 1 proceed`, idem.rawProceed === 1],
    [`остальные ${n - 1} получили in_flight`, idem.rawInFlight === n - 1],
    ['бизнес-функция выполнена ровно 1 раз', idem.serviceExecuted === 1],
    ['1 executed + остальные replayed', idem.tally.executed === 1 && idem.tally.replayed === n - 1],
    ['повтор после завершения → replayed', idem.replayKind === 'replayed'],
    ['replay вернул тот же результат', idem.replayResultJson === JSON.stringify({ executedBy: 0 })],
  ];
  const idemFailed = idemChecks.filter(([, ok]) => !ok).map(([name]) => name);
  record(
    'A1.4',
    'Идемпотентность commit (повтор и параллельные вызовы)',
    idemFailed.length === 0 ? 'PASS' : 'FAIL',
    idemFailed.length === 0
      ? `${n} параллельных: 1 proceed / 1 executed / ${n - 1} replayed; повтор → тот же результат из кэша`
      : idemFailed.join('; '),
  );

  const lock = report.optimisticLock;
  const lockChecks = [
    ['из двух параллельных записей одна ok', lock.kinds.includes('ok')],
    ['вторая — conflict', lock.kinds.includes('conflict')],
    ['conflict сообщает фактическую версию', lock.conflictActualVersion === 1],
    ['в БД осталась версия победителя', lock.storedVersion === 1],
    ['retry после перечитывания проходит', lock.retryKind === 'ok'],
  ];
  const lockFailed = lockChecks.filter(([, ok]) => !ok).map(([name]) => name);
  record(
    'A1.5',
    'Optimistic lock: вторая запись → VERSION_CONFLICT',
    lockFailed.length === 0 ? 'PASS' : 'FAIL',
    lockFailed.length === 0
      ? `две записи при version=0 → ok + conflict(actual=1); retry после перечитывания → ok`
      : lockFailed.join('; '),
  );
}

/** A1.11: персистентность — два запуска процесса сервера на одной БД. */
async function a1_11_persistence() {
  const fileName = `verify-${Date.now()}.sqlite`;
  const dbUrl = `file:./data/${fileName}`;
  const absolute = resolve(ROOT, 'data', fileName);

  const bootOnce = async () => {
    const { child, getStderr } = startServer({ DATABASE_URL: dbUrl });
    try {
      const health = await waitForHealth();
      return { health, stderr: getStderr() };
    } finally {
      child.kill('SIGTERM');
      await new Promise((r) => child.on('exit', r));
    }
  };

  try {
    const first = await bootOnce();
    const second = await bootOnce();
    const inspect = await runProbe(['tools/verify/db-inspect.ts', dbUrl]);

    const checks = [
      ['первый старт: db=ok', first.health.db === 'ok'],
      ['первый старт: посев выполнен (phase=seeded)', first.health.phase === 'seeded'],
      ['второй старт: db=ok', second.health.db === 'ok'],
      ['второй старт: посев НЕ повторяется (phase=ready)', second.health.phase === 'ready'],
      [
        'schemaVersion одинаков на обоих стартах',
        first.health.schemaVersion === second.health.schemaVersion && first.health.schemaVersion >= 1,
      ],
      ['сессия ровно одна (дублей при рестарте нет)', inspect.sessions === 1],
      ['7 игроков пережили рестарт', inspect.players === 7],
      ['7 персонажей пережили рестарт', inspect.characters === 7],
      ['3 локации пережили рестарт', inspect.locations === 3],
      ['состояние мира на месте', inspect.hasState === true],
      ['миграция применена один раз', inspect.migrations === 1 && inspect.lastMigration === '0000_init'],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    record(
      'A1.11',
      'Персистентность: восстановление после рестарта',
      failed.length === 0 ? 'PASS' : 'FAIL',
      failed.length === 0
        ? `2 старта процесса на одной БД: 1 сессия, ${inspect.players} игроков, ${inspect.locations} локации, state version=${inspect.stateVersion}`
        : failed.join('; '),
    );
  } catch (cause) {
    record('A1.11', 'Персистентность: восстановление после рестарта', 'FAIL', cause.message);
  } finally {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        rmSync(absolute + suffix, { force: true });
      } catch {
        /* уже удалён */
      }
    }
  }
}

/** A1.11b (промпт 1.5): outbox — публикация из committed-транзакции, откат не публикуется, републикация после рестарта. */
async function a1_11b_outbox() {
  const title = 'Outbox: 1 событие → опубликовано, published_at заполнен; откат не публикуется; рестарт → републикация';
  try {
    const report = await runProbe(['tools/verify/outbox-probe.ts']);
    const checks = [
      [
        'откат: не опубликовано, outbox пуст',
        report.rollback.scanned === 0 && report.rollback.delivered === 0 && report.rollback.pending === 0,
      ],
      ['commit: опубликовано ровно один раз', report.committed.delivered === 1 && report.committed.published === 1],
      [
        'published_at заполнен, status=PUBLISHED',
        report.committed.publishedAtSet === true && report.committed.status === 'PUBLISHED',
      ],
      [
        'рестарт: PENDING пережил «краш» и доставлен (at-least-once, D113)',
        report.restart.delivered === 1 &&
          report.restart.traceIds[0] === 'trace-restart' &&
          report.restart.pendingAfter === 0,
      ],
    ];
    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    record(
      'A1.11b',
      title,
      failed.length === 0 ? 'PASS' : 'FAIL',
      failed.length === 0
        ? 'откат → 0 публикаций; commit → PUBLISHED + published_at; «крах» → републикация после рестарта'
        : failed.join('; '),
    );
  } catch (cause) {
    record('A1.11b', title, 'FAIL', cause.message);
  }
}

/**
 * A1.6 и A1.15 (промпт 1.6): машина состояний Turn и локации/moveGroup —
 * через сервисный слой на живом процессе (HTTP/WS появятся в 1.10/1.11).
 * Одна проба core-probe.ts закрывает оба критерия.
 */
async function a1_6_a1_15_core() {
  let report;
  try {
    report = await runProbe(['tools/verify/core-probe.ts']);
  } catch (cause) {
    record('A1.6', 'Машина состояний Turn: все переходы по таблице', 'FAIL', cause.message);
    record('A1.15', 'Локации и moveGroup: LOCATION_CHANGED, locked exit → RULE_REJECTED', 'FAIL', cause.message);
    return;
  }

  const sm = report.stateMachine;
  const tc = report.turnCycle;
  const smChecks = [
    [
      'полный путь OPEN→LOCKED→PROCESSING→REVIEW→COMMITTED',
      JSON.stringify(sm.pathStatuses) === JSON.stringify(['OPEN', 'LOCKED', 'PROCESSING', 'REVIEW', 'COMMITTED']),
    ],
    [
      'запрещённый transition (retry из COMMITTED) → CORE_INVALID_STATE_TRANSITION',
      sm.transitionInvalid === 'CORE_INVALID_STATE_TRANSITION',
    ],
    ['lock в LOCKED → CORE_INVALID_STATE_TRANSITION', tc.lockWhileLocked === 'CORE_INVALID_STATE_TRANSITION'],
    ['unlock в OPEN → CORE_INVALID_STATE_TRANSITION', tc.unlockWhileOpen === 'CORE_INVALID_STATE_TRANSITION'],
    ['cancel в LOCKED → CORE_INVALID_STATE_TRANSITION', tc.cancelWhileLocked === 'CORE_INVALID_STATE_TRANSITION'],
    ['submit в LOCKED → TURN_NOT_OPEN', tc.submitWhileLocked === 'TURN_NOT_OPEN'],
    ['cancel в OPEN → FAILED + failed.code', tc.cancelStatus === 'FAILED' && tc.cancelFailedCode === 'CONFLICT'],
    ['lockTurn собрал actionIds из actions (F-1.17)', tc.lockActionIds === 2],
    ['повтор lockTurn с тем же ключом → replayed', tc.lockReplayed === true],
    ['гонка openTurn: все лишние отклонены', tc.openRaceRejected === true],
    ['номера ходов уникальны и монотонны (1,2,3)', JSON.stringify(tc.turnNumbers) === JSON.stringify([1, 2, 3])],
    ['лимит действий на игрока → RATE_LIMIT', tc.overLimit === 'RATE_LIMIT'],
    [
      'журнал хода: opened/locked/unlocked/processing/draft/committed',
      ['turn_opened', 'turn_locked', 'turn_unlocked', 'processing_started', 'draft_ready', 'committed'].every((k) =>
        sm.journalKinds.includes(k),
      ),
    ],
    [
      'события ходов в outbox',
      report.events['TURN_OPENED'] === 3 &&
        report.events['TURN_LOCKED'] === 2 &&
        report.events['TURN_UNLOCKED'] === 1 &&
        report.events['TURN_FAILED'] === 1,
    ],
  ];
  const smFailed = smChecks.filter(([, ok]) => !ok).map(([name]) => name);
  record(
    'A1.6',
    'Машина состояний Turn: все переходы по таблице',
    smFailed.length === 0 ? 'PASS' : 'FAIL',
    smFailed.length === 0
      ? 'сервисный слой (1.6): полный путь + 4 запрещённых перехода → CORE_INVALID_STATE_TRANSITION; движок добавит триггеры в 1.8'
      : smFailed.join('; '),
  );

  const mg = report.moveGroup;
  const mgChecks = [
    ['перемещение из стартовой локации, version+1', mg.fromIsStart === true && mg.versionBump === true],
    ['currentLocationId обновлён через StateService (F-1.16)', mg.currentIsTarget === true],
    ['повтор того же move → replayed, version не растёт (F-3.6)', mg.replayed === true && mg.versionUnchanged === true],
    ['детерминированный ключ не зависит от порядка playerIds', mg.deterministicKeyStable === true],
    ['LOCATION_CHANGED опубликовано ровно один раз', report.events['LOCATION_CHANGED'] === 1],
    ['locked exit → CORE_RULE_REJECTED (публичный RULE_REJECTED)', mg.lockedExit === 'CORE_RULE_REJECTED'],
    ['нет выхода → CORE_RULE_REJECTED', mg.noExit === 'CORE_RULE_REJECTED'],
    ['неизвестная локация → CORE_LOCATION_NOT_FOUND', mg.unknownTarget === 'CORE_LOCATION_NOT_FOUND'],
  ];
  const mgFailed = mgChecks.filter(([, ok]) => !ok).map(([name]) => name);
  record(
    'A1.15',
    'Локации и moveGroup: LOCATION_CHANGED, locked exit → RULE_REJECTED',
    mgFailed.length === 0 ? 'PASS' : 'FAIL',
    mgFailed.length === 0
      ? 'moveGroup: version+1, replay без двойного подъёма, locked/нет выхода → RULE_REJECTED, неизвестная → NOT_FOUND'
      : mgFailed.join('; '),
  );
}

const NOT_IMPLEMENTED = [
  [
    'A1.3',
    'Все WS/HTTP payload проходят Zod; неизвестный тип → VALIDATION',
    'схемы готовы (1.2, 71 contract-тест); enforcement в транспорте — промпты 1.10, 1.11',
  ],
  ['A1.7', 'Приватность: нет приватных данных в broadcast; view=ai|gm → 403', 'промпты 1.10, 1.11'],
  ['A1.8', 'GM Review: draft только GM, edit&approve, reject', 'промпты 1.8, 1.12'],
  ['A1.9', 'Реконнект после kill -9: полная проекция, offline-queue один раз', 'промпты 1.11, 1.12'],
  ['A1.10', 'Чат: публичные/приватные/системные, порядок, history', 'промпт 1.9'],
  ['A1.12', 'AI-стенды переключаются через env без правки кода', 'промпт 1.7'],
  ['A1.13', 'Capability Registry: breaker + CAPABILITY_CHANGED + /health', 'промпт 1.7'],
  ['A1.16', 'E2E «Стол»: 6 игроков + GM, полный цикл хода', 'промпт 1.13'],
];

function printTable() {
  const width = Math.max(...results.map((r) => r.title.length), 40);
  const line = (id, title, status, note) => {
    const mark = status === 'PASS' ? '✅ PASS' : status === 'FAIL' ? '❌ FAIL' : '⬜ N/A  ';
    return `${id.padEnd(7)} ${mark}  ${title.padEnd(width)}  ${note ?? ''}`;
  };
  process.stdout.write('\n=== МНЕМОСИН · verify:stage1 — критерии A1 ===\n\n');
  for (const r of results) process.stdout.write(line(r.id, r.title, r.status, r.note) + '\n');
  process.stdout.write('\n');

  const pass = results.filter((r) => r.status === 'PASS').length;
  const fail = results.filter((r) => r.status === 'FAIL').length;
  const na = results.filter((r) => r.status === 'NOT_IMPLEMENTED').length;
  process.stdout.write(`Итого: PASS ${pass} · FAIL ${fail} · ещё не реализовано ${na} (из 16 критериев A1)\n`);
  return fail;
}

async function main() {
  if (!existsSync(TSX)) {
    process.stderr.write('node_modules/.bin/tsx не найден — выполните npm install\n');
    process.exit(1);
  }

  await a1_1_serverStarts();
  await a1_1_failFast();
  await a1_2_boundaries();
  await a1_4_a1_5_persistenceGuarantees();
  await a1_6_a1_15_core();
  await a1_11_persistence();
  await a1_11b_outbox();
  await a1_14_extensibility();
  for (const [id, title, where] of NOT_IMPLEMENTED) {
    record(id, title, 'NOT_IMPLEMENTED', where);
  }

  // Гигиена: проверки поднимают сервер с DATABASE_URL=file:./data/verify.sqlite.
  // Файл в .gitignore, но оставлять мусор между прогонами незачем — следующий прогон
  // должен стартовать с пустой БД, иначе A1.11 увидит phase=ready вместо seeded.
  for (const name of ['verify.sqlite', 'verify.sqlite-wal', 'verify.sqlite-shm']) {
    try {
      rmSync(resolve(ROOT, 'data', name), { force: true });
    } catch {
      /* уже удалён */
    }
  }

  const failures = printTable();
  process.exit(failures > 0 ? 1 : 0);
}

await main();
