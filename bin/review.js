#!/usr/bin/env node
// second-agent-skill review runner
// Usage: review.js --engine=<engine>[:<model>] --cwd=<path>
//                  [--diff=<spec> | --file=<path>] "<prompt>"
//                  [--engine-arg=<arg> ... | -- <engine-args...>]
// Engines: opencode, gemini, codex, claude, copilot, qwen, kilo, agy, cmd,
//          agent (Cursor CLI; aliases: cursor, cursor-agent), kiro-cli
//          (alias: kiro)
//
// --diff=<spec> shortcuts (review.js runs git in --cwd):
//   unstaged     → git diff + untracked files (new files git diff omits)
//   staged       → git diff --staged
//   last-commit  → git diff HEAD~1
//   branch       → git diff <auto-detected default>..HEAD
//                  (fallback: HEAD~1..HEAD)
//   <custom>     → git diff <custom>        (e.g. "HEAD~3..HEAD")
//
// --file=<path>  Read file content from disk. Repeatable — every --file= is
//                embedded as its own <file> block.
//
// Diff/file content is embedded directly in the prompt as a <diff> or <file>
// block. No temp files written, no model-side file reads, no sandbox carve-outs.
// Engines without shell access (gemini, qwen) and sandboxed engines (codex,
// opencode) all get the same deterministic inline content.
//
// Secret-file guard (system-level, on by default): review.js never embeds
// .env-style secret files (.env / .env.* / *.env, except *example* etc). It
// refuses --file=.env, skips untracked .env files, and redacts .env hunks from
// diffs (including git's c-quoted headers for non-ASCII paths). In --no-embed
// mode it appends git exclude pathspecs so the engine's own `git diff` omits
// them too. A prompt-level reminder is the final layer for sandbox tree walks.
// Override the whole guard with --include-secrets.
//
// --print-prompt  Dry-run: print the composed prompt and exit 0 — no spawn,
//                 no preflight, no log file. Single-engine only (rejected in
//                 fusion mode).
//
// Exit codes: 0 = success, 124 = timeout (GNU `timeout` convention),
// 3 = clean exit but NO usable output (zero bytes, or — when wrapped — output
// missing the <<<SECOND_OPINION_START>>> envelope), otherwise the engine's own
// non-zero code.

'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { shellQuote } = require('./shell-quote');
const { isLikelyEnvSecret } = require('./env-guard');
const engines = require('./lib/engines');
const content = require('./lib/content');
const envelope = require('./lib/envelope');
const run = require('./lib/run');

let engine = ''; // resolved single-engine name (post-validation)
let model = ''; // resolved single-engine model (post-validation)
const rawEngineSpecs = []; // every --engine= occurrence, comma-split: each item is 'name' or 'name:model'
let cwd = process.cwd();
let diffSpec = '';
const filePaths = []; // every --file= occurrence; multiple files are all embedded
let prompt = '';
let extraEngineArgs = [];
let showHelp = false;
let logArg = null; // null = unset, '' = auto-disabled with --log=-, string = explicit path
let timeoutArg = null; // null = use default, number = seconds, 0 = no timeout
let heartbeatArg = null; // null = use default, number = seconds, 0 = disabled
let concurrencyArg = null; // null = unbounded (fusion only); >=1 = max parallel slots
let unrestricted = false; // when true, drop the per-engine sandbox/plan/read-only flags
let noEmbed = false; // when true, do not inline diff/file content; instruct engine to fetch itself
let noWrap = false; // when true, do not append the structured-output sentinel envelope
let includeSecrets = false; // when true, DON'T scrub .env-style secret files from embedded content
let printAnswer = false; // when true, also echo the extracted answer payload to stdout
let printPrompt = false; // when true, print the composed prompt and exit — no spawn

// Defaults. Override via --timeout / --heartbeat or env vars (for harness tuning).
const DEFAULT_TIMEOUT_SEC = Number(process.env.SOS_TIMEOUT_SEC) || 600;
const DEFAULT_HEARTBEAT_SEC = Number(process.env.SOS_HEARTBEAT_SEC) || 30;
// Exit code for a "clean" engine exit (status 0) that nonetheless produced no
// usable review — zero bytes, or output missing the structured-output
// envelope. Distinct from success (0), the engine's own failure codes, and the
// timeout code (124) so callers/fusion can tell "engine ran but said nothing"
// apart from "engine errored" and "engine timed out".
const EXIT_NO_OUTPUT = 3;

const argv = process.argv.slice(2);

