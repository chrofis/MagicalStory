/**
 * The garment fix has NO lighting factor (owner, 2026-08-15).
 *
 * It used to scale the avatar's target L* by page-skin-L / avatar-skin-L. That
 * ratio measured four things at once and reported them as illumination:
 *   1. actual scene lighting - the only one intended
 *   2. the character's skin tone as rendered on that page
 *   3. hair, collar, glasses, shadow, background - "skin" was never detected,
 *      it was every pixel the GARMENT test rejects, inside a face box that is
 *      padded down to the chest
 *   4. ART STYLE. Test Lab #432, watercolour pirate page: 0.73 from page skin
 *      L 60.9 vs avatar sheet L 83.7 - a painted page against a bright studio
 *      sheet, no illumination difference at all - which dragged Emma's top from
 *      L 73 to L 60, muddy.
 *
 * A page-level probe has the same disease: a night scene and a dark watercolour
 * both read "dark". Only a DECLARED time-of-day could separate them, and no
 * such field exists (sceneMetadata has 25 keys, none about lighting).
 *
 * Run: node tests/manual/garmentNoLighting.test.js
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const g = require('../../server/lib/garmentColourFix');

let pass = 0;
const t = (name, fn) => {
  try { fn(); pass++; }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); process.exitCode = 1; }
};

const SRC = fs.readFileSync(path.join(__dirname, '..', '..', 'server', 'lib', 'garmentColourFix.js'), 'utf8');

t('the skin probe is gone', () => {
  assert.ok(!/medianSkinL/.test(SRC), 'medianSkinL must not survive anywhere');
  assert.strictEqual(g.medianSkinL, undefined, 'and must not be exported');
  assert.ok(!/pageSkinL|avSkinL/.test(SRC), 'no page-vs-avatar skin comparison');
});

t('the target is no longer scaled by anything', () => {
  assert.ok(/const lighting = 1;/.test(SRC), 'the factor is a constant 1');
  assert.ok(/const targetL = target\.L \* lighting;/.test(SRC),
    'the repaint still reads targetL, so removing the factor cannot change the maths');
});

t('the report still carries the field, so a Lab run shows 1 rather than nothing', () => {
  assert.ok(/report\.lighting = 1;/.test(SRC));
  assert.ok(/report\.lightingSource = 'none/.test(SRC), 'and says why');
});

t('lightingMin/Max SURVIVE — they bound the observed-colour gate, a different job', () => {
  // These are not the removed factor. They bound the widest lightness range any
  // illumination could plausibly produce, so a cream mask cannot pass as brown.
  assert.ok(/lightingMin: 0\.55/.test(SRC));
  assert.ok(/lightingMax: 1\.35/.test(SRC));
  assert.ok(/const loL = ref\.lab\[0\] \* cfg\.lightingMin/.test(SRC));
  assert.ok(/const hiL = ref\.lab\[0\] \* cfg\.lightingMax/.test(SRC));
});

t('the guards that actually bound a repaint are untouched', () => {
  assert.ok(/maxDeltaL/.test(SRC), 'the L* clamp still limits how far a repaint moves');
  assert.ok(typeof g.maskMatchesObservedColour === 'function',
    'and the colour gate still refuses a mask that is not the reported colour');
});

console.log(`${pass} passed`);
