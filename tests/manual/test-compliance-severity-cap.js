/**
 * Unit tests for capComplianceIdentitySeverity (server/lib/images.js) — the
 * code-side never-CRITICAL gate on the compliance stage's identity-absence
 * findings (presence-is-input contract, see models.js complianceModel note +
 * docs/decisions.md). The blind compliance judge must not be able to emit a
 * CRITICAL "character missing / not identified in matches[]" finding: those
 * are inferences from the identification INPUT, and when that input is broken
 * (e.g. no usable reference photos → empty matches[]) they tanked covers into
 * an infinite repair loop.
 *
 * images.js cannot be require()'d here (native `sharp` dep absent), so the
 * REAL production source of the helper is vm-extracted — same pattern as
 * test-images-dispatch-helpers.js.
 *
 * Run: node tests/manual/test-compliance-severity-cap.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const SRC = fs.readFileSync(path.join(__dirname, '../../server/lib/images.js'), 'utf8');

function extractFunction(src, name) {
  const start = src.indexOf(`function ${name}(`);
  assert(start !== -1, `could not find function ${name} in images.js`);
  let i = src.indexOf('{', start);
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { i++; break; } }
  }
  return src.slice(start, i);
}

const ctx = { module: {} };
vm.createContext(ctx);
vm.runInContext(extractFunction(SRC, 'capComplianceIdentitySeverity')
  + '\nmodule.exports = capComplianceIdentitySeverity;', ctx);
const cap = ctx.module.exports;

let passed = 0;
function check(desc, cond) {
  assert(cond, `FAIL: ${desc}`);
  passed++;
}

// 1. CRITICAL missing_character (by type) → MAJOR + stamp
{
  const issues = [{ description: 'CharacterA is missing from the scene', severity: 'CRITICAL', type: 'missing_character' }];
  cap(issues);
  check('CRITICAL missing_character capped to MAJOR', issues[0].severity === 'MAJOR');
  check('cap is stamped for the dev panel', issues[0].severityCapped === 'identity-input');
}

// 2. CRITICAL "not identified in matches[]" wording (type drifted) → MAJOR
{
  const issues = [
    { description: 'CharacterA not identified in QUALITY_FIGURES.matches[] despite being named in prompt', severity: 'CRITICAL', type: 'default' },
    { description: 'CharacterB has no entry in matches[] and no plausible figure', severity: 'CRITICAL', type: 'compliance' },
    { description: 'CharacterC absent from matches[]', severity: 'CRITICAL', type: 'scene' },
  ];
  cap(issues);
  for (const i of issues) {
    check(`identity-absence wording capped (${i.description.slice(0, 30)}...)`, i.severity === 'MAJOR');
  }
}

// 3. CATASTROPHIC identity-absence → MAJOR (gate covers both top severities)
{
  const issues = [{ description: 'Main character unidentified against references', severity: 'CATASTROPHIC', type: 'missing_character' }];
  cap(issues);
  check('CATASTROPHIC identity-absence capped to MAJOR', issues[0].severity === 'MAJOR');
}

// 4. Real image defects at CRITICAL stay CRITICAL (no over-capping)
{
  const issues = [
    { description: 'CharacterA wears a modern sweatshirt instead of the requested costume', severity: 'CRITICAL', type: 'clothing' },
    { description: 'Figure has three arms', severity: 'CRITICAL', type: 'limb' },
    { description: 'A named figure stands inside the fountain', severity: 'CRITICAL', type: 'implausible_placement' },
    { description: 'Declared held object entirely missing from inventory', severity: 'CRITICAL', type: 'object' },
  ];
  cap(issues);
  for (const i of issues) {
    check(`non-identity CRITICAL untouched (${i.type})`, i.severity === 'CRITICAL' && i.severityCapped === undefined);
  }
}

// 5. Already-MAJOR/MODERATE identity findings untouched (idempotent below the gate)
{
  const issues = [
    { description: 'CharacterA not identified in matches[]', severity: 'MAJOR', type: 'missing_character' },
    { description: 'CharacterB missing hat', severity: 'MODERATE', type: 'clothing' },
  ];
  cap(issues);
  check('MAJOR identity finding stays MAJOR without stamp', issues[0].severity === 'MAJOR' && issues[0].severityCapped === undefined);
  check('MODERATE non-identity untouched', issues[1].severity === 'MODERATE');
}

// 6. Defensive inputs: non-array, empty, malformed entries
{
  check('non-array passes through', cap(null) === null && cap(undefined) === undefined);
  check('empty array ok', Array.isArray(cap([])) );
  const issues = [null, 42, { severity: 'CRITICAL' /* no description, no type */ }];
  cap(issues);
  check('malformed entries tolerated; severity-only CRITICAL not capped', issues[2].severity === 'CRITICAL');
}

// 7. Case-insensitivity of severity + wording
{
  const issues = [{ description: 'characterA Not Identified in the matches [] block', severity: 'critical', type: 'default' }];
  cap(issues);
  check('lowercase critical + spaced matches [] still capped', issues[0].severity === 'MAJOR');
}

console.log(`✅ test-compliance-severity-cap: all ${passed} checks passed`);
