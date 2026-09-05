/**
 * The text-zone rule family and its flag.
 *
 * WHY THIS EXISTS
 * The old unified chain enforced three things about the page-text zone that the
 * beats chain silently dropped (rule-survival audit, 2026-09-03): a set of
 * distribution floors over the book's `textPosition` values, a surface rule for
 * the corner behind the text, and a textPosition-vs-character collision check.
 * They were restored BEHIND A FLAG on the owner's ruling — "only active for the
 * modes with little text" — because they are meaningful only when a SHORT page
 * text is painted INSIDE the picture. With the text in a strip below the image
 * there is no zone in the frame at all, and the rules bend the composition of a
 * picture nothing will be written on.
 *
 * The flag is derived, not declared per story: `textZoneRulesActive` reads the
 * layout that resolveLayout() already picks from the reading level. This test
 * pins that derivation per reading level, and pins that the R1 counters produce
 * findings only when the flag is on.
 *
 * Run: node tests/manual/textZoneRules.test.js
 */
'use strict';

const assert = require('assert');
const { textZoneRulesActive, SETTINGS } = require('../../server/config/runtime');
const { resolveLayout } = require('../../server/lib/layout');
const {
  checkTextZoneDistribution, checkPage, parseTextPosition,
} = require('../../server/lib/sceneBriefCheck');

let passed = 0, failed = 0;
const ok = (label, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (err) { failed++; console.log(`  ✗ ${label}\n      ${err.message}`); }
};
const types = (findings) => findings.map(f => f.type).sort();

// A brief carrying only the metadata the text-zone checks read.
const brief = (metadata) => `Some prose.\n\n---METADATA---\n${JSON.stringify(metadata)}`;
const page = (pageNumber, textPosition, characters = []) =>
  ({ pageNumber, brief: brief({ textPosition, characters }) });

console.log('\n── The flag: which reading levels activate the rules ──');
{
  // Fact base this derivation rests on, asserted so a layout change breaks here
  // rather than silently switching the rules on for a text-below story.
  ok('1st-grade lays text BELOW the picture (2026-09-05: no level overlays by default)', () =>
    assert.strictEqual(resolveLayout('1st-grade').textInImage, false));
  ok('an a4-overlay override still lays text INSIDE the picture', () =>
    assert.strictEqual(resolveLayout('1st-grade', 'a4-overlay').textInImage, true));
  ok('standard lays text BELOW the picture', () =>
    assert.strictEqual(resolveLayout('standard').textInImage, false));
  ok('advanced lays text BELOW the picture', () =>
    assert.strictEqual(resolveLayout('advanced').textInImage, false));

  ok('OFF for 1st-grade — it is text-below like every other level', () =>
    assert.strictEqual(textZoneRulesActive({ languageLevel: '1st-grade' }), false));
  ok('active only for an explicit a4-overlay override', () =>
    assert.strictEqual(textZoneRulesActive({ languageLevel: '1st-grade', layoutOverride: 'a4-overlay' }), true));
  ok('OFF for standard', () =>
    assert.strictEqual(textZoneRulesActive({ languageLevel: 'standard' }), false));
  ok('OFF for advanced', () =>
    assert.strictEqual(textZoneRulesActive({ languageLevel: 'advanced' }), false));
  ok('an unknown level follows the text-below default', () =>
    assert.strictEqual(textZoneRulesActive({ languageLevel: 'martian' }), false));
  ok('no story at all is treated as text-below', () =>
    assert.strictEqual(textZoneRulesActive(), false));

  ok('a stamped layout wins over the reading level', () => {
    // The pipeline stamps inputData.layout once; every later stage must read
    // THAT, or a developer layoutOverride silently stops applying.
    assert.strictEqual(textZoneRulesActive({ languageLevel: 'advanced', layout: { textInImage: true } }), true);
    assert.strictEqual(textZoneRulesActive({ languageLevel: '1st-grade', layout: { textInImage: false } }), false);
  });
  ok('a developer layoutOverride is honoured', () => {
    assert.strictEqual(textZoneRulesActive({ languageLevel: 'advanced', layoutOverride: 'a4-overlay' }), true);
    assert.strictEqual(textZoneRulesActive({ languageLevel: '1st-grade', layoutOverride: 'square-below' }), false);
  });
  ok('the master switch is a real switch', () => {
    const saved = SETTINGS.textZoneRules;
    try {
      SETTINGS.textZoneRules = false;
      assert.strictEqual(textZoneRulesActive({ languageLevel: '1st-grade', layoutOverride: 'a4-overlay' }), false);
      assert.strictEqual(textZoneRulesActive({ languageLevel: '1st-grade', layout: { textInImage: true } }), false);
    } finally { SETTINGS.textZoneRules = saved; }
  });
}

