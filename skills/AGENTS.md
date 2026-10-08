# skills/ — engine skill docs

`skills/second-agent/SKILL.md` is the **only skill** this plugin registers — canonical for both workflows it supports: getting a second opinion/review, and delegating an arbitrary task to another engine via `agent.js`. It used to be a hub plus one thin `<engine>-agent/SKILL.md` per engine, near-duplicates of the hub hardcoded to a single engine; every host (Claude Code, Copilot, agy, cmd, …) auto-discovers every `skills/*/SKILL.md` as its own skill, so that design meant users got bombarded with 11+ nearly-identical skills. They were folded into `second-agent/SKILL.md` alone — its frontmatter description now carries a trigger phrase per engine, and its body branches on whether the user named one (see "Choose an engine and model"). The prompt tiers, full template set, fusion guidance, and the "Adding new engines" checklist live in `skills/second-agent/references/` (`prompts.md`, `fusion.md`, `adding-engines.md`) — SKILL.md stays lean and points to them.

## Adding an engine

Follow `references/adding-engines.md` under `second-agent/` (the `SAFETY_FLAGS` map + `buildEngineCmd()` case block in `bin/lib/engines.js`, `list.js` if it needs provider/model discovery, the engine tables, and `safety.test.js`). `agent.js` shares that same case block, so task-mode support for a new engine is automatic — add a trigger phrase to `second-agent/SKILL.md`'s frontmatter description and a row to its engine table, same as every other engine. Then add a test fixture and a `requiredFunctionalFlags` entry — see `test/CLAUDE.md`.

## Keep the engine list in sync

