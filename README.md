# Second Agent

**Get a second opinion or delegate an engineering task to any AI harness CLI you have installed — Gemini, Codex, Claude Code, opencode, Copilot, Qwen, Kilo, Antigravity (agy), Command Code (cmd), Cursor, or Kiro CLI (kiro-cli) — from inside your current one.**

No single model catches everything. Second Agent spawns another harness as a subprocess inside your repo, embeds the diff/file content it needs directly into the prompt (harnesses don't self-read by default), and either asks it to comment (read-only) or actually do the work (write-capable) — then hands you back a clean, structured result.

Installs as the `second-agent-skill` plugin, from the [`srwbsw/second-agent-skill`](https://github.com/srwbsw/second-agent-skill) repo.

## What it does

Two runners, one shared harness layer:

| Runner | Mode | Use it for |
|---|---|---|
| `bin/review.js` | read-only | Second opinion / code review — one harness, or several in parallel ("fusion") |
| `bin/agent.js` | write-capable, `--unrestricted` required | Delegate a real task — write tests, fix a bug, refactor — to one harness inside your repo |

Both share the same harness wiring, secret guard, and result format (`bin/lib/`) — see `bin/AGENTS.md` for internals.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/srwbsw/second-agent-skill/main/install.sh | bash
```

Auto-detects which of the 11 supported harnesses (below) you have installed, installs the plugin/skill/command adapter into each of the 10 installable harnesses it finds (Claude Code, Codex, Cursor, opencode, Gemini, Qwen, Copilot, Antigravity, Kilo, Command Code) — kiro-cli is harness-only, with no host adapter of its own — and symlinks `review.js`/`agent.js`/`list.js` onto `PATH` so every harness — even ones without a plugin cache — can resolve them. Idempotent; run `install.sh --help` for `--only=`, `--ref=`, and `--uninstall`.

Manual install for the two plugin-marketplace harnesses:

```bash
# Claude Code
claude plugin marketplace add srwbsw/second-agent-skill && claude plugin install second-agent-skill@second-agent-skill

# Codex CLI
codex plugin marketplace add srwbsw/second-agent-skill && codex plugin add second-agent-skill@second-agent-skill
```

Other harnesses (Cursor, opencode, Gemini, Qwen, Copilot, agy, Kilo, cmd) install a rule/command/skill file directly — see `install.sh` for the exact command, or run the one-liner above with `--only=<harness>`.

**Migrating from `second-opinion-skill`?** The plugin was renamed to `second-agent-skill` (the env vars `SECOND_OPINION_REVIEW`/`LIST`/`AGENT` are now `SECOND_AGENT_REVIEW`/`LIST`/`TASK`, breaking). Re-running `install.sh` auto-migrates each host — it retires the old-named plugin/extension after the new one installs successfully, no manual uninstall needed. One thing it *can't* fix for you: skill IDs are plugin-namespaced (`second-opinion-skill:second-agent` → `second-agent-skill:second-agent`) — update any hardcoded references in your `settings.json` permission allowlists or personal notes.

## Quickstart

```bash
# Second opinion: read-only review of your unstaged changes
review.js --harness=gemini --cwd=. --diff=unstaged \
  "Review this diff for correctness and regressions."

# Task delegation: let Codex actually make the change (write-capable)
agent.js --harness=codex --cwd=. --unrestricted \
  "Add a CHANGELOG entry summarizing the last commit."
```

(Assumes `install.sh` put `review.js`/`agent.js` on `PATH`; otherwise use the full path to your checkout's `bin/`.)

## Usage essentials

### Harnesses

| Harness | CLI | Model selection |
|---|---|---|
| Gemini CLI | `gemini` | automatic |
| opencode | `opencode` | optional — provider → model, or default |
| Codex CLI | `codex` | optional — type-in |
| Claude Code | `claude` | optional — type-in |
| GitHub Copilot CLI | `copilot` | optional — type-in |
| Qwen Code CLI | `qwen` | optional — type-in |
| Kilo | `kilo` | provider → model (free shown first) |
| Antigravity | `agy` | optional — `agy models`, or default |
| Command Code | `cmd` | optional — `cmd --list-models`, or default |
| Cursor CLI | `agent` (`cursor`/`cursor-agent` aliases) | optional — `agent --list-models`, or default |
| Kiro CLI | `kiro-cli` (`kiro` alias) | optional — `kiro-cli chat --list-models`, or default |

Pick one with `--harness=<name>` or `--harness=<name>:<model>` (`--engine=` is still accepted as an alias). `review.js` also supports fusion — repeat `--harness=` for multiple slots run in one pass (parallel by default, `--concurrency=1` for serial); see `skills/second-agent/references/fusion.md`. opencode/Kilo model discovery: `list.js --engine=opencode providers` then `list.js --engine=opencode models --provider=<p>`.

### review vs. task

- **`review.js`** never writes anything — every harness launches in its read-only/plan/sandbox mode.
- **`agent.js`** has no read-only mode: `--unrestricted` is required, and the harness may edit files and run commands inside `--cwd`. Exactly one harness per invocation (no fusion — run it again for a second harness's take).

### Safety model

- **Read-only by default** — `review.js` always launches harnesses in their safe/plan/sandbox mode.
- **`--unrestricted` gate** — required (hard-fails otherwise) on `agent.js`; optional on `review.js`, only for harnesses that need to run commands to review.
- **Secret guard** — `.env`-style files are refused/skipped/redacted from anything embedded into the prompt, by both runners, by default; opt out with `--include-secrets`.
- **Untrusted context** — embedded `--diff`/`--file` content is data, not instructions — but see the security note below before pointing a write-capable harness at someone else's diff.

### Security notes

`--unrestricted` is a deliberate acknowledgment, not a formality: an unrestricted harness can read anything the harness permissions allow — including `.env` files the secret guard never embedded — and can run commands in `--cwd`. Embedded `--diff`/`--file` content is handed straight to that write-capable harness, so treat any third-party or untrusted diff as a prompt-injection vector: only embed content you trust, or omit `--diff`/`--file` and let the harness read the repo itself.

## Reading the result

Both runners print a final one-line JSON result on stdout — `SECOND_OPINION_RESULT` (`review.js`) or `SECOND_AGENT_RESULT` (`agent.js`) — plus an `ANSWER FILE: <path>` line whenever the harness's answer was cleanly extracted (read that file with the Read tool, not stdout; fall back to the printed `LOG FILE:` path otherwise). `agent.js` additionally prints a `CHANGED FILES:` block from a before/after git snapshot of `--cwd`.

## Development

```bash
pnpm run lint          # runs all 8 test suites (safety, shell-quote, env-guard, spawn, answer, agent, locate, host-parity)
pnpm run lint:js       # eslint bin/ test/
pnpm run format        # prettier --write bin/ test/
pnpm run format:check  # prettier --check bin/ test/
```

No build step — never run `pnpm build`. `AGENTS.md` (root, plus `bin/`, `test/`, `skills/`) is the source of truth for internals — harness wiring, exit codes, secret guard, and test/fixture conventions; `CLAUDE.md`/`GEMINI.md`/`QWEN.md` are symlinks to it. Adding a new harness: `skills/second-agent/references/adding-harnesses.md` is the canonical checklist. Deeper reference docs (prompt templates, fusion mechanics, troubleshooting/anti-patterns) live under `skills/second-agent/references/`.

## License

[MIT](LICENSE)
