import { describe, it, expect } from 'vitest';

// premiseMentionsLandmark is the lexical rule behind the premise pin in
// resolveAvailableLandmarks ({ premiseText }): a landmark_index row whose
// name the family's story idea mentions is served FIRST. The SQL only
// prefilters (any premise word occurring in the name); this pure helper is
// the actual decision, so it is tested here without a database.

// @ts-expect-error - JS module without types
import { premiseMentionsLandmark } from '../../server/lib/landmarkPhotos.js';

describe('premiseMentionsLandmark', () => {
  it('matches a name across language and type word', () => {
    expect(premiseMentionsLandmark('Festung Aarburg', "Une visite au château d'Aarburg")).toBe(true);
    expect(premiseMentionsLandmark('Festung Aarburg', 'Wir gehen nach Aarburg')).toBe(true);
    expect(premiseMentionsLandmark('Château de Chillon', 'A day at Schloss Chillon')).toBe(true);
  });

  it('does not match a name that is only a fragment of a premise word', () => {
    expect(premiseMentionsLandmark('Aare', 'Ein Ausflug nach Aarburg')).toBe(false);
  });

  it('is accent- and case-insensitive on both sides', () => {
    expect(premiseMentionsLandmark('Zürich Hauptbahnhof', 'we arrive at ZURICH hauptbahnhof')).toBe(true);
    expect(premiseMentionsLandmark('Chateau de Gruyeres', 'un jour au Château de Gruyères')).toBe(true);
  });

  it('strips a trailing (Town) disambiguator', () => {
    expect(premiseMentionsLandmark('Schloss Lenzburg (Lenzburg)', 'Abenteuer auf der Lenzburg')).toBe(true);
  });

  it('requires EVERY distinctive token, not just one', () => {
    expect(premiseMentionsLandmark('Burg Hohen Rätien', 'a walk near Hohen')).toBe(false);
    expect(premiseMentionsLandmark('Burg Hohen Rätien', 'a walk on Hohen Raetien... no')).toBe(false);
    expect(premiseMentionsLandmark('Burg Hohen Rätien', 'a walk on Hohen Rätien')).toBe(true);
  });

  it('refuses names whose distinctive part is too short to be safe', () => {
    // "See" is generic and "Zug" is 3 chars — a match on that alone is noise.
    expect(premiseMentionsLandmark('Zugersee', 'ein Tag am See in Zug')).toBe(false);
    expect(premiseMentionsLandmark('Zug See', 'ein Tag am See in Zug')).toBe(false);
    expect(premiseMentionsLandmark('Schloss', 'ein Schloss')).toBe(false);
  });

  it('is false on an empty premise', () => {
    expect(premiseMentionsLandmark('Festung Aarburg', '')).toBe(false);
    expect(premiseMentionsLandmark('Festung Aarburg', undefined)).toBe(false);
  });
});
