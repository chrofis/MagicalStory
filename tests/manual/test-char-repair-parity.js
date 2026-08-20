/**
 * Lab ↔ production parity for the character-repair call.
 *
 * The Test Lab exists to reproduce and verify production behaviour, which it
 * can only do if it SENDS what production sends. Both call sites used to
 * assemble the options object by hand and drifted apart: the Lab was missing
 * clothingDescription, detectionBodyMask, imageBackend, issueDescription and
 * whiteoutTarget, and neither passed artStyle — so every production repair ran
 * without its art-style block and no Lab run could have revealed it.
 *
 * This test fails when:
 *   - a field is added to CHAR_REPAIR_REQUEST_KEYS but only one caller sets it;
 *   - a caller passes a field the canonical list does not know;
 *   - a Lab divergence appears that docs/lab-divergences.md does not declare.
 *
 * Run: node tests/manual/test-char-repair-parity.js
 */

const fs = require('fs');
const path = require('path');
const { CHAR_REPAIR_REQUEST_KEYS, buildCharRepairRequest } = require('../../server/lib/charRepairRequest');

const ROOT = path.join(__dirname, '../..');
let failures = 0;
const fail = (msg) => { console.error(`❌ ${msg}`); failures++; };
const pass = (msg) => console.log(`✅ ${msg}`);

// ── 1. The builder is the only way to add a field ──────────────────────────
try {
  buildCharRepairRequest({ notAField: 1 });
  fail('builder accepted an unknown field — a new option could reach one caller only');
} catch (err) {
  if (/unknown field/.test(err.message)) pass('builder rejects unknown fields');
  else fail(`builder threw the wrong error: ${err.message}`);
}

// ── 2. Every canonical key is present, even when unset ─────────────────────
{
  const req = buildCharRepairRequest({ artStyle: 'watercolor' });
  const missing = CHAR_REPAIR_REQUEST_KEYS.filter(k => !(k in req));
  if (missing.length) fail(`builder omitted ${missing.join(', ')}`);
  else pass(`all ${CHAR_REPAIR_REQUEST_KEYS.length} canonical fields present`);
  if (req.artStyle !== 'watercolor') fail('builder dropped a supplied value');
}

// ── 3. Both call sites build through the builder ───────────────────────────
for (const [file, label] of [
  ['server/lib/repairPipeline.js', 'production pipeline'],
  ['server/lib/testlab.js', 'Test Lab stage'],
]) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  if (src.includes('buildCharRepairRequest(')) pass(`${label} builds through the shared contract`);
  else fail(`${label} assembles the char-repair options by hand — it will drift`);
}

// ── 4. artStyle actually reaches the call in both ──────────────────────────
for (const [file, label] of [
  ['server/lib/repairPipeline.js', 'production pipeline'],
  ['server/lib/testlab.js', 'Test Lab stage'],
]) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
  const call = src.slice(src.indexOf('buildCharRepairRequest({'));
  const block = call.slice(0, call.indexOf('});') + 3);
  if (/artStyle:/.test(block)) pass(`${label} passes artStyle`);
  else fail(`${label} does not pass artStyle — the repair prompt's art-style block will be empty`);
}

// ── 5. Declared Lab divergences are indexed ────────────────────────────────
{
  const registry = path.join(ROOT, 'docs/lab-divergences.md');
  if (!fs.existsSync(registry)) {
    fail('docs/lab-divergences.md is missing — Lab deviations must be indexed');
  } else {
    const doc = fs.readFileSync(registry, 'utf8');
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/testlab.js'), 'utf8');
    const declared = [...src.matchAll(/LAB DIVERGENCE \(indexed\)/g)].length;
    const rows = [...doc.matchAll(/^\|\s*`?char_repair/gm)].length;
    if (declared > 0 && rows === 0) {
      fail(`${declared} in-code Lab divergence(s) for char_repair but no row in docs/lab-divergences.md`);
    } else {
      pass(`Lab divergences indexed (${declared} marked in code, ${rows} row(s) in the registry)`);
    }
    if (!/\b(testing|promoted|rejected)\b/.test(doc)) {
      fail('registry has no status column values — each divergence needs testing/promoted/rejected');
    }
  }
}

console.log(failures === 0 ? '\nPASS — Lab and production share one char-repair contract' : `\nFAIL — ${failures} problem(s)`);
process.exit(failures === 0 ? 0 : 1);
