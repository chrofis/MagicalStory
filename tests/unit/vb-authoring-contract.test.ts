import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

// The bug this file locks down: the Visual Bible authoring contract had no
// tripwire, so two authoring gaps reached the illustrator unnoticed on staging
// job_1788380714660_4p9mr11xszu and caused 6 of 8 serious page failures.
//
//   1. The secondary character's entry never stated her sex — "tall,
//      broad-shouldered, sturdy, square jaw, no facial hair" reads male, and
//      the image model rendered a man on three pages.
//   2. The hero vessel declared appearsInPages 1-16 although the story moves
//      inland at mid-book, so the vantage-plate builder baked the ship into two
//      inland hillside scenes.
//
// The audit is WARN-only by design: it never fails a story and never edits an
// entry. Classification of a good entry belongs to the authoring prompt
// (prompts/story-bible-from-beats.txt); this only reports that the prompt
// slipped.

// @ts-expect-error - JS module without types
import { auditVisualBibleContract, vbEntryProse } from '../../server/lib/outlineParser/shared.js';

const codes = (findings: any[]) => findings.map(f => `${f.id}:${f.code}`).sort();

// Neutral 16-page fixture. CHR001 states neither sex nor age; CHR002 states
// both; VEH001 claims every page; VEH002 claims an earned range.
const bible = {
  secondaryCharacters: [
    {
      id: 'CHR001',
      name: 'Rennick',
      age: 'adult',
      build: 'tall, broad-shouldered, sturdy',
      face: 'green eyes, square jaw, prominent cheekbones, no facial hair',
      hair: 'dark red, thick, chin-length',
      clothing: 'dark green long coat with large brass-coloured buttons, black trousers, tall black boots',
      appearsInPages: [4, 7, 13],
    },
    {
      id: 'CHR002',
      name: 'Aldon',
      age: 'a man in his fifties',
      build: 'short, stocky',
      face: 'brown eyes, full grey beard',
      hair: 'grey, cropped short',
      clothing: 'brown wool vest over a cream shirt, tan trousers, leather sandals',
      appearsInPages: [2, 9],
    },
  ],
  animals: [],
  artifacts: [
    { id: 'ART001', name: 'coil of rope', type: 'coiled rope', description: 'a circular coil of pale tan twisted fibre', appearsInPages: [3] },
  ],
  locations: [
    { id: 'LOC001', name: 'the quay', setting: 'outdoor, stone quay', appearsInPages: [1, 4], vantages: [{ id: 'LOC001.1', shot: 'wide', pages: [1] }, { id: 'LOC001.2', shot: 'medium', pages: [4] }] },
    { id: 'LOC002', name: 'the hillside', setting: 'outdoor, dry rocky slope', appearsInPages: [12, 13, 14, 15, 16] },
  ],
  vehicles: [
    { id: 'VEH001', name: 'the hero vessel', type: 'two-masted wooden sailing ship', description: 'a two-masted wooden sailing ship with a golden yellow hull', appearsInPages: Array.from({ length: 16 }, (_, i) => i + 1) },
    { id: 'VEH002', name: 'the rival vessel', type: 'two-masted wooden sailing ship', description: 'a two-masted ship with a dark grey-brown hull and black sails', appearsInPages: [4, 7] },
  ],
  clothing: [],
};

