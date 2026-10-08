---
name: second-agent
description: Get a second opinion, code review, or delegate a task (write code, fix a bug, refactor) to Gemini, opencode, Codex, Claude Code, Copilot, Qwen, Kilo, Antigravity (agy), Command Code (cmd), Cursor, or Kiro CLI. Covers generic requests ("a second opinion", "another perspective", "independent review", "cross-model review") and engine-named ones ("ask Gemini", "codex review", "use opencode", "have Cursor fix this", "Qwen's take", "ask Copilot", "agy review", "cmd review", "kilo's take", "ask kiro-cli", "Claude review"). Named engine → use it directly. Unnamed → ask once, with a recommended default.
---

# Second Agent

Cross-engine review (`review.js`) or task delegation (`agent.js`) — pick one per request.

## Golden path

<!-- BEGIN native-shortcut -->
```
Before resolving $REVIEW_SCRIPT: if SECOND_AGENT_NO_NATIVE is set
(`[ -n "${SECOND_AGENT_NO_NATIVE:-}" ]`), skip this block entirely — go
straight to "$REVIEW_SCRIPT". Otherwise check, using a concrete signal
(the native tool's actual name present in your own tool list — not
inferred from conversation context), whether <engine> is the SAME
runtime you are currently executing as, AND you have a native,
model-invokable subagent-delegation mode that ACTUALLY BLOCKS
write-capable tools (not just a curated tool list that still includes
shell/Bash access) — matching review.js's own enforced read-only
posture (--permission-mode plan / -s read-only / equivalent). No such
hard-enforced mode on your host → fall through to "$REVIEW_SCRIPT"
normally; a merely "read-only-flavored" subagent that still has Bash
is NOT sufficient.

If it holds: resolve $REVIEW_SCRIPT and run it once with --print-prompt to
get the exact composed prompt (diff/file embedded, self-contained notice,
secret reminder, and answer-format envelope all included verbatim — do
not hand-assemble this yourself). --print-prompt exiting non-zero → surface
the error, do not substitute self-read content. Pass the printed text to
your native subagent tool instead of spawning the engine CLI. Its raw
response still carries the envelope and any preamble — extract the LAST
complete <<<SECOND_OPINION_START>>>...<<<SECOND_OPINION_END>>> pair
yourself (same non-empty-last-pair rule as review.js's own extraction)
before presenting; never show the raw response verbatim.

Also fall through to "$REVIEW_SCRIPT" when:
- the request includes an explicit model/flag override for this engine
  (e.g. --engine=claude:opus, --engine-arg=) — a native subagent inherits
  your current session's config and cannot honor a different model/flag,
- this engine is one slot inside a Fusion Model B call (single command,
  repeated --engine=) — review.js's internal parallel-spawn loop can't
  reach your native tool; Fusion Model A (separate parallel tool calls
  per engine) is unaffected — swap only that one call, present its
  result inline under its own heading same as any other slot, it simply
  has no log/answer file to point at.
```
<!-- END native-shortcut -->

Resolve the runner, run it, read the answer:

```bash
REVIEW_SCRIPT="${SECOND_AGENT_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-agent-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```

`$LIST_SCRIPT` — opencode/kilo model lists only:

```bash
LIST_SCRIPT="${SECOND_AGENT_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/plugins/second-agent-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
```

<!-- BEGIN golden-path -->
```bash
# 1. Run (REVIEW_SCRIPT resolved by the snippet above):
"$REVIEW_SCRIPT" --engine=<engine> --cwd=<repo> --diff=unstaged "<review prompt>"
# 2. Result: stdout prints `ANSWER FILE: <path>`; the last line is a SECOND_OPINION_RESULT JSON.
#    Read the ANSWER FILE with the Read tool — it is the engine's clean answer.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```
<!-- END golden-path -->

## Execution contract

- Invoke via `"$REVIEW_SCRIPT"` only; exit `3` → stop and follow model policy (no autonomous retry/switch).
- Prefer `--diff=`/`--file=` embed; `--no-embed` only for large diffs with a shell-capable engine.
- Child engines inherit parent sandbox; `--unrestricted` drops read-only flags only (`references/troubleshooting.md`).

## Model and retry policy

