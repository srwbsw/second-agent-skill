#!/usr/bin/env node
/**
 * Safety test for bin/review.js
 *
 * review.js now houses safety flags in a `SAFETY_FLAGS` map and gates them
 * behind the --unrestricted flag (default: on). This test ensures:
 *
 *   1. Every supported engine has an entry in the SAFETY_FLAGS map
 *      containing the canonical safety flags we expect.
 *   2. Each engine's case block references safetyFor('<engine>') so the
 *      gate is actually wired up — a stray engine that skips the call
 *      would silently bypass the safety flags.
 *
 * Functional flags that exist outside the SAFETY_FLAGS gate (--print,
 * exec, run, etc.) are still verified per-engine since they are required
 * for the invocation to work, regardless of --unrestricted.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const reviewScript = path.join(__dirname, '..', 'bin', 'lib', 'harnesses.js');

// Flags that MUST live inside the SAFETY_FLAGS gate (stripped by --unrestricted).
const requiredSafetyFlags = {
  opencode: ['--agent', 'plan'],
  gemini: ['-s', '--approval-mode', 'plan'],
  codex: ['-s', 'read-only'],
  claude: ['--permission-mode', 'plan'],
  copilot: ['-s', '--plan', '--allow-all-tools', '--deny-tool=write'],
  qwen: ['-s', '--approval-mode', 'plan'],
  kilo: ['--agent', 'plan'],
  agy: ['--sandbox'],
  cmd: ['--permission-mode', 'plan'],
  agent: ['--plan'],
  'kiro-cli': ['--trust-tools='],
};

// Flags that are functional (engine breaks without them) and live OUTSIDE
// the safety gate, in the case block itself.
const requiredFunctionalFlags = {
  gemini: ['-p', '--skip-trust'],
  codex: ['exec', '--skip-git-repo-check'],
  claude: ['--print'],
  copilot: ['-p'],
  agy: ['--print'],
  opencode: ['run', '--dir'],
  kilo: ['run'],
  cmd: ['--print', '--skip-onboarding'],
  agent: ['--print', '--trust'],
  'kiro-cli': ['chat', '--no-interactive'],
};

let content;
try {
  content = fs.readFileSync(reviewScript, 'utf8');
} catch (err) {
  console.error(`FAIL: Could not read ${reviewScript}: ${err.message}`);
  process.exit(1);
}

let allPass = true;

// Extract the SAFETY_FLAGS object literal as a single block.
const safetyBlockMatch = content.match(
  /const\s+SAFETY_FLAGS\s*=\s*\{([\s\S]*?)\n\};/
);
if (!safetyBlockMatch) {
  console.log('FAIL: SAFETY_FLAGS map not found in review.js');
  process.exit(1);
}
const safetyBlock = safetyBlockMatch[1];

function hasLiteral(haystack, str) {
  return haystack.includes(`'${str}'`) || haystack.includes(`"${str}"`);
}

for (const [engine, flags] of Object.entries(requiredSafetyFlags)) {
  // Find this engine's line in the SAFETY_FLAGS map. The key is optionally
  // quoted (e.g. 'kiro-cli': [...] — hyphenated names aren't valid bare JS
  // identifiers, unlike every other engine key here).
  const lineRegex = new RegExp(
    `\\n\\s*['"]?${engine}['"]?\\s*:\\s*\\[(.*?)\\]`,
    's'
  );
  const lineMatch = safetyBlock.match(lineRegex);
  if (!lineMatch) {
    console.log(`FAIL [${engine}]: missing entry in SAFETY_FLAGS map`);
    allPass = false;
    continue;
  }
  const arrLiteral = lineMatch[1];
  let enginePass = true;
  for (const flag of flags) {
    if (!hasLiteral(arrLiteral, flag)) {
      console.log(`FAIL [${engine}]: SAFETY_FLAGS missing '${flag}'`);
      enginePass = false;
      allPass = false;
    }
  }

  // Verify the case block actually calls safetyFor('<engine>'), i.e. the
  // gate is wired up. Without this call the safety flags never reach argv.
  const caseRegex = new RegExp(
    `case\\s+'${engine}':[\\s\\S]*?(?=case\\s+|default:|^(?!\\s))`,
    'm'
  );
  const caseMatch = content.match(caseRegex);
  if (!caseMatch) {
    console.log(`FAIL [${engine}]: case block not found`);
    allPass = false;
    continue;
  }
  const caseBlock = caseMatch[0];
  if (!caseBlock.includes(`safetyFor('${engine}')`)) {
    console.log(
      `FAIL [${engine}]: case block does not call safetyFor('${engine}')`
    );
    enginePass = false;
    allPass = false;
  }

  // Functional flags must still appear literally in the case block.
  const funcFlags = requiredFunctionalFlags[engine] || [];
  for (const flag of funcFlags) {
    if (!hasLiteral(caseBlock, flag)) {
      console.log(
        `FAIL [${engine}]: case block missing functional flag '${flag}'`
      );
      enginePass = false;
      allPass = false;
    }
  }

  if (enginePass) {
    console.log(`PASS [${engine}]`);
  }
}

process.exit(allPass ? 0 : 1);
