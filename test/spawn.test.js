#!/usr/bin/env node
/**
 * Integration test for bin/review.js spawn behaviour:
 *   1. Pre-flight catches missing engine binary (exit 127)
 *   2. stdio[0]='ignore' so engines see EOF on stdin (no hang)
 *   3. Heartbeat fires when engine is silent
 *   4. Timeout kills hung engine with exit 124
 *   5. Tail flushed to stdout on exit when stdout was suppressed
 *   6. branch shortcut auto-detects default branch (smoke)
 *
 * Uses test/fixtures/codex (a node-based fake) as the engine binary, exposed
 * via PATH=fixtures:$PATH. Tests are independent and runnable in parallel.
 */

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const REVIEW = path.join(__dirname, '..', 'bin', 'review.js');
const FIXTURES = path.join(__dirname, 'fixtures');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'so-spawn-test-'));

let pass = 0;
let fail = 0;

function record(name, ok, info) {
  if (ok) {
    pass += 1;
    console.log(`PASS [${name}]`);
  } else {
    fail += 1;
    console.log(`FAIL [${name}]${info ? `: ${info}` : ''}`);
  }
}

// Helper: run review.js with a given env. Returns spawnSync result with the
// log file path injected at result.logPath. Captures stdout + stderr as
// strings.
function runReview({ env = {}, args = [], logPath, timeoutMs = 30_000 }) {
  const finalLog =
    logPath || path.join(TMP, `log-${Date.now()}-${Math.random()}.log`);
  const finalEnv = {
    ...process.env,
    // Shim PATH so `codex` resolves to our fake.
    PATH: `${FIXTURES}:${process.env.PATH}`,
    ...env,
  };
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      '--cwd=' + process.cwd(),
      `--log=${finalLog}`,
      ...args,
    ],
    { encoding: 'utf8', env: finalEnv, timeout: timeoutMs }
  );
  r.logPath = finalLog;
  r.logContent = '';
  try {
    r.logContent = fs.readFileSync(finalLog, 'utf8');
  } catch {
    /* may not exist on failure paths */
  }
  return r;
}

// ─── Test 1: pre-flight catches missing binary ────────────────────────────
{
  // Wipe PATH (apart from /usr/bin for spawnSync itself) so `codex` is gone.
  const r = spawnSync(
    process.execPath,
    [REVIEW, '--engine=codex', '--cwd=' + process.cwd(), 'noop'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: '/usr/bin:/bin' },
      timeout: 5000,
    }
  );
  const ok = r.status === 127 && /not found on PATH/i.test(r.stderr || '');
  record(
    'preflight missing binary → exit 127',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 2: stdio[0]='ignore' → fake engine sees EOF on stdin ────────────
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'echo-stdin' }, args: ['noop'] });
  const ok =
    r.status === 0 &&
    /STDIN_CLOSED bytes=0/.test(r.logContent) &&
    !/STDIN_HANG/.test(r.logContent);
  record(
    'stdio ignore: child stdin is EOF',
    ok,
    `status=${r.status} logTail=${r.logContent.slice(-200)}`
  );
}

// ─── Test 3: heartbeat fires when engine silent ───────────────────────────
{
  // Fake sleeps 5s with no output; heartbeat=1s → expect ≥2 heartbeats.
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'silent 3' },
    args: ['--heartbeat=1', '--timeout=15', 'noop'],
  });
  const matches = (r.logContent.match(/^# heartbeat /gm) || []).length;
  const ok = r.status === 0 && matches >= 2;
  record(
    'heartbeat: ≥2 ticks when engine silent',
    ok,
    `status=${r.status} heartbeats=${matches}`
  );
}

// ─── Test 4: timeout kills hung engine with exit 124 ──────────────────────
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'hang' },
    args: ['--timeout=2', '--heartbeat=0', 'noop'],
    timeoutMs: 20_000,
  });
  const ok =
    r.status === 124 &&
    /TIMEOUT after/.test(r.logContent) &&
    /SIGTERM/.test(r.logContent);
  record(
    'timeout: hung engine killed with exit 124',
    ok,
    `status=${r.status} sigterm=${/SIGTERM/.test(r.logContent)}`
  );
}

// ─── Test 5: tail flushed to stdout on exit when suppressed ───────────────
{
  // spawnSync inherits no TTY → stdout is suppressed in review.js. We expect
  // the engine's last bytes to appear on stdout after exit.
  const r = runReview({ env: { FAKE_BEHAVIOR: 'ok' }, args: ['noop'] });
  const ok =
    r.status === 0 &&
    /engine output tail/i.test(r.stdout || '') &&
    /\[fake-codex ok\] review complete/.test(r.stdout || '');
  record(
    'tail: last bytes flushed to stdout on exit',
    ok,
    `status=${r.status} stdoutTail=${(r.stdout || '').slice(-200)}`
  );
}

// ─── Test 6: --diff=branch auto-detects default branch ────────────────────
// Smoke only — works if this checkout has origin/HEAD set. If not, the
// resolver returns null and we fall back to HEAD~1..HEAD. Either way the
// command should NOT fail with a hard error from missing origin/main.
{
  // Use a tiny prompt and FAKE ok so the engine doesn't actually need to
  // process anything. We only care that diff resolution succeeded.
  const repo = path.join(__dirname, '..');
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      `--cwd=${repo}`,
      '--diff=branch',
      `--log=${path.join(TMP, 'branch.log')}`,
      'noop',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_BEHAVIOR: 'ok',
      },
      timeout: 15_000,
    }
  );
  // We don't assert on exit code (the diff may be empty in CI), but stderr
  // must NOT show the old `git diff origin/main..HEAD failed` message — it
  // should either succeed, or fall back cleanly to HEAD~1..HEAD.
  const oldFailureMsg = /git diff origin\/main\.\.HEAD failed/.test(
    r.stderr || ''
  );
  const ok = !oldFailureMsg;
  record(
    'branch shortcut: no hard-coded origin/main failure',
    ok,
    `stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Concurrency helpers ──────────────────────────────────────────────────
// Run a 2-slot codex fusion (same engine, two models → two distinct slots) with
// the `probe` fake, which records START/END timestamps to a shared file. Parse
// the intervals so tests can assert overlap (parallel) vs no-overlap (serial).
function runFusionProbe({ args = [], probeName, sleepSec = 1 }) {
  const probe = path.join(TMP, probeName);
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex:m1',
      '--engine=codex:m2',
      '--cwd=' + process.cwd(),
      '--heartbeat=0',
      ...args,
      'noop',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_BEHAVIOR: `probe ${sleepSec}`,
        FAKE_PROBE_FILE: probe,
      },
      timeout: 30_000,
    }
  );
  let starts = [];
  let ends = [];
  try {
    const rows = fs
      .readFileSync(probe, 'utf8')
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((l) => l.split(/\s+/));
    starts = rows
      .filter((e) => e[0] === 'START')
      .map((e) => Number(e[2]))
      .sort((a, b) => a - b);
    ends = rows
      .filter((e) => e[0] === 'END')
      .map((e) => Number(e[2]))
      .sort((a, b) => a - b);
  } catch {
    /* file may be absent on failure paths */
  }
  return { r, starts, ends };
}

// ─── Test 7: --concurrency=1 serializes fusion children ───────────────────
{
  const { r, starts, ends } = runFusionProbe({
    args: ['--concurrency=1'],
    probeName: 'probe-serial.log',
  });
  // Serialized: the second child must START at/after the first child's END.
  const ok =
    r.status === 0 &&
    starts.length === 2 &&
    ends.length === 2 &&
    starts[1] >= ends[0];
  record(
    'concurrency=1: fusion children run serially',
    ok,
    `status=${r.status} starts=${starts} ends=${ends}`
  );
}

// ─── Test 8: default (unbounded) fusion runs children in parallel ─────────
{
  const { r, starts, ends } = runFusionProbe({
    args: [],
    probeName: 'probe-parallel.log',
  });
  // Parallel: the second child STARTs before the first child ENDs (overlap).
  const ok =
    r.status === 0 &&
    starts.length === 2 &&
    ends.length === 2 &&
    starts[1] < ends[0];
  record(
    'default: fusion children run in parallel (overlap)',
    ok,
    `status=${r.status} starts=${starts} ends=${ends}`
  );
}

// ─── Test 9: invalid --concurrency rejected ───────────────────────────────
{
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex:m1',
      '--engine=codex:m2',
      '--cwd=' + process.cwd(),
      '--concurrency=abc',
      'noop',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${FIXTURES}:${process.env.PATH}` },
      timeout: 10_000,
    }
  );
  const ok = r.status === 1 && /--concurrency/.test(r.stderr || '');
  record(
    'concurrency: invalid value → exit 1',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── agy model passthrough helpers ───────────────────────────────────────
// Run review.js against the fake `agy` binary, which dumps its argv to a file.
// Returns the recorded argv as an array of lines so tests can assert whether
// review.js forwarded --model.
function runAgyArgv({ engineSpec, probeName, extraArgs = [], cwd, env = {} }) {
  const argvFile = path.join(TMP, probeName);
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      engineSpec,
      '--cwd=' + (cwd || process.cwd()),
      `--log=${path.join(TMP, probeName + '.engine.log')}`,
      ...extraArgs,
      'noop',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_ARGV_FILE: argvFile,
        ...env,
      },
      timeout: 15_000,
    }
  );
  let argv = [];
  try {
    argv = fs
      .readFileSync(argvFile, 'utf8')
      .split('\n')
      .filter((l) => l.length > 0);
  } catch {
    /* file may be absent on failure paths */
  }
  return { r, argv };
}

