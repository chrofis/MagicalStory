import { describe, it, beforeAll, expect } from 'vitest';

const { buildAvailableLandmarksSection } = require('../../server/lib/promptBuilders');
const { premiseMentionsLandmark } = require('../../server/lib/landmarkPhotos');

/**
 * Measured on staging job_1789759147125_p08djwhbl: the arc-create prompt for a
 * story set in Zürich carried 15,538 chars of landmark listing — 41.5% of
 * everything the arc creator read — and its first two offered landmarks were
 * Avenches (VD, 130 km away) and the Staatsarchiv Basel-Stadt. Both were
 * PINNED, ahead of the city's own, because the premise wrote "über den Dächern
 * der Stadt" and the relaxed final-token rule accepts "Stadt" as a name's
 * distinctive token.
 */
describe('a premise mention is a distinctive name, not a settlement word', () => {
  const premise = 'Die Geschichte spielt im Herbst in Zürich, wo man die Türme des Grossmünsters über den Dächern der Stadt sehen kann.';

  it('does not pin a landmark whose only shared token is "Stadt"', () => {
    expect(premiseMentionsLandmark('Staatsarchiv Basel-Stadt', premise, new Set(['zurich']))).toBe(false);
    expect(premiseMentionsLandmark(
      'Aventicum, römische Stadt - Avenches, mittelalterlich-neuzeitliche Stadt', premise, new Set(['zurich']))).toBe(false);
  });

  it('still pins a landmark the premise actually names', () => {
    const named = 'Levin und Julian verbringen den Nachmittag auf dem Lindenhof.';
    expect(premiseMentionsLandmark('Lindenhof (Zürcher Hügelzug)', named, new Set(['zurich']))).toBe(true);
  });

  it('keeps the final-token relaxation for a real place name', () => {
    // The 2026-09-05 motivating case: "Uetliberg" must reach its summit tower.
    expect(premiseMentionsLandmark('Fernsehturm Uetliberg', 'Sie wandern auf den Uetliberg hinauf.', new Set(['zurich']))).toBe(true);
  });
});

describe('a landmark entry is one or two sentences, not an article', () => {
  const longExtract = 'The Zurich James Joyce Foundation cultivates the memory of the life and work of the Irish writer James Joyce. '
    + 'Created in 1985 on the basis of a private collection, it is an archive, documentation center, specialized library and literary museum. '
    + 'Thanks to its extensive collection of thematic materials it has established itself as one of the leading European centers for the study of the biography of the classic of modernist literature.';

  it('cuts the extract at a sentence end well short of the full article', () => {
    const s = buildAvailableLandmarksSection([{ name: 'Joyce Foundation', type: 'Museum', wikipediaExtract: longExtract }]);
    const line = s.split('\n').find((l: string) => l.includes('DESCRIPTION:')) as string;
    const description = line.replace(/^\s*DESCRIPTION:\s*/, '');
    expect(description.length).toBeLessThanOrEqual(260);
    expect(description.endsWith('.') || description.endsWith('…')).toBe(true);
    expect(description).not.toContain('modernist literature');
  });

  it('leaves a description that already fits untouched', () => {
    const short = 'A covered wooden bridge over the river.';
    const s = buildAvailableLandmarksSection([{ name: 'Old Bridge', type: 'Bridge', wikipediaExtract: short }]);
    expect(s).toContain(`DESCRIPTION: ${short}`);
  });
});

describe('a photo with no stored description is not offered as a photo', () => {
  it('drops the "reference photo" placeholder clause', () => {
    const s = buildAvailableLandmarksSection([{
      name: 'Guild House', type: 'Building',
      photoVariants: [
        { variantNumber: 1, kind: 'medium', description: null },
        { variantNumber: 2, kind: 'interior', description: 'Vaulted hall with painted beams' },
      ],
    }]);
    expect(s).not.toContain('reference photo');
    expect(s).toContain('(interior) Vaulted hall with painted beams');
  });
});

describe('the landmark rule is stated ONCE, and only its consumer hears the JSON contract', () => {
  const { buildArcCreatePrompt, buildSceneExpansionAllPrompt } = require('../../server/lib/promptBuilders');
  const { loadPromptTemplates } = require('../../server/services/prompts');
  beforeAll(async () => { await loadPromptTemplates(); });

  const landmarks = [{
    name: 'Lindenhof', type: 'Square', wikipediaExtract: 'The historic centre of the city.',
    photoVariants: [{ variantNumber: 1, kind: 'medium', description: 'Town square with mature trees' }],
  }];
  const input = () => ({
    pages: 18, characters: [{ name: 'Levin', age: 5 }],
    availableLandmarks: landmarks, storyDetails: 'Four boys find an egg.', language: 'de-CH',
  });

  it('the arc prompt states the landmark count once, and it is the two-to-four rule', () => {
    const arc = buildArcCreatePrompt(input(), 18, {});
    expect(arc).toContain('two to four is the target');
    // The contradicting telling rule, deleted 2026-09-19 (owner).
    expect(arc).not.toContain('at most on the opening page');
  });

  it('the arc prompt carries no JSON output contract — it writes numbered prose', () => {
    const arc = buildArcCreatePrompt(input(), 18, {});
    expect(arc).not.toMatch(/isRealLandmark|landmarkQuery/);
    expect(arc).not.toContain('Enchanted Castle');
  });

  it('the Art Director, which does emit those fields, still gets the contract', () => {
    const s = buildAvailableLandmarksSection(landmarks, '', { jsonFields: true });
    expect(s).toContain('"isRealLandmark": true');
    expect(s).toContain('landmarkQuery');
    expect(s).toContain('Enchanted Castle');
  });
});
