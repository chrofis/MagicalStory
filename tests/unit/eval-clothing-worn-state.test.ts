import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  resolveGeneratedOutfit, stripOffItemsFromOutfit, resolveWornItemsForPage,
} = require('../../server/lib/wornItems.js');

// BEHAVIOUR PINNED: every eval-side clothing contract describes THE OUTFIT THE
// GENERATOR WAS GIVEN for that page. When the Art Director declares a worn item
// OFF (`wornItems[]`), buildImagePrompt strips that clause out of the outfit it
// sends to the image model (promptBuilders.js, `effectiveReferencePhotos`) and
// tells the model to leave it off. Nothing persisted that stripped copy, so the
// judges kept receiving the story-level outfit.
//
// Measured on staging job_1789207854566_l43qgl34w p12 (ART008 Sarah `off`
// "lost in the dark shaft", ART009 Facundo `off`): two MAJOR findings —
// "missing red sash / add red sash at waist" and the orange-sash equivalent —
// survived the consolidator and rode into imageVersions[1] = iterate-round-1,
// a PAID repair round ordering the pipeline to repaint both sashes. p10 same.
//
// Assert the RULE (the judge is never told to demand an off garment), never
// prompt wording.

const BIBLE = {
  artifacts: [
    { id: 'ART008', name: "Sarah's red fabric sash", wornAs: 'Sarah.belt/waist' },
    { id: 'ART009', name: "Facundo's orange sash", wornAs: 'Facundo.belt/waist' },
  ],
};

// The story-level outfit, exactly the shape referencePhotos[].clothingDescription
// carries on the measured page.
const SARAH_OUTFIT = 'Red wide-brimmed tricorn hat with the brim pinned up on one side, loose red linen blouse with a wide collar, black wide-leg sailor trousers cropped just below the knee, black buckled ankle boots, red fabric sash tied at the waist, small yellow stud earrings.';

const pageMeta = (state: string) => ({
  characters: ['Sarah', 'Facundo'],
  wornItems: [
    { id: 'ART008', owner: 'Sarah', state, location: state === 'off' ? 'lost in the dark shaft' : '' },
    { id: 'ART009', owner: 'Facundo', state, location: state === 'off' ? 'lost in the dark shaft' : '' },
  ],
});

describe('resolveGeneratedOutfit — the judge is handed the generator\'s outfit', () => {
  it('a garment declared OFF on the page is not demanded by the eval contract', () => {
    const contract = resolveGeneratedOutfit(SARAH_OUTFIT, 'Sarah', {
      visualBible: BIBLE, sceneMetadata: pageMeta('off'),
    });
    expect(contract).not.toMatch(/sash/i);
    // and nothing else was lost
    expect(contract).toMatch(/tricorn hat/);
    expect(contract).toMatch(/buckled ankle boots/);
    expect(contract).toMatch(/stud earrings/);
  });

  it('the eval contract equals the outfit the generator built for that page', () => {
    const meta = pageMeta('off');
    // What buildImagePrompt does to referencePhotos[].clothingDescription.
    const wornResolved = resolveWornItemsForPage(BIBLE, meta.characters, meta);
    const generatorOutfit = stripOffItemsFromOutfit(SARAH_OUTFIT, wornResolved, 'Sarah').text;
    const evalContract = resolveGeneratedOutfit(SARAH_OUTFIT, 'Sarah', {
      visualBible: BIBLE, sceneMetadata: meta,
    });
    expect(evalContract).toBe(generatorOutfit);
  });

  it('a garment declared WORN is still demanded — this never silences a real miss', () => {
    expect(resolveGeneratedOutfit(SARAH_OUTFIT, 'Sarah', {
      visualBible: BIBLE, sceneMetadata: pageMeta('worn'),
    })).toBe(SARAH_OUTFIT);
  });

  it('another character owns the off item — this outfit keeps its sash', () => {
    // Saira owns no wornAs item; Sarah's and Facundo's off sashes are not hers
    // to lose, so an identically-shaped outfit of hers is untouched.
    expect(resolveGeneratedOutfit(SARAH_OUTFIT, 'Saira', {
      visualBible: BIBLE, sceneMetadata: pageMeta('off'),
    })).toBe(SARAH_OUTFIT);
  });

  it('a multi-page grid contract drops an item off on ANY of its pages', () => {
    const contract = resolveGeneratedOutfit(SARAH_OUTFIT, 'Sarah', {
      visualBible: BIBLE,
      sceneMetadatas: [pageMeta('worn'), pageMeta('off'), pageMeta('worn')],
    });
    expect(contract).not.toMatch(/sash/i);
  });

  it('missing bible or metadata leaves the outfit untouched', () => {
    expect(resolveGeneratedOutfit(SARAH_OUTFIT, 'Sarah', { visualBible: null, sceneMetadata: pageMeta('off') })).toBe(SARAH_OUTFIT);
    expect(resolveGeneratedOutfit(SARAH_OUTFIT, 'Sarah', { visualBible: BIBLE })).toBe(SARAH_OUTFIT);
    expect(resolveGeneratedOutfit('', 'Sarah', { visualBible: BIBLE, sceneMetadata: pageMeta('off') })).toBe('');
  });
});

describe('every eval-side clothing contract goes through the one resolver', () => {
  const fs = require('node:fs');
  // Wiring guard: the three judges' shared CLOTHING CONTRACT block and the
  // entity grid's expectedClothing are the two places an outfit reaches a
  // judge. A third must not be built inline.
  for (const f of ['../../server/lib/evalPipeline.js', '../../server/lib/entityConsistency.js']) {
    it(`${f.split('/').pop()} resolves the outfit through resolveGeneratedOutfit`, () => {
      const src = fs.readFileSync(new URL(f, import.meta.url), 'utf8');
      expect(src).toContain('resolveGeneratedOutfit');
    });
  }
});