// ─── Test 10: agy forwards inline model as --model ────────────────────────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=agy:gpt-oss',
    probeName: 'agy-model',
  });
  const mi = argv.indexOf('--model');
  const printIdx = argv.indexOf('--print');
  const ok =
    r.status === 0 &&
    mi >= 0 &&
    argv[mi + 1] === 'gpt-oss' &&
    printIdx >= 0 &&
    mi < printIdx; // --model must precede --print (prompt follows --print)
  record(
    'agy: inline model forwarded as --model (before --print)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 11: agy omits --model when no model given ───────────────────────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=agy',
    probeName: 'agy-nomodel',
  });
  const ok =
    r.status === 0 && !argv.includes('--model') && argv.includes('--print');
  record(
    'agy: no model → no --model flag, still --print',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 12: review.js flag after `--` → warning, still forwarded ────────
// `--concurrency=3` after the bare `--` is the documented footgun: it goes to
// the engine CLI, not review.js. We must (a) emit a clear stderr note and
// (b) still run the engine (pass-through contract intact). The fake codex
// ignores its own argv, so it exits 0 regardless.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: ['noop', '--', '--concurrency=3'],
  });
  const warned =
    /look like review\.js flag/i.test(r.stderr || '') &&
    /--concurrency=3/.test(r.stderr || '');
  const stillRan = r.status === 0 && /\[fake-codex ok\]/.test(r.logContent);
  record(
    'misplaced-flag guard: warns yet forwards (engine still runs)',
    warned && stillRan,
    `status=${r.status} warned=${warned} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 13: no false positive when engine args are not review.js flags ──
// Genuine engine args after `--` must NOT trigger the warning.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: ['noop', '--', '--some-engine-flag', 'value'],
  });
  const ok =
    r.status === 0 && !/look like review\.js flag/i.test(r.stderr || '');
  record(
    'misplaced-flag guard: no false positive on real engine args',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 14: cmd forwards inline model as -m (before --print prompt) ──────
// runAgyArgv is engine-agnostic (it just runs the given engineSpec with a
// FAKE_ARGV_FILE), so reuse it for the fake `cmd` fixture too.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=cmd:claude-sonnet-4-6',
    probeName: 'cmd-model',
  });
  const mi = argv.indexOf('-m');
  const printIdx = argv.indexOf('--print');
  const ok =
    r.status === 0 &&
    mi >= 0 &&
    argv[mi + 1] === 'claude-sonnet-4-6' &&
    printIdx >= 0 &&
    argv.includes('--skip-onboarding');
  record(
    'cmd: inline model forwarded as -m, with --print + --skip-onboarding',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 15: cmd omits -m when no model given, keeps functional flags ─────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=cmd',
    probeName: 'cmd-nomodel',
  });
  const ok =
    r.status === 0 &&
    !argv.includes('-m') &&
    argv.includes('--print') &&
    argv.includes('--skip-onboarding');
  record(
    'cmd: no model → no -m, still --print + --skip-onboarding',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 16: cursor alias resolves to `agent`; inline model → --model ─────
// `--engine=cursor:<model>` must (a) resolve the alias to the `agent` binary
// (our fake fixture) and (b) forward the model as --model, with the functional
// --print + --trust flags and the gated --plan safety flag present.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=cursor:sonnet-4',
    probeName: 'cursor-model',
  });
  const mi = argv.indexOf('--model');
  const ok =
    r.status === 0 &&
    mi >= 0 &&
    argv[mi + 1] === 'sonnet-4' &&
    argv.includes('--print') &&
    argv.includes('--trust') &&
    argv.includes('--plan');
  record(
    'cursor alias: resolves to agent, model forwarded as --model (+ --print/--trust/--plan)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 17: agent omits --model when no model, keeps functional flags ────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=agent',
    probeName: 'agent-nomodel',
  });
  const ok =
    r.status === 0 &&
    !argv.includes('--model') &&
    argv.includes('--print') &&
    argv.includes('--trust');
  record(
    'agent: no model → no --model, still --print + --trust',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 18: codex forwards --skip-git-repo-check (after exec, before prompt)
// review.js must auto-append --skip-git-repo-check so codex exec doesn't
// hard-fail ("Not inside a trusted directory") when --cwd isn't a git repo.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'codex-trust',
  });
  const execIdx = argv.indexOf('exec');
  const skipIdx = argv.indexOf('--skip-git-repo-check');
  const promptIdx = argv.indexOf('noop');
  const ok =
    r.status === 0 && execIdx >= 0 && skipIdx > execIdx && promptIdx > skipIdx;
  record(
    'codex: --skip-git-repo-check forwarded (exec < flag < prompt)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 19: codex --skip-git-repo-check survives --unrestricted ──────────
// It is a FUNCTIONAL flag, not a safety flag, so --unrestricted (which drops
// -s/read-only) must NOT drop it.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'codex-trust-unrestricted',
    extraArgs: ['--unrestricted'],
  });
  const ok =
    r.status === 0 &&
    argv.includes('--skip-git-repo-check') &&
    !argv.includes('read-only'); // safety flag dropped by --unrestricted
  record(
    'codex: --skip-git-repo-check kept under --unrestricted (safety dropped)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 20: codex unavailable pinned model preserves failure ─────────────
// Codex has no reliable local model-listing command. If a user pins a model
// that this Codex install/account cannot use, keep the original failure and
// add a recovery hint instead of silently retrying with a different model.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex:gpt-5.4-mini',
    probeName: 'codex-model-fallback',
    env: { FAKE_BEHAVIOR: 'model-unavailable' },
  });
  const logPath = path.join(TMP, 'codex-model-fallback.engine.log');
  const log = fs.readFileSync(logPath, 'utf8');
  const ok =
    r.status === 2 &&
    argv.includes('-m') &&
    argv.includes('gpt-5.4-mini') &&
    /model 'gpt-5\.4-mini' not available/.test(log) &&
    /codex model unavailable/.test(log) &&
    /bare --engine=codex/.test(log);
  record(
    'codex: unavailable pinned model preserves failure with hint',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)} log=${log.slice(-400)}`
  );
}