function printHelp() {
  process.stdout.write(
    [
      'Usage:',
      '  review.js --engine=<name>[:<model>] [--engine=...] --cwd=<path>',
      '            [--diff=<spec> | --file=<path>] "<prompt>"',
      '            [--engine-arg=<arg> ... | -- <engine-args...>]',
      '',
      'Engines:',
      '  opencode, gemini, codex, claude, copilot, qwen, kilo, agy, cmd, agent,',
      '  kiro-cli',
      '  (agent = Cursor CLI; aliases "cursor" and "cursor-agent" also work)',
      '  (kiro-cli alias: "kiro")',
      '',
      'Engine / model:',
      '  --engine=gemini                            default model',
      '  --engine=codex:gpt-5                       single engine, inline model',
      '  --engine=gemini --engine=codex:gpt-5       fusion: repeat the flag',
      '  --engine=opencode:a --engine=opencode:b    same engine, two models',
      '  --engine=a,b,c                             CSV shorthand',
      '',
      'Fusion output:',
      '  Each slot gets its own log file under $TMPDIR/second-opinion-fusion-<ts>/.',
      '  Filename is <engine>.log or <engine>__<sanitized-model>.log.',
      '',
      'Diff/file shortcuts:',
      '  --diff=unstaged     git diff + untracked files',
      '  --diff=staged       git diff --staged',
      '  --diff=last-commit  git diff HEAD~1',
      '  --diff=branch       git diff <default-branch>..HEAD (auto-detected)',
      '  --diff=<range>      git diff <range>',
      '  --file=<path>       review a specific file (repeatable)',
      '',
      'Extra engine args:',
      '  --engine-arg=<arg>  Forward one extra arg to the engine CLI (repeatable)',
      '  --                  Forward all remaining args to the engine CLI',
      '',
      'Output capture:',
      '  --log=<path>        Tee engine output to <path> (in addition to stdout)',
      '  --log=-             Disable auto-logging (force stdout-only)',
      '  (default)           Auto-log to $TMPDIR/second-opinion-<engine>-<ts>.log',
      '                      when stdout is not a TTY (agent harness, pipes, CI)',
      '',
      'Answer extraction (when a log file is in use and --no-wrap is NOT set):',
      '  On exit, review.js reads the log back and extracts the LAST complete',
      '  <<<SECOND_OPINION_START>>>…<<<SECOND_OPINION_END>>> pair with a',
      '  non-empty payload (markers must each sit alone on their own line —',
      '  inline mentions in echoed prose are ignored), writes the trimmed',
      '  payload to <log>.answer.md, and prints `ANSWER FILE: <path>` on',
      '  stdout. No answer this run → any stale <log>.answer.md from a',
      '  previous run is removed. Skipped for --log=- and for --no-wrap.',
      '  --print-answer      Also echo the extracted payload to stdout (before',
      '                      the final SECOND_OPINION_RESULT line)',
      '  The LAST stdout line is always a one-line JSON result — also on',
      '  launch failures (missing binary → exit 127, spawn errors); only',
      '  usage errors (bad flags/arguments) exit before it:',
      '    SECOND_OPINION_RESULT: {"engine","model","exit","log","answer","timeout"}',
      '  In fusion mode: {"fusion":true,"slots":[{…same keys per slot}]}',
      '',
      'Liveness:',
      `  --timeout=<sec>     Kill engine after N seconds (default ${DEFAULT_TIMEOUT_SEC}, 0=disable)`,
      `  --heartbeat=<sec>   Heartbeat interval when engine silent (default ${DEFAULT_HEARTBEAT_SEC}, 0=disable)`,
      '',
      'Fusion concurrency (multi-slot only):',
      '  --concurrency=<n>   Max slots running at once (default: all in parallel)',
      '                      1 = strictly serial, for rate-limited providers',
      '',
      'Engine behavior:',
      '  --unrestricted      Drop per-engine sandbox/plan/read-only flags',
      '                      (lets the engine edit/run commands; use deliberately)',
      '  --no-embed          Do not inline diff/file content; tell the engine to',
      '                      fetch via its own shell. Lower argv, needs shell access.',
      '  --no-wrap           Skip the structured-output sentinel envelope',
      '                      (default appends <<<SECOND_OPINION_START/END>>> markers)',
      '  --include-secrets   Do NOT scrub .env-style secret files. By default',
      '                      review.js refuses --file=.env, skips untracked .env',
      '                      files, and redacts .env hunks from diffs (except',
      '                      *example*/*sample*/*template*).',
      '  --print-prompt      Dry-run: print the composed prompt instead of',
      '                      running the engine, then exit 0. Single-engine only.',
      '',
      'Exit codes:',
      '  0    success',
      '  3    clean exit but NO usable output (0 bytes, or — when wrapped —',
      '       missing the <<<SECOND_OPINION_START>>> envelope)',
      '  124  timeout (matches GNU `timeout`)',
      "  *    otherwise the engine CLI's own non-zero code",
      '',
      'Examples:',
      '  review.js --engine=claude --cwd=. "Review this" --engine-arg=--verbose',
      '  review.js --engine=codex --cwd=. "Review this" -- --model o3',
      '  review.js --engine=gemini --cwd=. --log=/tmp/r.log "Review this"',
      '  review.js --engine=codex --cwd=. --timeout=300 --heartbeat=15 "Review this"',
    ].join('\n') + '\n'
  );
}

// Canonical registry of review.js's OWN flags. Single source of truth, kept in
// sync with the parse loop below. Used by the post-parse guard to detect when
// one of these leaks past `--` (or into --engine-arg=) and gets forwarded to
// the engine CLI — a common footgun that surfaces as a confusing engine-side
// "unknown argument" error rather than a review.js error. Prefix flags take
// `=<value>`; bare flags are standalone booleans. `--help`/`-h` are omitted on
// purpose: an engine may legitimately accept its own --help after `--`.
const REVIEW_JS_PREFIX_FLAGS = [
  '--engine=',
  '--engine-arg=',
  '--model=',
  '--cwd=',
  '--diff=',
  '--file=',
  '--log=',
  '--timeout=',
  '--heartbeat=',
  '--concurrency=',
];
const REVIEW_JS_BARE_FLAGS = [
  '--unrestricted',
  '--no-embed',
  '--no-wrap',
  '--include-secrets',
  '--print-answer',
  '--print-prompt',
];

// Warn (do not block) when a token destined for the engine CLI looks like one
// of review.js's own flags. We keep the `--` pass-through contract intact —
// the token IS forwarded — but emit a clear hint so the caller knows to move
// it before `--` if they meant it for review.js. Non-fatal by design: an
// engine could genuinely accept a same-named flag.
function warnMisplacedReviewFlags(args) {
  const misplaced = args.filter(
    (a) =>
      REVIEW_JS_BARE_FLAGS.includes(a) ||
      REVIEW_JS_PREFIX_FLAGS.some((p) => a.startsWith(p))
  );
  if (misplaced.length === 0) return;
  process.stderr.write(
    `review.js: note: ${misplaced.map((m) => `'${m}'`).join(', ')} ` +
      `look like review.js flag(s) but were placed after '--' (or in ` +
      `--engine-arg=), so they are forwarded to the engine CLI verbatim — ` +
      `likely causing an "unknown argument" failure from the engine. If you ` +
      `meant them for review.js, move them BEFORE '--'.\n`
  );
}

