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

  it('requires sex and apparent age in a character entry', () => {
    const t = templates['storyBibleFromBeats'];
    expect(t).toBeTruthy();
    expect(t).toMatch(/sex and apparent age/i);
  });

  it('requires an earned appearsInPages range', () => {
    expect(templates['storyBibleFromBeats']).toMatch(/`pages` is earned/);
    expect(templates['storyBibleFromBeats']).toMatch(/never a blanket 1-\{PAGE_COUNT\} range/i);
  });

  it('requires an entry for every named vehicle or vessel', () => {
    expect(templates['storyBibleFromBeats']).toMatch(/vehicles\b/i);
    expect(templates['storyBibleFromBeats']).toMatch(/its own `?vehicles`? entry/i);
  });

  it('keeps the settled lettering gate intact', () => {
    // docs/SETTLED.md: no lettering unless the entry names the exact words.
    expect(templates['storyBibleFromBeats']).toMatch(/No lettering unless this entry names the exact words/);
  });

  // Every emitter of a VB character entry has to carry the sex+age rule, or a
  // story routed down the other pipeline ships the same defect. The four
  // template emitters, plus the phantom-patch prompt built in JS.
  it.each(['storyBibleFromBeats', 'storyUnified', 'storyUnifiedImageFirst', 'storyTrial'])(
    '%s states sex and apparent age in the character scaffold',
    (key) => {
      expect(templates[key], `template ${key} not loaded`).toBeTruthy();
      expect(templates[key]).toMatch(/"age":\s*"\[sex and apparent age/);
    }
  );

  it.each(['storyUnified', 'storyUnifiedImageFirst'])('%s carries all three authoring rules', (key) => {
    expect(templates[key]).toMatch(/sex and apparent age in its first sentence/);
    expect(templates[key]).toMatch(/its own `vehicles` entry/);
    expect(templates[key]).toMatch(/`pages` is earned/);
  });

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