// ─── Test 21: gemini forwards --skip-trust (with -p) ──────────────────────
// review.js must auto-append --skip-trust so gemini doesn't hard-fail
// ("not running in a trusted directory") in headless mode.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=gemini',
    probeName: 'gemini-trust',
  });
  const ok =
    r.status === 0 && argv.includes('--skip-trust') && argv.includes('-p');
  record(
    'gemini: --skip-trust forwarded (with -p)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 22: gemini --skip-trust survives --unrestricted ─────────────────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=gemini',
    probeName: 'gemini-trust-unrestricted',
    extraArgs: ['--unrestricted'],
  });
  const ok =
    r.status === 0 && argv.includes('--skip-trust') && !argv.includes('-s'); // gemini safety flag dropped by --unrestricted
  record(
    'gemini: --skip-trust kept under --unrestricted (safety dropped)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 22: opencode forwards --dir <cwd> ───────────────────────────────
// review.js must pass --dir <cwd> so opencode scopes its sandbox file-access
// root to the review cwd (otherwise subtree reads are "external_directory").
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=opencode:testprov/testmodel',
    probeName: 'opencode-dir',
    env: { FAKE_OPENCODE_HELP: 'dir' }, // R1: advertised branch
  });
  const dirIdx = argv.indexOf('--dir');
  const ok =
    r.status === 0 &&
    argv.includes('run') &&
    dirIdx >= 0 &&
    argv[dirIdx + 1] === process.cwd() &&
    argv.includes('--model');
  record(
    'opencode: --dir <cwd> forwarded (with run + --model)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 22b: opencode omits --model when no model given ─────────────────
// Bare --engine=opencode must let opencode pick its configured default model:
// review.js spawns `run --dir <cwd>` with NO --model (mirrors kilo). Before,
// opencode was MODEL_REQUIRED and review.js hard-failed (exit 1) here.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=opencode',
    probeName: 'opencode-nomodel',
    env: { FAKE_OPENCODE_HELP: 'dir' }, // R1: advertised branch
  });
  const ok =
    r.status === 0 &&
    argv.includes('run') &&
    argv.includes('--dir') &&
    !argv.includes('--model');
  record(
    'opencode: omits --model when no model given (uses CLI default)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── opencode --dir capability probe (R1–R4, c1–c12) ──────────────────────
// bin/lib/harnesses.js probes `opencode run --help` and pushes `--dir <cwd>`
// only when a `--dir` flag line is advertised (installed opencode v2.2.1
// removed it and exits 1 on the unknown flag). The fake opencode fixture
// selects the probe output via FAKE_OPENCODE_HELP and logs each probe's argv
// to FAKE_HELP_LOG (exact content for a single probe: 'run\n--help\n').
const PROBE_LOG_EXPECTED = 'run\n--help\n';

function runOpencodeProbe({
  mode,
  engineSpec = '--engine=opencode',
  name,
  extraArgs = [],
  cwd,
}) {
  const helpLog = path.join(TMP, `${name}.helplog`);
  const t0 = Date.now();
  const { r, argv } = runAgyArgv({
    engineSpec,
    probeName: name,
    extraArgs,
    cwd,
    env: { FAKE_OPENCODE_HELP: mode, FAKE_HELP_LOG: helpLog },
  });
  const elapsedMs = Date.now() - t0;
  let helpLogContent = '';
  try {
    helpLogContent = fs.readFileSync(helpLog, 'utf8');
  } catch {
    /* absent when the probe never ran */
  }
  let engineLog = '';
  try {
    engineLog = fs.readFileSync(path.join(TMP, name + '.engine.log'), 'utf8');
  } catch {
    /* absent on failure paths */
  }
  return { r, argv, helpLogContent, engineLog, elapsedMs };
}

// c1 | happy
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'dir',
    engineSpec: '--engine=opencode:p/m',
    name: 'oc-c1',
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 7)) ===
      JSON.stringify([
        'run',
        '--dir',
        process.cwd(),
        '--model',
        'p/m',
        '--agent',
        'plan',
      ]) &&
    argv.slice(7).join('\n').includes('noop'); // prompt follows the exact 7-element prefix
  record(
    'c1: R1 — opencode:p/m, probe advertises --dir → probe ran as `run --help`; argv `run --dir <cwd> --model p/m --agent plan <prompt>`',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 8))}`
  );
}

// c2 | happy
{
  const { r, argv, helpLogContent, engineLog } = runOpencodeProbe({
    mode: 'nodir',
    name: 'oc-c2',
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 3)) ===
      JSON.stringify(['run', '--agent', 'plan']) &&
    !argv.includes('--dir') &&
    argv.length > 3 &&
    /\[fake-opencode ok\] review complete/.test(engineLog);
  record(
    'c2: R2 — bare opencode, probe does not advertise --dir → argv `run --agent plan <prompt>`, no --dir, exit 0, envelope extracted',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 5))}`
  );
}

// c3 | happy
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'nodir',
    engineSpec: '--engine=opencode:p/m',
    name: 'oc-c3',
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 5)) ===
      JSON.stringify(['run', '--model', 'p/m', '--agent', 'plan']) &&
    !argv.includes('--dir');
  record(
    'c3: R2 — opencode:p/m, probe does not advertise --dir → argv keeps --model p/m, no --dir',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 6))}`
  );
}

// c4 | weird
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'dir',
    name: 'oc-c4',
    extraArgs: ['--unrestricted'],
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 3)) ===
      JSON.stringify(['run', '--dir', process.cwd()]) &&
    !argv.includes('--agent') &&
    !argv.includes('plan');
  record(
    'c4: R4 — --unrestricted opencode, probe advertises --dir → `--dir <cwd>` kept; --agent and plan absent',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 5))}`
  );
}

// c5 | weird
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'nodir',
    name: 'oc-c5',
    extraArgs: ['--unrestricted'],
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 1)) === JSON.stringify(['run']) &&
    argv.length > 1 &&
    !argv.includes('--dir') &&
    !argv.includes('--agent') &&
    !argv.includes('plan');
  record(
    'c5: R2/R4 — --unrestricted opencode, probe does not advertise --dir → no --dir, no --agent',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 5))}`
  );
}

// c6 | edge
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'prose-dir',
    name: 'oc-c6',
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 3)) ===
      JSON.stringify(['run', '--agent', 'plan']) &&
    !argv.includes('--dir') &&
    argv.length > 3 &&
    argv.slice(3).join('\n').includes('noop');
  record(
    'c6: R3 — help mentions --dir only mid-line in prose → not advertised → no --dir',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 5))}`
  );
}

// c7 | edge
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'directory-flag',
    name: 'oc-c7',
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 3)) ===
      JSON.stringify(['run', '--agent', 'plan']) &&
    !argv.includes('--dir') &&
    argv.length > 3 &&
    argv.slice(3).join('\n').includes('noop');
  record(
    'c7: R3 — help advertises only --directory → not advertised → no --dir',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 5))}`
  );
}

// c8 | edge
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'stderr-dir',
    name: 'oc-c8',
  });
  const dirIdx = argv.indexOf('--dir');
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    dirIdx === 1 &&
    argv[dirIdx + 1] === process.cwd();
  record(
    'c8: R1/R3 — --dir flag line on stderr only (stdout empty) → advertised → `--dir <cwd>` present',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 5))}`
  );
}