for (let i = 0; i < argv.length; i += 1) {
  const arg = argv[i];
  if (arg === '-h' || arg === '--help') {
    showHelp = true;
    break;
  }
  if (arg === '--') {
    extraEngineArgs = argv.slice(i + 1);
    break;
  }
  if (arg.startsWith('--engine-arg='))
    extraEngineArgs.push(arg.slice('--engine-arg='.length));
  else if (arg.startsWith('--engine=')) {
    // Repeatable. Each --engine= may also contain a comma-separated list;
    // each piece is 'name' or 'name:model'. Collect raw for later parsing.
    const v = arg.slice('--engine='.length);
    for (const piece of v
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean)) {
      rawEngineSpecs.push(piece);
    }
  } else if (arg.startsWith('--model=')) {
    process.stderr.write(
      "review.js: --model=<val> is no longer supported. Use '--engine=<name>:<model>' instead.\n"
    );
    process.exit(1);
  } else if (arg.startsWith('--cwd=')) cwd = arg.slice('--cwd='.length);
  else if (arg.startsWith('--diff=')) diffSpec = arg.slice('--diff='.length);
  else if (arg.startsWith('--file='))
    filePaths.push(arg.slice('--file='.length));
  else if (arg.startsWith('--log=')) logArg = arg.slice('--log='.length);
  else if (arg.startsWith('--timeout='))
    timeoutArg = arg.slice('--timeout='.length);
  else if (arg.startsWith('--heartbeat='))
    heartbeatArg = arg.slice('--heartbeat='.length);
  else if (arg.startsWith('--concurrency='))
    concurrencyArg = arg.slice('--concurrency='.length);
  else if (arg === '--unrestricted') unrestricted = true;
  else if (arg === '--no-embed') noEmbed = true;
  else if (arg === '--no-wrap') noWrap = true;
  else if (arg === '--include-secrets') includeSecrets = true;
  else if (arg === '--print-answer') printAnswer = true;
  else if (arg === '--print-prompt') printPrompt = true;
  else if (!prompt) prompt = arg;
  else {
    process.stderr.write(`review.js: unexpected argument '${arg}'\n`);
    process.stderr.write(
      'Use --engine-arg=<arg> or -- to pass extra engine-specific args.\n'
    );
    process.exit(1);
  }
}

if (showHelp) {
  printHelp();
  process.exit(0);
}

// Kept here (not hoisted to ./lib/engines) rather than merely re-exported:
// test/host-parity.test.js regex-parses this exact array literal straight
// out of this file's source text, so it has to stay a physical `const NAME =
// [ ... ]` declaration here, not a destructured reference. buildEngineCmd/
// preflightCheck/safetyFor (./lib/engines) don't need these three — they're
// arg-parsing/validation concerns review.js keeps.
const SUPPORTED_ENGINES = [
  'opencode',
  'gemini',
  'codex',
  'claude',
  'copilot',
  'qwen',
  'kilo',
  'agy',
  'cmd',
  'agent',
  'kiro-cli',
];

// Friendly engine-name aliases that normalize to a canonical engine before
// validation. Cursor's CLI binary is `agent`, but users naturally reach for
// "cursor" / "cursor-agent" — accept all three. kiro-cli similarly gets the
// shorter "kiro" alias. Applied in the slot parser below, so aliases flow
// through the rest of the script as the canonical name.
const ENGINE_ALIASES = {
  cursor: 'agent',
  'cursor-agent': 'agent',
  kiro: 'kiro-cli',
};

if (rawEngineSpecs.length === 0) {
  printHelp();
  process.exit(1);
}

// Engines that REQUIRE a model. Used to fail-fast. Currently none — every
// engine either picks its own model (gemini) or accepts a bare form that
// defers to the CLI's configured default (opencode/kilo/codex/claude/…).
const MODEL_REQUIRED = new Set([]);

// Parse every --engine= piece into a {engine, model} slot. Inline 'name:model'
// binds model directly to that slot; bare 'name' falls back to globalModel
// (if set) or empty. Dedup by (engine, model) tuple — same engine with
// different models is a valid pair of fusion slots.
const slots = [];
const seen = new Set();
for (const piece of rawEngineSpecs) {
  const idx = piece.indexOf(':');
  let eng, mdl;
  if (idx >= 0) {
    eng = piece.slice(0, idx);
    mdl = piece.slice(idx + 1);
    if (!eng || !mdl) {
      process.stderr.write(
        `review.js: --engine='${piece}' has empty engine or model around ':'\n`
      );
      process.exit(1);
    }
  } else {
    eng = piece;
    mdl = '';
  }
  // Normalize friendly aliases (cursor, cursor-agent) to their canonical
  // engine (agent) before validation and dedup.
  eng = ENGINE_ALIASES[eng] || eng;
  if (!SUPPORTED_ENGINES.includes(eng)) {
    process.stderr.write(`review.js: unknown engine '${eng}'\n`);
    process.stderr.write(
      `Supported engines: ${SUPPORTED_ENGINES.join(', ')}\n`
    );
    process.exit(1);
  }
  const key = `${eng}\u0001${mdl}`;
  if (seen.has(key)) continue; // dedup exact-duplicate slots
  seen.add(key);
  slots.push({ engine: eng, model: mdl });
}

// Validate model-required engines.
for (const s of slots) {
  if (MODEL_REQUIRED.has(s.engine) && !s.model) {
    process.stderr.write(
      `review.js: engine '${s.engine}' requires a model. Use '--engine=${s.engine}:<provider/model>'.\n`
    );
    process.exit(1);
  }
}

// Footgun guard: if a review.js flag was placed after `--` (or smuggled via
// --engine-arg=), warn before we dispatch. In fusion mode this runs in the
// parent (real stderr) and again in each child (stderr ignored), so the
// caller sees exactly one note.
warnMisplacedReviewFlags(extraEngineArgs);

const isFusion = slots.length > 1;

// --print-prompt is a single-engine-only dry-run (see the print-and-exit
// below, after combinedPrompt is built). Reject it up front in fusion mode,
// before the fusion banner or any child is spawned.
if (printPrompt && isFusion) {
  process.stderr.write(
    'review.js: --print-prompt is single-engine only; it cannot be used with ' +
      '2+ --engine= slots (fusion mode).\n'
  );
  process.exit(1);
}

