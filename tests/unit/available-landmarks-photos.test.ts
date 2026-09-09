import { describe, it, expect } from 'vitest';

const { buildAvailableLandmarksSection } = require('../../server/lib/promptBuilders');

/**
 * The writer authored a "distant aerial view" of a landmark whose only
 * exterior photo is a street-level façade, because it was shown the Wikipedia
 * extract and nothing about the photos. The section now lists each landmark's
 * photos and binds the writer to a viewpoint one of them shows.
 */
describe('REAL LANDMARKS section shows the photos', () => {
  const landmarks = [
    {
      name: 'Central Station', type: 'Station', wikipediaExtract: 'The largest railway station in the country.',
      photoVariants: [
        { variantNumber: 1, kind: 'exterior', description: '[whole, green, day] Railway station viewed from waterfront, grey stone with arched windows' },
        { variantNumber: 2, kind: 'interior', description: '[interior, unclear, day] Main hall interior crowded with passengers' },
      ],
    },
    { name: 'Old Bridge', type: 'Bridge', wikipediaExtract: 'A covered wooden bridge.' },
  ];

  it('lists one clause per photo with its kind, without the indexer tag', () => {
    const s = buildAvailableLandmarksSection(landmarks);
    expect(s).toContain('- Central Station [Station]');
    expect(s).toContain('PHOTOS: (exterior) Railway station viewed from waterfront');
    expect(s).toContain('; (interior) Main hall interior crowded with passengers');
    expect(s).not.toContain('[whole, green, day]');
  });

  it('prints no PHOTOS line for a landmark with no variants, and keeps the extract', () => {
    const s = buildAvailableLandmarksSection(landmarks);
    const bridge = s.slice(s.indexOf('- Old Bridge'));
    expect(bridge.split('\n')[1]).toContain('DESCRIPTION: A covered wooden bridge.');
    expect(bridge.split('\n')[2] || '').not.toContain('PHOTOS:');
  });

  it('binds the writer to a photographed viewpoint only when photos exist', () => {
    expect(buildAvailableLandmarksSection(landmarks)).toContain('Name a location or a vantage of it only from a viewpoint one of its photos shows');
    expect(buildAvailableLandmarksSection([landmarks[1]])).not.toContain('one of its photos shows');
  });

  it('returns nothing for no landmarks', () => {
    expect(buildAvailableLandmarksSection([])).toBe('');
  });
});
