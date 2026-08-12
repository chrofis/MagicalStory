/**
 * Garment vocabulary is a CLOSED enum (owner, 2026-08-12).
 *
 * The word reaches an open-vocabulary detector that always returns a box and
 * can never answer "not visible", so an ungroundable word yields a confident
 * wrong box. Measured on job_1786484554633_crojok432 p3 (Lab 533-537, replayed
 * against v0): "hatband" returned the hat's box to within 1px, "robe" a box over
 * 62% of the crop (the map the child holds), "shoes" 94% (the whole picture).
 *
 * Run: node tests/manual/garmentEnum.test.js
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');

const {
  GARMENT_ENUM, GARMENT_VALUES, garmentQueryFor, garmentEnumForPrompt,
} = require('../../server/lib/garmentColourFix');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
};

// ── The enum itself ─────────────────────────────────────────────────────────
t('exactly the seven agreed values, in order', () => {
  assert.deepStrictEqual(GARMENT_VALUES,
    ['hat', 'top', 'jacket', 'dress', 'pants', 'skirt', 'shoes']);
});

t('belt/sash is deliberately absent', () => {
  for (const gone of ['belt', 'sash', 'waistband']) {
    assert.ok(!(gone in GARMENT_ENUM), `${gone} must not be in the enum`);
  }
});

t('every value carries a query and a covers gloss', () => {
  for (const v of GARMENT_VALUES) {
    assert.ok(GARMENT_ENUM[v].query, `${v} needs a query`);
    assert.ok(GARMENT_ENUM[v].covers, `${v} needs a covers gloss`);
    assert.ok(/worn by the person$/.test(GARMENT_ENUM[v].query),
      `${v} query must be phrased for the detector`);
  }
});

t('enum is frozen — a runtime add does not take effect', () => {
  // CommonJS runs sloppy-mode, so writing to a frozen object silently no-ops
  // rather than throwing. Assert the effect, not an exception.
  GARMENT_ENUM.belt = { query: 'x', covers: 'y' };
  assert.ok(!('belt' in GARMENT_ENUM), 'frozen enum must not gain a value');
  assert.strictEqual(garmentQueryFor('belt').offEnum, true);
});

// ── Resolution ──────────────────────────────────────────────────────────────
t('each enum value resolves to its own distinct query', () => {
  const seen = new Set();
  for (const v of GARMENT_VALUES) {
    const q = garmentQueryFor(v);
    assert.strictEqual(q.key, v);
    assert.strictEqual(q.offEnum, false);
    assert.ok(!seen.has(q.prompt), `${v} duplicates another value's query`);
    seen.add(q.prompt);
  }
});

t('case and whitespace normalise', () => {
  for (const raw of ['SHOES', ' Shoes ', 'sHoEs']) {
    assert.strictEqual(garmentQueryFor(raw).key, 'shoes', `"${raw}"`);
  }
});

// ── The measured failures are now rejected ──────────────────────────────────
t('hatband is rejected — it returned the hat box to within 1px', () => {
  const q = garmentQueryFor('hatband');
  assert.strictEqual(q.key, null);
  assert.strictEqual(q.offEnum, true);
  assert.strictEqual(q.raw, 'hatband');
  assert.strictEqual(q.prompt, null);
});

t('every sub-part word is rejected', () => {
  for (const part of ['hatband', 'cuff', 'collar', 'trim', 'buckle', 'lining', 'hem']) {
    const q = garmentQueryFor(part);
    assert.strictEqual(q.key, null, `${part} must not resolve`);
    assert.strictEqual(q.offEnum, true, `${part} must be flagged off-enum`);
  }
});

t('the p3 words that produced runaway boxes are rejected', () => {
  for (const word of ['robe', 'sash', 'breeches']) {
    assert.strictEqual(garmentQueryFor(word).key, null, `${word} must not resolve`);
  }
});

t('NO synonym folding — an off-enum word never becomes a neighbour', () => {
  // The 2026-08-09 incident: an unrecognised word silently became `top` and
  // aimed a legwear repair at the chest. Nothing may resolve that way again.
  for (const word of ['robe', 'gown', 'trousers', 'boots', 'tunic', 'cloak']) {
    const q = garmentQueryFor(word);
    assert.strictEqual(q.key, null, `${word} must not fold onto an enum value`);
    assert.strictEqual(q.prompt, null, `${word} must not produce a query`);
  }
});

t('missing / empty is distinguished from off-enum', () => {
  for (const empty of [null, undefined, '', '   ', '!!!']) {
    const q = garmentQueryFor(empty);
    assert.strictEqual(q.key, null);
    assert.strictEqual(q.offEnum, false, `${JSON.stringify(empty)} is absent, not off-enum`);
  }
});

// ── Prompt rendering is driven by the same constant ─────────────────────────
t('prompt block lists every value and nothing else', () => {
  const block = garmentEnumForPrompt();
  const listed = [...block.matchAll(/^- `([a-z]+)`/gm)].map(m => m[1]);
  assert.deepStrictEqual(listed, GARMENT_VALUES);
});

t('template has the placeholder the renderer fills', () => {
  const tpl = fs.readFileSync(
    path.join(__dirname, '..', '..', 'prompts', 'entity-consistency-check.txt'), 'utf8');
  assert.ok(tpl.includes('{GARMENT_ENUM}'), 'entity-consistency-check.txt must carry {GARMENT_ENUM}');
});

t('the prompt example uses a real enum value', () => {
  const tpl = fs.readFileSync(
    path.join(__dirname, '..', '..', 'prompts', 'entity-consistency-check.txt'), 'utf8');
  const example = tpl.match(/"garment":\s*"([^"]+)"/);
  assert.ok(example, 'the JSON example must show a garment');
  assert.ok(GARMENT_VALUES.includes(example[1]),
    `example garment "${example[1]}" is not in the enum`);
});

t('the sub-part rule is stated in the prompt', () => {
  const tpl = fs.readFileSync(
    path.join(__dirname, '..', '..', 'prompts', 'entity-consistency-check.txt'), 'utf8');
  assert.ok(/never a part of one/i.test(tpl), 'prompt must forbid naming sub-parts');
});

// ── The caller drops off-enum rather than searching ─────────────────────────
t('repairPipeline drops off-enum mismatches loudly', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', '..', 'server', 'lib', 'repairPipeline.js'), 'utf8');
  assert.ok(src.includes('off-enum garment'), 'must record an off-enum refusal');
  assert.ok(/GARMENT_VALUES/.test(src), 'must name the allowed values in the log');
  assert.ok(/log\.error\([^)]*GARMENT-COLOUR/.test(src), 'the refusal must be an error-level log');
});

console.log(`${pass} passed`);