// In single-engine mode, project the slot back onto the module-level
// `engine`/`model` vars that the rest of the script reads.
if (!isFusion) {
  engine = slots[0].engine;
  model = slots[0].model;
}

if (!prompt) {
  process.stderr.write(
    'review.js: prompt is required as a positional argument\n'
  );
  process.exit(1);
}

if (diffSpec && filePaths.length) {
  process.stderr.write('review.js: --diff and --file are mutually exclusive\n');
  process.exit(1);
}

// Refuse to hand an engine a .env-style secret file — whether we embed its
// contents or (under --no-embed) tell the engine to open it itself. Override
// with --include-secrets. System-level: enforced before any prompt is built.
if (!includeSecrets) {
  const secret = filePaths.find((p) => isLikelyEnvSecret(p));
  if (secret) {
    process.stderr.write(
      `review.js: refusing --file='${secret}' — it looks like a secret/.env ` +
        'file and may hold real credentials. Pass --include-secrets to ' +
        'override, or use an .env.example.\n'
    );
    process.exit(1);
  }
}

function parseSecondsArg(name, raw, fallback) {
  if (raw === null) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) {
    process.stderr.write(
      `review.js: --${name}=<seconds> must be a non-negative number, got '${raw}'\n`
    );
    process.exit(1);
  }
  return n;
}

const timeoutSec = parseSecondsArg('timeout', timeoutArg, DEFAULT_TIMEOUT_SEC);
const heartbeatSec = parseSecondsArg(
  'heartbeat',
  heartbeatArg,
  DEFAULT_HEARTBEAT_SEC
);

// Max number of fusion slots to run at once. Unset → unbounded (all slots in
// parallel, the historical default). 1 → strictly serial (rate-limit safe).
// k → capped pool of k. Only meaningful in fusion mode; ignored for a single
// engine. Validated up front so a typo fails fast rather than mid-run.
function parseConcurrencyArg(raw) {
  if (raw === null) return Infinity;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1) {
    process.stderr.write(
      `review.js: --concurrency=<n> must be a positive integer, got '${raw}'\n`
    );
    process.exit(1);
  }
  return n;
}
const concurrency = parseConcurrencyArg(concurrencyArg);

// Diff/file fetching + the secret-file guard applied to it (resolveDiffArgs,
// fetchDiffContent, readFileContent, escapeForBlock, checkPromptSize, etc.)
// live in ./lib/content — shared with any other runner that composes a
// prompt from a diff/file the same way.

// `combinedPrompt` is consumed deep inside buildEngineCmd(). In single-engine
// mode we build it now; in fusion mode the children build their own copies
// (since each may differ if they ever specialize — but for now identical),
// so we skip the work here and let runFusion() spawn children that go
// through this same top-level codepath with --engine=<one>.
let combinedPrompt = '';
if (!isFusion) {
  combinedPrompt = prompt;
  if (diffSpec) {
    if (noEmbed) {
      const args = content
        .resolveDiffArgs(diffSpec, cwd, includeSecrets)
        .map(shellQuote)
        .join(' ');
      combinedPrompt =
        `Repository root: ${cwd}\n` +
        `Use your shell to run: git -C ${shellQuote(cwd)} ${args}\n` +
        `Read the resulting diff, then:\n\n${prompt}`;
    } else {
      const diffContent = content.escapeForBlock(
        content.fetchDiffContent(diffSpec, cwd, includeSecrets),
        'diff'
      );
      combinedPrompt = `<diff>\n${diffContent}\n</diff>\n\nReview the diff above. Then:\n\n${prompt}`;
    }
  } else if (filePaths.length) {
    if (noEmbed) {
      const list = filePaths.map((p) => `  - ${p}`).join('\n');
      combinedPrompt =
        `Repository root: ${cwd}\n` +
        `Read the file(s) at:\n${list}\n` +
        `Then:\n\n${prompt}`;
    } else {
      const blocks = filePaths
        .map((p) => {
          const fileContent = content.escapeForBlock(
            content.readFileContent(p),
            'file'
          );
          return `<file path="${p}">\n${fileContent}\n</file>`;
        })
        .join('\n\n');
      const noun = filePaths.length > 1 ? 'files' : 'file';
      combinedPrompt = `${blocks}\n\nReview the ${noun} above. Then:\n\n${prompt}`;
    }
  }

  // When review.js embedded the content (diff/file, not --no-embed), tell the
  // engine the review is self-contained. Agentic engines (notably opencode)
  // otherwise ignore the embedded block and explore the filesystem — globbing
  // outside --cwd, tripping sandbox auto-rejects, and returning an empty review.
  if (!noEmbed && (diffSpec || filePaths.length)) {
    combinedPrompt +=
      '\n\n---\n' +
      'This review is self-contained: everything needed is in the content above. ' +
      'Answer from it directly — do not read files, glob, run shell commands, or ' +
      'otherwise explore the repository.';
  }

  // Secret-file guard (belt-and-suspenders for self-read vectors). review.js
  // already scrubs .env contents from anything it embeds; this line covers the
  // cases where the engine reads on its own — --no-embed, or a sandbox engine
  // walking the tree. Skipped under --include-secrets.
  if (!includeSecrets) {
    combinedPrompt += content.buildSecretReminder();
  }

  // Structured-output envelope. Forces the engine to emit its real answer
  // between stable sentinels, so callers can extract the payload from the
  // log without scraping reasoning traces, tool-use noise, or model-specific
  // scaffolding. Topic-neutral — works for review, Q&A, brainstorming, anything.
  if (!noWrap) {
    combinedPrompt += envelope.buildEnvelopeInstruction();
  }

  content.checkPromptSize(combinedPrompt);

  // Dry-run: print the fully composed prompt and exit — no preflight, no
  // spawn, no log file, no progress banner. Single-engine only (rejected
  // above in fusion mode). Synchronous write (writeStdoutSync), same
  // rationale as emitResultAndExit: a large diff/file payload can exceed the
  // pipe buffer, and process.exit() right after an async process.stdout.write
  // would discard whatever hadn't drained yet, truncating the prompt.
  if (printPrompt) {
    run.writeStdoutSync(combinedPrompt + '\n');
    process.exit(0);
  }
}

