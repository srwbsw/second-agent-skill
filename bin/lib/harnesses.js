'use strict';

// Engine wiring shared by review.js (and, eventually, other runners):
// per-engine safety/functional flags, pre-flight PATH checking, and the
// buildHarnessCmd() switch that turns a resolved {engine, model, ...} slot
// into an argv. Side-effect-free by design (no process.exit, no stdout/
// stderr writes) so it can be reused by any entry point without dragging
// along one caller's error-message conventions.
//
// NOTE: SUPPORTED_HARNESSES / HARNESS_ALIASES / MODEL_REQUIRED are NOT here —
// they stay literal consts in bin/review.js because test/host-parity.test.js
// regex-parses `const SUPPORTED_HARNESSES = [...]` straight out of that file's
// source text, and nothing in this module needs them (buildHarnessCmd/
// preflightCheck/safetyFor take an already-validated `engine` string).

const { spawnSync } = require('child_process');
const { shellQuote } = require('../shell-quote');

const INSTALL_HINTS = {
  opencode: 'https://opencode.ai',
  gemini: 'https://github.com/google-gemini/gemini-cli',
  codex: 'https://github.com/openai/codex',
  claude: 'https://claude.ai/code',
  copilot: 'https://docs.github.com/copilot/how-tos/copilot-cli',
  qwen: 'https://github.com/QwenLM/qwen-code',
  kilo: 'https://kilocode.ai',
  agy: 'https://antigravity.google.com',
  cmd: 'https://commandcode.ai/docs',
  agent: 'https://cursor.com/cli',
  'kiro-cli': 'https://kiro.dev',
};

// Resolve a command on PATH. Returns the absolute path or null if missing.
// Used for pre-flight checks AND for picking the PTY wrapper.
function whichCmd(cmd) {
  // `command -v` is the POSIX-standard way and is a shell builtin, so we
  // have to invoke it via /bin/sh. Pass the full pipeline as a single
  // string to avoid Node's DEP0190 warning about array args + shell.
  // shellQuote guards against any path-injection via the input arg.
  const r = spawnSync('/bin/sh', ['-c', `command -v ${shellQuote(cmd)}`], {
    encoding: 'utf8',
  });
  if (r.status === 0 && r.stdout) return r.stdout.trim();
  // Some `command -v` builtins refuse to print non-builtin paths; fall back
  // to `which` which exists nearly everywhere POSIX.
  const r2 = spawnSync('which', [cmd], { encoding: 'utf8' });
  if (r2.status === 0 && r2.stdout) return r2.stdout.trim();
  return null;
}

// Does the installed opencode accept `run --dir`? Keyed on its own help text,
// not a version string: the flag is what we depend on, and version formats
// drift. One local `opencode run --help` call — no prompt, no model. Any
// failure (missing binary, non-zero exit, timeout) reads as "not advertised".
const OPENCODE_PROBE_TIMEOUT_MS = 5000;
function opencodeRunAcceptsDir() {
  const r = spawnSync('opencode', ['run', '--help'], {
    encoding: 'utf8',
    timeout: OPENCODE_PROBE_TIMEOUT_MS,
  });
  const help = `${r.stdout || ''}\n${r.stderr || ''}`;
  // A flag line starts with the flag (optionally indented), with or without a
  // short alias on either side (`-d, --dir` / `--dir, -d`). A mention inside
  // prose or a longer flag like --directory does not count.
  return /^\s*(?:-\w,\s*)?--dir(?:[\s,]|$)/m.test(help);
}

// Pre-flight: is `cmd` (the engine binary) on PATH? Returns null when found.
// When missing, returns a diagnostic `{ hint }` (hint is '' when no
// INSTALL_HINTS entry exists) — deliberately NOT writing to stderr/stdout or
// calling process.exit here, so callers (review.js today, other runners
// later) can each report the failure in their own voice and control the
// exit path.
function preflightCheck(cmd, engine) {
  const found = whichCmd(cmd);
  if (found) return null;
  const hint = INSTALL_HINTS[engine]
    ? `\n  Install: ${INSTALL_HINTS[engine]}`
    : '';
  return { hint };
}

// Per-engine sandbox / plan / read-only flags. These are the *only* flags
// that --unrestricted strips out. Functional flags (--print, exec, run,
// etc.) stay in the case blocks below because removing them breaks the
// invocation entirely. Order matters within a single engine's array, but
// the array is treated as a contiguous span.
//
// IMPORTANT: test/safety.test.js parses this object literally with a regex.
// Keep each engine's flags on simple string-literal lines (no spreads, no
// computed values) so the test can verify the safety contract.
const SAFETY_FLAGS = {
  opencode: ['--agent', 'plan'],
  gemini: ['-s', '--approval-mode', 'plan'],
  codex: ['-s', 'read-only'],
  claude: ['--permission-mode', 'plan'],
  copilot: ['-s', '--plan', '--allow-all-tools', '--deny-tool=write'],
  qwen: ['-s', '--approval-mode', 'plan'],
  kilo: ['--agent', 'plan'],
  agy: ['--sandbox'],
  cmd: ['--permission-mode', 'plan'],
  agent: ['--plan'],
  // kiro-cli's safety model is ADDITIVE and INVERTED relative to every other
  // engine here — see the buildHarnessCmd case block below for the full
  // explanation. This entry is defense-in-depth (--no-interactive alone
  // already auto-denies fs_write/execute_bash); it is NOT the primary gate,
  // and --unrestricted emptying it does NOT by itself grant write access.
  'kiro-cli': ['--trust-tools='],
};