<!-- BEGIN model-policy -->
```
Model binding (review.js, agent.js, and native subagent delegation):

- If the user named a model (`--engine=<name>:<model>`, or stated a model in the request), keep that binding for the run. On failure (non-zero exit, exit 3, timeout 124, quota/context errors, combined-prompt size limit, or engine stderr about an unavailable model), STOP. Summarize what failed using the LOG FILE tail, stderr, and the SECOND_OPINION_RESULT / SECOND_AGENT_RESULT JSON. Do NOT automatically retry, drop the `:model` suffix, pick a different model from a list, switch engines, change scope flags, or change native subagent model — unless the user explicitly chooses one of those next steps.

- If the user did not name a model, use bare `--engine=<name>` so the spawned CLI uses its configured default. Do NOT invent or guess model IDs (especially Codex). Use `list.js`, `agy models`, `--list-models`, etc. only when helping the user choose upfront — never to silently substitute after a failure.

- Native subagent path: when the user named a model or `--engine-arg=`, use review.js (see native-shortcut fall-through). When using a subagent without a user-specified model, the host session default is fine; do not swap to a different subagent model after a failure without asking.

- After a failure, offer options and wait for the user: retry the same command unchanged; name a different model; switch engine; for prompt-size limits, narrow the diff or discuss `--no-embed` — do not apply these without confirmation.

review.js / agent.js may append a codex-specific log note when a pinned codex model is rejected; that is a hint for the user, not permission for the harness to re-run with a different model.
```
<!-- END model-policy -->

## Choose an engine and model

Named engine → ask model (default vs specific); unnamed → ask once (Gemini default, fusion for higher stakes). `--engine=name:model` or bare `--engine=name` for the CLI default. Aliases: `cursor`/`cursor-agent`→`agent`, `kiro`→`kiro-cli`.

| Engine | Models | Notes |
|---|---|---|
| gemini | — | sandbox + plan |
| opencode | `$LIST_SCRIPT` | optional `:provider/model` |
| codex | never invent | read-only; failures → model policy |
| claude | type-in | `--print --permission-mode plan` |
| copilot | type-in | plan + deny write; needs `copilot` in PATH |
| qwen | type-in | plan mode |
| kilo | like opencode | `--agent plan` |
| agy | `agy models` | `--sandbox --print` |
| cmd | `--list-models` | `--skip-onboarding` |
| agent (cursor) | `--list-models` | `--print --plan --trust` |
| kiro-cli | `chat --list-models` | `--unrestricted` adds `--trust-all-tools` |

Tuple dedupes; same engine + different models = fusion compare slots.

## What to review

Embedded `<diff>`/`<file>` (engines don't self-read). `--diff=unstaged` (default, incl. untracked), `staged`, `last-commit`, `branch`, custom range, or repeat `--file=<abs>`; prompt-only if no scope flag. Fusion: `references/fusion.md`. Safety/`--unrestricted`, secrets/`--include-secrets`: `references/troubleshooting.md`.

## Task mode

`agent.js` — one engine, `--unrestricted` required, no fusion. Failures: model policy above. `CHANGED FILES:` / `changes` are ground truth (`NO REPORT` ≠ failure; exit `3` = no report and no changes).

<!-- BEGIN locate-agent -->
```bash
AGENT_SCRIPT="${SECOND_AGENT_TASK:-$(command -v agent.js || true)}"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$HOME/plugins/second-agent-skill/bin/agent.js"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/agent.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$PWD/bin/agent.js"
```
<!-- END locate-agent -->

<!-- BEGIN task-golden-path -->
```bash
# 1. Run (AGENT_SCRIPT resolved by the snippet above). --unrestricted is a
#    deliberate acknowledgment that the engine may edit files and run
#    commands inside --cwd — there is no read-only mode for agent.js:
"$AGENT_SCRIPT" --engine=<engine> --cwd=<repo> --unrestricted "<task prompt>"
# 2. Result: stdout prints a CHANGED FILES: block, then `ANSWER FILE: <path>`;
#    the last line is a SECOND_AGENT_RESULT JSON (includes `changes`).
#    Read the ANSWER FILE with the Read tool for the engine's report.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```
<!-- END task-golden-path -->

### Default task prompt

<!-- BEGIN task-template -->
```
<task statement — what to build/fix/change, and why>

Constraints:
- Make the minimal change needed; do not refactor unrelated code.
- Follow this repo's existing conventions, style, and file layout.
- Do not touch test files unless the task explicitly asks for it.

Verify by running the project's test suite (and linter/typecheck, if any)
before reporting done. If no test suite exists, say so explicitly.

Report:
**Changed**: files touched, and why
**Verified**: tests/commands run, and their results
**Left undone**: anything incomplete, deferred, or out of scope
```
<!-- END task-template -->

## More detail

`references/prompts.md`, `references/fusion.md`, `references/troubleshooting.md`, `references/adding-engines.md`.
