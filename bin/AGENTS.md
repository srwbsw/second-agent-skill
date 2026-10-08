# bin/ — runners & helpers

Two entry points share internals via `bin/lib/`: `review.js` is read-only second opinions/code review; its sibling `agent.js` delegates an arbitrary engineering task (write tests, fix a bug, refactor, run commands) to one engine inside `--cwd` — see its own section below. `list.js` does provider/model discovery (opencode, kilo). `shell-quote.js` and `env-guard.js` are pure modules, each with its own unit test in `test/`.

## bin/lib/ — shared modules

- `lib/engines.js` — `SAFETY_FLAGS` map, `safetyFor(eng, unrestricted)`, `buildEngineCmd()` (one `case` per engine), `preflightCheck`/`whichCmd`, `INSTALL_HINTS`, `codexModelUnavailableNote()` (log hint when a pinned codex model is rejected; no auto-retry). `SUPPORTED_ENGINES`/`ENGINE_ALIASES`/`MODEL_REQUIRED` stay as literal consts in **each** entry point (not hoisted here) — see the file's header comment for why; keep both copies in sync when adding an engine.
- `lib/content.js` — diff/file fetching (`fetchDiffContent`, `fetchUntrackedContent`, `readFileContent`), the `.env` secret guard glue (`redactEnvFromDiff`, `diffHeaderTouchesEnvSecret`, `buildSecretReminder`), `escapeForBlock`, `checkPromptSize`/`PROMPT_BYTE_LIMIT`, `resolveDiffArgs` (for `--no-embed`).
- `lib/envelope.js` — the `<<<SECOND_OPINION_START/END>>>` marker constants, `buildEnvelopeInstruction()`, `createEnvelopeWatcher()` (streaming `sawEnvelope`, loose presence-only — review.js's long-standing semantics), `createStrictEnvelopeWatcher()` (streaming, but requires a COMPLETE non-empty START..END pair — `agent.js`'s no-log-file path only), `extractLastAnswer()`, `writeAnswerFile()`.
- `lib/run.js` — spawn (`detached: true`, so the child leads its OWN process group) + heartbeat + timeout (`SIGTERM`→`SIGKILL` grace, each signaling the whole process GROUP via `process.kill(-pid, sig)` with a `child.kill()` fallback — kills PTY wrappers/engine-spawned subprocesses too, not just the direct child) + log streaming + `signum` + `writeStdoutSync`/`writeStderrSync`. `runEngine(cmd, args, logStream, opts)`'s `opts` also takes `progName` (diagnostic-message prefix, default `'review.js'`) and `strictEnvelope` (bool, default `false`).

Each entry point keeps its own arg parsing, prompt-composition policy (review prose vs. task directive), and `main()`. `review.js` also keeps fusion (multi-`--engine=`); `agent.js` has no fusion — exactly one engine slot per invocation.

## review.js / agent.js engine model

Engine wiring lives in `bin/lib/engines.js`: `SAFETY_FLAGS` map and the `buildEngineCmd()` switch (one `case` per engine) — shared by both entry points, so a new engine's task-mode support is automatic once it's wired here. Fusion = repeating `--engine=` on `review.js` only; the parent re-spawns `review.js` once per slot (children re-parse argv independently). `agent.js` always calls `buildEngineCmd()` with `unrestricted: true` (it has no read-only mode — see "agent.js" below).

## Safety vs functional flags

`SAFETY_FLAGS[engine]` = read-only / sandbox / plan flags, **stripped by `--unrestricted`** (e.g. codex `-s read-only`, claude `--permission-mode plan`). Everything else in a `case` block is **functional** and must survive `--unrestricted`: `--print` / `exec` / `run`, plus the non-interactive / trust flags — codex `--skip-git-repo-check`, gemini `--skip-trust`, opencode `--dir <cwd>`, cmd `--skip-onboarding`, agent `--trust`.

