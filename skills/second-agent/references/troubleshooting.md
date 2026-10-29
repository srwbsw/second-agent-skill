# Troubleshooting and anti-patterns

## Anti-patterns

Do not do any of these:

- `codex exec ...`, `gemini ...`, `claude ...`, etc. directly instead of `review.js`
- custom shell pipelines that try to reconstruct the prompt assembly outside `review.js`
- `zsh -lc` or `bash -lc` with the expectation that it changes sandbox permissions
- assuming an installed-plugin `"$REVIEW_SCRIPT"` invocation is host-level when the harness still sandboxes the parent command
- `--no-embed` on harnesses that cannot reliably run `git diff` in the current harness
- scraping `stdout` with `| tail` / `| head` instead of reading the ANSWER FILE or LOG FILE

Calling your OWN host's native in-session subagent-delegation tool per the `native-shortcut` block in `skills/AGENTS.md` is NOT this anti-pattern — it is a fundamentally different mechanism (no process spawn, no separate auth, no log file); the anti-pattern above means shell-level CLI invocation of a harness only.

`SECOND_AGENT_NO_NATIVE` (checked by that same block, to force the shell-level `"$REVIEW_SCRIPT"` path even when the native shortcut would otherwise apply) is a prompt-level convention only — an instruction the assistant follows, not something `bin/` reads or enforces. Setting the env var has zero effect unless the agent reading `skills/AGENTS.md` actually checks it.

## Sandbox and login-shell notes

- Harnesses spawned by `review.js` inherit the parent process context. If the parent agent command runs in a sandbox, the child harness runs in that sandbox too.
- `--unrestricted` only removes the harness-specific read-only / plan flags inside `review.js`; it does not change the outer harness permissions.
- Running `"$REVIEW_SCRIPT"` from an installed plugin does not make the run "system-level" if the parent harness is still sandboxed.
- A login shell (`zsh -lc` / `bash -lc`) may change `PATH` or shell init behavior, but it does not make the spawned harness run outside the parent sandbox.
- If an installed-plugin runner command fails only inside a sandboxed harness, diagnose the parent execution mode before changing `review.js`.
- Some harnesses require host-level prerequisites beyond plain `PATH` resolution, such as writable home-directory state, existing login/auth sessions, or network access.

## `--no-embed` caveats

`--no-embed` skips inlining the diff and instead tells the harness to run `git -C <cwd> diff <range>` itself — only useful for very large diffs (Tier C, see `prompts.md`), and only works when the chosen harness can actually shell out in the current environment:

```bash
"$REVIEW_SCRIPT" --harness=codex --cwd=. --diff=branch --no-embed "Review this diff for correctness and regressions."
```

Use this only when the harness can actually run `git` in the current harness — otherwise it will fail silently or produce a review of nothing.

## Launcher verification

To confirm an installed-plugin runner actually launches a harness (useful right after install, or when debugging a harness that seems to hang), send a trivial no-op prompt:

```bash
"$REVIEW_SCRIPT" --harness=cmd --harness=claude --cwd=. --timeout=120 --heartbeat=10 "Report whether you were launched successfully and what harness you are. Reply briefly."
```

Use this as a launcher check only when you control the parent execution mode. Inside a sandboxed harness, failure may still be caused by inherited sandbox restrictions rather than by `review.js`.

## Reading output when stdout doesn't stream it

Reviews routinely span 50–300 lines. When `review.js` runs from an agent harness (non-TTY stdout) it does not stream the harness output to stdout at all — harness bytes go to a log file, and stdout receives only a banner pointing at it, plus the `ANSWER FILE:` / `SECOND_OPINION_RESULT` lines once the harness finishes:

```
===========================================================
REVIEW IN PROGRESS — codex (gpt-5.5)
LOG FILE: /var/folders/.../second-opinion-codex-1731603012.log
Harness output is being written to the log file only.
After this command exits, use the Read tool on the LOG FILE path
above to retrieve the full review. Do not pipe to tail/head — the
harness output is not on stdout in this mode.
===========================================================
... (no harness output here) ...
REVIEW COMPLETE — read with Read tool: /var/folders/.../second-opinion-codex-1731603012.log (47213B, exit=0, 42.1s)
```

Workflow: run the command (no `| tail`, no `| head`), read the `ANSWER FILE:` path with the Read tool, and fall back to the `LOG FILE:` path if there is no `ANSWER FILE:` line. If you need a known log location, pass `--log=<path>` explicitly. To force the old tee-to-stdout behavior (e.g. for interactive `| less`), pass `--log=-`.

## How the ANSWER FILE is produced (internals)

`review.js` wraps the prompt with a structured-output envelope (`<<<SECOND_OPINION_START>>> ... <<<SECOND_OPINION_END>>>`) before handing it to the harness, then pulls the harness's answer out of that envelope into the ANSWER FILE itself — agents should not need to parse the envelope by hand. Internally it takes the **last non-empty** complete marker pair (some harnesses echo the format instructions, and some emit the answer twice), only accepts markers sitting alone on their own line (inline mentions in echoed prose are ignored), and tolerates malformed markers (e.g. `<<SECOND_OPINION_START>>` with only two brackets). Pass `--no-wrap` to disable the envelope entirely (e.g. when feeding output to another tool that does its own parsing) — note this also means no ANSWER FILE will be produced, since `review.js` has nothing to pull out anymore.

## Exit codes

