/**
 * Visual-bible secondary characters are consistency-checked too (owner, 2026-08-15).
 *
 * They were never in the entity report. On job_1786780194082_s980g4s9a it covered
 * [Emma, Hans, Noah, Sarah, Daniel] while Lira — a mermaid on pages 3, 4, 7 and 9,
 * correctly detected AND named on every one — had nothing watching her for drift.
 *
 * They are judged against their VISUAL BIBLE entry and nothing else: the
 * `description` (which already carries hair, build, signature look and clothing)
 * as the expected text, and `referenceImageUrl` as the comparison cell. No
 * clothing category is involved — the roster's category system does not dress
 * them ("secondary characters are described, never dressed", decisions.md), and
 * they have no clothingRequirements row to resolve against.
 *
 * The helper is extracted from source rather than required: entityConsistency
 * pulls in the heavy modules and require() hangs.
 *
 * Run: node tests/manual/secondaryEntityCheck.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const SRC_PATH = path.join(__dirname, '..', '..', 'server', 'lib', 'entityConsistency.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
const start = src.indexOf('function collectSecondaryEntities');
const end = src.indexOf('async function collectEntityAppearances');
assert.ok(start > 0 && end > start, 'collectSecondaryEntities not found in source');
const collectSecondaryEntities = new Function(src.slice(start, end) + '; return collectSecondaryEntities;')();

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
};

const LIRA = {
  name: 'Lira', pages: [3, 4, 7, 9], referenceImageUrl: 'https://img/vb/CHR001.jpg',
  hair: 'deep teal-green, long, loose', build: 'slender',
  signatureLook: 'large silver-grey fish tail replacing legs',
  clothing: 'a structured green swim top',
  description: 'young adult aquatic being. hair: deep teal-green, long, loose. Signature: large silver-grey fish tail. Clothing: a structured green swim top',
};
const VB = { secondaryCharacters: [LIRA] };
const pagesSeen = (nums, name = 'Lira') => nums.map(n => ({
  pageNumber: n, bboxDetection: { figures: [{ name }, { name: 'Emma' }] },
}));

// ── Who qualifies ───────────────────────────────────────────────────────────
t('a secondary seen on several pages is included', () => {
  const r = collectSecondaryEntities(VB, pagesSeen([3, 4, 7, 9]));
  assert.deepStrictEqual(r.map(e => e.name), ['Lira']);
  assert.deepStrictEqual(r[0].__vbPages.sort(), [3, 4, 7, 9]);
});

t('ONE appearance is not checked — it cannot drift', () => {
  assert.deepStrictEqual(collectSecondaryEntities(VB, pagesSeen([3])), []);
});

t('detected pages win over declared pages', () => {
  // She declares 3,4,7,9 but was only actually found on two of them.
  const r = collectSecondaryEntities(VB, pagesSeen([3, 9]));
  assert.deepStrictEqual(r[0].__vbPages.sort(), [3, 9]);
});

t('declared pages are the fallback when nothing is detected yet', () => {
  // gridsOnly rebuilds run before/without detection.
  const r = collectSecondaryEntities(VB, []);
  assert.deepStrictEqual(r[0].__vbPages, [3, 4, 7, 9]);
});

t('appearsInPages works as well as pages', () => {
  const vb = { secondaryCharacters: [{ name: 'Lira', appearsInPages: [1, 2], description: 'teal hair' }] };
  assert.deepStrictEqual(collectSecondaryEntities(vb, []).map(e => e.name), ['Lira']);
});

t('name matching is case-insensitive', () => {
  const imgs = [1, 2].map(n => ({ pageNumber: n, bboxDetection: { figures: [{ name: 'LIRA' }] } }));
  assert.deepStrictEqual(collectSecondaryEntities(VB, imgs).map(e => e.name), ['Lira']);
});

// ── What they are judged against ────────────────────────────────────────────
t('the VB description is carried as the expected text', () => {
  const r = collectSecondaryEntities(VB, pagesSeen([3, 4]));
  assert.strictEqual(r[0].__vbDescription, LIRA.description);
  assert.ok(/teal/.test(r[0].__vbDescription), 'must carry the identifying feature');
  assert.ok(/Clothing:/.test(r[0].__vbDescription), 'the description already covers clothing');
});

t('the VB reference image is carried as the comparison cell', () => {
  const r = collectSecondaryEntities(VB, pagesSeen([3, 4]));
  assert.strictEqual(r[0].__vbReferenceUrl, LIRA.referenceImageUrl);
});

t('a description is composed when the entry has no `description` field', () => {
  const vb = { secondaryCharacters: [{ name: 'Lira', pages: [1, 2], hair: 'deep teal', signatureLook: 'fish tail', clothing: 'green top' }] };
  const d = collectSecondaryEntities(vb, [])[0].__vbDescription;
  assert.ok(/teal/.test(d) && /fish tail/.test(d) && /green top/.test(d), d);
});

t('no description at all → skipped, never checked against nothing', () => {
  assert.deepStrictEqual(collectSecondaryEntities({ secondaryCharacters: [{ name: 'Ghost', pages: [1, 2] }] }, []), []);
});

t('a missing reference image does not disqualify them', () => {
  const vb = { secondaryCharacters: [{ name: 'Lira', pages: [1, 2], description: 'teal hair' }] };
  const r = collectSecondaryEntities(vb, []);
  assert.strictEqual(r.length, 1);
  assert.strictEqual(r[0].__vbReferenceUrl, null, 'grid runs without a reference cell');
});

// ── Robustness ──────────────────────────────────────────────────────────────
t('survives missing / empty / object-shaped visual bibles', () => {
  for (const vb of [null, undefined, {}, { secondaryCharacters: null }, { secondaryCharacters: [] }]) {
    assert.deepStrictEqual(collectSecondaryEntities(vb, []), [], JSON.stringify(vb));
  }
  const obj = { secondaryCharacters: { a: { name: 'Lira', pages: [1, 2], description: 'teal hair' } } };
  assert.deepStrictEqual(collectSecondaryEntities(obj, []).map(e => e.name), ['Lira']);
});

t('a nameless entry is skipped', () => {
  assert.deepStrictEqual(collectSecondaryEntities({ secondaryCharacters: [{ pages: [1, 2], description: 'x' }] }, []), []);
});

// ── Wiring: the three judging points must branch ────────────────────────────
t('secondaries get ONE group, not clothing categories', () => {
  assert.ok(/character\.__vbSecondary\s*\n?\s*\?\s*new Map\(\[\['visual-bible', appearances\]\]\)/.test(src),
    'byClothing must be a single visual-bible group for secondaries');
});

t('the reference cell is the VB image, not a styled avatar', () => {
  assert.ok(/character\.__vbSecondary[\s\S]{0,120}__vbReferenceUrl/.test(src),
    'refAvatar must come from the visual bible for secondaries');
});

t('the expected text is the VB description, not clothingRequirements', () => {
  assert.ok(/character\.__vbSecondary[\s\S]{0,80}__vbDescription/.test(src),
    'expectedClothing must be the VB description for secondaries');
});

t('the roster the check iterates includes them', () => {
  assert.ok(/const entityRoster = \[\.\.\.characters, \.\.\.secondaryEntities\]/.test(src));
  assert.ok(/for \(const character of entityRoster\)/.test(src), 'the task loop must use the augmented roster');
  assert.ok(/collectEntityAppearances\(allImages, entityRoster/.test(src), 'collection must use it too');
});

console.log(`${pass} passed`);