// Determine where to write the captured copy of engine output (the "log").
// Priority:
//   --log=<path>   → explicit file path
//   --log=-        → disable (force stdout-only)
//   stdout is TTY  → no log (interactive use)
//   otherwise      → auto-generate $TMPDIR/second-opinion-<engine>-<ts>.log
// Returning null means "don't write a log file, just stream to stdout".
function resolveLogPath() {
  if (logArg === '-') return null;
  if (logArg) return path.resolve(logArg);
  if (process.stdout.isTTY) return null;
  const tmp = (process.env.TMPDIR || '/tmp').replace(/\/+$/, '');
  return path.join(tmp, `second-opinion-${engine}-${Date.now()}.log`);
}

// whichCmd/preflightCheck live in ./lib/engines (side-effect-free there —
// this file decides how to report/exit on a launch failure; see the
// preflight check inside main()).

// chooseSpawn / runEngine / signum (PTY selection, heartbeat/timeout
// lifecycle, signal-name mapping) live in ./lib/run. SAFETY_FLAGS/
// safetyFor/buildEngineCmd live in ./lib/engines.

// ANSWER_START_RE/ANSWER_END_RE/extractLastAnswer live in ./lib/envelope.
// writeStdoutSync lives in ./lib/run.

// `started` is read by emitHeartbeat / timeout messages, so declare at
// module scope for clarity.
const started = Date.now();