console.log('\n── R1: the distribution floors ──');
{
  // 10 pages, 4 full-width (40%), 5 top / 5 bottom, no run over 3 — clean.
  const clean = [
    page(1, 'top-left'), page(2, 'bottom-right'), page(3, 'top-full'), page(4, 'bottom-full'),
    page(5, 'top-left'), page(6, 'bottom-right'), page(7, 'top-full'), page(8, 'bottom-full'),
    page(9, 'top-left'), page(10, 'bottom-right'),
  ];
  ok('a compliant book produces nothing', () =>
    assert.deepStrictEqual(checkTextZoneDistribution(clean), []));

  ok('no full-width at all trips the floor', () => {
    const pages = clean.map((p, i) => page(i + 1, i % 2 ? 'bottom-right' : 'top-left'));
    assert.deepStrictEqual(types(checkTextZoneDistribution(pages)), ['textzone_fullwidth_floor']);
  });
  ok('too MUCH full-width trips the same ceiling', () => {
    const pages = clean.map((p, i) => page(i + 1, i % 2 ? 'bottom-full' : 'top-full'));
    assert.deepStrictEqual(types(checkTextZoneDistribution(pages)), ['textzone_fullwidth_floor']);
  });
  ok('an all-top book trips the bottom floor', () => {
    const pages = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => page(n, n % 3 === 0 ? 'top-full' : 'top-left'));
    const t = types(checkTextZoneDistribution(pages));
    assert.ok(t.includes('textzone_bottom_floor'), t.join());
    assert.ok(t.includes('textzone_half_streak'), t.join());
  });
  ok('exactly 3 consecutive pages in one half is allowed', () => {
    const pages = [
      page(1, 'top-left'), page(2, 'top-right'), page(3, 'top-full'),
      page(4, 'bottom-left'), page(5, 'bottom-right'), page(6, 'bottom-full'),
      page(7, 'top-left'), page(8, 'top-right'), page(9, 'top-full'), page(10, 'bottom-full'),
    ];
    assert.ok(!types(checkTextZoneDistribution(pages)).includes('textzone_half_streak'));
  });
  ok('4 consecutive pages in one half is a streak', () => {
    const pages = [
      page(1, 'top-left'), page(2, 'top-right'), page(3, 'top-full'), page(4, 'top-left'),
      page(5, 'bottom-left'), page(6, 'bottom-right'), page(7, 'bottom-full'),
      page(8, 'bottom-left'), page(9, 'top-full'), page(10, 'bottom-full'),
    ];
    const streaks = checkTextZoneDistribution(pages).filter(f => f.type === 'textzone_half_streak');
    assert.strictEqual(streaks.length, 2, JSON.stringify(streaks));
  });
  ok('a whole-book finding carries pageNumber 0', () =>
    assert.ok(checkTextZoneDistribution(clean.map((p, i) => page(i + 1, 'top-left')))
      .every(f => f.pageNumber === 0)));
  ok('a book with no textPosition anywhere reports nothing', () =>
    assert.deepStrictEqual(checkTextZoneDistribution([{ pageNumber: 1, brief: brief({}) }]), []));
  ok('empty and missing input do not crash', () => {
    assert.deepStrictEqual(checkTextZoneDistribution(), []);
    assert.deepStrictEqual(checkTextZoneDistribution([]), []);
    assert.deepStrictEqual(checkTextZoneDistribution([null]), []);
  });
}