// c9 | edge
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'error',
    name: 'oc-c9',
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 3)) ===
      JSON.stringify(['run', '--agent', 'plan']) &&
    !argv.includes('--dir') &&
    argv.length > 3 &&
    argv.slice(3).join('\n').includes('noop');
  record(
    'c9: R3 — probe exits 2 with no output → not advertised; run still exits 0 (no throw)',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 5))}`
  );
}

// c10 | edge
{
  const { r, argv, helpLogContent, elapsedMs } = runOpencodeProbe({
    mode: 'hang',
    name: 'oc-c10',
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    argv[0] === 'run' &&
    !argv.includes('--dir') &&
    elapsedMs >= 4500 &&
    elapsedMs < 9000;
  record(
    'c10: R3 — probe hangs past the 5000 ms probe timeout → killed, not advertised; exit 0; wall time in [4500, 9000) ms',
    ok,
    `status=${r.status} signal=${r.signal} elapsedMs=${elapsedMs} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 5))}`
  );
}

// c11 | happy
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'dir',
    engineSpec: '--engine=opencode:p/m',
    name: 'oc-c11',
  });
  // Exactly one probe, argv exactly `run --help` (no prompt/--model/--agent).
  // The real run's argv dump (FAKE_ARGV_FILE) must be a different, longer
  // invocation — i.e. the probe never wrote it.
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    argv.length > 2 &&
    argv[1] !== '--help';
  record(
    'c11: R3 — probe argv is exactly `run --help`, logged once; FAKE_ARGV_FILE holds the real run, not the probe',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 5))}`
  );
}

// c11 (fixture guard) — passes before implementation by design: it checks the
// fake binary's own probe contract (no FAKE_ARGV_FILE write, exact help log),
// which c11 above relies on.
{
  const argvFile = path.join(TMP, 'oc-c11-fixture.argv');
  const helpLog = path.join(TMP, 'oc-c11-fixture.helplog');
  const r = spawnSync(path.join(FIXTURES, 'opencode'), ['run', '--help'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FAKE_ARGV_FILE: argvFile,
      FAKE_HELP_LOG: helpLog,
      FAKE_OPENCODE_HELP: 'dir',
    },
    timeout: 10_000,
  });
  const ok =
    r.status === 0 &&
    !fs.existsSync(argvFile) &&
    fs.readFileSync(helpLog, 'utf8') === PROBE_LOG_EXPECTED &&
    /^\s+--dir string/m.test(r.stdout);
  record(
    'c11 (fixture guard): fake opencode probe prints per mode, logs argv, never writes FAKE_ARGV_FILE',
    ok,
    `status=${r.status} argvFileExists=${fs.existsSync(argvFile)}`
  );
}

// c12 | weird
{
  const spacedCwd = fs.mkdtempSync(path.join(os.tmpdir(), 'so a b ü-'));
  try {
    const { r, argv, helpLogContent } = runOpencodeProbe({
      mode: 'dir',
      name: 'oc-c12',
      cwd: spacedCwd,
    });
    const dirIdx = argv.indexOf('--dir');
    const ok =
      r.status === 0 &&
      helpLogContent === PROBE_LOG_EXPECTED &&
      dirIdx === 1 &&
      argv[dirIdx + 1] === spacedCwd;
    record(
      'c12: R1 — advertised + cwd with a space and unicode → `--dir` followed by that exact cwd as one argv element',
      ok,
      `status=${r.status} expected=${JSON.stringify(spacedCwd)} argv=${JSON.stringify(argv.slice(0, 4))}`
    );
  } finally {
    fs.rmSync(spacedCwd, { recursive: true, force: true });
  }
}

// c18 / c19 | edge — aliased flag lines (R1). The help line carries both the
// long flag and a short alias; either order still advertises --dir.
const ADVERTISED_PREFIX = (cwd) => [
  'run',
  '--dir',
  cwd,
  '--model',
  'p/m',
  '--agent',
  'plan',
];
for (const [id, mode, shape] of [
  ['c18', 'alias-long', '`--dir, -d string`'],
  ['c19', 'alias-short', '`-d, --dir string`'],
]) {
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode,
    engineSpec: '--engine=opencode:p/m',
    name: `oc-${id}`,
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 7)) ===
      JSON.stringify(ADVERTISED_PREFIX(process.cwd()));
  record(
    `${id}: R1 — help flag line aliased as ${shape} → advertised → probe ran as \`run --help\`; argv prefix \`run --dir <cwd> --model p/m --agent plan\``,
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 8))}`
  );
}

// c17a | edge — missing binary (R3). `opencode` is absent from PATH, so the
// probe's spawnSync returns an ENOENT result with null stdout/stderr; it must
// not throw, and review.js's preflight then reports exit 127.
{
  const MISSING_PATH = '/usr/bin:/bin';
  const pre = spawnSync('/bin/sh', ['-c', 'command -v opencode'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: MISSING_PATH },
  });
  const preOk = pre.status !== null && (pre.stdout || '').trim() === '';
  const r = spawnSync(
    process.execPath,
    [REVIEW, '--engine=opencode:p/m', '--cwd=' + process.cwd(), 'noop'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: MISSING_PATH },
      timeout: 15_000,
    }
  );
  const resultLine = (r.stdout || '')
    .split('\n')
    .filter((l) => l.startsWith('SECOND_OPINION_RESULT: '))
    .pop();
  const ok =
    preOk &&
    r.status === 127 &&
    /not found on PATH/.test(r.stderr || '') &&
    typeof resultLine === 'string' &&
    resultLine.includes('"exit":127');
  record(
    'c17a: R3 — opencode missing from PATH → probe does not throw; preflight exit 127',
    ok,
    `precondition=${preOk} (command -v → ${JSON.stringify(pre.stdout)}) status=${r.status} stderr=${(r.stderr || '').slice(0, 300)} resultLine=${JSON.stringify(resultLine)}`
  );
}

// ─── Test 23: empty output (0 bytes) → exit 3 + "no output" note ──────────
// An engine that exits 0 but produces nothing must not be reported as success.
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'empty' }, args: ['noop'] });
  const ok =
    r.status === 3 && /no output/i.test((r.stderr || '') + r.logContent);
  record(
    'empty output: exit 3 + no-output note',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 24: output without envelope → exit 3 + envelope note ────────────
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'noenvelope' }, args: ['noop'] });
  const ok =
    r.status === 3 && /envelope/i.test((r.stderr || '') + r.logContent);
  record(
    'no-envelope output: exit 3 + envelope note',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 25: well-formed envelope output → exit 0 (regression guard) ─────
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'ok' }, args: ['noop'] });
  const ok = r.status === 0 && /SECOND_OPINION_START/.test(r.logContent);
  record(
    'envelope present: exit 0',
    ok,
    `status=${r.status} logTail=${r.logContent.slice(-160)}`
  );
}

// ─── Test 26: --no-wrap skips the envelope check (no-envelope → exit 0) ────
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'noenvelope' },
    args: ['--no-wrap', 'noop'],
  });
  const ok = r.status === 0;
  record(
    '--no-wrap: no-envelope output is not flagged (exit 0)',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 27: --no-wrap still flags empty output (exit 3) ─────────────────
// The 0-byte check is independent of the envelope; empty output is never useful.
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'empty' },
    args: ['--no-wrap', 'noop'],
  });
  const ok =
    r.status === 3 && /no output/i.test((r.stderr || '') + r.logContent);
  record(
    '--no-wrap: empty output still exit 3',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 28: 0-byte heartbeat carries a distinct outage note ─────────────
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'silent 3' },
    args: ['--heartbeat=1', '--timeout=15', 'noop'],
  });
  const ok =
    r.status === 0 &&
    /# heartbeat /m.test(r.logContent) &&
    /(NO OUTPUT YET|possible upstream)/i.test(r.logContent);
  record(
    '0-byte heartbeat: distinct outage note while engine silent',
    ok,
    `status=${r.status} logSample=${(r.logContent.match(/# heartbeat[^\n]*/g) || []).join(' | ').slice(0, 220)}`
  );
}

// ─── Test 29: multiple --file= args embed every file ──────────────────────
{
  const fa = path.join(TMP, 'multi-a.txt');
  const fb = path.join(TMP, 'multi-b.txt');
  fs.writeFileSync(fa, 'ALPHA_CONTENT_MARKER\n');
  fs.writeFileSync(fb, 'BETA_CONTENT_MARKER\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'multi-file',
    extraArgs: [`--file=${fa}`, `--file=${fb}`],
  });
  // The fixture dumps argv newline-joined and the helper re-splits on '\n', so
  // a multi-line prompt is spread across entries — rejoin to recover it whole.
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    /ALPHA_CONTENT_MARKER/.test(prompt) &&
    /BETA_CONTENT_MARKER/.test(prompt) &&
    prompt.includes(fa) &&
    prompt.includes(fb);
  record(
    'multi --file: both files embedded in the prompt',
    ok,
    `status=${r.status} promptHas=A:${/ALPHA/.test(prompt)} B:${/BETA/.test(prompt)}`
  );
}