async function main() {
  if (unrestricted) {
    process.stderr.write(
      `review.js: --unrestricted — dropping safety flags for ${engine} ` +
        `(${engines.SAFETY_FLAGS[engine].join(' ')}). The engine may edit files or run ` +
        'arbitrary commands.\n'
    );
  }

  const [cmd, args] = engines.buildEngineCmd({
    engine,
    model,
    cwd,
    extraEngineArgs,
    combinedPrompt,
    unrestricted,
  });

  // Pre-flight: fail fast with a clear error if the engine CLI isn't on
  // PATH, rather than letting spawn surface ENOENT mid-stream. Side-effect
  // free in engines.preflightCheck (returns a diagnostic instead of writing
  // to stderr/exiting itself) — this is the one call site, so it reports and
  // exits right here.
  const missing = engines.preflightCheck(cmd, engine);
  if (missing) {
    process.stderr.write(
      `review.js: '${cmd}' not found on PATH. Cannot run --engine=${engine}.${missing.hint}\n`
    );
    // Launch failures still emit the machine-readable result line (always
    // the last stdout line — see emitResultAndExit below). No log file
    // exists yet at preflight time, so log is null. Synchronous write: this
    // exits immediately after, and async stdout would be discarded.
    run.writeStdoutSync(
      `SECOND_OPINION_RESULT: ${JSON.stringify({
        engine,
        model: model || null,
        exit: 127,
        log: null,
        answer: null,
        timeout: false,
      })}\n`
    );
    process.exit(127);
  }

  // Set up output capture. We pipe child stdout/stderr through this process,
  // optionally tee'ing every chunk into a log file so callers (especially
  // agent harnesses) can recover the full output even if their stdout was
  // truncated by `| head`, `| tail`, or buffered until exit.
  const logPath = resolveLogPath();
  let logStream = null;
  if (logPath) {
    try {
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      // mode: 0o600 — engine transcripts can contain diff/file content the
      // secret guard tried to keep away from other users on a shared host.
      logStream = fs.createWriteStream(logPath, { flags: 'w', mode: 0o600 });
    } catch (err) {
      process.stderr.write(
        `review.js: could not open log file '${logPath}': ${err.message}\n`
      );
      logStream = null;
    }
  }

  const stdoutSuppressed = !!logStream && !process.stdout.isTTY;
  if (logStream) {
    const header = [
      `# review.js ${engine}${model ? ` (${model})` : ''}`,
      `# cwd: ${cwd}`,
      `# started: ${new Date(started).toISOString()}`,
      `# prompt-bytes: ${Buffer.byteLength(combinedPrompt, 'utf8')}`,
      `# timeout: ${timeoutSec}s, heartbeat: ${heartbeatSec}s`,
      diffSpec
        ? `# diff: ${diffSpec}`
        : filePaths.length
          ? `# file: ${filePaths.join(', ')}`
          : '# scope: prompt-only',
      '',
    ].join('\n');
    logStream.write(header);
    // Print a loud banner on BOTH stdout and stderr so it survives any kind
    // of agent-side stream redirection — `| tail -N`, `2>/dev/null`,
    // `> file`, etc. The banner explicitly tells the caller to Read the log
    // path rather than scrape the command output.
    const banner = stdoutSuppressed
      ? [
          '===========================================================',
          `REVIEW IN PROGRESS — ${engine}${model ? ` (${model})` : ''}`,
          `LOG FILE: ${logPath}`,
          `TIMEOUT: ${timeoutSec}s, HEARTBEAT: ${heartbeatSec}s`,
          'Engine output is being written to the log file only.',
          'After this command exits, use the Read tool on the LOG FILE path',
          'above to retrieve the full review. A short tail will be printed',
          'on stdout after the engine exits.',
          '===========================================================',
        ].join('\n')
      : `review.js: logging to ${logPath} (tee'd)`;
    process.stdout.write(banner + '\n');
    process.stderr.write(`review.js: logging to ${logPath}\n`);
  }

  const result = await run.runEngine(cmd, args, logStream, {
    cwd,
    timeoutSec,
    heartbeatSec,
    started,
  });
  const codexModelNote = engines.codexModelUnavailableNote(
    engine,
    model,
    result
  );
  if (codexModelNote) {
    if (logStream) logStream.write(codexModelNote);
    process.stderr.write(`review.js: ${codexModelNote.replace(/^# /, '')}`);
  }
  const dur = ((Date.now() - started) / 1000).toFixed(1);

  // Finalize the log's engine-output portion BEFORE extraction: the write
  // stream may still hold buffered bytes, and extraction reads the file back
  // from disk. The trailer (exit/duration/quality note) is appended after the
  // quality verdict below, so the note in the log matches the actual verdict.
  if (logStream) await new Promise((r) => logStream.end(r));

  // Answer extraction. When a log FILE is on disk (auto-log or --log=<path>,
  // but NOT --log=-) and the structured-output envelope was requested (not
  // --no-wrap), read the just-closed log back and pull the LAST complete
  // non-empty own-line <<<SECOND_OPINION_START>>>…<<<SECOND_OPINION_END>>>
  // pair. The trimmed payload is written to <log>.answer.md so callers get
  // the engine's answer without re-scraping the log. No payload this run →
  // any stale .answer.md a previous run left on a reused --log path is
  // removed, so the file's existence always reflects THIS run.
  let answerPath = null;
  let answerPayload = null;
  if (logPath) {
    const answerResult = envelope.writeAnswerFile(logPath, { noWrap });
    answerPath = answerResult.answerPath;
    answerPayload = answerResult.answerPayload;
    if (answerResult.writeError) {
      process.stderr.write(
        `review.js: could not write answer file '${logPath}.answer.md': ${answerResult.writeError.message}\n`
      );
    }
  }

  // Output-quality verdict — only for a CLEAN exit (no launch error, no
  // timeout, status 0). An engine that "succeeds" yet returns nothing, or
  // returns text without a usable structured-output envelope, is silently
  // useless (an empty review reported as success).
  //   - 0 bytes → always flagged (empty output is never useful)
  //   - wrapped, log file in use → keyed on extraction success: no extracted
  //     answer (e.g. only an instructions-echo with inline markers) is
  //     exactly the silent-uselessness exit 3 exists for
  //   - wrapped, no log file (--log=- / TTY, or the log could not be
  //     created — logStream null means nothing was ever on disk to extract
  //     from) → fall back to the streaming sawEnvelope presence check
  let qualityExit = null;
  let qualityNote = '';
  if (!result.error && !result.killedByTimeout && result.status === 0) {
    const envelopeUsable = logStream
      ? answerPayload !== null
      : result.sawEnvelope;
    if ((result.totalBytes ?? 0) === 0) {
      qualityExit = EXIT_NO_OUTPUT;
      qualityNote =
        `engine '${engine}' exited 0 but produced NO OUTPUT — possible ` +
        'upstream model unavailability, or the sandbox blocked all reads';
    } else if (!noWrap && !envelopeUsable) {
      qualityExit = EXIT_NO_OUTPUT;
      qualityNote =
        `engine '${engine}' exited 0 with output but NO ` +
        '<<<SECOND_OPINION_START>>> envelope — likely truncated, refused, or ' +
        'sandbox-blocked';
    }
  }

  if (logStream) {
    const trailer =
      `\n\n# exit: ${result.status ?? 'unknown'} duration: ${dur}s` +
      (result.killedByTimeout ? ' (timeout)' : '') +
      (qualityExit !== null ? `\n# NO USABLE OUTPUT: ${qualityNote}` : '') +
      '\n';
    try {
      // The stream is already closed (extraction needed the flushed file), so
      // the trailer goes on with a plain append.
      fs.appendFileSync(logPath, trailer);
    } catch {
      /* best-effort */
    }
    let bytes = 0;
    try {
      bytes = fs.statSync(logPath).size;
    } catch {
      /* ignore */
    }
    const finalLine = `REVIEW COMPLETE — read with Read tool: ${logPath} (${bytes}B, exit=${result.status ?? 'unknown'}, ${dur}s${result.killedByTimeout ? ', TIMEOUT' : ''})`;
    process.stdout.write(finalLine + '\n');
    process.stderr.write(
      `review.js: log ${logPath} (${bytes}B, exit=${result.status ?? 'unknown'}, ${dur}s${result.killedByTimeout ? ', TIMEOUT' : ''})\n`
    );
  }

  // Order barrier: everything above went through process.stdout, which is
  // asynchronous on a pipe. Wait for it to flush before the synchronous tail
  // writes below (writeStdoutSync), so queued banner/engine-tail bytes can
  // neither be reordered past the ANSWER FILE / result lines nor dropped.
  if (process.stdout.writable)
    await new Promise((r) => process.stdout.write('', r));

  // Emit the machine-readable result line — ALWAYS the final stdout line —
  // then exit. Single-engine shape: {engine, model, exit, log, answer,
  // timeout}. Written synchronously (writeStdoutSync) because process.exit()
  // discards async stdout still queued on a pipe: behind a multi-MB
  // --print-answer echo that silently truncates the payload AND drops this
  // line. Shared by every post-spawn exit path (success, EXIT_NO_OUTPUT,
  // timeout, launch failure) so callers can always parse one line.
  function emitResultAndExit(exitCode, answer, timedOut) {
    run.writeStdoutSync(
      `SECOND_OPINION_RESULT: ${JSON.stringify({
        engine,
        model: model || null,
        exit: exitCode,
        // Planned-but-never-created path → null: when the log could not be
        // opened (logStream null) there is no file for a consumer to Read,
        // same rule as the fusion slots and the preflight-failure line.
        log: logStream ? logPath : null,
        answer: answer ?? null,
        timeout: !!timedOut,
      })}\n`
    );
    process.exit(exitCode);
  }

  if (result.error) {
    if (result.error.code === 'E2BIG') {
      process.stderr.write(
        `review.js: argv too large for OS (E2BIG). Lower PROMPT_BYTE_LIMIT or narrow the diff range.\n`
      );
      emitResultAndExit(1, null, false);
    }
    process.stderr.write(
      `review.js: failed to launch '${engine}': ${result.error.message}\n`
    );
    emitResultAndExit(1, null, false);
  }

  // Final exit code (priority: launch error above → timeout → the
  // no-usable-output verdict → the engine's own status). Computed once so the
  // machine result line below and the actual process exit stay in lockstep.
  const finalExit = result.killedByTimeout
    ? 124
    : qualityExit !== null
      ? qualityExit
      : (result.status ?? 1);

  // ANSWER FILE line + optional payload echo (--print-answer). Both land
  // BEFORE the result line. The echo uses the in-memory payload, so it still
  // works when the .answer.md write itself failed. Synchronous writes — same
  // rationale as emitResultAndExit.
  if (answerPath) run.writeStdoutSync(`ANSWER FILE: ${answerPath}\n`);
  if (printAnswer && answerPayload !== null)
    run.writeStdoutSync(answerPayload + '\n');

  // Human-facing no-usable-output note (kept on stderr for parity with the
  // previous behavior; the machine result line carries the same signal in
  // its `exit` field).
  if (qualityExit !== null) {
    process.stderr.write(
      `review.js: ${qualityNote}. Treating as failure (exit ${qualityExit}).\n`
    );
  }

  emitResultAndExit(finalExit, answerPath, result.killedByTimeout);
}