console.log('\n── R1 + R4 are produced ONLY when the flag is on ──');
{
  const offBook = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map(n => page(n, 'top-left'));
  const { checkScenes } = require('../../server/lib/sceneBriefCheck');
  ok('flag on → distribution findings appear', () =>
    assert.ok(checkScenes(offBook, [], null, { textZoneRules: true }).findings
      .some(f => f.type.startsWith('textzone_'))));
  ok('flag off → no textzone finding of any kind', () =>
    assert.deepStrictEqual(checkScenes(offBook, [], null, { textZoneRules: false }).findings
      .filter(f => f.type.startsWith('textzone_')), []));
  ok('no options at all → off (the pre-flag behaviour of this module)', () =>
    assert.deepStrictEqual(checkScenes(offBook, []).findings
      .filter(f => f.type.startsWith('textzone_')), []));
}

console.log('\n── R4: textPosition vs character vertical collision ──');
{
  const collide = (textPosition, characters) =>
    types(checkPage(page(1, textPosition, characters), [], null, { textZoneRules: true }));

  ok('bottom-full collides with any foreground character', () =>
    assert.deepStrictEqual(collide('bottom-full', [{ name: 'A', position: 'center foreground' }]),
      ['textzone_character_collision']));
  ok('bottom-left collides with a left-foreground character', () =>
    assert.deepStrictEqual(collide('bottom-left', [{ name: 'A', position: 'left foreground' }]),
      ['textzone_character_collision']));
  ok('bottom-left does NOT collide with a right-foreground character', () =>
    assert.deepStrictEqual(collide('bottom-left', [{ name: 'A', position: 'right foreground' }]), []));
  ok('bottom-left collides with a centre-foreground character', () =>
    assert.deepStrictEqual(collide('bottom-left', [{ name: 'A', position: 'center foreground' }]),
      ['textzone_character_collision']));
  ok('top-right collides with a right-background character (their head is high)', () =>
    assert.deepStrictEqual(collide('top-right', [{ name: 'A', position: 'right background', depth: 'background' }]),
      ['textzone_character_collision']));
  ok('top-right does NOT collide with a right-foreground character', () =>
    assert.deepStrictEqual(collide('top-right', [{ name: 'A', position: 'right foreground' }]), []));
  ok('the depth FIELD counts, not just the position prose', () =>
    assert.deepStrictEqual(collide('top-full', [{ name: 'A', position: 'beside the gate', depth: 'background' }]),
      ['textzone_character_collision']));
  ok('a midground character never collides', () =>
    assert.deepStrictEqual(collide('bottom-full', [{ name: 'A', position: 'center midground', depth: 'midground' }]), []));
  ok('a relational position with no depth at all never collides', () =>
    assert.deepStrictEqual(collide('bottom-full', [{ name: 'A', position: 'on the boat' }]), []));
  ok('no textPosition → no check', () =>
    assert.deepStrictEqual(collide('', [{ name: 'A', position: 'center foreground' }]), []));
  ok('a bogus textPosition → no check', () =>
    assert.deepStrictEqual(collide('middle-ish', [{ name: 'A', position: 'center foreground' }]), []));
  ok('flag off → no collision finding', () =>
    assert.deepStrictEqual(
      types(checkPage(page(1, 'bottom-full', [{ name: 'A', position: 'center foreground' }]), [], null, {})), []));
  ok('every colliding character is named in the one finding', () => {
    const f = checkPage(page(1, 'bottom-full', [
      { name: 'A', position: 'center foreground' },
      { name: 'B', position: 'left foreground' },
      { name: 'C', position: 'right midground', depth: 'midground' },
    ]), [], null, { textZoneRules: true }).find(x => x.type === 'textzone_character_collision');
    assert.ok(/A/.test(f.detail) && /B/.test(f.detail), f.detail);
    assert.ok(!/\bC\b/.test(f.detail.replace(/character/g, '')), f.detail);
  });
}

console.log('\n── parseTextPosition ──');
{
  ok('valid values parse', () => {
    assert.deepStrictEqual(parseTextPosition('top-left'), { half: 'top', side: 'left' });
    assert.deepStrictEqual(parseTextPosition('BOTTOM-FULL'), { half: 'bottom', side: 'full' });
    assert.deepStrictEqual(parseTextPosition('  top-right '), { half: 'top', side: 'right' });
  });
  ok('anything else is null', () => {
    for (const v of ['', null, undefined, 'left', 'top', 'top-middle', 42, {}]) {
      assert.strictEqual(parseTextPosition(v), null, String(v));
    }
  });
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