// ─── Test 30: --diff=unstaged includes UNTRACKED files ────────────────────
// Build a throwaway git repo with one modified tracked file and one untracked
// file, then assert the embedded diff (last argv = the prompt) contains both.
{
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'so-untracked-'));
  function git(...a) {
    return spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  }
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'original\nMODIFIED_LINE\n');
  fs.writeFileSync(path.join(repo, 'untracked.txt'), 'UNTRACKED_MARKER\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'untracked',
    extraArgs: ['--diff=unstaged'],
    cwd: repo,
  });
  const prompt = argv.join('\n'); // rejoin multi-line prompt (see test 29)
  const ok =
    r.status === 0 &&
    /MODIFIED_LINE/.test(prompt) && // tracked change present
    /UNTRACKED_MARKER/.test(prompt) && // untracked content present
    /untracked\.txt/.test(prompt);
  record(
    '--diff=unstaged: untracked files included in the diff',
    ok,
    `status=${r.status} hasTracked=${/MODIFIED_LINE/.test(prompt)} hasUntracked=${/UNTRACKED_MARKER/.test(prompt)}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Secret-file (.env) scrubbing ─────────────────────────────────────────
// review.js must never embed real .env contents into an engine prompt. Helper
// to spin up a throwaway git repo for the diff-based cases.
function newRepo() {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'so-env-'));
  const git = (...a) => spawnSync('git', a, { cwd: repo, encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 't@t');
  git('config', 'user.name', 't');
  return { repo, git };
}
const SECRET = 'SECRET_ENV_VALUE_DO_NOT_LEAK=hunter2';
const EXAMPLE = 'EXAMPLE_ENV_VALUE_OK=placeholder';

// ─── Test 31: --file=.env is refused (exit 1, content never embedded) ─────
{
  const envFile = path.join(TMP, '.env');
  fs.writeFileSync(envFile, SECRET + '\n');
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'ok' },
    args: [`--file=${envFile}`, 'noop'],
  });
  const ok =
    r.status === 1 &&
    /secret|\.env|--include-secrets/i.test(r.stderr || '') &&
    !r.logContent.includes(SECRET); // never reached the engine
  record(
    '--file=.env: refused (exit 1), content not embedded',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── Test 32: --file=.env --include-secrets embeds it ─────────────────────
{
  const envFile = path.join(TMP, '.env');
  fs.writeFileSync(envFile, SECRET + '\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-include',
    extraArgs: ['--include-secrets', `--file=${envFile}`],
  });
  const prompt = argv.join('\n');
  const ok = r.status === 0 && prompt.includes(SECRET);
  record(
    '--file=.env --include-secrets: embedded',
    ok,
    `status=${r.status} hasSecret=${prompt.includes(SECRET)}`
  );
}

// ─── Test 33: untracked .env scrubbed from --diff=unstaged, .env.example kept
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\nKEEP_TRACKED_MARKER\n');
  fs.writeFileSync(path.join(repo, '.env'), SECRET + '\n'); // untracked secret
  fs.writeFileSync(path.join(repo, '.env.example'), EXAMPLE + '\n'); // safe
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-untracked',
    extraArgs: ['--diff=unstaged'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !prompt.includes(SECRET) && // secret scrubbed
    prompt.includes(EXAMPLE) && // example included
    prompt.includes('KEEP_TRACKED_MARKER') && // tracked change still there
    /\.env/.test(prompt); // skip/redact note mentions it
  record(
    'untracked .env scrubbed from unstaged; .env.example kept',
    ok,
    `status=${r.status} secret=${prompt.includes(SECRET)} example=${prompt.includes(EXAMPLE)}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 34: --include-secrets re-includes the untracked .env ────────────
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\n');
  git('add', 'tracked.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, 'tracked.txt'), 'a\nKEEP\n');
  fs.writeFileSync(path.join(repo, '.env'), SECRET + '\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-untracked-include',
    extraArgs: ['--diff=unstaged', '--include-secrets'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok = r.status === 0 && prompt.includes(SECRET);
  record(
    'untracked .env included under --include-secrets',
    ok,
    `status=${r.status} hasSecret=${prompt.includes(SECRET)}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 35: tracked .env change redacted from the diff ──────────────────
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, '.env'), 'OLD=1\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\n');
  git('add', '.env', 'app.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, '.env'), 'OLD=1\n' + SECRET + '\n'); // tracked change
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\nAPP_CHANGE_MARKER\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-tracked',
    extraArgs: ['--diff=unstaged'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !prompt.includes(SECRET) && // secret hunk redacted
    prompt.includes('APP_CHANGE_MARKER') && // other change preserved
    /redact/i.test(prompt); // redaction note present
  record(
    'tracked .env change redacted from diff (other changes preserved)',
    ok,
    `status=${r.status} secret=${prompt.includes(SECRET)} app=${prompt.includes('APP_CHANGE_MARKER')}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 36: staged NEW .env redacted from --diff=staged ─────────────────
// A newly-added (staged) .env renders as a "new file" diff section; its header
// path must still be matched and redacted. Guards the new-file header variant.
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\n');
  git('add', 'app.txt');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(repo, '.env'), SECRET + '\n'); // brand-new secret
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\nSTAGED_APP_MARKER\n');
  git('add', '.env', 'app.txt');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-staged',
    extraArgs: ['--diff=staged'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !prompt.includes(SECRET) && // new-file .env hunk redacted
    prompt.includes('STAGED_APP_MARKER') && // other staged change preserved
    /redact/i.test(prompt);
  record(
    'staged new .env redacted from --diff=staged (new-file header)',
    ok,
    `status=${r.status} secret=${prompt.includes(SECRET)} app=${prompt.includes('STAGED_APP_MARKER')}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 37: .env under a non-ASCII path (git c-quotes the diff header) ──
// git quotes paths with non-ASCII/special bytes: `diff --git "a/…/.env" "b/…"`.
// The redactor must still match the quoted header, or the secret leaks.
{
  const { repo, git } = newRepo();
  const dir = path.join(repo, 'サンプル'); // non-ASCII → forces git c-quoting
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '.env'), 'OLD=1\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\n');
  git('add', '-A');
  git('commit', '-qm', 'init');
  fs.writeFileSync(path.join(dir, '.env'), 'OLD=1\n' + SECRET + '\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'app\nQUOTED_APP_MARKER\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'env-quoted',
    extraArgs: ['--diff=unstaged'],
    cwd: repo,
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !prompt.includes(SECRET) && // quoted-path .env redacted
    prompt.includes('QUOTED_APP_MARKER'); // other change preserved
  record(
    'quoted (non-ASCII) .env path redacted from diff',
    ok,
    `status=${r.status} secret=${prompt.includes(SECRET)}`
  );
  try {
    fs.rmSync(repo, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
}

// ─── Test 38: --no-embed --diff excludes env files via git pathspec ───────
// In --no-embed mode the engine runs `git diff` itself, so review.js can't
// redact the output. It instead appends exclude pathspecs to the suggested
// command so the engine never fetches env files in the first place.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'noembed-exclude',
    extraArgs: ['--no-embed', '--diff=unstaged'],
  });
  const prompt = argv.join('\n');
  const ok = r.status === 0 && /exclude/.test(prompt) && /\.env/.test(prompt);
  record(
    '--no-embed --diff: env-file exclude pathspecs in suggested command',
    ok,
    `status=${r.status} hasExclude=${/exclude/.test(prompt)}`
  );
}

// ─── Test 39: malformed open marker (>>) still detected → exit 0 ──────────
// A real engine (cmd) emitted `<<<SECOND_OPINION_START>>` (two '>'). review.js
// must treat that as a usable envelope, not a no-output failure (exit 3).
{
  const r = runReview({
    env: { FAKE_BEHAVIOR: 'malformed-marker' },
    args: ['noop'],
  });
  const ok = r.status === 0 && /usable review body/.test(r.logContent);
  record(
    'malformed open marker (>>) detected → exit 0',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 160)}`
  );
}

// ─── Test 40: embed mode appends a "self-contained, don't explore" directive
// Stops agentic engines (opencode) from ignoring the embedded content and
// globbing the filesystem instead.
{
  const f = path.join(TMP, 'embed-directive.txt');
  fs.writeFileSync(f, 'hello\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'embed-directive',
    extraArgs: [`--file=${f}`],
  });
  const prompt = argv.join('\n');
  const ok = r.status === 0 && /do not read files/i.test(prompt);
  record(
    'embed mode: self-contained directive present',
    ok,
    `status=${r.status} hasDirective=${/do not read files/i.test(prompt)}`
  );
}

// ─── Test 41: --no-embed must NOT add the "don't read files" directive ────
// In --no-embed the engine is explicitly told to fetch the file itself, so the
// contradictory directive must be absent.
{
  const f = path.join(TMP, 'noembed-directive.txt');
  fs.writeFileSync(f, 'hello\n');
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'noembed-directive',
    extraArgs: ['--no-embed', `--file=${f}`],
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !/do not read files/i.test(prompt) &&
    /Read the file/i.test(prompt);
  record(
    '--no-embed: no self-contained directive (engine must read)',
    ok,
    `status=${r.status} prompt=${prompt.slice(0, 120)}`
  );
}

// ─── Test 42: OUTPUT FORMAT carries no decoy answer-body placeholder ──────
// The old instruction printed `...your complete answer here...` between
// standalone markers, which a first-match extractor would grab. It must be gone.
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'no-decoy',
  });
  const prompt = argv.join('\n');
  const ok =
    r.status === 0 &&
    !/your complete answer here/i.test(prompt) &&
    /SECOND_OPINION_START/.test(prompt); // markers still described
  record(
    'OUTPUT FORMAT: no decoy answer-body placeholder',
    ok,
    `status=${r.status} hasDecoy=${/your complete answer here/i.test(prompt)}`
  );
}

