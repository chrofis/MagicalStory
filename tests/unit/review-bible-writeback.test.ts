/**
 * The scene review's Visual Bible corrections reach the TRANSCRIPT.
 *
 * The live run hands storyJobPipeline the in-memory bible, but the resume
 * path, the Lab and every later extractVisualBible() re-parse the transcript.
 * syncVisualBibleSection projected pages, states (only when the authored entry
 * already had states[]), labels and the age clamp — never `landmarkPhoto` or
 * `text`, and never looks added to a stateless entry. Evidence: staging
 * job_1790446348343_z3fw660ie (ART003 coat-rope states lost from data.outline)
 * and Lab 1574 (LOC004.2 / LOC005.1 photo → "none" lost). The write-back is now
 * verified by re-parsing, and a correction the re-parse does not carry is an
 * error.
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';
const nodeRequire = createRequire(import.meta.url);

const {
  applyReviewBibleCorrections, syncVisualBibleSection, bibleCorrectionsMissingFromTranscript,
} = nodeRequire('../../server/lib/beatsPipeline.js');
const { UnifiedStoryParser } = nodeRequire('../../server/lib/outlineParser/unified.js');

const photo = (n: number) => ({ variantNumber: n, kind: 'exterior', framing: 'wide', photoScore: 70, url: `https://x/${n}.jpg` });

// As the Art Director authors it: string citations, a stateless artifact.
const authored = {
  secondaryCharacters: [],
  artifacts: [
    { id: 'ART001', name: 'wool rope', label: 'rope', pages: [11, 12], description: 'a rope' },
    { id: 'ART002', name: 'sign', label: 'sign', pages: [2], description: 'a wooden sign', text: 'OPEN' },
  ],
  locations: [
    {
      id: 'LOC001', name: 'Old Bridge', isRealLandmark: true, pages: [1, 2, 3],
      vantages: [
        { id: 'LOC001.1', name: 'wide', pages: [1], landmarkPhoto: '3' },
        { id: 'LOC001.2', name: 'deck', pages: [2, 3], landmarkPhoto: '1' },
      ],
    },
  ],
};
const transcript = () => `---CLOTHING REQUIREMENTS---\n{}\n\n---VISUAL BIBLE---\n\`\`\`json\n${JSON.stringify(authored, null, 2)}\n\`\`\`\n\n`;
const review = (json: any) => `analysis\n---VISUAL BIBLE---\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\``;

function adopt() {
  const text = transcript();
  const vb = new UnifiedStoryParser(text).extractVisualBible();
  // linkPreDiscoveredLandmarks puts the photo variants on the in-memory copy only.
  vb.locations[0].photoVariants = [photo(1), photo(2), photo(3)];
  return { text, vb };
}
const reparse = (text: string) => new UnifiedStoryParser(text).extractVisualBible();

describe('scene review bible corrections are written back into the transcript', () => {
  it('a vantage landmarkPhoto correction lands (Lab 1574 shape)', () => {
    const { text, vb } = adopt();
    const corr = applyReviewBibleCorrections(review({ locations: [{ id: 'LOC001', vantages: [{ id: 'LOC001.1', landmarkPhoto: 'none' }] }] }), vb, 17);
    expect(corr.applied).toHaveLength(1);
    const synced = syncVisualBibleSection(text, vb);
    expect(bibleCorrectionsMissingFromTranscript(synced, vb, corr.applied)).toEqual([]);
    expect(reparse(synced).locations[0].vantages[0].landmarkPhoto).toBe('none');
  });

  it('a location-level landmarkPhoto correction lands', () => {
    const text = transcript().replace(/"vantages": \[[\s\S]*?\]\n    \}/, '"landmarkPhoto": 2\n    }');
    const vb = reparse(text);
    vb.locations[0].photoVariants = [photo(1), photo(2), photo(3)];
    const corr = applyReviewBibleCorrections(review({ locations: [{ id: 'LOC001', landmarkPhoto: 3 }] }), vb, 17);
    expect(corr.applied).toHaveLength(1);
    const synced = syncVisualBibleSection(text, vb);
    expect(bibleCorrectionsMissingFromTranscript(synced, vb, corr.applied)).toEqual([]);
    expect(reparse(synced).locations[0].landmarkPhoto).toBe(3);
  });

  it('states given to an entry authored WITHOUT states land (z3fw660ie ART003 shape)', () => {
    const { text, vb } = adopt();
    const corr = applyReviewBibleCorrections(review({ artifacts: [{ id: 'ART001', states: [{ name: 'coat-rope', delta: 'knotted from a coat', pages: [11, 12] }] }] }), vb, 17);
    expect(corr.applied).toHaveLength(1);
    const synced = syncVisualBibleSection(text, vb);
    expect(bibleCorrectionsMissingFromTranscript(synced, vb, corr.applied)).toEqual([]);
    expect(reparse(synced).artifacts[0].states.map((s: any) => [s.name, s.pages])).toEqual([['coat-rope', [11, 12]]]);
  });

  it('a text correction and a text withdrawal land', () => {
    const { text, vb } = adopt();
    const set = applyReviewBibleCorrections(review({ artifacts: [{ id: 'ART002', text: 'CLOSED' }] }), vb, 17);
    let synced = syncVisualBibleSection(text, vb);
    expect(bibleCorrectionsMissingFromTranscript(synced, vb, set.applied)).toEqual([]);
    expect(reparse(synced).artifacts[1].text).toBe('CLOSED');
    const drop = applyReviewBibleCorrections(review({ artifacts: [{ id: 'ART002', text: null }] }), vb, 17);
    synced = syncVisualBibleSection(synced, vb);
    expect(bibleCorrectionsMissingFromTranscript(synced, vb, drop.applied)).toEqual([]);
    expect(reparse(synced).artifacts[1].text).toBeUndefined();
  });

  it('a transcript that lacks the correction is reported, field by field', () => {
    const { text, vb } = adopt();
    const corr = applyReviewBibleCorrections(review({
      locations: [{ id: 'LOC001', vantages: [{ id: 'LOC001.1', landmarkPhoto: 'none' }] }],
      artifacts: [{ id: 'ART001', states: [{ name: 'coat-rope', delta: 'knotted', pages: [11] }] }],
    }), vb, 17);
    const missing = bibleCorrectionsMissingFromTranscript(text, vb, corr.applied);
    expect(missing.map((m: any) => `${m.id}:${m.field}`).sort()).toEqual(['ART001:states', 'LOC001.1:landmarkPhoto']);
    expect(missing.find((m: any) => m.field === 'landmarkPhoto')).toMatchObject({ expected: 'none', found: 3 });
  });

  it('re-citing the same photo as a number is not a correction ("1" vs 1)', () => {
    const { vb } = adopt();
    const corr = applyReviewBibleCorrections(review({ locations: [{ id: 'LOC001', vantages: [{ id: 'LOC001.2', landmarkPhoto: 1 }] }] }), vb, 17);
    expect(corr.applied).toEqual([]);
    expect(corr.rejected).toEqual([]);
  });
});

// Staging job_1790508305061_dka3jpog9: the bible's own state tables carry the
// cover pages (ANI001.1 = [-1, 5, 9, …]) and the review's correction for ANI001
// copied that -1 back — rejected whole as "pages outside the book", so page 15
// kept a "missing scale" state with no pages. A cover page is a page of the book.
describe('a bible correction that carries a cover page', () => {
  const dragon = {
    secondaryCharacters: [],
    animals: [{
      id: 'ANI001', name: 'Sura', pages: [5, 9, 12, 13, 14, 16, 17, -1], description: 'a grown grey dragon',
      states: [
        { name: 'unaltered', delta: 'a plain grey scaled chest', pages: [5, 9, 12, 13, 14, -1] },
        { name: 'missing scale', delta: 'a dark round gap in the chest', pages: [] },
        { name: 'scale restored', delta: 'the chest glows warmly', pages: [16, 17] },
      ],
    }],
  };
  const text = `---VISUAL BIBLE---\n\`\`\`json\n${JSON.stringify(dragon, null, 2)}\n\`\`\`\n\n`;
  const correction = { animals: [{ id: 'ANI001', states: [
    { name: 'unaltered', delta: 'a plain grey scaled chest', pages: [-1, 5, 9, 12, 13, 14] },
    { name: 'missing scale', delta: 'a dark round gap in the chest', pages: [15] },
    { name: 'scale restored', delta: 'the chest glows warmly', pages: [16, 17] },
  ] }] };

  it('is applied, reaches the transcript, and the page resolves to the corrected state', () => {
    const vb = reparse(text);
    const corr = applyReviewBibleCorrections(review(correction), vb, 18, new Set(['ANI001.1', 'ANI001.3']));
    expect(corr.rejected).toEqual([]);
    expect(corr.applied.map((a: any) => a.id)).toEqual(['ANI001']);
    const synced = syncVisualBibleSection(text, vb);
    expect(bibleCorrectionsMissingFromTranscript(synced, vb, corr.applied)).toEqual([]);
    const back = reparse(synced).animals[0];
    expect(back.states.map((s: any) => [s.id, s.pages])).toEqual([
      ['ANI001.1', [-1, 5, 9, 12, 13, 14]], ['ANI001.2', [15]], ['ANI001.3', [16, 17]],
    ]);
    const { objectStateForPage } = nodeRequire('../../server/lib/visualBible.js');
    expect(objectStateForPage(back, 15).id).toBe('ANI001.2');
  });

  it('still rejects a page that is neither in the book nor a cover', () => {
    for (const bad of [0, 19, -4]) {
      const vb = reparse(text);
      const wrong = JSON.parse(JSON.stringify(correction));
      wrong.animals[0].states[1].pages = [15, bad];
      const corr = applyReviewBibleCorrections(review(wrong), vb, 18);
      expect(corr.applied).toEqual([]);
      expect(corr.rejected).toEqual([{ id: 'ANI001', reason: 'state "missing scale" has pages outside the book' }]);
    }
  });
});