// Run `worker(item, idx)` over `items` with at most `limit` in flight at once.
// Results preserve item order. limit === Infinity runs everything at once
// (Promise.all equivalent — the historical fusion behavior). Workers are
// expected to resolve (never reject), matching the fusion child contract.
async function runPool(items, limit, worker) {
  const results = new Array(items.length);
  const lanes = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  async function lane() {
    while (cursor < items.length) {
      const idx = cursor;
      cursor += 1;
      results[idx] = await worker(items[idx], idx);
    }
  }
  await Promise.all(Array.from({ length: lanes }, lane));
  return results;
}

// Fusion mode: spawn one child review.js per engine. By default every slot
// runs at once; --concurrency=<n> caps how many run in parallel (1 = strictly
// serial, for rate-limited providers). Each child goes through the normal
// single-engine codepath (log file, output envelope, safety flags, etc.) —
// the parent only orchestrates and aggregates.
async function runFusion() {
  const tmp = (process.env.TMPDIR || '/tmp').replace(/\/+$/, '');
  const fusionDir = path.join(tmp, `second-opinion-fusion-${Date.now()}`);
  try {
    fs.mkdirSync(fusionDir, { recursive: true });
  } catch (err) {
    process.stderr.write(
      `review.js: could not create fusion dir ${fusionDir}: ${err.message}\n`
    );
    // Even this launch failure emits the machine-readable result line (the
    // parent's only stdout write so far): one dead entry per requested slot —
    // nothing ran, no logs exist.
    run.writeStdoutSync(
      `SECOND_OPINION_RESULT: ${JSON.stringify({
        fusion: true,
        slots: slots.map((s) => ({
          engine: s.engine,
          model: s.model || null,
          exit: 1,
          log: null,
          answer: null,
          timeout: false,
        })),
      })}\n`
    );
    return 1;
  }

  // Strip --engine, --model, and --log from the inherited argv. The parent
  // re-injects them per child. Everything else (--cwd, --diff, --file,
  // --unrestricted, --no-embed, --no-wrap, --timeout, --heartbeat,
  // --engine-arg=..., --, the prompt) flows through unchanged.
  //
  // Args after a bare `--` are extraEngineArgs and must be passed through
  // verbatim — they may legitimately contain '--engine=', '--model=', or
  // '--log=' tokens intended for the engine CLI itself, not review.js.
  const stripped = [];
  let pastDoubleDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!pastDoubleDash && a === '--') {
      pastDoubleDash = true;
      stripped.push(a);
      continue;
    }
    if (
      !pastDoubleDash &&
      (a.startsWith('--engine=') ||
        a.startsWith('--model=') ||
        a.startsWith('--log=') ||
        a.startsWith('--concurrency='))
    ) {
      continue;
    }
    stripped.push(a);
  }

  // Build collision-free log filenames. Same engine with different models is
  // allowed, so encode the model in the filename when present.
  function slotLogName(slot) {
    if (!slot.model) return `${slot.engine}.log`;
    const safe = slot.model.replace(/[^A-Za-z0-9._-]/g, '_');
    return `${slot.engine}__${safe}.log`;
  }

  const slotPaths = slots.map((s) => ({
    ...s,
    logPath: path.join(fusionDir, slotLogName(s)),
  }));

  const concurrencyLine = Number.isFinite(concurrency)
    ? `CONCURRENCY: ${concurrency} at a time${concurrency === 1 ? ' (serial)' : ''}`
    : 'CONCURRENCY: unbounded (all slots at once)';
  const banner = [
    '===========================================================',
    `FUSION REVIEW — ${slotPaths.length} slots`,
    `FUSION DIR: ${fusionDir}`,
    concurrencyLine,
    ...slotPaths.map(
      (s) => `  ${s.engine}${s.model ? ` (${s.model})` : ''}: ${s.logPath}`
    ),
    'Read each log file after exit; each log is',
    'wrapped with <<<SECOND_OPINION_START/END>>> markers (unless --no-wrap).',
    '===========================================================',
  ].join('\n');
  process.stdout.write(banner + '\n');
  process.stderr.write(`review.js: fusion dir ${fusionDir}\n`);

  // Track every spawned child so a parent-level signal (SIGINT/SIGTERM) can
  // tear them all down together. Without this, Ctrl-C on the parent leaves
  // children running headless in the background, eating quota and ignoring
  // user intent.
  const liveChildren = new Set();
  function reapAll(signal) {
    for (const c of liveChildren) {
      try {
        c.kill(signal);
      } catch {
        /* already gone */
      }
    }
  }
  let forwardedSignal = null;
  function onParentSignal(sig) {
    if (forwardedSignal) return;
    forwardedSignal = sig;
    process.stderr.write(
      `review.js: fusion: received ${sig}, forwarding to ${liveChildren.size} child(ren)\n`
    );
    reapAll('SIGTERM');
    // Grace then SIGKILL anything still alive.
    setTimeout(() => reapAll('SIGKILL'), run.KILL_GRACE_MS).unref();
  }
  process.on('SIGINT', onParentSignal);
  process.on('SIGTERM', onParentSignal);

  // Parent-level heartbeat. Children are stdio-silenced, so the parent
  // process is otherwise inert from the caller's perspective for the full
  // duration of the slowest engine. Emit one short stderr line every
  // heartbeatSec while any child is alive, so the caller (and `tail -f` on
  // the user's terminal) can tell the run hasn't hung. Disabled by
  // --heartbeat=0.
  const fusionStarted = Date.now();
  let fusionHeartbeatTimer = null;
  if (heartbeatSec > 0) {
    fusionHeartbeatTimer = setInterval(() => {
      const alive = liveChildren.size;
      if (alive === 0) return;
      const elapsed = Math.round((Date.now() - fusionStarted) / 1000);
      process.stderr.write(
        `review.js: fusion: ${alive}/${slotPaths.length} alive +${elapsed}s ` +
          `(read logs in ${fusionDir} for engine output)\n`
      );
    }, heartbeatSec * 1000);
    if (fusionHeartbeatTimer.unref) fusionHeartbeatTimer.unref();
  }

  // Wrap the await in try/finally so the SIGINT/SIGTERM handlers and the
  // heartbeat interval get torn down even if an unexpected error reaches
  // here. (Child promises only resolve, never reject, so a leak is
  // unlikely in practice — but unref'd or not, leaving a setInterval
  // running past its scope is sloppy.)
  let results;
  try {
    results = await runPool(slotPaths, concurrency, (s) => {
      // Pass the slot's (engine, model) inline as a single --engine=name:model
      // arg. --model= no longer exists at the CLI surface.
      const childArgs = [
        __filename,
        ...stripped,
        `--engine=${s.engine}${s.model ? `:${s.model}` : ''}`,
        `--log=${s.logPath}`,
      ];
      return new Promise((resolve) => {
        // Suppress child stdio entirely. Each child's log file is opened
        // via fs.createWriteStream and captures engine stdout AND stderr
        // independently of the process pipes, so nothing useful is lost.
        // Inheriting would surface the per-child "REVIEW IN PROGRESS"
        // banner, heartbeats, and engine-output tail to the parent — all
        // already captured in the log. For an agent harness that reads
        // the parent's stdout, that doubles token usage for no signal.
        const child = spawn(process.execPath, childArgs, {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        liveChildren.add(child);
        child.on('exit', (code, signal) => {
          liveChildren.delete(child);
          resolve({
            slot: s,
            code: signal ? 128 + (run.signum(signal) || 0) : (code ?? 1),
            signal,
          });
        });
        child.on('error', (err) => {
          liveChildren.delete(child);
          process.stderr.write(
            `review.js: fusion child for '${s.engine}' failed to spawn: ${err.message}\n`
          );
          resolve({ slot: s, code: 1, err });
        });
      });
    });
  } finally {
    process.off('SIGINT', onParentSignal);
    process.off('SIGTERM', onParentSignal);
    if (fusionHeartbeatTimer) clearInterval(fusionHeartbeatTimer);
  }

  const trailer = [
    '',
    '===========================================================',
    'FUSION COMPLETE',
    ...results.map((r) => {
      // Annotate each slot's exit code: 124 = timeout, EXIT_NO_OUTPUT (3) =
      // engine ran but returned nothing usable (empty / no envelope), any
      // other non-zero = engine-reported failure.
      const label =
        r.code === 124
          ? ' (TIMEOUT)'
          : r.code === EXIT_NO_OUTPUT
            ? ' (NO USABLE OUTPUT — empty or missing envelope)'
            : r.code !== 0
              ? ' (FAILED)'
              : '';
      return (
        `  ${r.slot.engine}${r.slot.model ? ` (${r.slot.model})` : ''}: ` +
        `exit=${r.code}${label} log=${r.slot.logPath}`
      );
    }),
    `Read each log with the Read tool and extract the LAST complete`,
    `<<<SECOND_OPINION_START>>> … <<<SECOND_OPINION_END>>> pair (engines may`,
    `echo the format instructions or duplicate output; the last pair is the answer).`,
    '===========================================================',
  ].join('\n');
  process.stdout.write(trailer + '\n');

  // Machine-readable result line — the parent's final stdout line. Children run
  // as review.js subprocesses with stdio fully silenced, so we can't parse each
  // child's own SECOND_OPINION_RESULT line; instead we derive each slot's
  // fields from what the parent already controls — the slot's known log path
  // (passed as --log=<slot>) and its captured exit code. The child writes
  // <slot>.answer.md when it extracts an answer, so the parent reports that
  // path when it exists on disk, else null. Same per-slot key shape as the
  // single-engine line.
  const slotResults = results.map((r) => {
    // Both file paths are reported only if the file actually exists: a child
    // that died in preflight (missing binary → 127) never opened its slot log,
    // and pointing machine consumers at a planned-but-never-created path would
    // send them Read-ing a nonexistent file. Mirrors the single-engine
    // launch-failure result line, which reports log:null.
    const answerFile = `${r.slot.logPath}.answer.md`;
    let answer = null;
    let log = null;
    try {
      if (fs.existsSync(answerFile)) answer = answerFile;
      if (fs.existsSync(r.slot.logPath)) log = r.slot.logPath;
    } catch {
      /* ignore — reported as null */
    }
    return {
      engine: r.slot.engine,
      model: r.slot.model || null,
      exit: r.code,
      log,
      answer,
      timeout: r.code === 124,
    };
  });
  // Order barrier + synchronous write, same rationale as the single-engine
  // path: the trailer above is async on a pipe, and process.exit right after
  // runFusion resolves would discard anything still queued.
  if (process.stdout.writable)
    await new Promise((r) => process.stdout.write('', r));
  run.writeStdoutSync(
    `SECOND_OPINION_RESULT: ${JSON.stringify({ fusion: true, slots: slotResults })}\n`
  );

  // Aggregate exit code: 124 (timeout) dominates, then any non-zero, then 0.
  const codes = results.map((r) => r.code);
  if (codes.includes(124)) return 124;
  return codes.find((c) => c !== 0) ?? 0;
}

(async () => {
  try {
    if (isFusion) {
      const code = await runFusion();
      process.exit(code);
    } else {
      await main();
    }
  } catch (err) {
    process.stderr.write(
      `review.js: unexpected error: ${err.stack || err.message}\n`
    );
    process.exit(1);
  }
})();