// ─── Test 43 (F11): log file is created with mode 0o600 ───────────────────
// Engine transcripts can contain diff/file content the secret guard tried to
// keep away from other users on a shared host — the log file itself
// shouldn't be left world/group-readable.
{
  const r = runReview({ env: { FAKE_BEHAVIOR: 'ok' }, args: ['noop'] });
  let mode = null;
  try {
    mode = fs.statSync(r.logPath).mode & 0o777;
  } catch {
    /* logPath assertion below will fail on its own */
  }
  const ok = r.status === 0 && mode === 0o600;
  record(
    'log file permissions: created with mode 0o600',
    ok,
    `status=${r.status} mode=${mode === null ? 'null' : mode.toString(8)}`
  );
}

// ─── Test 44: kiro-cli default mode — chat/--no-interactive/--trust-tools=,
// prompt last ────────────────────────────────────────────────────────────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=kiro-cli',
    probeName: 'kiro-default',
  });
  const chatIdx = argv.indexOf('chat');
  const noInteractiveIdx = argv.indexOf('--no-interactive');
  const trustToolsIdx = argv.indexOf('--trust-tools=');
  const promptIdx = argv.indexOf('noop');
  // The composed prompt (embedded envelope/secret-reminder instructions
  // appended after the raw 'noop' prompt) is ONE argv element that spans
  // multiple lines — the argv-dump/re-split convention documented in
  // test/AGENTS.md spreads it across several array entries. So "prompt
  // last" means it's the last review.js FLAG-bearing token, not literally
  // argv[argv.length - 1] (that's the tail of the appended instructions).
  const ok =
    r.status === 0 &&
    chatIdx === 0 &&
    noInteractiveIdx > chatIdx &&
    trustToolsIdx > noInteractiveIdx &&
    !argv.includes('--trust-all-tools') &&
    promptIdx > trustToolsIdx;
  record(
    'kiro-cli: default mode is chat/--no-interactive/--trust-tools=, prompt last, no --trust-all-tools',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 45: kiro-cli --unrestricted strips --trust-tools=, adds
// --trust-all-tools (ADDITIVE safety model — see harnesses.js comment) ──────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=kiro-cli',
    probeName: 'kiro-unrestricted',
    extraArgs: ['--unrestricted'],
  });
  const ok =
    r.status === 0 &&
    !argv.includes('--trust-tools=') &&
    argv.includes('--trust-all-tools') &&
    argv.includes('chat') &&
    argv.includes('--no-interactive');
  record(
    'kiro-cli: --unrestricted drops --trust-tools= AND adds --trust-all-tools',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 46: kiro-cli inline model forwarded as --model ──────────────────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=kiro-cli:qwen3-coder-next',
    probeName: 'kiro-model',
  });
  const modelIdx = argv.indexOf('--model');
  const promptIdx = argv.indexOf('noop');
  const ok =
    r.status === 0 &&
    modelIdx >= 0 &&
    argv[modelIdx + 1] === 'qwen3-coder-next' &&
    promptIdx > modelIdx;
  record(
    'kiro-cli: inline model forwarded as --model (before the prompt)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 47: --engine=kiro alias resolves to the kiro-cli binary ─────────
{
  const { r, argv } = runAgyArgv({
    engineSpec: '--engine=kiro',
    probeName: 'kiro-alias',
  });
  const ok =
    r.status === 0 &&
    argv.includes('chat') &&
    argv.includes('--no-interactive') &&
    argv.includes('--trust-tools=');
  record(
    'kiro alias: resolves to the kiro-cli binary (chat/--no-interactive/--trust-tools= present)',
    ok,
    `status=${r.status} argv=${JSON.stringify(argv)}`
  );
}

// ─── Test 48: --print-prompt prints the composed prompt verbatim, exits 0,
// and never spawns the engine (no preflight, no child process, no log
// banner) — single-engine, no --diff/--file ────────────────────────────────
{
  const argvFile = path.join(TMP, 'print-prompt-basic-argv.txt');
  const marker = 'MARKER_BASIC_48_UNIQUE';
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      '--cwd=' + process.cwd(),
      '--print-prompt',
      marker,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_ARGV_FILE: argvFile,
      },
      timeout: 10_000,
    }
  );
  const ok =
    r.status === 0 &&
    (r.stdout || '').includes(marker) &&
    !fs.existsSync(argvFile) &&
    !/REVIEW IN PROGRESS/.test(r.stdout || '') &&
    !/LOG FILE:/.test(r.stdout || '');
  record(
    '--print-prompt: prints prompt verbatim, exit 0, no spawn, no log banner',
    ok,
    `status=${r.status} stdout=${(r.stdout || '').slice(0, 200)} argvFileExists=${fs.existsSync(argvFile)}`
  );
}