describe('auditVisualBibleContract — character sex and apparent age', () => {
  it('flags the entry that states neither, and leaves the complete one alone', () => {
    const found = auditVisualBibleContract(bible).filter((f: any) => f.code === 'character-missing-sex-or-age');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('CHR001');
    expect(found[0].category).toBe('secondaryCharacters');
    expect(found[0].message).toContain('no sex');
    // The age field said "adult", so only sex is reported missing.
    expect(found[0].message).not.toContain('apparent age');
  });

  it('reports both when neither is stated', () => {
    const bare = { secondaryCharacters: [{ id: 'CHR009', name: 'the keeper', build: 'sturdy', clothing: 'a brown coat' }] };
    const found = auditVisualBibleContract(bare);
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('no sex and no apparent age');
  });

  it('does not let a NAME satisfy the sex rule — prose has to state it', () => {
    // "Mrs" / "Grandmother" in a name is not a statement of sex in the prose
    // the illustrator reads. vbEntryProse deliberately excludes `name`.
    const entry = { id: 'CHR010', name: 'Grandmother Vale', build: 'slight', age: 'elderly' };
    expect(vbEntryProse(entry)).not.toContain('Grandmother');
    const found = auditVisualBibleContract({ secondaryCharacters: [entry] });
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('no sex');
  });

  it('accepts a sex stated only as a pronoun in the description', () => {
    const found = auditVisualBibleContract({
      secondaryCharacters: [{ id: 'CHR011', name: 'Vane', description: 'a woman in her thirties, slight build, her hair cropped short' }],
    });
    expect(found).toHaveLength(0);
  });

  // The authoring prompt (prompts/scene-expansion-all.txt) mandates `age` as a
  // NUMBER of years and a `build` opening with the sex. Before 2026-09-14 the
  // check dropped every non-string field before matching AND its age regex
  // needed a "years"/"aged" token, so an entry obeying the prompt EXACTLY was
  // reported as stating no apparent age — a false positive on correct output.
  it('accepts the contract the prompt mandates: numeric age + a sex-opening build', () => {
    const found = auditVisualBibleContract({
      secondaryCharacters: [
        { id: 'CHR020', name: 'Frau Brunner', age: 34, build: 'a woman, broad-shouldered', hair: 'dark, pinned up', appearsInPages: [3] },
        { id: 'CHR021', name: 'Nico', age: 8, build: 'a boy, slightly tall for his age', hair: 'brown, cropped', appearsInPages: [5] },
      ],
    });
    expect(found).toHaveLength(0);
  });

  // True-positive control: the fix must not become a disable. No age field at
  // all and no age word anywhere in the prose is still the omission.
  it('still reports a genuine age omission when nothing states one', () => {
    const found = auditVisualBibleContract({
      secondaryCharacters: [{ id: 'CHR022', name: 'Frau Brunner', build: 'a woman, broad-shouldered', hair: 'dark, pinned up' }],
    });
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('no apparent age');
    expect(found[0].message).not.toContain('no sex');
  });

  it('rejects age 0 and garbage ages — an unset or defaulted field is the omission', () => {
    for (const age of [0, -5, 999, NaN, null, true, {}, [], '', 'unknown', 'N/A']) {
      const found = auditVisualBibleContract({
        secondaryCharacters: [{ id: 'CHR023', name: 'the keeper', age: age as any, build: 'a woman, sturdy' }],
      });
      expect(found, `age ${JSON.stringify(age)} must not satisfy the rule`).toHaveLength(1);
      expect(found[0].message).toContain('no apparent age');
    }
  });

  it('keeps accepting the prose age forms other templates still emit', () => {
    for (const age of ['8 years old', 'elderly', 'a teenager', 'aged 40']) {
      const found = auditVisualBibleContract({
        secondaryCharacters: [{ id: 'CHR024', name: 'the keeper', age, build: 'a woman, sturdy' }],
      });
      expect(found, `age "${age}" should satisfy the rule`).toHaveLength(0);
    }
  });

  it('only audits secondary characters for sex and age, never props', () => {
    // A prop description mentioning neither must not be reported.
    const found = auditVisualBibleContract({
      artifacts: [{ id: 'ART020', name: 'iron latch', description: 'a flat dark grey iron latch' }],
    });
    expect(found).toHaveLength(0);
  });
});