The set of engines is repeated in four places — update all when adding/removing
(`test/host-parity.test.js` enforces the first pair staying in sync with each
other; the other two are prose, not test-enforced):
- `bin/review.js` **and** `bin/agent.js` → each keeps its own literal
  `SUPPORTED_ENGINES`/`ENGINE_ALIASES` const (NOT hoisted to `bin/lib/engines.js`
  — see that file's header comment for why)
- `README.md` → Engines table
- `skills/second-agent/SKILL.md` → engine table ("Choose an engine and model")

## Host parity — every engine is also a supported host

**Invariant:** the set of supported **host harnesses** (where a user installs the
plugin and triggers reviews) must equal the set of supported **engines** (what
`review.js`/`agent.js` spawn). Adding or removing an engine means adding or removing
the matching host integration in the same change — never let the two sets drift.

A host integration = (a) detection + install in `install.sh`, and (b) an adapter
in that harness's native format that loads the second-agent workflow and embeds
the canonical REVIEW snippet (so `test/locate.test.js` covers it).

| Engine / host | Host adapter (reused/new) | `install.sh` mechanism | Status |
|---|---|---|---|
| claude | `.claude-plugin` + `skills/*/SKILL.md` | `claude plugin marketplace add` + `install` | ✅ |
| codex | `.codex-plugin` + skills | `codex plugin marketplace add` + `add` (`source: url`) | ✅ |
| agent (cursor) | `.cursor/rules/second-agent.mdc` | copy → `~/.cursor/rules/` | ✅ |
| opencode | `.opencode/command/second-agent.md` | copy → `~/.config/opencode/command/` | ✅ |
| gemini | `gemini-extension.json` + `commands/second-agent.toml` | `gemini extensions link` | ✅ |
| qwen | reuses `commands/second-agent.toml` | copy → `~/.qwen/commands/` (gemini-cli fork) | 🔶 built, unverified (qwen not installed locally) |
| copilot | reuses `skills/*/SKILL.md` | `copilot plugin install` | ✅ |
| agy | reuses `skills/*/SKILL.md` | `agy plugin install <dir>` | ✅ |
| kilo | reuses `.opencode/command/second-agent.md` | copy → `~/.config/kilo/command/` (opencode fork) | ✅ |
| cmd | reuses `skills/*/SKILL.md` | `cmd skills add <repo> -g` | ✅ |
| kiro-cli | — (none) | — (none) | ⛔ engine-only exception |

`test/host-parity.test.js` enforces the invariant: the `HOSTS=` list in
`install.sh` must equal `SUPPORTED_ENGINES` (cursor≡agent), each host needs an
`if want <host>;` block, and there are no orphan hosts. If a harness genuinely
has no host/skill mechanism it stays engine-only — record it in that test's
`EXCEPTIONS` (with a reason) rather than silently dropping it. `kiro-cli` is
the one recorded exception as of this writing: it is an MCP-only host with no
skill/plugin-install mechanism (v2.12.3), so it has a `<engine>-agent` skill
(review + task delegation via `review.js`/`agent.js`) but no `install.sh`
block and no `HOSTS=` entry — reviewing WITH kiro-cli works, installing INTO
it does not (yet).

## Locating the runner — canonical snippet (harness-agnostic)

`second-agent/SKILL.md` (the only skill) embeds the **REVIEW** block verbatim,
plus the **LIST** block since it drives opencode/kilo provider+model discovery.
The host adapters `.opencode/command/second-agent.md` (opencode), `.cursor/rules/second-agent.mdc`
(Cursor CLI), and `commands/second-agent.toml` (gemini + qwen) embed the
**REVIEW** block too, plus the three task-delegation blocks below (see
"Locating the task runner" and the task-golden-path/task-template sections).
`test/locate.test.js` extracts the blocks below and fails if any of them drift —
**edit the snippet here, never per-file.**

Resolution order is reliability-first, so a harness that puts plugin `bin/` on
`PATH` (Claude Code does) needs zero path logic. Adding a new harness = one extra
fallback line, not a new per-skill block:

1. `SECOND_AGENT_REVIEW` / `SECOND_AGENT_LIST` env override (any harness / power user)
2. `command -v` on `PATH` (Claude Code adds each plugin's `bin/` to `PATH`)
3. Codex local install (`~/plugins/second-agent-skill/bin/`)
4. Claude Code marketplace cache glob
5. repo-local dev checkout (`$PWD/bin/`)

<!-- BEGIN locate-review -->
```bash
REVIEW_SCRIPT="${SECOND_AGENT_REVIEW:-$(command -v review.js || true)}"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$HOME/plugins/second-agent-skill/bin/review.js"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/review.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$REVIEW_SCRIPT" ] || REVIEW_SCRIPT="$PWD/bin/review.js"
```
<!-- END locate-review -->

<!-- BEGIN locate-list -->
```bash
LIST_SCRIPT="${SECOND_AGENT_LIST:-$(command -v list.js || true)}"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$HOME/plugins/second-agent-skill/bin/list.js"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/list.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -f "$LIST_SCRIPT" ] || LIST_SCRIPT="$PWD/bin/list.js"
```
<!-- END locate-list -->

`command -v` returns empty (not an error) when the script is not on `PATH`, so the
guards fall through cleanly. `grep -v '\*'` drops a literal-glob non-match (bash
leaves the pattern unexpanded when nothing matches). REVIEW uses `[ -x ]` because
skills exec it directly (`"$REVIEW_SCRIPT" …`, relies on the +x shebang); LIST uses
`[ -f ]` because skills run it via `node "$LIST_SCRIPT" …`, so a stale cache copy
that lost its exec bit still resolves.

## Locating the task runner — canonical snippet (`agent.js`)

`agent.js` is `review.js`'s sibling entry point for task delegation (see root
`AGENTS.md`) and resolves the same PATH-first way, with its own env override so
a caller can point at either script independently:

<!-- BEGIN locate-agent -->
```bash
AGENT_SCRIPT="${SECOND_AGENT_TASK:-$(command -v agent.js || true)}"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$HOME/plugins/second-agent-skill/bin/agent.js"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$(printf '%s\n' "$HOME"/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/agent.js 2>/dev/null | grep -v '\*' | sort -V | tail -1)"
[ -x "$AGENT_SCRIPT" ] || AGENT_SCRIPT="$PWD/bin/agent.js"
```
<!-- END locate-agent -->

`second-agent/SKILL.md` embeds this verbatim in its `## Task
mode` section. `install.sh` symlinks `agent.js` into the bindir alongside
`review.js`/`list.js`, so step 2 (`command -v` on `PATH`) resolves it the same
way. Steps 3 (Codex local install) and 4 (Claude Code marketplace cache glob)
work automatically too, since both installs clone the full repo tree rather
than symlink individual files; step 5 (repo-local checkout) always works from
a dev checkout.

## Native-host shortcut — canonical snippet

Before resolving the runner in the Golden path below, check whether the requested engine can skip the subprocess entirely. This applies to `review.js`'s Golden path ONLY — task delegation (`agent.js`) does not get this shortcut: bypassing `agent.js`'s own before/after `git status`/`HEAD` snapshot would lose the `SECOND_AGENT_RESULT.changes` ground truth, and that loss is silent. Considered and rejected for `agent.js` — do not re-add a task-mode variant without solving that gap first. `second-agent/SKILL.md` and the host adapters below embed this block verbatim, at the top of their "Golden path" / "Resolve the runner" section — edit it here, never per-file.

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

## Model and retry policy — canonical snippet

Applies to `review.js`, `agent.js`, and native subagent delegation. `second-agent/SKILL.md` (under Execution contract) and the host adapters embed this block verbatim — edit it here, never per-file.

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

## Golden path — canonical snippet (small-model refactor)

The single copy-paste "locate → run → read the answer" recipe `second-agent/SKILL.md` leads with; it is canonical, embedded verbatim, and enforced by `test/locate.test.js` — edit it here, never per-file.

<!-- BEGIN golden-path -->
```bash
# 1. Run (REVIEW_SCRIPT resolved by the snippet above):
"$REVIEW_SCRIPT" --engine=<engine> --cwd=<repo> --diff=unstaged "<review prompt>"
# 2. Result: stdout prints `ANSWER FILE: <path>`; the last line is a SECOND_OPINION_RESULT JSON.
#    Read the ANSWER FILE with the Read tool — it is the engine's clean answer.
#    No ANSWER FILE line -> read the LOG FILE path instead.
```
<!-- END golden-path -->

## Task golden path — canonical snippet

The task-delegation counterpart to the golden path above: locate `agent.js`, run it with the required `--unrestricted` acknowledgment, then read the result. It is canonical, embedded verbatim by `second-agent/SKILL.md`'s `## Task mode` section, and enforced by `test/locate.test.js` — edit it here, never per-file.

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

## Task template — canonical snippet

The compact default task prompt `second-agent/SKILL.md`'s `## Task mode` section falls back to when the caller has no more specific task description ready; it is canonical, embedded verbatim, and enforced by `test/locate.test.js` — edit it here, never per-file. Unlike the prompts in `references/prompts.md`, this one is a skeleton, not literal prose to send as-is: the `<task statement>` line must be replaced with the actual task before running `agent.js`.

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
