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
import WebSocket from 'ws';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env['VERIFY_PORT'] ?? 3911);
const BASE = `http://127.0.0.1:${PORT}`;
// Windows: шимы в node_modules/.bin — это .cmd; spawn без расширения = ENOENT.
const bin = (name) => resolve(ROOT, 'node_modules/.bin', process.platform === 'win32' ? `${name}.cmd` : name);
const TSX = bin('tsx');

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
    // tsx CLI порождает внутреннего ребёнка-сервер: остановка — по группе
    // процессов, иначе зомби держит порт и ломает следующие проверки.
    detached: true,
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });
  return { child, getStderr: () => stderr };
}

/** SIGKILL по группе и ожидание выхода; умерший child не вешает await. */
async function killGroupAndWait(child, timeoutMs = 5000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* уже мертвы */
    }
  }
  await Promise.race([
    new Promise((resolve) => child.on('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}

/** Остановка сервера: SIGTERM → 5 c → SIGKILL по ГРУППЕ процессов; не виснет на умершем child. */
async function stopServer(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const signalGroup = (sig) => {
    try {
      if (child.pid !== undefined) process.kill(-child.pid, sig);
    } catch {
      try {
        child.kill(sig);
      } catch {
        /* уже мертвы */
      }
    }
  };
  signalGroup('SIGTERM');
  const exited = await Promise.race([
    new Promise((resolve) => child.on('exit', () => resolve(true))),
    new Promise((resolve) => setTimeout(() => resolve(false), 5000)),
  ]);
  if (!exited && child.exitCode === null) {
    signalGroup('SIGKILL');
    await Promise.race([
      new Promise((resolve) => child.on('exit', () => resolve(true))),
      new Promise((resolve) => setTimeout(() => resolve(false), 3000)),
    ]);
  }
}

async function waitForHealth(timeoutMs = 30_000, child = null) {
  const deadline = Date.now() + timeoutMs;
  let lastError = 'timeout';
  while (Date.now() < deadline) {
    // Fail-fast: наш процесс умер (EADDRINUSE на порту, занятом чужим
    // сервером-зомби, crash старта) — иначе fetch может «успешно» отвечать
    // чужим процессом, а финальный await exit повиснет (промпт 1.13).
    if (child !== null && child.exitCode !== null) {
      throw new Error(`server process exited (${child.exitCode}) before becoming healthy: ${lastError}`);
    }
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.ok) {
        if (child !== null && child.exitCode !== null) {
          throw new Error(`порт ${PORT} отвечает чужим процессом: наш server умер`);
        }
        return await res.json();
      }
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
    const health = await waitForHealth(30_000, child);
    const version = await (await fetch(`${BASE}/version`)).json();

    const checks = [
      ['ok === true', health.ok === true],
      ['version present', typeof version.version === 'string' && version.version.length > 0],
      ['contractsVersion present', typeof version.contractsVersion === 'string'],
      // промпт 1.7: capabilities = срез CapabilityRegistry (A1.13); env приёмки — AI_PROVIDER=scripted
      [
        'capabilities: TEXT_AI available (промпт 1.7)',
        health.capabilities?.capabilities?.TEXT_AI?.available === true &&
          (health.capabilities?.capabilities?.TEXT_AI?.providers ?? []).includes('scripted'),
      ],
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
    await stopServer(child);
    if (getStderr().length > 0) process.stderr.write(getStderr());
  }
}

/**
 * A1.1/A1.4/A1.7 (промпт 1.10): HTTP-транспорт на ЖИВОМ сервере (fetch —
 * аналог curl-прогона из п.10 промта): создать сессию, join 2 игроками,
 * submit action, lock, дождаться REVIEW (scripted AI, auto-resolve D253),
 * commit → {version}; повтор commit → тот же version; view=ai под игроком → 403.
 */
async function a1_http_transport() {
  const dbFile = resolve(ROOT, 'data/verify-http.sqlite');
  try {
    rmSync(dbFile, { force: true });
    rmSync(`${dbFile}-shm`, { force: true });
    rmSync(`${dbFile}-wal`, { force: true });
  } catch {
    /* игнорируем */
  }
  // DB_SEED=false: посевная dev-сессия заблокировала бы POST /auth/session (D108).
  const { child, getStderr } = startServer({ DATABASE_URL: `file:${dbFile}`, DB_SEED: 'false' });
  const checks = [];
  const note = [];
  try {
    await waitForHealth(30_000, child);

    const post = async (url, body, token) => {
      const res = await fetch(`${BASE}${url}`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const get = async (url, token) => {
      const res = await fetch(`${BASE}${url}`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    // 1. POST /auth/session — создание сессии и GM-игрока (D122).
    const created = await post('/auth/session', {
      displayName: 'Ведущий приёмки',
      characterName: 'Архивариус',
      title: 'Приёмочная партия 1.10',
    });
    checks.push([
      'POST /auth/session → 200 + токены',
      created.status === 200 && !!created.body?.token && !!created.body?.refreshToken,
    ]);
    const sessionId = created.body?.sessionId;
    const gmToken = created.body?.token;

    // 2. join ×2.
    const joinA = await post(`/sessions/${sessionId}/join`, { displayName: 'Ирма', characterName: 'Ирма Векторова' });
    const joinB = await post(`/sessions/${sessionId}/join`, { displayName: 'Каймен', characterName: 'Каймен' });
    checks.push([
      'join ×2 → 200 + playerId/token',
      joinA.status === 200 && joinB.status === 200 && !!joinA.body?.playerId,
    ]);
    const playerAToken = joinA.body?.token;

    // 3. start → turnId; action; lock; ждём REVIEW (scripted AI).
    const started = await post(
      `/sessions/${sessionId}/start`,
      { idempotencyKey: `verify-http-start-${Date.now()}-000000` },
      gmToken,
    );
    const turnId = started.body?.turnId;
    checks.push(['POST /sessions/:id/start → 200 + turnId', started.status === 200 && typeof turnId === 'string']);
    const action = await post(
      `/turns/${turnId}/action`,
      { rawText: 'Осматриваю шлюз', idempotencyKey: `verify-http-act-${Date.now()}-000000` },
      playerAToken,
    );
    checks.push(['POST /turns/:id/action → 200', action.status === 200 && !!action.body?.actionId]);
    const lock = await post(
      `/turns/${turnId}/lock`,
      { idempotencyKey: `verify-http-lock-${Date.now()}-00000` },
      gmToken,
    );
    checks.push(['POST /turns/:id/lock → 200', lock.status === 200]);

    let status = 'UNKNOWN';
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const view = await get(`/turns/${turnId}`, gmToken);
      status = view.body?.status ?? status;
      if (status === 'REVIEW' || status === 'FAILED') break;
      await new Promise((r) => setTimeout(r, 500));
    }
    checks.push(['lock → auto-resolve → REVIEW (scripted AI, D253)', status === 'REVIEW']);

    // 4. commit → version; повтор с тем же ключом → тот же version (A1.4).
    const commitKey = `verify-http-commit-${Date.now()}-00000`;
    const commit1 = await post(`/turns/${turnId}/commit`, { idempotencyKey: commitKey }, gmToken);
    const commit2 = await post(`/turns/${turnId}/commit`, { idempotencyKey: commitKey }, gmToken);
    const sameVersion =
      commit1.status === 200 &&
      commit2.status === 200 &&
      typeof commit1.body?.version === 'number' &&
      commit1.body.version === commit2.body?.version;
    checks.push(['commit → {version}; повтор → тот же version (A1.4 через HTTP)', sameVersion]);

    // 5. Приватность (A1.7): ai/gm-виды под игроком → 403; под GM → 200.
    const aiAsPlayer = await get(`/state/projection/gm?sessionId=${sessionId}&view=ai`, playerAToken);
    const gmAsPlayer = await get(`/state/projection/gm?sessionId=${sessionId}&view=gm`, playerAToken);
    const aiAsGm = await get(`/state/projection/gm?sessionId=${sessionId}&view=ai`, gmToken);
    const publicAsPlayer = await get(`/state/projection?sessionId=${sessionId}&view=public`, playerAToken);
    checks.push(['view=ai|gm под игроком → 403 (A1.7)', aiAsPlayer.status === 403 && gmAsPlayer.status === 403]);
    checks.push([
      'view=ai под GM → 200; public под игроком → 200',
      aiAsGm.status === 200 && publicAsPlayer.status === 200,
    ]);

    // 6. player-токен на GM-маршруте → 403; без токена → 401 (B-11/B-12).
    const gmRouteAsPlayer = await post('/gm/inspect/state', { sessionId }, playerAToken);
    const noToken = await get(`/sessions/${sessionId}`);
    checks.push([
      'GM-маршрут под игроком → 403; без токена → 401',
      gmRouteAsPlayer.status === 403 && noToken.status === 401,
    ]);

    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    note.push(`${checks.length - failed.length}/${checks.length} HTTP-проверок`);
    record(
      'A1.3',
      'HTTP-транспорт: сессия/join/action/lock/commit через реальный HTTP',
      failed.length === 0 ? 'PASS' : 'FAIL',
      failed.length === 0 ? note.join('; ') : `не выполнено: ${failed.join(', ')}`,
    );
    record(
      'A1.4',
      'Идемпотентность через HTTP: повтор commit → тот же version (промпт 1.10)',
      sameVersion ? 'PASS' : 'FAIL',
      `version=${commit1.body?.version}`,
    );
    const privacyOk = aiAsPlayer.status === 403 && gmAsPlayer.status === 403 && aiAsGm.status === 200;
    record(
      'A1.7',
      'Приватность через HTTP: view=ai|gm под игроком → 403 (промпт 1.10)',
      privacyOk ? 'PASS' : 'FAIL',
      privacyOk
        ? 'WS-часть A1.7 — отдельная запись (ws-probe + property-тесты, промпт 1.11)'
        : `ai=${aiAsPlayer.status} gm=${gmAsPlayer.status} aiGm=${aiAsGm.status}`,
    );
  } catch (cause) {
    record('A1.3', 'HTTP-транспорт: сессия/join/action/lock/commit через реальный HTTP', 'FAIL', cause.message);
    record('A1.4', 'Идемпотентность через HTTP: повтор commit → тот же version (промпт 1.10)', 'FAIL', cause.message);
    record('A1.7', 'Приватность через HTTP: view=ai|gm под игроком → 403 (промпт 1.10)', 'FAIL', cause.message);
  } finally {
    await stopServer(child);
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
    record('A1.1', 'Fail-fast при невалидном env (без утечки секрета)', 'FAIL', `не выполнено: ${failed.join(', ')}`);
    if (stderr) process.stderr.write(stderr);
  } else {
    record('A1.1', 'Fail-fast при невалидном env (без утечки секрета)', 'PASS', `exit=${exitCode}`);
  }
}

/** A1.2: границы зависимостей — dependency-cruiser + arch-тесты. */
async function a1_2_boundaries() {
  const cruiser = spawnSync(
    bin('depcruise'),
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
  const archTests = spawnSync(bin('vitest'), ['run', '--project', 'arch', '--reporter=basic'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
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

/** A1.10: чат — видимости, история, sanitize, rate limit, доставка черновика (промпт 1.9). */
async function a1_10_chat() {
  let report;
  try {
    report = await runProbe(['tools/verify/chat-probe.ts'], 180000);
  } catch (cause) {
    record('A1.10', 'Чат: публичные/приватные/системные, порядок, history', 'FAIL', cause.message);
    return;
  }
  const checks = report.checks ?? {};
  const required = [
    'visibility',
    'history',
    'sanitizeAndLimits',
    'storySetFlag',
    'commitDelivery',
    'redeliveryNoDuplicates',
    'gmAudit',
    'registry',
  ];
  const failed = required.filter((k) => checks[k] !== true);
  record(
    'A1.10',
    'Чат: публичные/приватные/системные, порядок, history',
    failed.length === 0 ? 'PASS' : 'FAIL',
    failed.length === 0
      ? 'видимости (private — только адресат, GM — только GM), history-фильтры, sanitize+RATE_LIMIT, TURN_COMMITTED→доставка (ровно один раз), аудит append-only, реестр 9 модулей; транспорт — 1.11'
      : `не выполнено: ${failed.join(', ')}`,
  );
}

/** A1.12/A1.13: стенды переключаются env/config'ом; breaker, CAPABILITY_CHANGED, /health. */
async function a1_12_a1_13_switchProvider() {
  const child = spawn(process.execPath, ['tools/verify/switch-provider.mjs'], {
    cwd: ROOT,
    env: { ...process.env, VERIFY_AI_PORT: String(PORT + 2) },
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
    }, 240000);
    child.on('exit', (c) => {
      clearTimeout(timer);
      r(c ?? -1);
    });
  });

  let report = null;
  try {
    report = JSON.parse(stdout.trim().split('\n').filter(Boolean).pop() ?? 'null');
  } catch {
    report = null;
  }
  if (report === null || typeof report !== 'object') {
    record(
      'A1.12',
      'AI-стенды переключаются через env без правки кода',
      'FAIL',
      `switch-provider не вернул отчёт (exit ${code})`,
    );
    record(
      'A1.13',
      'Capability Registry: breaker + CAPABILITY_CHANGED + /health',
      'FAIL',
      'switch-provider не вернул отчёт',
    );
    if (stderr) process.stderr.write(stderr.slice(-800));
    return;
  }
  record(
    'A1.12',
    'AI-стенды переключаются через env без правки кода',
    report.A1_12 === 'PASS' ? 'PASS' : 'FAIL',
    'switch-provider: scripted→REVIEW, echo→нарратив действий, failing→FAILED{PROVIDER_TIMEOUT}',
  );
  record(
    'A1.13',
    'Capability Registry: breaker + CAPABILITY_CHANGED + /health',
    report.A1_13 === 'PASS' ? 'PASS' : 'FAIL',
    'switch-provider: breaker OPEN, CAPABILITY_CHANGED{TEXT_AI,false}, /health деградирует/восстанавливается',
  );
  // A1.14 switch-provider проверяет инвариантность core/modules ВО ВРЕМЯ сценариев;
  // сверка манифеста — в a1_14_extensibility (отдельный Record).
  if (report.A1_14 !== 'PASS') {
    record(
      'A1.14',
      'Расширяемость: core/ и modules/ не менялись при переключении',
      'FAIL',
      'switch-provider: код изменился во время сценариев',
    );
  }
}

/** A1.6 (движок, промпт 1.8) и A1.8 (GM-ревью на сервисном слое): turn-probe. */
async function a1_6_engine_a1_8_review() {
  let report;
  try {
    report = await runProbe(['tools/verify/turn-probe.ts'], 180000);
  } catch (cause) {
    record('A1.6', 'Turn Engine: resolveTurn/commitTurn — полный цикл (промпт 1.8)', 'FAIL', cause.message);
    record('A1.8', 'GM Review: edit&approve (hash→409), reject, retry (сервисный слой)', 'FAIL', cause.message);
    return;
  }
  const checks = report.checks ?? {};
  const engineKeys = [
    'resolveToReview',
    'resolveReplay',
    'commitVersion',
    'commitStatus',
    'objectChangeApplied',
    'd117NoAutoOpen',
    'approveReplay',
    'outboxEvents',
    'journalKinds',
    'providerFailure',
    'retryAfterProviderFailure',
  ];
  const reviewKeys = ['editHashConflict', 'editAndApprove', 'staleVersionConflict', 'rejectFlow', 'retryFromFailed'];
  const engineFailed = engineKeys.filter((k) => checks[k] !== true);
  const reviewFailed = reviewKeys.filter((k) => checks[k] !== true);
  record(
    'A1.6',
    'Turn Engine: resolveTurn/commitTurn — полный цикл (промпт 1.8)',
    engineFailed.length === 0 ? 'PASS' : 'FAIL',
    engineFailed.length === 0
      ? 'OPEN→…→COMMITTED движком: replay (B-08.4), версия+1, outbox/journal, D117 (без авто-open), FAILED{PROVIDER_TIMEOUT}→retry'
      : `не выполнено: ${engineFailed.join(', ')}`,
  );
  record(
    'A1.8',
    'GM Review: edit&approve (hash→409), reject, retry (сервисный слой)',
    reviewFailed.length === 0 ? 'PASS' : 'FAIL',
    reviewFailed.length === 0
      ? 'чужой hash → VERSION_CONFLICT c resolution в meta; правка AI_THEN_GM_EDIT применяется; stale version → 409; reject → FAILED; транспорт (draft только GM) — 1.10/1.12'
      : `не выполнено: ${reviewFailed.join(', ')}`,
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
      const health = await waitForHealth(30_000, child);
      return { health, stderr: getStderr() };
    } finally {
      await stopServer(child);
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
      'A1.11',
      title,
      failed.length === 0 ? 'PASS' : 'FAIL',
      failed.length === 0
        ? 'откат → 0 публикаций; commit → PUBLISHED + published_at; «крах» → републикация после рестарта'
        : failed.join('; '),
    );
  } catch (cause) {
    record('A1.11', title, 'FAIL', cause.message);
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

/**
 * A1.7 (+ WS-часть A1.3): приватность WS-broadcast на живом транспорте —
 * проба ws-probe.ts (GM + 3 игрока, полный цикл хода, сниффер envelope'ов,
 * инварианты WS_PRIVACY_POLICY / FORBIDDEN_IN_BROADCAST / GM_ONLY / TARGETED).
 * Property-based тесты (fast-check) — tests/integration/ws-privacy.property.test.ts.
 */
async function a1_7_ws_privacy() {
  let report;
  try {
    report = await runProbe(['tools/verify/ws-probe.ts']);
  } catch (cause) {
    record('A1.7', 'Приватность WS-broadcast: property-тесты «приватное не уходит в broadcast»', 'FAIL', cause.message);
    record('A1.3', 'Все WS/HTTP payload проходят Zod; неизвестный тип → VALIDATION', 'FAIL', cause.message);
    return;
  }
  const checks = report.checks ?? {};
  const names = Object.keys(checks);
  const failed = names.filter((name) => checks[name] !== true);
  const wsPrivacyOk =
    checks['broadcast_no_forbidden_fields'] === true &&
    checks['no_gm_only_to_players'] === true &&
    checks['targeted_matches_addressee'] === true &&
    checks['private_chat_only_to_addressee'] === true &&
    checks['gm_note_not_leaked'] === true &&
    checks['gm_got_full_resolution'] === true &&
    checks['turn_committed_shape'] === true;
  record(
    'A1.7',
    'Приватность WS-broadcast: property-тесты «приватное не уходит в broadcast»',
    wsPrivacyOk ? 'PASS' : 'FAIL',
    wsPrivacyOk
      ? `live-проба ws-probe (${names.length - failed.length}/${names.length}); fast-check: tests/integration/ws-privacy.property.test.ts; HTTP-часть (view=ai|gm → 403) — 1.10`
      : `не выполнено: ${failed.join(', ')}; ${JSON.stringify(report.details ?? {}).slice(0, 200)}`,
  );
  const a13Ok = checks['a13_ws_unknown_type_validation_alive'] === true;
  record(
    'A1.3',
    'Все WS/HTTP payload проходят Zod; неизвестный тип → VALIDATION',
    a13Ok ? 'PASS' : 'FAIL',
    a13Ok
      ? 'HTTP закрыт в 1.10 (Zod вход+ответ каждого маршрута); WS в 1.11: входящие — WSClientMessageSchema (неизвестный тип → ERROR VALIDATION без разрыва), исходящие — WSServerMessageSchema.parse перед send (инвариант 16)'
      : 'WS: неизвестный тип не дал VALIDATION или соединение разорвано',
  );
}

/** Мини-клиент WS для приёмки (A1.9). */
function wsClient(url, token, label) {
  const ws = new WebSocket(url, [`mnemosin.v1.${token}`]);
  const client = {
    label,
    ws,
    messages: [],
    closed: null,
    send(type, payload, extra = {}) {
      ws.send(JSON.stringify({ type, payload, ts: new Date().toISOString(), ...extra }));
    },
    async waitFor(pred, timeoutMs = 20000) {
      const deadline = Date.now() + timeoutMs;
      for (;;) {
        const found = client.messages.find(pred);
        if (found) return found;
        if (Date.now() > deadline) {
          throw new Error(`${label}: timeout (${client.messages.map((m) => m.type).join(',')})`);
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    },
  };
  ws.on('message', (data) => {
    try {
      const parsed = JSON.parse(data.toString('utf8'));
      client.messages.push({
        type: String(parsed.type ?? ''),
        payload: parsed.payload ?? {},
        requestId: parsed.requestId,
      });
    } catch {
      /* игнор */
    }
  });
  ws.on('close', (code, reason) => {
    client.closed = { code, reason: reason.toString('utf8') };
  });
  return new Promise((resolveConn, rejectConn) => {
    ws.on('open', () => resolveConn(client));
    ws.on('error', rejectConn);
  });
}

/**
 * A1.9: реконнект после kill -9 — живой сервер, WS-клиент, SIGKILL процесса,
 * подъём нового процесса на той же БД/порту, реконнект: полная проекция
 * (фиксированный порядок п.7 промта 1.11), переотправленное действие
 * применяется РОВНО один раз (F-6.7 + durable-идемпотентность модулей).
 */
async function a1_9_ws_reconnect() {
  const dbFile = resolve(ROOT, 'data/verify-ws9.sqlite');
  for (const suffix of ['', '-shm', '-wal']) {
    try {
      rmSync(`${dbFile}${suffix}`, { force: true });
    } catch {
      /* игнорируем */
    }
  }
  // Фиксированный JWT_SECRET: рестарт после kill -9 обязан принимать ТЕ ЖЕ
  // токены (иначе реконнект-контракт непроверяем); serverEnv по умолчанию
  // генерирует случайный секрет на каждый startServer.
  const env = {
    DATABASE_URL: `file:${dbFile}`,
    DB_SEED: 'false',
    JWT_SECRET: 'a19-verify-secret-0123456789abcdef0123456789abcdef',
  };
  let server = startServer(env);
  const checks = [];
  let client = null;
  try {
    await waitForHealth(30_000, server.child);
    const post = async (url, body, token) => {
      const res = await fetch(`${BASE}${url}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
        body: JSON.stringify(body ?? {}),
      });
      return { status: res.status, body: await res.json().catch(() => null) };
    };
    const get = async (url, token) => {
      const res = await fetch(`${BASE}${url}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
      return { status: res.status, body: await res.json().catch(() => null) };
    };

    const created = await post('/auth/session', {
      displayName: 'Ведущий A1.9',
      characterName: 'Ведущий',
      title: 'Реконнект',
    });
    const sessionId = created.body?.sessionId;
    const gmToken = created.body?.token;
    const joined = await post(`/sessions/${sessionId}/join`, { displayName: 'Ирма', characterName: 'Ирма' });
    const playerToken = joined.body?.token;
    const started = await post(
      `/sessions/${sessionId}/start`,
      { idempotencyKey: `verify-ws9-start-${Date.now()}-0000` },
      gmToken,
    );
    const turnId = started.body?.turnId;
    checks.push(['сессия+игрок+ход созданы', Boolean(sessionId && playerToken && turnId)]);

    // 1. Подключение, действие с ack.
    const wsUrl = `ws://127.0.0.1:${PORT}/ws`;
    client = await wsClient(wsUrl, playerToken, 'p1');
    await client.waitFor((m) => m.type === 'AUTH_OK');
    const requestId = `req-${randomBytes(8).toString('hex')}`;
    const key = `verify-ws9-act-${Date.now()}-0000`;
    client.send(
      'ACTION_SUBMIT',
      { turnId, rawText: 'Держу дверь шлюза', idempotencyKey: key, requestId },
      { requestId },
    );
    const firstAck = await client.waitFor((m) => m.type === 'ACTION_ACK' && m.requestId === requestId);
    checks.push(['действие до kill → ACTION_ACK', Boolean(firstAck.payload?.actionId)]);

    // 2. kill -9 → подъём нового процесса на той же БД/порту.
    client.ws.removeAllListeners('error');
    client.ws.on('error', () => {});
    await killGroupAndWait(server.child);
    server = startServer(env);
    await waitForHealth(30_000, server.child);
    checks.push(['сервер убит (SIGKILL) и поднят заново', true]);

    // 3. Реконнект: фиксированный порядок reconnect-контракта (п.7).
    client = await wsClient(wsUrl, playerToken, 'p1-re');
    await client.waitFor((m) => m.type === 'PLAYER_PRESENCE');
    const sequence = client.messages.map((m) => m.type).slice(0, 7);
    const expected = [
      'HELLO',
      'AUTH_OK',
      'STATE_PROJECTION',
      'STATE_PROJECTION_PRIVATE',
      'TURN_UPDATE',
      'SESSION_STATUS',
      'PLAYER_PRESENCE',
    ];
    checks.push([
      `reconnect-последовательность ${expected.join('→')}`,
      JSON.stringify(sequence) === JSON.stringify(expected),
    ]);
    const turnUpdate = client.messages.find((m) => m.type === 'TURN_UPDATE');
    checks.push([
      'TURN_UPDATE реконнекта содержит свои действия (offline-queue reconcile)',
      Array.isArray(turnUpdate?.payload?.myActions) &&
        turnUpdate.payload.myActions.some((a) => a.actionId === firstAck.payload?.actionId),
    ]);

    // 4. Переотправка НЕполучившего ack действия (тот же requestId+ключ) — ровно один раз.
    client.send(
      'ACTION_SUBMIT',
      { turnId, rawText: 'Держу дверь шлюза', idempotencyKey: key, requestId },
      { requestId },
    );
    const replayAck = await client.waitFor((m) => m.type === 'ACTION_ACK' && m.requestId === requestId);
    checks.push([
      'переотправка → тот же actionId (ровно один раз)',
      replayAck.payload?.actionId === firstAck.payload?.actionId,
    ]);
    const req2 = `req-${randomBytes(8).toString('hex')}`;
    client.send(
      'ACTION_SUBMIT',
      { turnId, rawText: 'Смотрю на панель', idempotencyKey: `verify-ws9-act2-${Date.now()}-000`, requestId: req2 },
      { requestId: req2 },
    );
    await client.waitFor((m) => m.type === 'ACTION_ACK' && m.requestId === req2);
    const view = await get(`/turns/${turnId}`, gmToken);
    checks.push(['в ходе ровно 2 действия (дубль не применён)', view.body?.actionCount === 2]);

    const failed = checks.filter(([, ok]) => !ok).map(([name]) => name);
    record(
      'A1.9',
      'Реконнект после kill -9: полная проекция, offline-queue один раз',
      failed.length === 0 ? 'PASS' : 'FAIL',
      failed.length === 0
        ? `${checks.length}/${checks.length}: kill -9 → restart → фиксированная reconnect-последовательность, TURN_UPDATE.myActions для reconcile, переотправка requestId+idempotencyKey применена один раз (actionCount=2)`
        : `не выполнено: ${failed.join(', ')}`,
    );
  } catch (cause) {
    record('A1.9', 'Реконнект после kill -9: полная проекция, offline-queue один раз', 'FAIL', cause.message);
  } finally {
    if (client) {
      try {
        client.ws.terminate();
      } catch {
        /* игнорируем */
      }
    }
    await killGroupAndWait(server.child);
    for (const suffix of ['', '-shm', '-wal']) {
      try {
        rmSync(`${dbFile}${suffix}`, { force: true });
      } catch {
        /* игнорируем */
      }
    }
  }
}

// Промпт 1.13: все 16 критериев проверяются здесь; A1.16 — запуском
// браузерного сценария «Стол» (e2e/stage1-table.spec.ts, 7 контекстов).
const NOT_IMPLEMENTED = [];

/** A1.16: сквозной Playwright-сценарий «Стол» (6 игроков + GM). */
async function a1_16_e2e_table() {
  const run = spawnSync(
    bin('playwright'),
    ['test', '--config', 'e2e/playwright.config.ts', 'e2e/stage1-table.spec.ts'],
    { cwd: ROOT, encoding: 'utf8', timeout: 600_000 },
  );
  const tail = (run.stdout ?? '').split('\n').slice(-6).join(' ').slice(0, 220);
  if (run.status === 0) {
    record('A1.16', 'E2E «Стол»: 6 игроков + GM, полный цикл хода (7 браузерных контекстов)', 'PASS', tail);
  } else {
    record(
      'A1.16',
      'E2E «Стол»: 6 игроков + GM, полный цикл хода (7 браузерных контекстов)',
      'FAIL',
      `${tail} ${(run.stderr ?? '').slice(-200)}`,
    );
  }
}

const CRITERIA_ORDER = [
  'A1.1',
  'A1.2',
  'A1.3',
  'A1.4',
  'A1.5',
  'A1.6',
  'A1.7',
  'A1.8',
  'A1.9',
  'A1.10',
  'A1.11',
  'A1.12',
  'A1.13',
  'A1.14',
  'A1.15',
  'A1.16',
];

/** Агрегация детальных записей по 16 критериям: FAIL перекрывает PASS. */
function aggregate() {
  const byId = new Map();
  for (const row of results) {
    const prev = byId.get(row.id);
    if (prev === undefined) {
      byId.set(row.id, { ...row, notes: [row.note] });
    } else {
      prev.notes.push(row.note);
      if (row.status === 'FAIL') prev.status = 'FAIL';
      else if (row.status === 'PASS' && prev.status === 'NOT_IMPLEMENTED') prev.status = 'PASS';
    }
  }
  return byId;
}

function printTable() {
  const byId = aggregate();
  const rows = CRITERIA_ORDER.map((id) => byId.get(id)).filter((row) => row !== undefined);
  const width = Math.max(...rows.map((r) => r.title.length), 40);
  const line = (id, title, status, note) => {
    const mark = status === 'PASS' ? '✅ PASS' : status === 'FAIL' ? '❌ FAIL' : '⬜ N/A  ';
    return `${id.padEnd(7)} ${mark}  ${title.padEnd(width)}  ${note ?? ''}`;
  };
  process.stdout.write('\n=== МНЕМОСИН · verify:stage1 — критерии A1 (этап 1 «Стол») ===\n\n');
  for (const r of rows) {
    const note = (r.notes ?? [r.note]).filter(Boolean).join(' · ');
    process.stdout.write(line(r.id, r.title, r.status, note.slice(0, 240)) + '\n');
  }
  // Детальные строки вне 16 критериев (служебные прогoны) — в verbose-хвост.
  const extra = results.filter((row) => !CRITERIA_ORDER.includes(row.id));
  if (extra.length > 0) {
    process.stdout.write('\n--- детализация прогонов ---\n');
    for (const r of extra) {
      process.stdout.write(line(r.id, r.title, r.status, (r.note ?? '').slice(0, 200)) + '\n');
    }
  }
  process.stdout.write('\n');

  let pass = 0;
  let fail = 0;
  let na = 0;
  for (const id of CRITERIA_ORDER) {
    const row = byId.get(id);
    if (row === undefined || row.status === 'NOT_IMPLEMENTED') na += 1;
    else if (row.status === 'FAIL') fail += 1;
    else pass += 1;
  }
  process.stdout.write(`Итого: PASS ${pass}/16 · FAIL ${fail} · не реализовано ${na}\n`);
  return fail + na;
}

async function main() {
  // Preflight: порт приёмки не должен отвечать чужим процессом (зомби прошлых
  // прогонов): иначе проверки молча идут против чужого сервера (промпт 1.13).
  try {
    const res = await fetch(`${BASE}/health`);
    if (res.ok) {
      process.stderr.write(
        `FATAL: ${BASE}/health отвечает ДО старта проверок — порт ${PORT} занят чужим процессом. Остановите его и повторите.\n`,
      );
      process.exit(2);
    }
  } catch {
    /* порт свободен — ожидаемое состояние */
  }

  if (!existsSync(TSX)) {
    process.stderr.write('node_modules/.bin/tsx не найден — выполните npm install\n');
    process.exit(1);
  }

  await a1_1_serverStarts();
  await a1_http_transport();
  await a1_1_failFast();
  await a1_2_boundaries();
  await a1_4_a1_5_persistenceGuarantees();
  await a1_6_a1_15_core();
  await a1_11_persistence();
  await a1_11b_outbox();
  await a1_6_engine_a1_8_review();
  await a1_10_chat();
  await a1_7_ws_privacy();
  await a1_9_ws_reconnect();
  await a1_14_extensibility();
  await a1_12_a1_13_switchProvider();
  await a1_16_e2e_table();
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