describe('auditVisualBibleContract — earned appearsInPages', () => {
  it('flags a blanket full-book range and accepts an earned one', () => {
    const found = auditVisualBibleContract(bible).filter((f: any) => f.code === 'blanket-appears-in-pages');
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('VEH001');
    expect(found[0].category).toBe('vehicles');
    expect(found[0].message).toContain('16 of 16 pages');
  });

  it('derives the page count from the highest page the VB references, vantages included', () => {
    // No appearsInPages array reaches past page 10; the story's real length
    // only shows in LOC002's vantage. Without scanning vantages the derived
    // count would be 10 and LOC001's earned 10 pages would trip the ratio.
    const found = auditVisualBibleContract({
      locations: [
        { id: 'LOC001', name: 'the hall', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] },
        { id: 'LOC002', name: 'the yard', appearsInPages: [], vantages: [{ id: 'LOC002.1', pages: [11, 20] }] },
      ],
    });
    expect(found).toHaveLength(0);
  });

  it('honours an explicit pageCount over the derived one', () => {
    const entry = { id: 'ART001', name: 'lantern', appearsInPages: [1, 2, 3, 4] };
    // Derived count is 4 → 4/4 is blanket.
    expect(auditVisualBibleContract({ artifacts: [entry] })).toHaveLength(1);
    // The story is really 16 pages → 4/16 is earned.
    expect(auditVisualBibleContract({ artifacts: [entry] }, { pageCount: 16 })).toHaveLength(0);
  });

  it('counts distinct pages, so a duplicated page cannot inflate a range', () => {
    const found = auditVisualBibleContract(
      { vehicles: [{ id: 'VEH001', name: 'cart', appearsInPages: [1, 1, 2, 2, 3, 3, 4, 4] }] },
      { pageCount: 8 }
    );
    expect(found).toHaveLength(0);
  });

  it('stays quiet on a story too short for the ratio to mean anything', () => {
    const found = auditVisualBibleContract({ locations: [{ id: 'LOC001', name: 'the kitchen', appearsInPages: [1, 2, 3] }] });
    expect(found).toHaveLength(0);
  });

  it('tells a LOCATION what a blanket range means for it, not the element-baking claim', () => {
    // Locations are not elements (docs/SETTLED.md, 2026-09-08): nothing composites
    // a location from a reference cell, so a wide range cannot bake it into a
    // scene. The tripwire stays; the wording says what the reader should check.
    const found = auditVisualBibleContract(
      { locations: [{ id: 'LOC001', name: 'the workshop', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8] }] },
      { pageCount: 8 }
    );
    expect(found).toHaveLength(1);
    expect(found[0].category).toBe('locations');
    expect(found[0].code).toBe('blanket-appears-in-pages');
    expect(found[0].message).toContain('8 of 8 pages');
    expect(found[0].message).toContain('single-setting');
    expect(found[0].message).not.toContain('bakes the element');
  });

  it('keeps the element-baking wording for every non-location category', () => {
    const found = auditVisualBibleContract(
      {
        animals: [{ id: 'ANI001', name: 'the cat', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8] }],
        artifacts: [{ id: 'ART001', name: 'the lantern', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8] }],
        vehicles: [{ id: 'VEH001', name: 'the cart', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8] }],
        clothing: [{ id: 'CLO001', name: 'the red cloak', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8] }],
      },
      { pageCount: 8 }
    );
    expect(found).toHaveLength(4);
    for (const f of found) expect(f.message).toContain('bakes the element into scenes that never contain it');
  });

  it('audits every category, not just vehicles', () => {
    const found = auditVisualBibleContract(
      {
        animals: [{ id: 'ANI001', name: 'the cat', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8] }],
        clothing: [{ id: 'CLO001', name: 'the red cloak', appearsInPages: [1, 2, 3, 4, 5, 6, 7, 8] }],
      },
      { pageCount: 8 }
    );
    expect(codes(found)).toEqual(['ANI001:blanket-appears-in-pages', 'CLO001:blanket-appears-in-pages']);
  });
});

describe('auditVisualBibleContract — robustness', () => {
  it('never throws on a missing or malformed visual bible', () => {
    expect(auditVisualBibleContract(null)).toEqual([]);
    expect(auditVisualBibleContract(undefined)).toEqual([]);
    expect(auditVisualBibleContract({})).toEqual([]);
    expect(auditVisualBibleContract('not an object')).toEqual([]);
    expect(auditVisualBibleContract({ secondaryCharacters: 'not an array', vehicles: null })).toEqual([]);
  });

  it('tolerates an entry with no id, name or pages, and skips non-object entries', () => {
    const found = auditVisualBibleContract({ secondaryCharacters: [{}, null, 'CHR001', 7] });
    expect(found).toHaveLength(1);
    expect(found[0].id).toBe('(unnamed)');
    expect(found[0].message).toContain('(no id)');
  });

  it('ignores non-numeric page entries instead of counting them', () => {
    const found = auditVisualBibleContract({ vehicles: [{ id: 'VEH001', name: 'raft', appearsInPages: ['x', null, 1, 2] }] }, { pageCount: 8 });
    expect(found).toHaveLength(0);
  });

  it('reports only, so the visual bible is never mutated', () => {
    const before = JSON.stringify(bible);
    auditVisualBibleContract(bible);
    expect(JSON.stringify(bible)).toBe(before);
  });
});

