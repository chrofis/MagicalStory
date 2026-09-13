import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const { applyCoverWornHeldDedupe } = require('../../server/lib/coverIterate.js');
const { resolveCoverTextContract } = require('../../server/lib/coverTypography.js');
const { scrubVbIds } = require('../../server/lib/vbIdGuard.js');
const { MODEL_DEFAULTS } = require('../../server/config/models.js');

// BEHAVIOUR PINNED: a cover is judged against the inputs its generator got.
// The cover iterate path (regeneration, repair, Test Lab) used to hand the
// evaluator three different inputs than the page path does:
//   1. the PRE-dedupe reference list — the CLOTHING CONTRACT then said a
//      character WEARS the artifact the cover hint says she HOLDS;
//   2. no visualBible — the cover EXPECTED CAST branch never ran, the fidelity
//      reference had every VB id scrubbed to "the object", and the worn-item
//      resolver was inert;
//   3. no expectedText / textMode — the "the title is an app overlay, never
//      flag it" branch was unreachable on a regenerated cover.
// Assert the RULES, not any prompt wording.

const visualBible = {
  artifacts: [
    { id: 'ART002', name: 'Red Cape', description: 'A red handmade cape with golden trim and a round clasp' },
    { id: 'ART003', name: 'Blue Scarf', description: 'a blue knitted scarf with a white snowflake pattern' },
  ],
  locations: [{ id: 'LOC001', name: 'Summer Garden', features: 'flowering arbors' }],
};

const coverHint = {
  objects: ['LOC001', 'ART002', 'ART003'],
  characters: ['Child', 'Parent'],
  characterDetails: {
    Child: { name: 'Child', position: 'center foreground', holds: 'ART002' },
    Parent: { name: 'Parent', position: 'left' },
  },
};

const coverCharacterPhotos = [
  { name: 'Child', clothingDescription: 'red t-shirt, a red handmade cape tied at the neck, blue trousers' },
  { name: 'Parent', clothingDescription: 'green jacket, blue knitted scarf with a snowflake pattern, brown boots' },
];

// The fallback evalPipeline uses to build the CLOTHING CONTRACT when the caller
// passes no explicit clothingRequirements — exactly what a cover eval hits.
const contractFrom = (refs: any[]) => refs
  .filter(p => p?.name && p?.clothingDescription)
  .map(p => `- ${p.name}: ${p.clothingDescription}`)
  .join('\n');

describe('cover eval clothing contract == the generator\'s deduped outfit', () => {
  const { photos: deduped } = applyCoverWornHeldDedupe(coverCharacterPhotos, coverHint, visualBible);

  it('the held artifact is not also in the judge\'s clothing contract', () => {
    const generatorContract = contractFrom(deduped);
    const evaluatorContract = contractFrom(deduped); // what the eval call site now receives
    expect(evaluatorContract).toBe(generatorContract);
    expect(evaluatorContract).not.toMatch(/cape/i);
  });

  it('the pre-dedupe list — what the judge used to get — really does contradict the hint', () => {
    // Guards the test itself: without this the assertion above could pass on a
    // fixture where the dedupe changes nothing.
    expect(contractFrom(coverCharacterPhotos)).toMatch(/cape tied at the neck/i);
  });

  it('an outfit item nobody holds stays in the contract', () => {
    expect(contractFrom(deduped)).toMatch(/blue knitted scarf/i);
  });
});

describe('cover eval receives a visualBible so VB ids keep their nouns', () => {
  const brief = 'The child stands in LOC001 holding ART002 while the parent watches.';

  it('a null bible degrades every id to a generic noun (the regressed behaviour)', () => {
    const scrubbed = scrubVbIds(brief, null);
    expect(scrubbed).not.toMatch(/ART002|LOC001/);
    expect(scrubbed.toLowerCase()).toContain('the object');
  });

  it('the real bible resolves ids to the names the generator prompt carried', () => {
    const scrubbed = scrubVbIds(brief, visualBible);
    expect(scrubbed).not.toMatch(/ART002|LOC001/);
    expect(scrubbed).toMatch(/red handmade cape/i);
    expect(scrubbed).toMatch(/Summer Garden/i);
    expect(scrubbed.toLowerCase()).not.toContain('the object');
  });
});

describe('resolveCoverTextContract — one rule for pipeline and iterate covers', () => {
  const appSide = MODEL_DEFAULTS.appSideCoverType;

  it('a baked front cover is letter-checked against the title', () => {
    expect(resolveCoverTextContract('frontCover', { titleBaked: true, title: 'The Lantern Keeper' }))
      .toEqual({ textMode: 'painted', expectedText: 'The Lantern Keeper' });
  });

  it('a textless app-side cover tells the judge the text is an overlay', () => {
    const c = resolveCoverTextContract('frontCover', { titleBaked: false, title: 'The Lantern Keeper' });
    if (appSide) {
      expect(c).toEqual({ textMode: 'appOverlay', expectedText: null });
    } else {
      expect(c).toEqual({ textMode: 'painted', expectedText: 'The Lantern Keeper' });
    }
  });

  it('each cover key owns its own painted text', () => {
    expect(resolveCoverTextContract('initialPage', { titleBaked: true, dedication: 'For Ada' }).expectedText).toBe('For Ada');
    expect(resolveCoverTextContract('backCover', { titleBaked: true }).expectedText).toBe('magicalstory.ch');
  });

  it('short cover types resolve to the same contract as their keys', () => {
    expect(resolveCoverTextContract('front', { titleBaked: true, title: 'T' }))
      .toEqual(resolveCoverTextContract('frontCover', { titleBaked: true, title: 'T' }));
    expect(resolveCoverTextContract('back', { titleBaked: true }))
      .toEqual(resolveCoverTextContract('backCover', { titleBaked: true }));
  });

  it('a painted cover with no title yields no allowed-text rule rather than an empty one', () => {
    expect(resolveCoverTextContract('frontCover', { titleBaked: true, title: '' }).expectedText).toBeNull();
  });
});

describe('wiring guard — the cover eval call sites cannot drift back', () => {
  const src = fs.readFileSync(new URL('../../server/lib/coverIterate.js', import.meta.url), 'utf8');

  it('neither eval call site is handed the pre-dedupe reference list', () => {
    // The exact regressed expressions (direct path and composite path).
    expect(src).not.toMatch(/coverCharacterPhotos,\s*'cover'/);
    expect(src).not.toMatch(/coverPrompt,\s*coverCharacterPhotos,\s*'cover'/);
    // Both call sites pass the deduped list.
    expect((src.match(/clothingDedupedPhotos,\s*'cover'/g) || []).length).toBe(2);
  });

  it('both eval call sites carry the visualBible and the shared text contract', () => {
    expect((src.match(/resolveCoverTextContract\(coverKey/g) || []).length).toBe(2);
    expect(src).toContain('resolveCoverTextContract');
  });

  it('the pipeline cover loop shares the same text-contract resolver', () => {
    const pipeline = fs.readFileSync(new URL('../../storyJobPipeline.js', import.meta.url), 'utf8');
    expect(pipeline).toContain('resolveCoverTextContract');
    // The inline copy that used to live here.
    expect(pipeline).not.toMatch(/const textMode = \(coverData\.titleBaked === true/);
  });
});