**kiro-cli is the one ADDITIVE exception** to this model: `--no-interactive` (a functional flag, always present) already auto-denies `fs_write`/`execute_bash` on its own, so `SAFETY_FLAGS['kiro-cli']` (`--trust-tools=`, an empty allowlist) is defense-in-depth, not the primary gate — stripping it via `--unrestricted` does NOT by itself grant write access. Write capability instead requires the separate additive flag `--trust-all-tools`, which the `kiro-cli` `case` block pushes explicitly whenever `unrestricted` is true (reading that parameter directly, unlike every other engine's block, which only ever calls `safetyFor(eng)`).

`SAFETY_FLAGS` entries must stay simple string-literal lines (no spreads, no computed values) — `test/safety.test.js` parses them by regex (see `test/CLAUDE.md`).

## Exit codes (review.js)

`0` success · `3` clean exit but no usable output (0 bytes, or — when wrapped — missing the `<<<SECOND_OPINION_START>>>` envelope) · `124` timeout · otherwise the engine CLI's own code.

## Output contract (stdout tail) — review.js

After the engine exits, review.js prints (in order, when applicable):

1. `REVIEW COMPLETE — read with Read tool: <log> …` — when a log file is in use.
2. `ANSWER FILE: <log>.answer.md` — when answer extraction succeeded (see below).
3. The extracted payload itself — only with `--print-answer`.
4. `SECOND_OPINION_RESULT: {…}` — **always the last stdout line**, one-line JSON.

**`--print-prompt`** (bare flag, single-engine only — rejected in fusion mode before the fusion banner) — dry-run: skips preflight/spawn/log entirely and instead writes the fully composed `combinedPrompt` (diff/file embedding, self-contained notice, secret reminder, envelope instruction — same composition as a real run) to stdout via `writeStdoutSync`, then exits 0. None of the tail contract above applies to this path — no `REVIEW COMPLETE`, no `ANSWER FILE`, no `SECOND_OPINION_RESULT` line.

**Answer extraction** — when a log FILE is in use (auto-log in non-TTY, or `--log=<path>`) AND `--no-wrap` was not passed, review.js reads the just-closed log back from disk and extracts the LAST complete envelope pair **with a non-empty trimmed payload** (END markers walked backwards, each bound to the LAST START before it and after the previous END — a stray START echoed mid-reasoning is skipped, a blank trailing pair falls back to the previous real one, and a falsy-but-real payload like `"0"` counts) via **line-delimited** tolerant matchers (`/^[ \t]*<{2,}\s*SECOND_OPINION_START\s*>{2,}[ \t\r]*$/m`, END equivalent — 2+-bracket tolerance retained, but a marker only counts alone on its own line, so inline marker mentions in echoed instruction prose never form a bogus pair). The trimmed payload is written verbatim to `<log>.answer.md`. No payload this run → any stale `<log>.answer.md` from a previous run on a reused `--log` path is **removed** (file existence always reflects the current run). With a log file in use, the exit-3 "no usable output" verdict is **keyed on extraction success** (no extractable answer → exit 3, even if marker text appeared inline); the loose streaming `sawEnvelope` check remains the fallback only for the no-log-file path. `--log=-` disables extraction (no log file → nothing to extract).

**`--print-answer`** (bare flag, in the own-flags registry / leaked-flag guard) — on successful extraction also echoes the payload to stdout, before the final result line. The echo uses the in-memory payload, so it works even if the `.answer.md` write failed.

**`SECOND_OPINION_RESULT` JSON** — single engine: `{engine, model (null if none), exit, log (null with --log=-, or when the log file could not be created — never a path that doesn't exist), answer (path or null), timeout (bool)}`. When the log could not be created, output streams to stdout and the quality verdict falls back to the streaming envelope check (a good run is NOT exit-3'd for the missing log). Fusion parent: `{"fusion":true,"slots":[{…same keys per slot}]}`. Children run stdio-silenced, so the parent derives each slot's fields from disk + the captured child exit code (it does not parse child stdout): `answer` = `<slotLog>.answer.md` if it exists, `log` = the slot log path **only if the file exists** — a child that died in preflight (missing binary → 127) never created its log, and is reported `log:null`, matching the single-engine launch-failure line.

The tail lines (2–4 above, and the fusion result line) are written **synchronously** (`writeStdoutSync`: looped `fs.writeSync(1)` with EAGAIN retry, behind a one-shot flush barrier for earlier async stdout) — async `process.stdout` writes queued behind a multi-MB payload echo are discarded by `process.exit()`, truncating the payload and dropping the result line. The result line is also emitted on **launch failures**: preflight missing binary (exit 127, `log:null`), spawn error / E2BIG (exit 1), and fusion-dir-creation failure (fusion shape, dead slots). Only usage errors (bad flags/arguments, unknown engine) exit before it.

## agent.js — task delegation

`agent.js` shares `buildEngineCmd()`/`SAFETY_FLAGS` with `review.js` via `bin/lib/engines.js` but is a distinct entry point with its own arg parsing, prompt composition, and output contract:

- **Hard gate**: `--unrestricted` is REQUIRED — no read-only mode exists. Missing it exits `1` before any spawn/preflight side effect, with a message pointing to `review.js` for read-only consultation.
- **One engine only**: no fusion; multiple `--engine=` (or a CSV spec) exits `1`.
- **Unknown dash arguments**: any token starting with `-` that isn't a recognized flag (and isn't after `--`) is rejected outright (exit `1`) rather than silently becoming the task prompt — a typo'd flag never gets run as the task text.
- **Prompt**: a task directive ("explore, modify files, run commands as needed"), never review.js's self-contained/no-explore directive. `--diff=`/`--file=` are optional context ahead of the task, not the task itself — the composed prompt also appends a prompt-injection advisory (treat embedded context as data/reference, not instructions) whenever either is used.
- **Change reporting**: `git status --porcelain=v1 -z` + `git rev-parse HEAD` in `--cwd`, snapshotted before and after the engine runs (skipped → `changes: null` on a non-git `--cwd`). `-z` (NUL-delimited) avoids the display-porcelain rename-arrow/c-quoting pitfalls a plain-text parse hits on unusual filenames. Each snapshot also records a content identity (sha1 of the working-tree bytes, or `'ENOENT'`) for every path it lists as dirty/untracked, so an engine editing an ALREADY-dirty or ALREADY-untracked file (same status code before and after) is still reported `modified`, not silently dropped. A HEAD move (the engine committed) is reported too — committed paths are derived via `git diff --name-status` between the two HEADs and marked `committed: true` (rendered as `<state> (committed)` in the printed block). Always prints a `CHANGED FILES:` block (or `(none)` / `(not a git repository)`), plus a `HEAD moved: <before> -> <after>` line when HEAD changed.
- **Exit codes**: `0` success — including "completed with changes but no envelope" (prints a `NO REPORT` warning; the changes are the deliverable) · `1` usage error (bad flags, unknown engine, unrecognized argument, the `--unrestricted` gate, the secret guard, the prompt-size cap, an unexpected internal error) · `3` clean exit with **neither** a usable envelope **nor** any changes · `124` timeout · `127` engine binary missing · otherwise the engine CLI's own code.
- **Result line**: `SECOND_AGENT_RESULT: {engine, model, exit, log, answer, timeout, changes}` — always the last stdout line, same `writeStdoutSync` synchronous-flush mechanism as `review.js`'s `SECOND_OPINION_RESULT`. A `process.on('exit')` fallback (emit-once guarded) covers every exit path that predates the normal emitter — usage errors, the secret guard, `./lib/content`'s internal `process.exit()`s, `main().catch` — emitting a minimal `{engine, model, exit, log:null, answer:null, timeout:false, changes:null}` shape instead of nothing. `--help` is the one deliberate exception (plain usage text, no result line).
- **Timeout**: defaults to 1800s (`SOS_AGENT_TIMEOUT_SEC`), independent of `review.js`'s 600s `SOS_TIMEOUT_SEC` default — tasks run longer than a review. Heartbeat is shared (`SOS_HEARTBEAT_SEC`, default 30s).
- **Envelope/answer file**: reuses `lib/envelope.js`'s markers/`extractLastAnswer()`/`writeAnswerFile()` — same `<<<SECOND_OPINION_START/END>>>` markers (kept for fixture/extraction compat), same `ANSWER FILE: <log>.answer.md` mechanism as `review.js`. One difference: on the no-log-file path (`--log=-`, or a TTY), agent.js uses `createStrictEnvelopeWatcher()` instead of review.js's loose `createEnvelopeWatcher()` — a lone START marker with no END/payload is NOT usable output there (`review.js`'s own no-log semantics are unchanged). Answer extraction is gated on the log stream having been **successfully opened this run** (tracked via a flag, not `logPath` truthiness) — an open failure never reads back a stale answer from a previous run on a reused `--log` path, and an async stream error mid-run (e.g. disk full, EACCES) is caught (`logStream.on('error', ...)`) and degrades the same way instead of crashing. Log files are created with mode `0o600` (also true for `review.js`'s).

## Secret guard

`env-guard.js` keeps `.env`-style files out of prompts (shared by both entry points): refuse `--file=.env`, skip untracked `.env`, redact `.env` diff hunks (incl. git's c-quoted headers for non-ASCII paths), and pathspec-exclude in `--no-embed`. `--include-secrets` opts out. Matcher: `.env` / `.env.*` / `*.env`, exempting `*example*` / `*sample*` / `*template*`.

Adding an engine: see `skills/AGENTS.md` (canonical checklist in `skills/second-agent/references/adding-engines.md`).