describe('story-bible-from-beats.txt — authoring rules the audit backs', () => {
  const cjs = createRequire(import.meta.url);
  let templates: any;
  beforeAll(async () => {
    await cjs('../../server/services/prompts.js').loadPromptTemplates();
    templates = cjs('../../server/services/prompts.js').PROMPT_TEMPLATES;
  });

  // The Visual Bible moved OUT of storyBibleFromBeats and into the ALL-PAGES
  // Art Director call on 2026-09-11 (owner): one author writes both what is in
  // each picture and what each thing looks like, so a page cannot cite an
  // element nobody declared. storyBibleFromBeats writes CLOTHING only now.
  it('requires sex and a NUMERIC age in a character entry', () => {
    // Beats states the age as a number, not prose, so the band computed from
    // the commissioned children is comparable (I11, 2026-09-06 — the other
    // three emitters keep the prose form, asserted below). The sex requirement
    // is unchanged; it moved from `age` to the opening of `build`.
    const t = templates['sceneExpansionAll'];
    expect(t).toBeTruthy();
    expect(t).toMatch(/`age` as a NUMBER of years/);
    expect(t).toMatch(/opens `build` with the character's sex/);
    expect(t).toMatch(/"age": \[age in years as a number\]/);
  });

  it('requires an earned appearsInPages range', () => {
    expect(templates['sceneExpansionAll']).toMatch(/`pages` is earned/);
    expect(templates['sceneExpansionAll']).toMatch(/never a blanket 1-\{PAGE_COUNT\} range/i);
  });

  it('requires an entry for every named vehicle or vessel', () => {
    expect(templates['sceneExpansionAll']).toMatch(/vehicles\b/i);
    expect(templates['sceneExpansionAll']).toMatch(/its own `?vehicles`? entry/i);
  });

  // Regression: staging job_1789147573901_m3uam0nxi, Lab experiments 1189/1190.
  // A parts-list description renders as whatever everyday object its bare
  // geometry describes — a lamp entry as a camera, a scale entry as a shell.
  // The schema asked for exactly that ("described by shape and parts"), with no
  // recognisability requirement to hold it in place.
  it('requires the description to read as the named thing, not as its geometry', () => {
    const t = templates['sceneExpansionAll'];
    expect(t).toMatch(/It must read as that thing at a glance/);
    expect(t).toMatch(/Name the thing with the word that names it/);
    expect(t).toMatch(/separates it from the everyday object its bare geometry would otherwise describe/);
    expect(t).toMatch(/Geometry serves recognition; it is never the whole description/);
  });

  // Owner ruling 2026-09-11, on the cells rendered for Lab experiments
  // 1191/1192 (staging job_1789147573901_m3uam0nxi): naming what the object
  // attaches to is what makes it recognisable, and drew the mounting as well.
  it('says the attachment named for recognition is never drawn', () => {
    expect(templates['sceneExpansionAll'])
      .toMatch(/Naming that thing identifies the object and never puts it in the picture/);
  });

  // Owner ruling 2026-09-11: two cells for the same object under different
  // SCENE light are indistinguishable pictures. The world's light is the
  // scene's, per page. Owner ruling 2026-09-14 (backlog #37) settled the other
  // half: the object's OWN emission IS a state, because a state is drawn as
  // its own reference cell and that cell is the only way a glowing look
  // reaches the page. All three templates now carry the same split.
  it.each([
    ['sceneExpansionAll'],
    ['storyTrial'],
  ])("%s excludes the WORLD light from the state test, keeps the object own light in", (key) => {
    expect(templates[key]).toBeTruthy();
    expect(templates[key]).toMatch(/world lights it is not a state/i);
    expect(templates[key]).toMatch(/own light is a state/i);
    expect(templates[key]).not.toMatch(/A change of light is not a state/);
    expect(templates[key]).not.toMatch(/lantern is lit/);
    expect(templates[key]).not.toMatch(/alters it — lit,/);
  });

  it('keeps the rest of the state test intact', () => {
    const t = templates['sceneExpansionAll'];
    expect(t).toMatch(/Held, set down, carried, pressed against something/);
    expect(t).toMatch(/when a face prop turns its other side to us/);
    expect(t).toMatch(/cannot be drawn without that element and drags it into the cell/);
    expect(t).toMatch(/a flower wilts, a bottle breaks, a canvas gets painted/);
  });

  it("sceneExpansionAll states schema: the object's own light may be a delta, the scene's light never", () => {
    expect(templates['sceneExpansionAll']).toMatch(/the object's own light belongs here when the story turns it on or off, how the scene lights it never does/);
  });

  it('carries the recognisability requirement into the artifact schema field', () => {
    const t = templates['sceneExpansionAll'];
    expect(t).toMatch(/"description": "\[what it is, named with the word that names it/);
    // The style-name ban predates this and stays (a prop once described as
    // "<style>-style" instead of described at all).
    expect(t).toMatch(/never by a style name/);
  });

  it('keeps the settled lettering gate intact', () => {
    // docs/SETTLED.md: no lettering unless the entry names the exact words.
    expect(templates['sceneExpansionAll']).toMatch(/No lettering unless this entry names the exact words/);
  });

  it('the wardrobe stage no longer authors the bible or the covers', () => {
    const t = templates['storyBibleFromBeats'];
    expect(t).toBeTruthy();
    expect(t).toContain('---CLOTHING REQUIREMENTS---');
    expect(t).not.toContain('---VISUAL BIBLE---');
    expect(t).not.toContain('---COVER SCENE HINTS---');
  });

  // Every emitter of a VB character entry has to carry the sex+age rule, or a
  // story routed down the other pipeline ships the same defect. The live
  // template emitters, plus the phantom-patch prompt built in JS.
  it.each(['storyTrial'])(
    '%s states sex and apparent age in the character scaffold',
    (key) => {
      expect(templates[key], `template ${key} not loaded`).toBeTruthy();
      expect(templates[key]).toMatch(/"age":\s*"\[sex and apparent age/);
    }
  );

  // The two unified writers carried these three rules and were the subjects
  // here until 2026-09-15, when both were deleted as unreachable.

  it('the phantom-patch prompt asks for sex, not a bare age category', () => {
    // server/lib/phantomCharacters.js mints CHR entries from a JS-built prompt,
    // outside prompts/ — the same rule has to reach it.
    const src = cjs('node:fs').readFileSync(
      cjs.resolve('../../server/lib/phantomCharacters.js'),
      'utf8'
    );
    expect(src).toMatch(/"age":\s*"<sex and apparent age/);
    expect(src).not.toMatch(/<age category/);
  });
});

describe('the authored `label` — one English name per element', () => {
  const cjs = createRequire(import.meta.url);
  const { parseVisualBible } = cjs('../../server/lib/visualBible.js');

  it('survives the parse whitelist on every pool', () => {
    const json = {
      secondaryCharacters: [{ id: 'CHR001', label: 'village baker', name: 'Aline', pages: [1] }],
      animals: [{ id: 'ANI001', label: 'grey farm cat', name: 'Mitzi', pages: [1] }],
      artifacts: [{ id: 'ART001', label: 'brass hand lantern', name: 'lantern', type: 'hand tool', pages: [1], description: 'small brass lantern' }],
      locations: [{ id: 'LOC001', label: 'hilltop meadow', name: 'Wiese', pages: [1] }],
      vehicles: [{ id: 'VEH001', label: 'red mail cart', name: 'cart', pages: [1], colorAndDetails: 'red', signatureElement: 'brass bell' }],
      clothing: [{ id: 'CLO001', label: 'blue wool cloak', name: 'cloak', pages: [1], wornBy: 'Aline', description: 'blue wool', howWorn: 'over the shoulders' }],
    };
    const outline = [
      'Visual Bible',
      '',
      '```json',
      JSON.stringify(json),
      '```',
      '',
    ].join('\n');
    const vb = parseVisualBible(outline);
    for (const pool of ['secondaryCharacters', 'animals', 'artifacts', 'locations', 'vehicles', 'clothing']) {
      expect(vb[pool], pool).toHaveLength(1);
      expect(vb[pool][0].label, pool).toBe(json[pool][0].label);
    }
  });

  it('is authored by both bible-emitting templates', async () => {
    await cjs('../../server/services/prompts.js').loadPromptTemplates();
    const templates = cjs('../../server/services/prompts.js').PROMPT_TEMPLATES;
    for (const key of ['storyTrial', 'sceneExpansionAll']) {
      expect(templates[key], key).toBeTruthy();
      // The schema slot, or (all-pages Art Director, 2026-09-23) one rule its
      // four schema slots point at.
      expect(templates[key], key).toMatch(/"label":\s*"\[the one English name every prompt uses|`label` is the one English name every prompt uses/);
    }
  });
});
