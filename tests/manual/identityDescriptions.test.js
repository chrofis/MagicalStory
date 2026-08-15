/**
 * The identity call must be given something to identify WITH (owner, 2026-08-15).
 *
 * Every call site built its expected list as `{ name, description: c.description
 * || '' }` from `sceneCharacters`, whose entries are
 *   [id, age, name, gender, photos, traits, avatars, physical, ageCategory,
 *    structuredClothing]
 * — there is NO `description` key, so the field was ALWAYS ''. The Set-of-Mark
 * prompt then says "match each letter by age, gender, hair, and clothing" and
 * lists "- Emma: Emma."
 *
 * Measured on job_1786743927715_kcx0p939w p3 — a brown-haired girl in yellow, a
 * teal-haired mermaid in green, a blond boy in blue, two bare names:
 *   expectedCharacters: [{"name":"Emma","description":""},{"name":"Noah","description":""}]
 *   SoM answer: Emma -> the MERMAID, the real Emma -> UNKNOWN
 * and the garment recolour then repainted the mermaid's green top toward Emma's
 * yellow (16,127px at hue 162.9 — green).
 *
 * Second half: a visual-bible secondary declares its own pages (Lira is
 * `pages: [3,5,9]`). On that page the scene metadata listed only [Emma, Noah] —
 * sceneCharacters, outlineCharacters and characterClothing all — while the PROSE
 * and the image prompt both named her, so a name-collector over the metadata
 * found nothing. Her own page list is authoritative.
 *
 * Run: node tests/manual/identityDescriptions.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
  buildCastIdentityDescription, buildSecondaryExpectedForPage,
} = require('../../server/lib/promptBuilders');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
};

// The real shape of a sceneCharacters entry, from the DB.
const EMMA = {
  id: 1778709081750, age: '5', name: 'Emma', gender: 'female', ageCategory: 'preschooler',
  physical: { hair: 'brown, wavy, ear-length, ponytail, side part right', build: 'average', face: 'soft jawline, freckles' },
  traits: ['freckles'], photos: [], avatars: {}, structuredClothing: {},
};
const NOAH = {
  name: 'Noah', gender: 'male', ageCategory: 'kindergartner',
  physical: { hair: 'blonde, wavy, ear-length, bangs at eyebrows', build: 'average' },
};

// ── The cast line ───────────────────────────────────────────────────────────
t('a cast member yields a non-empty identity line', () => {
  const d = buildCastIdentityDescription(EMMA, '');
  assert.ok(d && d.length > 20, `got "${d}"`);
});

t('it carries the features the prompt asks to match on', () => {
  const d = buildCastIdentityDescription(EMMA, '').toLowerCase();
  assert.ok(d.includes('preschooler'), 'age band missing');
  assert.ok(d.includes('girl'), 'gender missing');
  assert.ok(d.includes('brown'), 'hair colour missing');
  assert.ok(d.includes('ponytail'), 'hair style missing');
});

t('clothing is appended when known', () => {
  const d = buildCastIdentityDescription(EMMA, 'yellow swim shirt, red swim shorts');
  assert.ok(/Wearing: yellow swim shirt/.test(d), d);
});

t('two children are separable by their lines alone', () => {
  // The page-3 failure in one assertion: these must not read alike.
  const e = buildCastIdentityDescription(EMMA, 'yellow swim shirt').toLowerCase();
  const n = buildCastIdentityDescription(NOAH, 'blue swim shirt').toLowerCase();
  assert.notStrictEqual(e, n);
  assert.ok(e.includes('brown') && !e.includes('blonde'), e);
  assert.ok(n.includes('blonde') && !n.includes('brown'), n);
});

t('a description that already exists is never overwritten', () => {
  // The call site prefers c.description when present; this helper is the fallback.
  assert.strictEqual(buildCastIdentityDescription(null), '');
  assert.strictEqual(buildCastIdentityDescription('Emma'), '');
});

t('a character with no usable traits yields empty, not junk', () => {
  assert.strictEqual(buildCastIdentityDescription({ name: 'X' }, ''), '');
});

// ── Secondaries by their own declared pages ─────────────────────────────────
const VB = {
  secondaryCharacters: [{
    id: 'CHR001', name: 'Lira', pages: [3, 5, 9],
    hair: 'deep teal-green, long, loose', build: 'slender',
    signatureLook: 'large silver-grey fish tail replacing legs',
    clothing: 'a structured green swim top',
    description: 'young adult aquatic being. hair: deep teal-green, long, loose. Signature: large silver-grey fish tail. Clothing: a structured green swim top',
  }],
};

t('a secondary is included on a page it declares', () => {
  const r = buildSecondaryExpectedForPage(VB, 3, ['Emma', 'Noah']);
  assert.deepStrictEqual(r.map(c => c.name), ['Lira']);
  assert.ok(r[0].description.length > 20, 'must carry a description');
  assert.ok(/teal/.test(r[0].description), 'must carry the distinguishing feature');
});

t('and excluded from a page it does not', () => {
  assert.deepStrictEqual(buildSecondaryExpectedForPage(VB, 4, ['Emma', 'Noah']), []);
});

t('appearsInPages works as well as pages', () => {
  const vb = { secondaryCharacters: [{ name: 'Lira', appearsInPages: [3], description: 'a mermaid with teal hair' }] };
  assert.deepStrictEqual(buildSecondaryExpectedForPage(vb, 3, []).map(c => c.name), ['Lira']);
});

t('never duplicates a name the cast already has', () => {
  assert.deepStrictEqual(buildSecondaryExpectedForPage(VB, 3, ['Emma', 'Lira']), []);
  assert.deepStrictEqual(buildSecondaryExpectedForPage(VB, 3, ['lira']), [], 'case-insensitive');
});

t('a secondary with no description is skipped, not sent nameless', () => {
  const vb = { secondaryCharacters: [{ name: 'Ghost', pages: [3] }] };
  assert.deepStrictEqual(buildSecondaryExpectedForPage(vb, 3, []), []);
});

t('survives a missing / empty / object-shaped visual bible', () => {
  for (const vb of [null, undefined, {}, { secondaryCharacters: null }, { secondaryCharacters: {} },
    { secondaryCharacters: { a: { name: 'Lira', pages: [3], description: 'teal hair' } } }]) {
    assert.ok(Array.isArray(buildSecondaryExpectedForPage(vb, 3, [])), `threw or returned non-array for ${JSON.stringify(vb)}`);
  }
  // the object-shaped one still resolves
  const vb = { secondaryCharacters: { a: { name: 'Lira', pages: [3], description: 'teal hair' } } };
  assert.deepStrictEqual(buildSecondaryExpectedForPage(vb, 3, []).map(c => c.name), ['Lira']);
});

t('page numbers match across string/number types', () => {
  const vb = { secondaryCharacters: [{ name: 'Lira', pages: ['3'], description: 'teal hair' }] };
  assert.deepStrictEqual(buildSecondaryExpectedForPage(vb, 3, []).map(c => c.name), ['Lira']);
});

// ── Wiring ──────────────────────────────────────────────────────────────────
t('the pipeline no longer sends a bare `c.description || \'\'`', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');
  assert.ok(/buildCastIdentityDescription\(c, clothingText\)/.test(src),
    'Phase 5b-pre must fall back to a built identity line');
  assert.ok(/buildSecondaryExpectedForPage\(/.test(src),
    'Phase 5b-pre must include page-declared secondaries');
});

// ── Clothing is the page's, and never a metadata tag ────────────────────────
t('a CATEGORY LABEL never reaches the prompt as clothing', () => {
  // sceneCharacterClothing holds 'costumed:mermaid' / 'summer' — tags, not
  // garments. Sending "Wearing: costumed:mermaid" is the same leak
  // buildExpectedCharactersForBbox guards with isCategoryLabel().
  for (const tag of ['costumed:mermaid', 'costumed', 'summer', 'winter', 'standard', ' Summer ']) {
    const d = buildCastIdentityDescription(EMMA, tag);
    assert.ok(!/Wearing:/.test(d), `"${tag}" leaked: ${d}`);
    assert.ok(d.length > 20, 'the identity half must survive');
  }
});

t('resolved prose IS kept', () => {
  const d = buildCastIdentityDescription(EMMA, 'A yellow short-sleeve swim shirt, and a silver mermaid tail');
  assert.ok(/Wearing: A yellow short-sleeve swim shirt/.test(d), d);
});

t('the call site resolves the category through the canonical source', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'storyJobPipeline.js'), 'utf8');
  // clothingRequirements first — the settled canonical-source rule.
  assert.ok(/buildClothingDescription\(c, category, artStyle, clothingRequirements/.test(src),
    'must resolve via buildClothingDescription with clothingRequirements');
  assert.ok(!/buildCastIdentityDescription\(c, clothingByName\[name\]/.test(src),
    'must NOT pass the raw category through');
});

// ── ALL THREE detection call sites, not just the first ──────────────────────
t('every detection call site builds a real identity line', () => {
  // Phase 5b-pre getting it right is not enough: the round re-detect and the
  // iterate path OVERWRITE the stored detection. On
  // job_1786737619634_d66c7bg9g p4 (char-fix-round-1) the stored
  // expectedCharacters came back [{"name":"Emma","description":""},...] —
  // a good first detection replaced by a bare-name one.
  const files = ['storyJobPipeline.js', 'server/lib/repairPipeline.js', 'server/lib/images.js'];
  for (const f of files) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
    assert.ok(!/description: typeof c === 'object' \? \(c\.description \|\| ''\) : ''/.test(src),
      `${f} still sends a bare description`);
    assert.ok(/buildCastIdentityDescription\(/.test(src), `${f} must build an identity line`);
  }
});

t('each site resolves the clothing category rather than passing the tag', () => {
  for (const f of ['storyJobPipeline.js', 'server/lib/repairPipeline.js', 'server/lib/images.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', '..', f), 'utf8');
    assert.ok(/buildClothingDescription\(/.test(src), `${f} must resolve the category to prose`);
  }
});

console.log(`${pass} passed (incl. all three call sites)`);
