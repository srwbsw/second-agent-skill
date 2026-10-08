#!/usr/bin/env node
/**
 * Drift test for the "Locating the runner" snippet.
 *
 * `skills/AGENTS.md` owns the canonical PATH-first discovery blocks (REVIEW +
 * LIST) between `<!-- BEGIN locate-* -->` / `<!-- END locate-* -->` markers.
 * Every SKILL.md must embed the REVIEW block verbatim; any skill that uses
 * `$LIST_SCRIPT` must also embed the LIST block verbatim. This prevents the
 * per-skill divergence that crept in when each skill carried its own glob
 * chain (mismatched fallbacks, a missing `grep -v '\*'` guard, etc.).
 *
 * It also fails on stale phrasings/old block forms so a half-finished edit
 * cannot leave a skill on the previous resolution logic.
 *
 * `skills/` was consolidated to a single skill (`second-agent`) — the prior
 * "hub + one thin `<engine>-agent` skill per engine" design meant every host
 * surfaced 11+ near-identical skills. The GOLDEN block below still lives in
 * `skills/AGENTS.md` and is still embedded verbatim, by fewer consumers now:
 *   <!-- BEGIN golden-path --> ```bash …one-command locate→run→read recipe… ``` <!-- END golden-path -->
 * GOLDEN is embedded by `second-agent/SKILL.md` (the only skill left). A
 * parallel review-TEMPLATE block (the compact default review prompt) used to
 * live here too, embedded by every now-deleted `<engine>-agent` skill; once
 * nothing embedded it any more, both the block and its shape-check were
 * retired together rather than left checking an orphan.
 *
 * Three more canonical blocks exist for task delegation via `bin/agent.js`:
 *   <!-- BEGIN locate-agent -->     ```bash …PATH-first agent.js discovery… ```         <!-- END locate-agent -->
 *   <!-- BEGIN task-golden-path --> ```bash …locate→run --unrestricted→read recipe… ``` <!-- END task-golden-path -->
 *   <!-- BEGIN task-template -->   ``` …compact default task prompt skeleton… ```       <!-- END task-template -->
 *   <!-- BEGIN model-policy -->    ``` …never auto-switch model/engine… ```          <!-- END model-policy -->
 * These are embedded by `second-agent/SKILL.md`'s `## Task mode` section and
 * by the three host adapters below (`.opencode/command/second-agent.md`,
 * `.cursor/rules/second-agent.mdc`, `commands/second-agent.toml`), which also
 * embed the REVIEW block. The pre-rename `second-opinion.*` filenames must
 * still not exist on disk.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const skillsDir = path.join(__dirname, '..', 'skills');
const agentsMd = path.join(skillsDir, 'AGENTS.md');

let allPass = true;
function record(name, ok, detail) {
  if (ok) {
    console.log(`PASS [${name}]`);
  } else {
    console.log(`FAIL [${name}]${detail ? `: ${detail}` : ''}`);
    allPass = false;
  }
}

// Extract a fenced canonical block from skills/AGENTS.md by marker name.
function extractBlock(md, name) {
  const re = new RegExp(
    `<!-- BEGIN ${name} -->\\s*\`\`\`bash\\n([\\s\\S]*?)\\n\`\`\`\\s*<!-- END ${name} -->`
  );
  const m = md.match(re);
  if (!m) {
    throw new Error(`canonical block '${name}' not found in skills/AGENTS.md`);
  }
  return m[1];
}

let agents;
try {
  agents = fs.readFileSync(agentsMd, 'utf8');
} catch (err) {
  console.error(`FAIL: could not read ${agentsMd}: ${err.message}`);
  process.exit(1);
}

let reviewBlock;
let listBlock;
try {
  reviewBlock = extractBlock(agents, 'locate-review');
  listBlock = extractBlock(agents, 'locate-list');
} catch (err) {
  console.error(`FAIL: ${err.message}`);
  process.exit(1);
}

// Stale forms that must not survive anywhere in a skill's Locating section.
const STALE = [
  'if [ ! -x "$REVIEW_SCRIPT" ]; then',
  'Resolve the installed path',
  'Find the script with',
  // Old tilde-glob discovery block. The canonical snippet uses "$HOME"/.claude,
  // so a literal ~/.claude printf only survives if an old block was left behind.
  "printf '%s\\n' ~/.claude/plugins/cache",
  '`opencode` requires a model',
  'retry or pick another engine',
  'retry or switch engines',
];

// Every <engine>/SKILL.md (each dir under skills/ that has one).
const skillFiles = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => path.join(skillsDir, d.name, 'SKILL.md'))
  .filter((p) => fs.existsSync(p));

if (skillFiles.length === 0) {
  console.error('FAIL: no SKILL.md files found under skills/');
  process.exit(1);
}

for (const file of skillFiles) {
  const rel = path.relative(skillsDir, file);
  const content = fs.readFileSync(file, 'utf8');

  record(
    `${rel}: embeds canonical REVIEW block`,
    content.includes(reviewBlock)
  );

  // Any skill that drives provider/model discovery must carry the LIST block.
  if (content.includes('LIST_SCRIPT')) {
    record(`${rel}: embeds canonical LIST block`, content.includes(listBlock));
  }

  for (const stale of STALE) {
    record(
      `${rel}: no stale form (${stale.slice(0, 28)}…)`,
      !content.includes(stale),
      `found stale snippet: ${stale}`
    );
  }
}

// Host adapters (Cursor CLI rule, opencode command) embed the same REVIEW block
// so they resolve review.js identically — drift-check them too.
const repoRoot = path.join(__dirname, '..');
const hostAdapters = [
  path.join(repoRoot, '.opencode', 'command', 'second-agent.md'),
  path.join(repoRoot, '.cursor', 'rules', 'second-agent.mdc'),
  path.join(repoRoot, 'commands', 'second-agent.toml'), // gemini + qwen
];

for (const file of hostAdapters) {
  const rel = path.relative(repoRoot, file);
  if (!fs.existsSync(file)) {
    record(`${rel}: present`, false, 'host adapter file missing');
    continue;
  }
  const content = fs.readFileSync(file, 'utf8');
  record(
    `${rel}: embeds canonical REVIEW block`,
    content.includes(reviewBlock)
  );
  for (const stale of STALE) {
    record(
      `${rel}: no stale form (${stale.slice(0, 28)}…)`,
      !content.includes(stale),
      `found stale snippet: ${stale}`
    );
  }
}

// ---------------------------------------------------------------------------
// Canonical GOLDEN path block (small-model refactor)
// ---------------------------------------------------------------------------
//
// Lives in skills/AGENTS.md, extracted the same way as locate-review /
// locate-list — by BEGIN/END markers:
//
//   <!-- BEGIN golden-path --> ```bash …one-command golden path… ``` <!-- END golden-path -->
//
// GOLDEN is the single copy-paste "locate → run → read the ANSWER FILE"
// recipe, embedded verbatim by second-agent/SKILL.md (the only skill left).
// Edit it in skills/AGENTS.md, never per-file.
//
// (A parallel review-TEMPLATE block — the compact default review prompt —
// used to live here too, embedded by every now-deleted <engine>-agent skill.
// Nothing embeds it any more, so both the block and this check were retired
// together rather than left checking an orphan.)

const GOLDEN_MARKER = 'golden-path';

// Whole region between BEGIN/END markers (fences included), or null if absent.
function extractRegion(md, name) {
  const m = md.match(
    new RegExp(`<!-- BEGIN ${name} -->([\\s\\S]*?)<!-- END ${name} -->`)
  );
  return m ? m[1] : null;
}

// Inner text of the single fenced code block between the markers (any language
// tag, or none — TEMPLATE is a bare ``` fence), or null if markers/fence absent.
function extractFenced(md, name) {
  const m = md.match(
    new RegExp(
      `<!-- BEGIN ${name} -->\\s*\`\`\`[^\\n]*\\n([\\s\\S]*?)\\n\`\`\`\\s*<!-- END ${name} -->`
    )
  );
  return m ? m[1] : null;
}

// Count of fence markers (```), used to assert a *single* fenced block.
function fenceCount(region) {
  return (region.match(/```/g) || []).length;
}

const goldenRegion = extractRegion(agents, GOLDEN_MARKER);
const goldenBlock = extractFenced(agents, GOLDEN_MARKER);

// --- Shape of the GOLDEN block itself ---
record(
  `AGENTS.md: defines GOLDEN block (<!-- BEGIN ${GOLDEN_MARKER} -->)`,
  goldenBlock !== null,
  `no ${GOLDEN_MARKER} block in skills/AGENTS.md`
);
if (goldenBlock !== null) {
  record('GOLDEN block: non-empty', goldenBlock.trim().length > 0);
  const goldenHasBash = /```bash\n/.test(goldenRegion);
  record(
    'GOLDEN block: single fenced bash block',
    goldenHasBash && fenceCount(goldenRegion) === 2,
    `fences=${fenceCount(goldenRegion)}, bash-fence=${goldenHasBash}`
  );
  record(
    'GOLDEN block: references "$REVIEW_SCRIPT"',
    goldenBlock.includes('"$REVIEW_SCRIPT"')
  );
  record(
    'GOLDEN block: mentions ANSWER FILE',
    goldenBlock.includes('ANSWER FILE')
  );
}

// --- Consolidated design: no <engine>-agent skills should exist any more ---
// (second-agent is the hub and is handled separately below; it itself ends
// with `-agent` too, so it must be excluded explicitly rather than relying
// on the suffix alone.) Each used to be a near-duplicate of the hub hardcoded
// to one engine, so every host surfaced 11+ nearly-identical skills — they
// were folded into second-agent/SKILL.md alone. This must stay true.
const engineSkillFiles = fs
  .readdirSync(skillsDir, { withFileTypes: true })
  .filter(
    (d) =>
      d.isDirectory() && d.name.endsWith('-agent') && d.name !== 'second-agent'
  )
  .map((d) => path.join(skillsDir, d.name, 'SKILL.md'))
  .filter((p) => fs.existsSync(p));

record(
  'no <engine>-agent skills remain (consolidated into second-agent)',
  engineSkillFiles.length === 0,
  `found stray per-engine skill(s): ${engineSkillFiles.map((f) => path.relative(skillsDir, f)).join(', ')}`
);

// Stronger form of the same invariant: not just "no *-agent stray dirs", but
// skills/ contains EXACTLY ONE skill, and it's second-agent/SKILL.md. Catches
// a differently-named stray skill (e.g. `foo-review/SKILL.md`) that wouldn't
// match the `-agent` suffix filter above.
record(
  'skills/ contains exactly one skill (second-agent/SKILL.md)',
  skillFiles.length === 1 &&
    path.relative(skillsDir, skillFiles[0]) ===
      path.join('second-agent', 'SKILL.md'),
  `found: ${skillFiles.map((f) => path.relative(skillsDir, f)).join(', ') || '(none)'}`
);

// --- Hub (second-agent): embeds GOLDEN verbatim; body stays compact ---
const hubSkill = path.join(skillsDir, 'second-agent', 'SKILL.md');
if (!fs.existsSync(hubSkill)) {
  record('second-agent/SKILL.md: present', false, 'hub skill missing');
} else {
  const hub = fs.readFileSync(hubSkill, 'utf8');
  record(
    'second-agent/SKILL.md: embeds canonical GOLDEN block',
    Boolean(goldenBlock) && hub.includes(goldenBlock),
    goldenBlock === null
      ? 'GOLDEN block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
  // wc -w parity: whitespace-delimited token count over the whole file.
  const words = hub.trim().split(/\s+/).filter(Boolean).length;
  record(
    'second-agent/SKILL.md: body under 1400 words',
    words < 1400,
    `${words} words`
  );
}

// ---------------------------------------------------------------------------
// Canonical task-delegation blocks
// ---------------------------------------------------------------------------
//
// Three more canonical blocks live in skills/AGENTS.md, extracted the same
// way as GOLDEN/TEMPLATE above:
//
//   <!-- BEGIN locate-agent -->     ```bash  …PATH-first agent.js discovery…  ```        <!-- END locate-agent -->
//   <!-- BEGIN task-golden-path --> ```bash  …locate→run --unrestricted→read recipe…  ``` <!-- END task-golden-path -->
//   <!-- BEGIN task-template -->   ``` …compact default task prompt skeleton…  ```        <!-- END task-template -->
//
// All three are required in `second-agent/SKILL.md` (the only skill left)
// inside a `## Task mode` section, and in the three host adapters below.
// Edit these blocks in skills/AGENTS.md, never per-file.

const LOCATE_AGENT_MARKER = 'locate-agent';
const TASK_GOLDEN_MARKER = 'task-golden-path';
const TASK_TEMPLATE_MARKER = 'task-template';

const locateAgentRegion = extractRegion(agents, LOCATE_AGENT_MARKER);
const locateAgentBlock = extractFenced(agents, LOCATE_AGENT_MARKER);
const taskGoldenRegion = extractRegion(agents, TASK_GOLDEN_MARKER);
const taskGoldenBlock = extractFenced(agents, TASK_GOLDEN_MARKER);
const taskTemplateRegion = extractRegion(agents, TASK_TEMPLATE_MARKER);
const taskTemplateBlock = extractFenced(agents, TASK_TEMPLATE_MARKER);

// --- Shape of the LOCATE_AGENT block itself ---
record(
  `AGENTS.md: defines LOCATE_AGENT block (<!-- BEGIN ${LOCATE_AGENT_MARKER} -->)`,
  locateAgentBlock !== null,
  `no ${LOCATE_AGENT_MARKER} block in skills/AGENTS.md`
);
if (locateAgentBlock !== null) {
  record('LOCATE_AGENT block: non-empty', locateAgentBlock.trim().length > 0);
  const locateAgentHasBash = /```bash\n/.test(locateAgentRegion);
  record(
    'LOCATE_AGENT block: single fenced bash block',
    locateAgentHasBash && fenceCount(locateAgentRegion) === 2,
    `fences=${fenceCount(locateAgentRegion)}, bash-fence=${locateAgentHasBash}`
  );
  record(
    'LOCATE_AGENT block: references AGENT_SCRIPT',
    locateAgentBlock.includes('AGENT_SCRIPT')
  );
  record(
    'LOCATE_AGENT block: SECOND_AGENT_TASK env override',
    locateAgentBlock.includes('SECOND_AGENT_TASK')
  );
  record(
    'LOCATE_AGENT block: resolves agent.js',
    locateAgentBlock.includes('agent.js')
  );
}

// --- Shape of the TASK_GOLDEN block itself ---
record(
  `AGENTS.md: defines TASK_GOLDEN block (<!-- BEGIN ${TASK_GOLDEN_MARKER} -->)`,
  taskGoldenBlock !== null,
  `no ${TASK_GOLDEN_MARKER} block in skills/AGENTS.md`
);
if (taskGoldenBlock !== null) {
  record('TASK_GOLDEN block: non-empty', taskGoldenBlock.trim().length > 0);
  const taskGoldenHasBash = /```bash\n/.test(taskGoldenRegion);
  record(
    'TASK_GOLDEN block: single fenced bash block',
    taskGoldenHasBash && fenceCount(taskGoldenRegion) === 2,
    `fences=${fenceCount(taskGoldenRegion)}, bash-fence=${taskGoldenHasBash}`
  );
  record(
    'TASK_GOLDEN block: references "$AGENT_SCRIPT"',
    taskGoldenBlock.includes('"$AGENT_SCRIPT"')
  );
  record(
    'TASK_GOLDEN block: mentions --unrestricted',
    taskGoldenBlock.includes('--unrestricted')
  );
  record(
    'TASK_GOLDEN block: mentions ANSWER FILE',
    taskGoldenBlock.includes('ANSWER FILE')
  );
  record(
    'TASK_GOLDEN block: mentions CHANGED FILES',
    taskGoldenBlock.includes('CHANGED FILES')
  );
  record(
    'TASK_GOLDEN block: mentions SECOND_AGENT_RESULT',
    taskGoldenBlock.includes('SECOND_AGENT_RESULT')
  );
}

// --- Shape of the TASK_TEMPLATE block itself ---
record(
  `AGENTS.md: defines TASK_TEMPLATE block (<!-- BEGIN ${TASK_TEMPLATE_MARKER} -->)`,
  taskTemplateBlock !== null,
  `no ${TASK_TEMPLATE_MARKER} block in skills/AGENTS.md`
);
if (taskTemplateBlock !== null) {
  record('TASK_TEMPLATE block: non-empty', taskTemplateBlock.trim().length > 0);
  record(
    'TASK_TEMPLATE block: single fenced block',
    fenceCount(taskTemplateRegion) === 2,
    `fences=${fenceCount(taskTemplateRegion)}`
  );
  const taskTemplateLineCount = taskTemplateBlock.split('\n').length;
  record(
    'TASK_TEMPLATE block: at most 25 lines',
    taskTemplateLineCount <= 25,
    `${taskTemplateLineCount} lines`
  );
}

// --- The hub (only skill left) embeds all three verbatim, inside a
// "## Task mode" section.
const taskModeSkillFiles = [hubSkill];
for (const file of taskModeSkillFiles) {
  const rel = path.relative(skillsDir, file);
  if (!fs.existsSync(file)) {
    record(`${rel}: present`, false, 'skill file missing');
    continue;
  }
  const content = fs.readFileSync(file, 'utf8');

  record(
    `${rel}: has "## Task mode" section`,
    /##\s*Task mode/i.test(content),
    'missing a "## Task mode" heading'
  );
  record(
    `${rel}: embeds canonical LOCATE_AGENT block`,
    Boolean(locateAgentBlock) && content.includes(locateAgentBlock),
    locateAgentBlock === null
      ? 'LOCATE_AGENT block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
  record(
    `${rel}: embeds canonical TASK_GOLDEN block`,
    Boolean(taskGoldenBlock) && content.includes(taskGoldenBlock),
    taskGoldenBlock === null
      ? 'TASK_GOLDEN block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
  record(
    `${rel}: embeds canonical TASK_TEMPLATE block`,
    Boolean(taskTemplateBlock) && content.includes(taskTemplateBlock),
    taskTemplateBlock === null
      ? 'TASK_TEMPLATE block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
}

// ---------------------------------------------------------------------------
// Host adapters (Phase 4): embed the three task-delegation blocks verbatim
// too, mirroring how the REVIEW block is enforced for them above; and the
// pre-rename `second-opinion.*` filenames must no longer exist on disk.
// ---------------------------------------------------------------------------

for (const file of hostAdapters) {
  const rel = path.relative(repoRoot, file);
  if (!fs.existsSync(file)) {
    record(`${rel}: present`, false, 'host adapter file missing');
    continue;
  }
  const content = fs.readFileSync(file, 'utf8');
  record(
    `${rel}: embeds canonical LOCATE_AGENT block`,
    Boolean(locateAgentBlock) && content.includes(locateAgentBlock),
    locateAgentBlock === null
      ? 'LOCATE_AGENT block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
  record(
    `${rel}: embeds canonical TASK_GOLDEN block`,
    Boolean(taskGoldenBlock) && content.includes(taskGoldenBlock),
    taskGoldenBlock === null
      ? 'TASK_GOLDEN block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
  record(
    `${rel}: embeds canonical TASK_TEMPLATE block`,
    Boolean(taskTemplateBlock) && content.includes(taskTemplateBlock),
    taskTemplateBlock === null
      ? 'TASK_TEMPLATE block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
}

// Pre-rename filenames must be gone — a half-finished rename that left the
// old file sitting alongside the new one must fail loudly.
const OLD_HOST_ADAPTERS = [
  path.join(repoRoot, '.opencode', 'command', 'second-opinion.md'),
  path.join(repoRoot, '.cursor', 'rules', 'second-opinion.mdc'),
  path.join(repoRoot, 'commands', 'second-opinion.toml'),
];

for (const file of OLD_HOST_ADAPTERS) {
  const rel = path.relative(repoRoot, file);
  record(
    `${rel}: removed (renamed to second-agent.*)`,
    !fs.existsSync(file),
    'stale pre-rename host adapter file still exists'
  );
}

// ---------------------------------------------------------------------------
// Canonical native-shortcut block
// ---------------------------------------------------------------------------
//
// Lives in skills/AGENTS.md like the task-delegation blocks above — a
// bare-fenced (no language tag) snippet documenting the SECOND_AGENT_NO_NATIVE
// / --print-prompt escape hatch around Fusion Model B's native-CLI shortcut.
// Embedded verbatim by second-agent/SKILL.md and the three host adapters.

const NATIVE_SHORTCUT_MARKER = 'native-shortcut';

const nativeShortcutRegion = extractRegion(agents, NATIVE_SHORTCUT_MARKER);
const nativeShortcutBlock = extractFenced(agents, NATIVE_SHORTCUT_MARKER);

// --- Shape of the native-shortcut block itself ---
record(
  `AGENTS.md: defines ${NATIVE_SHORTCUT_MARKER} block (<!-- BEGIN ${NATIVE_SHORTCUT_MARKER} -->)`,
  nativeShortcutBlock !== null,
  `no ${NATIVE_SHORTCUT_MARKER} block in skills/AGENTS.md`
);
if (nativeShortcutBlock !== null) {
  record(
    'native-shortcut block: non-empty',
    nativeShortcutBlock.trim().length > 0
  );
  record(
    'native-shortcut block: single fenced block',
    fenceCount(nativeShortcutRegion) === 2,
    `fences=${fenceCount(nativeShortcutRegion)}`
  );
  record(
    'native-shortcut block: mentions "$REVIEW_SCRIPT"',
    nativeShortcutBlock.includes('"$REVIEW_SCRIPT"')
  );
  record(
    'native-shortcut block: mentions SECOND_AGENT_NO_NATIVE',
    nativeShortcutBlock.includes('SECOND_AGENT_NO_NATIVE')
  );
  record(
    'native-shortcut block: mentions --print-prompt',
    nativeShortcutBlock.includes('--print-prompt')
  );
  record(
    'native-shortcut block: mentions Fusion Model B',
    nativeShortcutBlock.includes('Model B')
  );
}

// --- Hub (second-agent): embeds native-shortcut verbatim ---
if (!fs.existsSync(hubSkill)) {
  record(
    'second-agent/SKILL.md: embeds canonical native-shortcut block',
    false,
    'hub skill missing'
  );
} else {
  const hubForNativeShortcut = fs.readFileSync(hubSkill, 'utf8');
  record(
    'second-agent/SKILL.md: embeds canonical native-shortcut block',
    Boolean(nativeShortcutBlock) &&
      hubForNativeShortcut.includes(nativeShortcutBlock),
    nativeShortcutBlock === null
      ? 'native-shortcut block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
}

// --- Host adapters: embed native-shortcut verbatim too ---
for (const file of hostAdapters) {
  const rel = path.relative(repoRoot, file);
  if (!fs.existsSync(file)) {
    record(
      `${rel}: embeds canonical native-shortcut block`,
      false,
      'host adapter file missing'
    );
    continue;
  }
  const content = fs.readFileSync(file, 'utf8');
  record(
    `${rel}: embeds canonical native-shortcut block`,
    Boolean(nativeShortcutBlock) && content.includes(nativeShortcutBlock),
    nativeShortcutBlock === null
      ? 'native-shortcut block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
}

// ---------------------------------------------------------------------------
// Canonical model-policy block
// ---------------------------------------------------------------------------

const MODEL_POLICY_MARKER = 'model-policy';

const modelPolicyRegion = extractRegion(agents, MODEL_POLICY_MARKER);
const modelPolicyBlock = extractFenced(agents, MODEL_POLICY_MARKER);

record(
  `AGENTS.md: defines ${MODEL_POLICY_MARKER} block (<!-- BEGIN ${MODEL_POLICY_MARKER} -->)`,
  modelPolicyBlock !== null,
  `no ${MODEL_POLICY_MARKER} block in skills/AGENTS.md`
);
if (modelPolicyBlock !== null) {
  record('model-policy block: non-empty', modelPolicyBlock.trim().length > 0);
  record(
    'model-policy block: single fenced block',
    fenceCount(modelPolicyRegion) === 2,
    `fences=${fenceCount(modelPolicyRegion)}`
  );
  record(
    'model-policy block: forbids automatic model change',
    modelPolicyBlock.includes('Do NOT automatically retry')
  );
  record(
    'model-policy block: mentions SECOND_OPINION_RESULT',
    modelPolicyBlock.includes('SECOND_OPINION_RESULT')
  );
  record(
    'model-policy block: bare --engine default',
    modelPolicyBlock.includes('bare `--engine=<name>`')
  );
}

if (!fs.existsSync(hubSkill)) {
  record(
    'second-agent/SKILL.md: embeds canonical model-policy block',
    false,
    'hub skill missing'
  );
} else {
  const hubForModelPolicy = fs.readFileSync(hubSkill, 'utf8');
  record(
    'second-agent/SKILL.md: embeds canonical model-policy block',
    Boolean(modelPolicyBlock) && hubForModelPolicy.includes(modelPolicyBlock),
    modelPolicyBlock === null
      ? 'model-policy block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
}

for (const file of hostAdapters) {
  const rel = path.relative(repoRoot, file);
  if (!fs.existsSync(file)) {
    record(
      `${rel}: embeds canonical model-policy block`,
      false,
      'host adapter file missing'
    );
    continue;
  }
  const content = fs.readFileSync(file, 'utf8');
  record(
    `${rel}: embeds canonical model-policy block`,
    Boolean(modelPolicyBlock) && content.includes(modelPolicyBlock),
    modelPolicyBlock === null
      ? 'model-policy block missing from skills/AGENTS.md'
      : 'not embedded verbatim'
  );
}

// ---------------------------------------------------------------------------
// Staleness: old dir names (second-opinion/, <engine>-review/) must not be
// referenced anywhere under skills/ after the rename. Walks every file
// (SKILL.md, references/*.md, AGENTS.md, and the CLAUDE.md/GEMINI.md/QWEN.md
// symlinks that resolve to it) rather than just the enforced skill list, per
// the "anywhere in skills/" requirement.
// ---------------------------------------------------------------------------

const OLD_ENGINE_SKILL_DIRS = [
  'agy-review',
  'claude-review',
  'cmd-review',
  'codex-review',
  'copilot-review',
  'cursor-review',
  'gemini-review',
  'kilo-review',
  'opencode-review',
  'qwen-review',
];

// Path-shaped / frontmatter-shaped old-name forms, plus (now that the plugin
// slug and its env vars are also renamed to `second-agent-skill` /
// `SECOND_AGENT_*`) the pre-migration forms directly — nothing under skills/
// should reference them any more (install.sh's OLD_PLUGIN migration constant
// is the one legitimate place the old slug still lives, and that file is
// outside this walk). The three old env var names are listed individually,
// NOT as a bare 'SECOND_OPINION_' prefix — that would false-positive on the
// unrelated, still-current `SECOND_OPINION_RESULT` JSON result key.
const OLD_NAME_PATTERNS = [
  'skills/second-opinion',
  'second-opinion/SKILL.md',
  'second-opinion/references',
  '`second-opinion`',
  'name: second-opinion',
  'second-opinion-skill',
  'SECOND_OPINION_REVIEW',
  'SECOND_OPINION_LIST',
  'SECOND_OPINION_AGENT',
  ...OLD_ENGINE_SKILL_DIRS,
];

function walkFiles(dir) {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, d.name);
    if (d.isDirectory()) {
      out.push(...walkFiles(p));
    } else if (d.isFile() || d.isSymbolicLink()) {
      out.push(p);
    }
  }
  return out;
}

const allSkillsTreeFiles = walkFiles(skillsDir);
for (const file of allSkillsTreeFiles) {
  const rel = path.relative(skillsDir, file);
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue; // unreadable (e.g. broken symlink, binary) — skip
  }
  for (const oldName of OLD_NAME_PATTERNS) {
    record(
      `${rel}: no stale old-name reference (${oldName})`,
      !text.includes(oldName),
      `found stale reference: ${oldName}`
    );
  }
}

process.exit(allPass ? 0 : 1);