`0` success. `124` timeout. `3` = the harness exited cleanly but produced no usable output (zero bytes — often a transient upstream provider outage, or a missing envelope when wrapped) — treat as "no answer," not success. In fusion mode, each slot's exit code is reported in that slot's entry in the result JSON's `slots` array (see `fusion.md`).

On any failure (including exit `3`, timeouts, non-zero harness exit, or `review.js`/`agent.js` usage exit `1` such as combined-prompt size over limit), the host harness must follow the canonical **model and retry policy** in `skills/AGENTS.md` (`<!-- BEGIN model-policy -->`): stop, report from the log and `SECOND_OPINION_RESULT` / `SECOND_AGENT_RESULT`, and do not change harness, model, or scope until the user chooses a next step. Runners never auto-retry with a different model; a codex log note about an unavailable pinned model is only a user-facing hint.

## Secrets handling (details)

`review.js` excludes `.env`-style secret files by default: it refuses `--file=.env`, skips untracked `.env` files from `--diff=unstaged`, and redacts `.env` hunks from diffs — matching `.env`, `.env.*`, `*.env`, and exempting filenames containing `example`, `sample`, or `template`. It also appends a prompt reminder not to open env files, for harnesses running `--no-embed` or otherwise self-reading in a sandbox. This is enforced in the runner itself, not just documentation. Pass `--include-secrets` only when the user explicitly wants a real `.env` file reviewed. `agent.js` applies the exact same guard.

## Security notes (task mode)

- `--unrestricted` harnesses can read anything the harness allows, including `.env` files — the secret guard above only redacts what `agent.js` embeds into the prompt via `--diff`/`--file`; it is prompt-level hygiene for embedded content, not enforcement against a filesystem-capable harness.
- Embedded `--diff`/`--file` context is fed straight to a write-capable harness. Treat any third-party or untrusted diff as a prompt-injection vector — only embed content you trust, or drop `--diff`/`--file` and let the harness read the repo itself.
- Log files land in `$TMPDIR` (mode `0600` as of this branch).

## `agent.js` exit semantics (task delegation, not review)

`agent.js` layers its own quality verdict on top of the harness's own exit code, because "did it report something" and "did it actually change anything" are independent signals for a task run (unlike a review, where the only deliverable is prose).

- **`--unrestricted` gate**: `agent.js` refuses to run at all without `--unrestricted` — exit `1`, before any spawn or preflight side effect. There is no plan/read-only mode; passing the flag is a deliberate acknowledgment that the harness may edit files and run commands in `--cwd`.
- **`NO REPORT` warning (not a failure)**: if the harness made real changes on disk (a dirty `git status --porcelain`, or `HEAD` itself moved — e.g. the harness committed its own work) but printed no extractable envelope, `agent.js` still exits `0` and prints a `NO REPORT: harness completed with changes but no envelope` warning to stderr — the changes ARE the deliverable; a missing prose report doesn't fail the run.
- **Exit `3`**: reserved for a clean harness exit with genuinely nothing to show — NEITHER a usable envelope/answer NOR any changes on disk (porcelain unchanged AND `HEAD` unchanged). Treat it exactly like `review.js`'s exit `3`: no-answer, not success.
- **`changes` in `SECOND_AGENT_RESULT`**: `{"headBefore","headAfter","files":[{"path","state"}...]}` (`state`: `added`/`modified`/`deleted`/`renamed`), captured via `git status --porcelain` + `rev-parse HEAD` before/after the harness runs, or `null` on a non-git `--cwd`. This is the ground truth for "what happened" — read it, and the `CHANGED FILES:` stdout block, alongside (or instead of) the prose report.

## Permissions on locked-down harnesses

On a harness with a restrictive, non-interactive command-approval allowlist (no prompt-to-confirm), the exact installed-plugin path has to be pre-approved for `review.js`/`agent.js`/`list.js` or every run just hangs waiting on an approval that never comes. Resolve the installed path for the current harness first, then allow that specific pattern — do not blanket-allow `Bash(*)`.

Typical installed locations:

- Codex local install (this repo's helper script):
  - `~/plugins/second-agent-skill/bin/review.js`
  - `~/plugins/second-agent-skill/bin/agent.js`
  - `~/plugins/second-agent-skill/bin/list.js`
- Claude Code marketplace install:
  - `~/.claude/plugins/cache/second-agent-skill/second-agent-skill/<version>/bin/review.js`
  - `~/.claude/plugins/cache/second-agent-skill/second-agent-skill/<version>/bin/agent.js`
  - `~/.claude/plugins/cache/second-agent-skill/second-agent-skill/<version>/bin/list.js`
- Repo-local development checkout:
  - `<repo>/bin/review.js`
  - `<repo>/bin/agent.js`
  - `<repo>/bin/list.js`

Claude Code `settings.json` allowlist, both entry points:

```json
{
  "permissions": {
    "allow": [
      "Bash(~/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/review.js*)",
      "Bash(~/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/agent.js*)",
      "Bash(node ~/.claude/plugins/cache/second-agent-skill/second-agent-skill/*/bin/list.js*)"
    ]
  }
}
```

The plugin-cache path segment is `second-agent-skill` — that is the plugin NAME (see root `AGENTS.md`), independent of whatever the GitHub repo is named; keep it in sync with the plugin's actual name, not the repo's, if either ever changes again.

Codex has no `settings.json` allowlist of its own — permissions there are handled by the harness's interactive command-approval flow. Resolve `$AGENT_SCRIPT`/`$REVIEW_SCRIPT` the same way (see the locate snippet in `skills/AGENTS.md`) and approve those exact resolved paths when the harness prompts, rather than approving on a per-invocation basis.