// unrestricted is passed in explicitly (not read from module state) so this
// module has no mutable state shared across entry points — each caller
// (review.js, and later other runners) owns its own --unrestricted flag.
function safetyFor(eng, unrestricted) {
  return unrestricted ? [] : SAFETY_FLAGS[eng];
}

// Build the [cmd, args] argv for a resolved engine slot. All inputs are
// passed in explicitly: `engine`/`model` (the resolved slot), `cwd` (needed
// by opencode's --dir), `extraHarnessArgs` (forwarded --engine-arg=/-- args),
// `combinedPrompt` (the fully composed prompt), and `unrestricted` (gates
// safetyFor()).
function buildHarnessCmd({
  engine,
  model,
  cwd,
  extraHarnessArgs,
  combinedPrompt,
  unrestricted,
  progName = 'review.js',
}) {
  // Single-arg shadow of the exported safetyFor(eng, unrestricted), closing
  // over THIS call's `unrestricted` — so the case blocks below read exactly
  // like `safetyFor('<engine>')` (test/safety.test.js parses that literally)
  // while there is still no module-level mutable `unrestricted` shared
  // across calls/entry points.
  function safetyFor(eng) {
    return unrestricted ? [] : SAFETY_FLAGS[eng];
  }

  switch (engine) {
    case 'opencode': {
      // --dir <cwd> scopes opencode's sandbox file-access root to the review
      // directory. Without it, older opencode picks its own root and treats
      // reads of the --cwd subtree as `external_directory`, auto-rejecting them
      // and returning an empty review. Newer opencode (v2.x) removed the flag
      // and exits "Unrecognized flag: --dir", so it is passed only when the
      // installed CLI advertises it. Functional, not a safety flag — survives
      // --unrestricted.
      // Model is optional: bare --engine=opencode omits --model so opencode
      // uses its configured default (mirrors kilo).
      const opencodeArgs = ['run'];
      if (opencodeRunAcceptsDir()) opencodeArgs.push('--dir', cwd);
      if (model) opencodeArgs.push('--model', model);
      opencodeArgs.push(...safetyFor('opencode'));
      opencodeArgs.push(...extraHarnessArgs);
      opencodeArgs.push(combinedPrompt);
      return ['opencode', opencodeArgs];
    }

    case 'gemini':
      // --skip-trust bypasses gemini's "not running in a trusted directory"
      // hard-fail in headless mode. Functional, NOT a safety flag (read-only
      // is enforced by -s/--approval-mode plan), so it survives --unrestricted.
      return [
        'gemini',
        [
          ...safetyFor('gemini'),
          '--skip-trust',
          ...extraHarnessArgs,
          '-p',
          combinedPrompt,
        ],
      ];

    case 'codex': {
      // --skip-git-repo-check stops `codex exec` from hard-failing ("Not
      // inside a trusted directory ...") when --cwd is not a git repo. The
      // review is read-only (safetyFor('codex') → -s read-only), so skipping
      // the git-trust gate cannot cause writes. Functional, not a safety flag
      // — survives --unrestricted.
      const codexArgs = [
        'exec',
        ...safetyFor('codex'),
        '--skip-git-repo-check',
      ];
      if (model) codexArgs.push('-m', model);
      codexArgs.push(...extraHarnessArgs);
      codexArgs.push(combinedPrompt);
      return ['codex', codexArgs];
    }

    case 'claude': {
      const claudeArgs = ['--print', ...safetyFor('claude')];
      if (model) claudeArgs.push('--model', model);
      claudeArgs.push(...extraHarnessArgs);
      claudeArgs.push(combinedPrompt);
      return ['claude', claudeArgs];
    }

    case 'copilot': {
      const copilotArgs = [...safetyFor('copilot')];
      if (model) copilotArgs.push('--model', model);
      copilotArgs.push(...extraHarnessArgs, '-p', combinedPrompt);
      return ['copilot', copilotArgs];
    }

    case 'qwen': {
      const qwenArgs = [...safetyFor('qwen')];
      if (model) qwenArgs.push('-m', model);
      qwenArgs.push(...extraHarnessArgs);
      qwenArgs.push(combinedPrompt);
      return ['qwen', qwenArgs];
    }

    case 'kilo': {
      const kiloArgs = ['run', ...safetyFor('kilo')];
      if (model) kiloArgs.push('-m', model);
      kiloArgs.push(...extraHarnessArgs);
      kiloArgs.push(combinedPrompt);
      return ['kilo', kiloArgs];
    }

    case 'agy': {
      // Antigravity CLI (`agy`) — single-prompt mode via --print.
      // agy >=1.0.1 supports a --model flag (`agy models` lists choices);
      // forward it when a model is given, otherwise let agy pick its default.
      // extraHarnessArgs go BEFORE --print so the prompt stays adjacent to
      // its flag (same pattern as gemini's -p).
      const agyArgs = [...safetyFor('agy')];
      if (model) agyArgs.push('--model', model);
      agyArgs.push(...extraHarnessArgs, '--print', combinedPrompt);
      return ['agy', agyArgs];
    }

    case 'cmd': {
      // Command Code (`cmd`) — single-prompt mode via --print. Model optional
      // (`cmd --list-models`); forward as -m when given, else let cmd pick its
      // default. --skip-onboarding is functional, NOT a safety flag: it stops
      // the interactive taste-onboarding prompt from hanging an automated run,
      // so it stays outside safetyFor() and survives --unrestricted. Mirrors
      // the claude block otherwise.
      const cmdArgs = ['--print', ...safetyFor('cmd'), '--skip-onboarding'];
      if (model) cmdArgs.push('-m', model);
      cmdArgs.push(...extraHarnessArgs);
      cmdArgs.push(combinedPrompt);
      return ['cmd', cmdArgs];
    }

    case 'agent': {
      // Cursor CLI — binary `agent` (aliases `cursor`, `cursor-agent` are
      // normalized to `agent` upstream). Single-prompt headless mode via
      // --print. --plan is the gated safety flag (read-only plan mode; stripped
      // by --unrestricted). --trust is functional, NOT a safety flag: headless
      // --print mode otherwise prompts to trust the workspace and hangs an
      // automated run, so it stays outside safetyFor() and survives
      // --unrestricted. Model optional (`agent --list-models`); forward as
      // --model when given.
      const agentArgs = ['--print', ...safetyFor('agent'), '--trust'];
      if (model) agentArgs.push('--model', model);
      agentArgs.push(...extraHarnessArgs);
      agentArgs.push(combinedPrompt);
      return ['agent', agentArgs];
    }

    case 'kiro-cli': {
      // kiro-cli (AWS's rebrand of amazon-q-developer-cli) — one-shot mode
      // via `chat --no-interactive`. Its safety model is ADDITIVE and
      // INVERTED relative to every other engine handled above: --no-interactive
      // ALONE already auto-denies fs_write/execute_bash, so
      // safetyFor('kiro-cli') (--trust-tools= with an empty value) is
      // defense-in-depth on top of that, not the primary gate — unlike
      // codex's `-s read-only` or claude's `--permission-mode plan`, there is
      // no single flag here whose mere ABSENCE grants write capability.
      // Write access instead requires the separate ADDITIVE flag
      // --trust-all-tools, so (unlike every branch preceding this one) this
      // block reads the raw `unrestricted` parameter directly — safetyFor()
      // emptying alone would leave the engine no more permissive than
      // read-only, silently failing to honor --unrestricted.
      const kiroArgs = ['chat', '--no-interactive', ...safetyFor('kiro-cli')];
      if (unrestricted) kiroArgs.push('--trust-all-tools');
      if (model) kiroArgs.push('--model', model);
      kiroArgs.push(...extraHarnessArgs);
      kiroArgs.push(combinedPrompt);
      return ['kiro-cli', kiroArgs];
    }

    default:
      process.stderr.write(`${progName}: unhandled engine '${engine}'\n`);
      process.exit(1);
  }
}

// Detect Codex rejecting a pinned -m/--model (stderr is folded into
// result.tailText by run.js). Returns null when this is not that case.
function codexModelUnavailableNote(engine, model, result) {
  if (engine !== 'codex' || !model || result.error || result.killedByTimeout)
    return null;
  if ((result.status ?? 0) === 0) return null;
  const text = result.tailText || '';
  const looksLikeRejection =
    /(?:unknown|invalid|unsupported)\s+model\b/i.test(text) ||
    /\bmodel\b[^\n]{0,80}(?:not\s+found|not\s+available|unavailable)/i.test(
      text
    );
  if (!looksLikeRejection) return null;
  return (
    `# codex model unavailable: '${model}' was rejected by this Codex install/account. ` +
    'This invocation will keep the original engine exit code; retry with bare --engine=codex to use the Codex CLI default model.\n'
  );
}

module.exports = {
  INSTALL_HINTS,
  whichCmd,
  preflightCheck,
  SAFETY_FLAGS,
  safetyFor,
  buildHarnessCmd,
  codexModelUnavailableNote,
};
