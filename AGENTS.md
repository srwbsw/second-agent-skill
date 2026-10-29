# second-agent (second-agent-skill)

Multi-harness plugin with two entry points, both spawning harness CLIs (gemini, codex, claude, opencode, copilot, qwen, kilo, agy, cmd, cursor, kiro-cli) as subprocesses and embedding diff/file content into the prompt (harnesses don't self-read by default): `bin/review.js` for read-only second opinions/code review, and its sibling `bin/agent.js` for delegating an arbitrary engineering task (write tests, fix a bug, refactor) to one of those harnesses inside the repo. Both share internals via `bin/lib/`. `skills/AGENTS.md`'s `native-shortcut` block lets the calling assistant skip that subprocess spawn for `review.js` when the requested harness matches its own host and a native in-session delegation tool is available — see `skills/AGENTS.md` for details.

Subsystem-specific rules live next to the code:
- **`bin/AGENTS.md`** — runner internals, harness flags, exit codes, secret guard
- **`test/AGENTS.md`** — test conventions + fixture contract
- **`skills/AGENTS.md`** — harness skill docs & the canonical template/checklist source

## Agent context files

`AGENTS.md` is the single source of truth (root + `bin/`, `test/`, `skills/`). Per-tool filenames are **symlinks** to it so every supported agent picks up the same guidance — edit only `AGENTS.md`:
- `CLAUDE.md → AGENTS.md` (Claude Code; also recognized by Copilot CLI & Cursor)
- `GEMINI.md → AGENTS.md` (Gemini CLI; also older Antigravity <1.20.3)
- `QWEN.md → AGENTS.md` (Qwen Code)

Codex, opencode, Copilot CLI, Kilo, Cursor, Command Code, and Antigravity ≥1.20.3 read `AGENTS.md` natively. Gemini/Qwen also get **nested** `AGENTS.md` (subdirs) via `.gemini/settings.json` / `.qwen/settings.json` (`context.fileName: ["AGENTS.md", …]`); the root symlinks are the zero-config fallback.

## Commands

```bash
pnpm run lint          # runs all 8 test suites (safety, shell-quote, env-guard, spawn, answer, agent, locate, host-parity)
pnpm run lint:js       # eslint bin/ test/
pnpm run format        # prettier --write bin/ test/
pnpm run format:check  # prettier --check bin/ test/
```

- No build step exists. Never run `pnpm build`.
- `*.md` (README, skills, these files) is NOT prettier-checked — only `bin/` and `test/`.

## Versioning & release (do NOT hand-edit versions)

`.github/workflows/version-bump.yml` runs on push to `main` and bumps `package.json` + `.claude-plugin/marketplace.json` + `.codex-plugin/plugin.json` from the **first line of the head commit** (via `scripts/bump-version.js`), then commits `[skip ci]`. Mapping: `feat:`→minor, `fix|chore|refactor|perf:`→patch, `type!:`/`BREAKING CHANGE`→major, else none.

Workflow: small commits → PR to `main` → **squash-merge**. The **PR title becomes the squash commit's first line**, so it must be a conventional commit (it drives the version bump). Husky `pre-commit` runs prettier+eslint on staged files automatically (no pre-push hook — security reviews are on-demand via the skills).
