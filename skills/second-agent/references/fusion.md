# Fusion — running multiple harnesses

When more than one `(harness, model)` slot is wanted, there are two equally valid ways to run them. There is no enforced default — pick the one that fits your harness and the task. Both end up running single-harness `review.js` invocations; they differ only in *who* parallelizes.

## Model A — Harness fan-out (you issue the parallel calls)

If your harness can issue concurrent tool calls (Claude Code can — emit multiple Bash calls in one message), fire **one single-harness `review.js` per slot**, all in the same batch:

```bash
# Each of these is a separate Bash tool call, sent together so they run at once
"$REVIEW_SCRIPT" --harness=gemini --cwd=. --diff=branch "<prompt>"
"$REVIEW_SCRIPT" --harness=codex:gpt-5 --cwd=. --diff=branch "<prompt>"
"$REVIEW_SCRIPT" --harness=claude --cwd=. --diff=branch "<prompt>"
```

Best when: your harness supports parallel tool calls, you want per-harness visibility/control (each is its own task you can read, retry, or abort independently), or each harness should review something *different* (different scope/question/diff). Each call produces its own ANSWER FILE / LOG FILE; read each one.

## Model B — Fusion (`review.js` parallelizes internally)

Repeat `--harness=` in one command. Each occurrence is a "slot" — one `(harness, model)` pair that runs as its own child of `review.js`. The parent orchestrates: parallel children, collision-free logs, signal teardown, parent heartbeat, and a single aggregated exit code.

```bash
# Three harnesses, default models
"$REVIEW_SCRIPT" --harness=gemini --harness=codex --harness=claude --cwd=. --diff=branch "<prompt>"

# Per-slot models inline
"$REVIEW_SCRIPT" --harness=opencode:openai/gpt-5 --harness=codex:gpt-5 --harness=gemini --cwd=. "<prompt>"

# Same harness, multiple models (compare two opencode picks against each other)
"$REVIEW_SCRIPT" --harness=opencode:openai/gpt-5 --harness=opencode:anthropic/claude-sonnet-4-6 --cwd=. "<prompt>"

# CSV shorthand for the no-model case
"$REVIEW_SCRIPT" --harness=gemini,codex,claude --cwd=. "<prompt>"
```

Best when: your harness **can't** run tool calls in parallel (fusion gives you parallelism anyway), you want one command with central teardown + aggregated exit code, or you're running unattended. Same prompt goes to every slot.

## Sequential / rate-limited runs

If a provider rate-limits, or the user asks to go one-by-one, do **not** run all slots at once:

- **Model A**: issue the `review.js` calls one at a time (wait for each to finish before the next) instead of batching them.
- **Model B**: pass `--concurrency=<n>` — `--concurrency=1` runs slots strictly serially; `--concurrency=2` caps at two at a time; omit it for the default (all in parallel).

```bash
# Fusion, but never more than one harness hitting providers at once
"$REVIEW_SCRIPT" --harness=gemini --harness=codex --harness=claude --cwd=. --concurrency=1 "<prompt>"
```

## Shared rules (both models)

- **Model binding**: `--harness=name:model` binds a model to that slot; bare `--harness=name` uses the CLI default. No harness currently requires a model.
- **Dedup**: slots are deduplicated by `(harness, model)` tuple, so accidental repeats collapse but legitimate "same harness, different model" pairs survive.
- **Fusion log files** live under `$TMPDIR/second-opinion-fusion-<ts>/`. Filenames are `<harness>.log` or `<harness>__<sanitized-model>.log` — collision-free even with multiple slots of the same harness.
- **Reading output**: read each slot's ANSWER FILE with the Read tool (fall back to its LOG FILE if that slot has no ANSWER FILE line). Fusion's final stdout line is one `SECOND_OPINION_RESULT` JSON object shaped `{"fusion":true,"slots":[{"harness","engine","model","exit","log","answer","timeout"}, ...]}` — one entry per child. Present results side-by-side under sectioned headings (e.g. `## Gemini's Take`, `## Codex's Take (gpt-5)`). The agent does the synthesis — there is no built-in synthesizer (would just bias toward one model family).
- **Exit code aggregation**: `124` (timeout) dominates; otherwise the first non-zero child code; otherwise `0`.

## Native shortcut inside fusion

The `native-shortcut` block (see `skills/AGENTS.md`) applies per-slot to **Model A** only: each harness is already its own separate tool call, so swap the one call whose harness matches your own host for a native subagent-delegation call instead, and present its result inline under its own heading same as any other slot — it simply has no log/answer file to point at.

It does NOT apply inside **Model B**: a single command with repeated `--harness=` runs `review.js`'s internal parallel-spawn loop, which has no way to reach the calling assistant's native tool from inside that child process. Every slot in a Model B call always subprocess-spawns the harness CLI, including a slot whose harness happens to match your own host.
