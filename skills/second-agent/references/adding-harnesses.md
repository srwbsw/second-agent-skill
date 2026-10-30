# Adding new harnesses

1. Add the harness name to the list in `second-agent/SKILL.md`'s frontmatter description (there's no separate per-harness skill any more — `second-agent` is the only skill, so this is what makes it match requests naming the new harness).
2. Add an entry to the `SAFETY_FLAGS` map in `bin/lib/harnesses.js` with the harness's read-only/sandbox flags, and add a `case` block in `buildHarnessCmd()` that calls `safetyFor('<harness>')` plus any required functional flags (e.g. `--print`, `-p`, `exec`, `run`). Both `review.js` and `agent.js` share this module, so this one edit wires up review AND task mode for the new harness — no separate agent.js-side change needed.
3. If the harness needs provider/model discovery, add a `case` block to `bin/list.js`.
4. Add a row to the harness table and per-harness model rules in `second-agent/SKILL.md` ("Choose a harness and model").
5. Add the harness's required safety flags to `requiredSafetyFlags` and any functional flags to `requiredFunctionalFlags` in `test/safety.test.js`, then run `pnpm run lint` to verify.
6. **Host parity** (see `skills/AGENTS.md`): add the matching host integration so the harness is also installable — a detection+install block in `install.sh` and its `HOSTS=` entry, plus a native adapter (reuse `skills/`, the opencode command, or the gemini TOML where possible). `test/host-parity.test.js` fails until host set == harness set, or the harness is recorded as an `EXCEPTIONS` entry there.
