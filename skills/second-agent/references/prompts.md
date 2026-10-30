# Prompt tiers and templates

Composing the prompt well is what makes a "second opinion" useful — the harness needs to know what it's looking at and what you actually want. Pick the tier that fits.

## Tier A — Specific task / open question (preferred when context exists)

Use this when the user is mid-feature, has a plan, is debating an approach, or asked something more nuanced than "review this." Embed the relevant context inline in the prompt argument, then ask whatever you actually want a second opinion on. The templates below are fallbacks, not constraints — write the prompt that matches the question.

Things worth pasting into the prompt when relevant:
- The user's stated goal or the task they're working on
- The current plan, design notes, or constraints
- Excerpts of conversation that establish what was tried, ruled out, or already agreed
- Specific questions ("does this preserve invariant X?", "any race condition I missed?")
- Non-code context: requirements, deadlines, stakeholders, prior incidents

Do not include private chat verbatim if it contains user secrets the user did not intend to share with a third-party harness. Summarize.

## Tier B — Plain diff/file review with no extra context

Use this when the user just says "review this" with no further detail. Pick a template below and fire. This is the historical behavior — kept so the skill still does something useful when no context is available.

## Tier C — Large change with shell-capable harness

Use this when the diff is very large (close to the 120KB prompt cap) AND the harness has shell access (codex, claude, copilot in `--unrestricted`, or sandbox harnesses that allow `git`). Pass `--no-embed` to `review.js`: instead of inlining the diff, it tells the harness to run `git -C <cwd> diff <range>` itself. Lower argv, but only works for harnesses that can actually shell out — see `troubleshooting.md` for the example and caveats.

## Tier D — Task delegation, not review (`agent.js`)

Use this when the goal isn't commentary but action — write tests, fix a bug, add a feature, refactor — inside the repo. This tier skips `review.js` entirely and goes through its sibling `agent.js` (see `SKILL.md`'s `## Task mode` section for the locate/run/read recipe). The default task prompt skeleton is the `task-template` canonical block in `skills/AGENTS.md`, embedded verbatim in `SKILL.md`'s `## Task mode` section: fill in the `<task statement>` line with the real task, keep the constraints/verify/report scaffolding, and don't invent an ad-hoc format.

Unlike Tiers A–C, `--diff=`/`--file=` here are optional *context* for the task, not the thing being reviewed — the task statement itself is the point, and `--unrestricted` is required (there is no read-only mode for `agent.js`).

## Default templates

These are fallbacks for Tier B. For Tier A, write a bespoke prompt — these templates can be a starting skeleton, but don't force-fit a nuanced question into them. The harness sees your prompt as-is plus the structured-output envelope; everything else is up to you.

### Code review (diff or file)
```
Review this as a senior engineer. Spawn all sub-agents simultaneously in a single batch — one per domain below — then synthesize their findings once all have returned. Do NOT spawn them sequentially or wait for one to finish before starting the next. If sub-agents are not supported, cover all domains yourself in a single pass.

Domains:
- **Architecture & design decisions**: Is this the right approach for the problem? Module boundaries, layering, separation of concerns, coupling/cohesion, abstractions that leak or over-engineer, data-model fit. Call out where a simpler or more conventional design would do, and any decision that will be expensive to reverse.
- **Security**: injection (SQL / NoSQL / OS-command / template / path-traversal), authentication & authorization boundaries (missing or incorrect access checks, IDOR), input validation and handling of untrusted input, data exposure (PII, secrets in logs/errors, over-fetching), SSRF, unsafe deserialization.
- **Least privilege**: over-broad permissions, roles, OAuth scopes, IAM policies, API tokens, DB grants, or file modes. Does each component get only the access it needs? Flag hardcoded credentials and secrets that should be externalized.
- **Correctness & robustness**: edge cases, error handling, resource leaks, concurrency/race conditions, off-by-one and boundary bugs.
- **Regression**: what existing behaviour could this change break.
- **Test coverage**: what's untested, what edge cases are missing, what would break silently.
- **Maintainability**: naming, readability, duplication, dead code, comment/intent clarity.

Synthesized output:
**Summary**: What this does in one sentence
**Issues**: [HIGH/MED/LOW] description → suggested fix (tag each with its domain)
**Concerns**: Minor notes not worth a fix
**Positives**: What's done well (brief)

If nothing is wrong, say so plainly. Prioritize HIGH-severity correctness/security findings over style.
```

### Second opinion on approach
```
Give your honest assessment of this approach.

Consider: is this the right architecture/design decision for the problem, what are the failure modes, does it respect least-privilege and security boundaries, and will it be expensive to change later.

Structure as:
**Assessment**: Your take in 2-3 sentences
**Concerns**: What could go wrong or why this might be the wrong call
**Alternatives**: Other approaches worth considering (skip if none)

Be direct, not diplomatic.
```

### Security review
```
Review this code for security vulnerabilities.

Cover:
- **Injection**: SQL / NoSQL / OS-command / template / path-traversal / LDAP
- **AuthN/AuthZ**: missing or incorrect access checks, IDOR, privilege escalation, session/token handling
- **Least privilege**: over-broad permissions, roles, OAuth scopes, IAM policies, DB grants, file modes; credentials that should be scoped down or externalized
- **Data exposure**: PII handling, secrets in logs/errors/responses, over-fetching
- **Input validation**: untrusted input reaching sinks, deserialization, SSRF
- **Secrets**: hardcoded credentials, keys, tokens

Structure:
**Risk Level**: Critical / High / Medium / Low / None
**Vulnerabilities**: [SEVERITY] description → how to fix
**OK**: What's handled correctly

If no vulnerabilities found, confirm explicitly.
```

### General consultation
```
Answer directly. If giving a recommendation, structure as: **Recommendation**, **Reasoning**, **Trade-offs**.
```