// ─── Test 49: --print-prompt + --diff= embeds the <diff> block in the
// printed prompt (proves diff content was actually fetched, not skipped) ──
// Runs in a throwaway repo with two commits, so `--diff=last-commit` (git diff
// HEAD~1) is one small known change. Against the real checkout it would pull in
// every uncommitted edit and overflow the prompt size limit.
{
  const { repo, git } = newRepo();
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'one');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'two\n');
  git('add', '-A');
  git('commit', '-q', '-m', 'two');
  const marker = 'MARKER_DIFF_49_UNIQUE';
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      `--cwd=${repo}`,
      '--diff=last-commit',
      '--print-prompt',
      marker,
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${FIXTURES}:${process.env.PATH}` },
      timeout: 10_000,
    }
  );
  const ok =
    r.status === 0 &&
    /<diff>/.test(r.stdout || '') &&
    /<\/diff>/.test(r.stdout || '') &&
    /Review the diff above/.test(r.stdout || '') &&
    (r.stdout || '').includes(marker);
  record(
    '--print-prompt + --diff=: <diff> block embedded in the printed prompt',
    ok,
    `status=${r.status} stdout=${(r.stdout || '').slice(0, 300)}`
  );
  fs.rmSync(repo, { recursive: true, force: true });
}

// ─── Test 50: --print-prompt is rejected in fusion mode (2+ --engine=) ────
{
  const argvFile = path.join(TMP, 'print-prompt-fusion-argv.txt');
  const marker = 'MARKER_FUSION_50_UNIQUE';
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      '--engine=codex:some-model',
      '--cwd=' + process.cwd(),
      '--print-prompt',
      marker,
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_ARGV_FILE: argvFile,
      },
      timeout: 10_000,
    }
  );
  const ok =
    r.status === 1 &&
    /print-prompt/i.test(r.stderr || '') &&
    (r.stderr || '').trim().length > 0 &&
    !/FUSION REVIEW/.test(r.stdout || '') &&
    !fs.existsSync(argvFile);
  record(
    '--print-prompt: rejected in fusion mode (exit 1, no fusion banner, no children spawned)',
    ok,
    `status=${r.status} stderr=${(r.stderr || '').slice(0, 200)} stdout=${(r.stdout || '').slice(0, 200)} argvFileExists=${fs.existsSync(argvFile)}`
  );
}

// ─── Test 51: --print-prompt still enforces the prompt-size cap — regression
// guard for content.checkPromptSize() staying ABOVE the print-and-exit in
// review.js. A --file= large enough to push combinedPrompt past
// content.PROMPT_BYTE_LIMIT (120,000 bytes) must still hit the size guard:
// exit 1, NOTHING on stdout (the guard exits before any prompt is printed),
// stderr mentions the byte limit. If the print-and-exit were ever hoisted
// above checkPromptSize, this would instead exit 0 and dump the oversized
// prompt to stdout. ──────────────────────────────────────────────────────
{
  const bigFile = path.join(TMP, 'print-prompt-oversized.txt');
  fs.writeFileSync(bigFile, 'A'.repeat(130_000));
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      '--cwd=' + process.cwd(),
      `--file=${bigFile}`,
      '--print-prompt',
      'noop',
    ],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${FIXTURES}:${process.env.PATH}` },
      timeout: 10_000,
    }
  );
  const ok =
    r.status === 1 &&
    (r.stdout || '') === '' &&
    /bytes/i.test(r.stderr || '') &&
    /limit/i.test(r.stderr || '');
  record(
    '--print-prompt: prompt-size cap still enforced (exit 1, no stdout, stderr mentions the byte limit)',
    ok,
    `status=${r.status} stdout=${(r.stdout || '').slice(0, 100)} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// ─── --harness selector (R6, R7; c20–c27) ────────────────────────────────
// `--harness=<name>[:<model>]` is the new selector; `--engine=` stays as an
// alias. Both in one call is a usage error. The result JSON carries `harness`
// and `engine` with the same value (per slot in fusion).

// Run review.js with an arbitrary list of selector args (no --log, so fusion
// and single runs share one shape). Returns spawnSync result, the argv the
// fixture dumped (FAKE_ARGV_FILE; [] when no engine was spawned), whether
// that file exists, and the parsed SECOND_OPINION_RESULT line (null if absent).
function runSelectors({ selectors, name, env = {} }) {
  const argvFile = path.join(TMP, `${name}.argv`);
  const r = spawnSync(
    process.execPath,
    [REVIEW, ...selectors, '--cwd=' + process.cwd(), '--heartbeat=0', 'noop'],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_BEHAVIOR: 'ok',
        FAKE_ARGV_FILE: argvFile,
        ...env,
      },
      timeout: 30_000,
    }
  );
  return {
    r,
    argvCreated: fs.existsSync(argvFile),
    result: parseOpinionResult(r.stdout),
  };
}

// Parse the `SECOND_OPINION_RESULT: {...}` line from stdout; null when
// missing or malformed (never throws).
function parseOpinionResult(stdout) {
  const m = (stdout || '').match(/^SECOND_OPINION_RESULT: (.+)$/m);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}

// c20 | happy
{
  const { r, argv, helpLogContent } = runOpencodeProbe({
    mode: 'dir',
    engineSpec: '--harness=opencode:p/m',
    name: 'oc-c20',
  });
  const ok =
    r.status === 0 &&
    helpLogContent === PROBE_LOG_EXPECTED &&
    JSON.stringify(argv.slice(0, 7)) ===
      JSON.stringify([
        'run',
        '--dir',
        process.cwd(),
        '--model',
        'p/m',
        '--agent',
        'plan',
      ]) &&
    argv.slice(7).join('\n').includes('noop');
  record(
    'c20: R6 — --harness=opencode:p/m, probe advertises --dir → argv `run --dir <cwd> --model p/m --agent plan <prompt>` (same as --engine), exit 0',
    ok,
    `status=${r.status} helpLog=${JSON.stringify(helpLogContent)} argv=${JSON.stringify(argv.slice(0, 8))} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// c21 | happy
{
  const viaEngine = runAgyArgv({
    engineSpec: '--engine=codex',
    probeName: 'c21-engine',
  });
  const viaHarness = runAgyArgv({
    engineSpec: '--harness=codex',
    probeName: 'c21-harness',
  });
  const ok =
    viaEngine.r.status === 0 &&
    viaEngine.argv.length > 0 &&
    viaHarness.r.status === 0 &&
    JSON.stringify(viaHarness.argv) === JSON.stringify(viaEngine.argv);
  record(
    'c21: R6 — --harness=codex → codex argv identical to --engine=codex for the same prompt, exit 0',
    ok,
    `engine: status=${viaEngine.r.status} argvLen=${viaEngine.argv.length}; harness: status=${viaHarness.r.status} argvLen=${viaHarness.argv.length} sameArgv=${JSON.stringify(viaHarness.argv) === JSON.stringify(viaEngine.argv)} stderr=${(viaHarness.r.stderr || '').slice(0, 200)}`
  );
}

// c22 | happy
{
  const { r, result } = runSelectors({
    selectors: ['--harness=codex', '--harness=opencode:p/m'],
    name: 'c22',
  });
  const slots = (result && result.slots) || [];
  const ok =
    r.status === 0 &&
    !!result &&
    result.fusion === true &&
    slots.length === 2 &&
    JSON.stringify(slots.map((s) => s.engine)) ===
      JSON.stringify(['codex', 'opencode']) &&
    JSON.stringify(slots.map((s) => s.model)) ===
      JSON.stringify([null, 'p/m']) &&
    JSON.stringify(slots.map((s) => s.exit)) === JSON.stringify([0, 0]);
  record(
    'c22: R6 — repeated --harness=codex --harness=opencode:p/m → fusion, two slots (codex, opencode:p/m), both exit 0',
    ok,
    `status=${r.status} result=${JSON.stringify(result)} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// c23 | weird
{
  const viaEngine = runSelectors({
    selectors: ['--engine=codex,opencode'],
    name: 'c23-engine',
  });
  const viaHarness = runSelectors({
    selectors: ['--harness=codex,opencode'],
    name: 'c23-harness',
  });
  const names = (x) =>
    ((x.result && x.result.slots) || []).map((s) => `${s.engine}:${s.model}`);
  const ok =
    viaEngine.r.status === 0 &&
    viaHarness.r.status === 0 &&
    JSON.stringify(names(viaEngine)) ===
      JSON.stringify(['codex:null', 'opencode:null']) &&
    JSON.stringify(names(viaHarness)) === JSON.stringify(names(viaEngine));
  record(
    'c23: R6 — --harness=codex,opencode (CSV) → same two slots as --engine=codex,opencode',
    ok,
    `engine: status=${viaEngine.r.status} slots=${JSON.stringify(names(viaEngine))}; harness: status=${viaHarness.r.status} slots=${JSON.stringify(names(viaHarness))} stderr=${(viaHarness.r.stderr || '').slice(0, 200)}`
  );
}

// c24 | edge
{
  const { r, argvCreated, result } = runSelectors({
    selectors: ['--harness=codex', '--engine=codex'],
    name: 'c24',
  });
  const stderr = r.stderr || '';
  const ok =
    r.status === 1 &&
    !argvCreated &&
    result === null &&
    /--harness/.test(stderr) &&
    /--engine(?![-\w])/.test(stderr);
  record(
    'c24: R6 — --harness=codex plus --engine=codex in one call → usage error exit 1, no spawn, stderr names --harness and --engine',
    ok,
    `status=${r.status} argvCreated=${argvCreated} result=${JSON.stringify(result)} stderr=${stderr.slice(0, 300)}`
  );
}

// c25 | edge
{
  const { r, argvCreated, result } = runSelectors({
    selectors: ['--harness='],
    name: 'c25',
  });
  const stderr = r.stderr || '';
  const ok =
    r.status === 1 &&
    !argvCreated &&
    result === null &&
    /--harness/.test(stderr);
  record(
    'c25: R6 — --harness= (empty value) → usage error exit 1, no spawn, stderr names --harness',
    ok,
    `status=${r.status} argvCreated=${argvCreated} stdoutHead=${(r.stdout || '').slice(0, 80)} stderr=${stderr.slice(0, 300)}`
  );
}

// c26 | happy
{
  const { r } = runAgyArgv({
    engineSpec: '--harness=codex',
    probeName: 'c26',
  });
  const result = parseOpinionResult(r.stdout);
  const ok =
    r.status === 0 &&
    !!result &&
    result.harness === 'codex' &&
    result.engine === 'codex';
  record(
    'c26: R7 — single --harness=codex run → SECOND_OPINION_RESULT has "harness":"codex" and "engine":"codex"',
    ok,
    `status=${r.status} result=${JSON.stringify(result)} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// c27 | weird
{
  const { r, result } = runSelectors({
    selectors: ['--harness=codex', '--harness=opencode:p/m'],
    name: 'c27',
  });
  const slots = (result && result.slots) || [];
  const ok =
    r.status === 0 &&
    slots.length === 2 &&
    JSON.stringify(slots.map((s) => s.harness)) ===
      JSON.stringify(['codex', 'opencode']) &&
    JSON.stringify(slots.map((s) => s.engine)) ===
      JSON.stringify(['codex', 'opencode']);
  record(
    'c27: R7 — fusion result: each slot carries harness and engine with matching values (codex, opencode)',
    ok,
    `status=${r.status} result=${JSON.stringify(result)} stderr=${(r.stderr || '').slice(0, 200)}`
  );
}

// c31 | happy (guard) — review.js preflight-127 result carries harness and engine
{
  const MISSING_PATH = '/usr/bin:/bin';
  const pre = spawnSync('/bin/sh', ['-c', 'command -v opencode'], {
    encoding: 'utf8',
    env: { ...process.env, PATH: MISSING_PATH },
  });
  const preOk = pre.status !== null && (pre.stdout || '').trim() === '';
  const r = spawnSync(
    process.execPath,
    [REVIEW, '--engine=opencode:p/m', '--cwd=' + process.cwd(), 'noop'],
    {
      encoding: 'utf8',
      env: { ...process.env, PATH: MISSING_PATH },
      timeout: 15_000,
    }
  );
  const result = parseOpinionResult(r.stdout);
  const ok =
    preOk &&
    r.status === 127 &&
    !!result &&
    result.harness === 'opencode' &&
    result.engine === 'opencode' &&
    result.exit === 127;
  record(
    'c31: R7 — review.js preflight 127 (opencode missing from PATH) result line has harness and engine both "opencode", exit 127',
    ok,
    `precondition=${preOk} status=${r.status} result=${JSON.stringify(result)}`
  );
}

// c34 | edge (guard) — leaked-flag registry, review.js
{
  const r = spawnSync(
    process.execPath,
    [
      REVIEW,
      '--engine=codex',
      '--cwd=' + process.cwd(),
      '--heartbeat=0',
      'noop',
      '--',
      '--harness=x',
    ],
    {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${FIXTURES}:${process.env.PATH}`,
        FAKE_BEHAVIOR: 'ok',
      },
      timeout: 30_000,
    }
  );
  const stderr = r.stderr || '';
  const ok =
    /review\.js: note: .*'--harness=x'/.test(stderr) &&
    /placed after '--'/.test(stderr);
  record(
    "c34: R6 — review.js `-- --harness=x` after the prompt → stderr carries the misplaced-flag note naming '--harness=x'",
    ok,
    `status=${r.status} stderr=${stderr.slice(0, 300)}`
  );
}

// c35 | edge (guard) — fusion launch-failure slots carry harness === engine
{
  const notADir = path.join(TMP, 'c35-not-a-dir');
  fs.writeFileSync(notADir, 'regular file, not a directory\n');
  const { r, result } = runSelectors({
    selectors: ['--harness=codex', '--harness=opencode:p/m'],
    name: 'c35',
    env: { TMPDIR: notADir },
  });
  const slots = (result && result.slots) || [];
  const ok =
    r.status === 1 &&
    !!result &&
    result.fusion === true &&
    JSON.stringify(slots.map((s) => s.harness)) ===
      JSON.stringify(['codex', 'opencode']) &&
    JSON.stringify(slots.map((s) => s.engine)) ===
      JSON.stringify(['codex', 'opencode']) &&
    JSON.stringify(slots.map((s) => s.exit)) === JSON.stringify([1, 1]);
  record(
    'c35: R7 — fusion launch failure (TMPDIR is a regular file) → every slot has harness equal to engine, exit 1',
    ok,
    `status=${r.status} result=${JSON.stringify(result)} stderr=${(r.stderr || '').slice(0, 300)}`
  );
}

// c36 | edge (guard) — engine-then-harness order, review.js
{
  const { r, argvCreated, result } = runSelectors({
    selectors: ['--engine=codex', '--harness=codex'],
    name: 'c36',
  });
  const stderr = r.stderr || '';
  const ok =
    r.status === 1 &&
    !argvCreated &&
    result === null &&
    /--harness/.test(stderr) &&
    /--engine(?![-\w])/.test(stderr);
  record(
    'c36: R6 — review.js --engine=codex then --harness=codex → usage error exit 1, no spawn, stderr names both flags',
    ok,
    `status=${r.status} argvCreated=${argvCreated} result=${JSON.stringify(result)} stderr=${stderr.slice(0, 300)}`
  );
}

// ─── Cleanup ──────────────────────────────────────────────────────────────
try {
  fs.rmSync(TMP, { recursive: true, force: true });
} catch {
  /* ignore */
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail > 0 ? 1 : 0);
