import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// BEHAVIOUR PINNED: a garment seen from behind is not evidence of its TYPE.
//
// Measured on staging story `job_1789207854566_l43qgl34w` p5 — five figures
// walking away down a street, every one `facing: "away from viewer"`. Stage 1
// (`prompts/image-inventory-unified.txt`) wrote, verbatim:
//
//   figure 3  "red puffed-sleeve coat, black skirt, brown boots"
//   figure 4  "green long-sleeved shirt, black corset, black skirt, brown boots"
//
// The pixels show black cropped wide-leg trousers on both — the split between
// the legs is visible at the hem — over brown buckled boots. Stage 2 compared
// stage 1's noun to the contract and emitted two CRITICAL `clothing` findings
// plus a third for boots stage 1 had actually reported. Removing the three
// moved that page -20 -> 35.
//
// Sweep of 105 staging stories / 1211 pages (2026-07-31..2026-09-18): 59
// garment findings on pages holding a back-turned figure, 11 of them CRITICAL,
// all from the blind compliance judge; the two evaluators that SEE the image
// produced 18 and zero CRITICAL.
//
// Assert the RULE at each site, never the prompt's wording.

const ABSTENTION = 'type not visible from this angle';

describe('the blind describer may abstain on a garment the angle hides', () => {
  // Stage 1's per-figure `clothing` had no abstention vocabulary at all, while
  // `eyewear`, `headwear`, `facial_hair` and `worn_carried` each carried one.
  // Required to name a type, it guessed.
  it('the unified inventory offers the abstention on clothing', () => {
    const t = read('prompts/image-inventory-unified.txt');
    const line = t.split('\n').find(l => l.startsWith('- `hair`, `clothing`'));
    expect(line).toBeTruthy();
    expect(line).toContain(ABSTENTION);
  });

  // inventory-schema sibling (scripts/admin/sibling-registry.json): both
  // templates describe the inventory the blind judge consumes, so an
  // abstention only one of them can emit makes the two incomparable.
  it('the quality evaluator describes the same abstention', () => {
    expect(read('prompts/image-evaluation.txt')).toContain(ABSTENTION);
  });
});

describe('the judges do not rule on a garment type the camera hid', () => {
  // The carve-out already existed in the compliance judge and was skipped on
  // the measured page: it sat two sentences AFTER the sentence that awards
  // CRITICAL, reading as a qualifier on a verdict already reached. Same
  // failure shape as the absence rule hoisted above STEP 1 on 2026-08-10.
  // Pinned as ORDER, so a future edit cannot re-bury it.
  it('the compliance judge checks facing before it reaches any severity', () => {
    const t = read('prompts/image-prompt-compliance.txt');
    const bullet = t.split('\n').find(l => l.includes('**Clothing type**'))!;
    expect(bullet).toBeTruthy();
    const gate = bullet.indexOf('`facing`');
    const critical = bullet.indexOf('CRITICAL');
    expect(gate).toBeGreaterThan(-1);
    expect(critical).toBeGreaterThan(-1);
    expect(gate).toBeLessThan(critical);
  });

  // It gated on a garment NOUN it had to recognise ("cropped wide-leg trousers
  // read as a skirt"). It now gates on the inventory's own machine-written
  // `facing` value, which needs no recognition.
  it('the compliance judge names the facing values that hide the type', () => {
    const bullet = read('prompts/image-prompt-compliance.txt')
      .split('\n').find(l => l.includes('**Clothing type**'))!;
    for (const v of ['away from viewer', 'left', 'right']) expect(bullet).toContain(v);
    expect(bullet).toContain(ABSTENTION);
  });

  // The third finding on the measured page — "missing brown buckled boots" —
  // was raised against an inventory that said "brown boots". An unlisted
  // attribute of a listed garment is undescribed, not absent.
  it('an unitemised garment attribute is not an absence', () => {
    expect(read('prompts/image-prompt-compliance.txt')).toContain('undescribed, never missing');
  });

  // The two judges that SEE the image carry the same rule: the one live
  // instance in the sweep was semantic, MAJOR, "a dark skirt-like garment"
  // against a contract naming knee-length breeches.
  it('both sighted judges decline a type difference they cannot see', () => {
    for (const f of ['prompts/image-evaluation.txt', 'prompts/image-semantic.txt']) {
      const t = read(f);
      expect(t).toMatch(/split between the legs/);
      expect(t).toMatch(/front fastening/);
    }
  });

  // The rule REMOVES deductions; it asks the illustrator for nothing new, so
  // the generator needs no counterpart. Pin that it stayed out of the
  // generator, so a later sweep does not "sync" a no-op into it.
  it('the generator is not given a judging rule', () => {
    expect(read('prompts/image-generation.txt')).not.toContain(ABSTENTION);
  });
});

describe('the measured page replayed against the new rules', () => {
  // The stored stage-1 inventory for l43qgl34w p5, verbatim from
  // stories.data -> sceneImages[4] -> threeStageResult.visionInventory.
  const STORED = [
    { id: 1, facing: 'away from viewer', clothing: 'white puffed-sleeve blouse, brown corset, blue wide-leg trousers, brown boots' },
    { id: 2, facing: 'away from viewer', clothing: 'orange long-sleeved shirt, brown vest, brown sash tied around waist, brown trousers, brown boots' },
    { id: 3, facing: 'away from viewer', clothing: 'red puffed-sleeve coat, black skirt, brown boots' },
    { id: 4, facing: 'away from viewer', clothing: 'green long-sleeved shirt, black corset, black skirt, brown boots' },
    { id: 5, facing: 'left', clothing: 'purple hooded cloak, dark grey or teal trousers, black boots' },
  ];

  // The three CRITICAL `clothing` findings the judge actually emitted, each
  // tied to the figure whose inventory line produced it.
  const EMITTED = [
    { figure: 3, description: 'Wearing a red coat and black skirt instead of red linen blouse and black cropped wide-leg sailor trousers' },
    { figure: 4, description: 'Wearing a black skirt instead of black cropped wide-leg sailor trousers; missing brown buckled boots detail' },
    { figure: 5, description: 'Wearing a purple hooded cloak instead of loose purple linen blouse and purple sash' },
  ];

  it('every figure the three CRITICALs were raised against is gated by facing', () => {
    const gated = new Set(
      STORED.filter(f => ['away from viewer', 'left', 'right'].includes(f.facing)).map(f => f.id),
    );
    // All five figures on this page qualify, so none of the three survives.
    expect(gated.size).toBe(5);
    for (const e of EMITTED) expect(gated.has(e.figure)).toBe(true);
  });

  it('the gate is about the type, not the colour', () => {
    // The page also carried a MODERATE accessory finding on a hat colour.
    // Colour survives a back view and the rule leaves it alone.
    const bullet = read('prompts/image-prompt-compliance.txt')
      .split('\n').find(l => l.includes('**Clothing type**'))!;
    expect(bullet).toMatch(/Colour, which the angle does not hide, you still rule on/);
  });
});
