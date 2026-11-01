import { describe, it, expect, beforeAll } from 'vitest';

// Staging jobs job_1793520777470_7sgat9ene (back cover in nightwear), job_1793526073039_9nhq3ju59 (label day, prose pyjamas),
// job_1793531935175_rhdndngoq (Jules had only nightwear) and PRODUCTION job_1793542624900_w0aqtk6aj (Ludovica had only
// nightwear): the Art Director picked a cover outfit from a list that held only the story's page categories. Owner,
// 2026-11-01: code decides what every cover figure wears (the story's day outfit, `standard`); the Art Director describes it.
// docs/decisions.md "Cover outfit decided by code".
const cats = require('../../server/lib/clothingCategories.js');
const { buildCoverBeats, coverOutfits, coverOutfitFact, COVER_COSTUME_FACT } = require('../../server/lib/coverBeats.js');
const { coverFacts } = require('../../server/lib/jevBriefFields.js');
const JD = require('../../server/lib/jevDecisions.js');
const { standardAbsent } = require('../../server/lib/clothingCheck.js');
const { collectAvatarRequirements } = require('../../server/lib/styledAvatars.js');
const PB = require('../../server/lib/promptBuilders.js');
const { loadPromptTemplates } = require('../../server/services/prompts.js');
const fs = require('fs');
const path = require('path');

const cast = { characters: [{ name: 'Mia', isMainCharacter: true }, { name: 'Tom' }] };
const wardrobe = (extra: any = {}) => ({
  Mia: { standard: { used: true, description: 'a yellow raincoat over blue jeans and red boots.' }, nightwear: { used: true, description: 'red pyjamas' } },
  Tom: { standard: { used: true, description: 'a green jumper and grey trousers' }, ...extra },
});

describe('the decider: coverOutfits', () => {
  it('every figure without a costume wears `standard`; the text is its standard description', () => {
    const r = coverOutfits(['Mia', 'Tom'], wardrobe());
    expect(r.fixed).toEqual({ Mia: 'standard', Tom: 'standard' });
    expect(r.open).toEqual({});
    expect(r.outfits.Mia).toBe('a yellow raincoat over blue jeans and red boots');
  });
  it('a character whose pages use only nightwear still wears standard on the cover: nightwear is never offered', () => {
    const r = coverOutfits(['Mia'], { Mia: { standard: { used: false, description: 'a blue dress' }, nightwear: { used: true, description: 'pyjamas' } } });
    expect(r.fixed).toEqual({ Mia: 'standard' });
  });
  it('a figure the wardrobe also costumes chooses between standard and that costume, nothing else', () => {
    const r = coverOutfits(['Mia', 'Tom'], wardrobe({ costumed: { used: true, costume: 'Pirate' } }));
    expect(r.fixed).toEqual({ Mia: 'standard' });
    expect(r.open).toEqual({ Tom: ['standard', 'costumed:pirate'] });
  });
  it('throws, naming who, when a figure has no standard day outfit', () => {
    expect(() => coverOutfits(['Mia', 'Tom'], { Mia: { nightwear: { used: true, description: 'pyjamas' } }, Tom: { standard: { used: true, description: 'x' } } })).toThrow(/Mia has no standard day outfit/);
    expect(() => coverOutfits(['Mia'], null)).toThrow(/no standard day outfit/);
    expect(() => coverOutfits(['Mia'], { Mia: { standard: { used: true, description: 'NONE' } } })).toThrow(/no standard day outfit/);
  });
});

describe('the cover plan line says who wears what, and no longer polices the Art Director', () => {
  it('every cover plan line carries "<name> wears: <outfit>" for each decided figure', () => {
    const beats = buildCoverBeats(cast, { clothingRequirements: wardrobe() });
    expect(beats).toHaveLength(3);
    for (const b of beats) {
      expect(b.planLine).toContain('Mia wears: a yellow raincoat over blue jeans and red boots');
      expect(b.planLine).not.toContain('never `nightwear`');
    }
    // the front cover shows the main characters only; the other two show the whole cast
    expect(beats[0].planLine).not.toContain('Tom wears:');
    for (const b of beats.slice(1)) expect(b.planLine).toContain('Tom wears: a green jumper and grey trousers');
  });
  it('a costumed figure keeps COVER_COSTUME_FACT and is not named as wearing one fixed outfit', () => {
    const beats = buildCoverBeats(cast, { clothingRequirements: wardrobe({ costumed: { used: true, costume: 'pirate' } }) });
    for (const b of beats.slice(1)) {
      expect(b.planLine).toContain(COVER_COSTUME_FACT);
      expect(b.planLine).toContain('Mia wears:');
      expect(b.planLine).not.toContain('Tom wears:');
    }
    expect(beats[0].planLine).not.toContain(COVER_COSTUME_FACT); // Tom is not on the front cover
  });
  it('a story with a figure that has no standard outfit cannot build its cover beats', () => {
    expect(() => buildCoverBeats(cast, { clothingRequirements: { Mia: wardrobe().Mia } })).toThrow(/Tom has no standard day outfit/);
  });
  it('coverOutfitFact is null when nobody is fixed', () => {
    expect(coverOutfitFact({ fixed: {}, outfits: {} })).toBeNull();
  });
});

describe('the decision is a cover fixed field: FIXED block, pin, render guard', () => {
  const outfits = coverOutfits(['Mia', 'Tom'], wardrobe({ costumed: { used: true, costume: 'pirate' } }));
  const facts = coverFacts({ coverKey: 'backCover', storyBeats: [], outfits });
  const brief = (clothing: Record<string, string>) => `Mia and Tom stand under the stars.\n\n---METADATA---\n${JSON.stringify({
    characters: Object.entries(clothing).map(([name, c]) => ({ name, clothing: c, looksAt: 'viewer' })), shot: 'wide' }, null, 2)}`;
  const metaOf = (b: string) => JSON.parse(b.split('---METADATA---')[1]);

  it('coverFacts carries the fixed map and the open choices', () => {
    expect(facts.clothing).toEqual({ Mia: 'standard' });
    expect(facts.clothingOpen).toEqual({ Tom: ['standard', 'costumed:pirate'] });
    expect(coverFacts({ coverKey: 'backCover', storyBeats: [] }).clothing).toBeUndefined();
  });
  it('the FIXED block shows each decided figure, and stays silent on the outage backup', () => {
    const block = JD.fixedBlock({ jevFixed: { ...facts, coverPlace: true } });
    expect(block).toContain('- clothing: Mia → standard');
    expect(block).not.toContain('Tom →');
    expect(JD.fixedBlock({ jevFixed: { ...facts, coverPlace: true, quiet: true } })).toBe('');
  });
  it('pinBrief writes the decided category into the figure row, whatever the Art Director wrote', () => {
    const pinned = JD.pinBrief(brief({ Mia: 'nightwear', Tom: 'standard' }), { ...facts, coverPlace: true });
    const meta = metaOf(pinned.brief);
    expect(meta.characters.find((c: any) => c.name === 'Mia').clothing).toBe('standard');
    expect(meta.characters.find((c: any) => c.name === 'Tom').clothing).toBe('standard');
    expect(pinned.changes.filter((c: any) => c.field === 'clothing')).toEqual([{ field: 'clothing', name: 'Mia', from: 'nightwear', to: 'standard' }]);
  });
  it('an open figure the Art Director left in the costume is not touched; a pin that changes nothing reports nothing', () => {
    const pinned = JD.pinBrief(brief({ Mia: 'standard', Tom: 'costumed:pirate' }), { ...facts, coverPlace: true });
    expect(pinned.changes.filter((c: any) => c.field === 'clothing')).toEqual([]);
  });
  it('the render guard holds the brief to the decision, and refuses a cover with none', () => {
    expect(() => cats.assertCoverClothingIsDecided({ Mia: 'standard', Tom: 'costumed:pirate' }, facts, 'page -3')).not.toThrow();
    expect(() => cats.assertCoverClothingIsDecided({ Mia: 'nightwear' }, facts, 'page -3')).toThrow(/code decided standard/);
    expect(() => cats.assertCoverClothingIsDecided({ Tom: 'nightwear' }, facts, 'page -3')).toThrow(/standard or costumed:pirate/);
    expect(() => cats.assertCoverClothingIsDecided({ Mia: 'standard' }, null, 'page -3')).toThrow(/no outfit was decided/);
  });
  it('the decision is wired: pipeline stores it in jevFixed, the first render checks it, iterate re-pins from it', () => {
    const src = fs.readFileSync(path.join(__dirname, '../../storyJobPipeline.js'), 'utf8');
    expect(src).toMatch(/assertCoverClothingIsDecided\(perCharClothing, scene\.jevFixed,/);
    const bp = fs.readFileSync(path.join(__dirname, '../../server/lib/beatsPipeline.js'), 'utf8');
    expect(bp).toMatch(/coverOutfits\(coverCasts\(inputData\)\[cb\.coverKey\], clothingRequirements\)/);
    expect(bp).toMatch(/\.\.\.\(cb\.jevFixed \? \{ jevFixed: cb\.jevFixed \} : \{\}\)/);
    const im = fs.readFileSync(path.join(__dirname, '../../server/lib/images.js'), 'utf8');
    expect(im).toMatch(/pinBrief\(newSceneDescription, freeIterate \? \{ \.\.\.jevFixedOfPage, shot: undefined \} : jevFixedOfPage\)/);
  });
});

describe('the standard sheet exists for every cover figure', () => {
  const chars = [{ name: 'Mia' }, { name: 'Tom' }];
  const reqs = (r: any) => collectAvatarRequirements([{ pageNumber: 1, description: 'Mia in bed' }], chars, {}, 'standard', r)
    .filter((x: any) => x.pageNumber === 'cover').map((x: any) => `${x.characterNames[0]}:${x.clothingCategory}`);
  it('a character whose pages use only nightwear still gets a cover standard sheet requirement', () => {
    const r = reqs({ Mia: { standard: { used: false, description: 'a blue dress' }, nightwear: { used: true, description: 'pyjamas' } }, Tom: { standard: { used: true, description: 'x' } } });
    expect(r).toContain('Mia:nightwear');
    expect(r).toContain('Mia:standard');
    expect(r).toContain('Tom:standard');
  });
  it('a wardrobe with no standard outfit text adds no standard sheet (a trial costumed-only wardrobe costs nothing extra)', () => {
    expect(reqs({ Mia: { costumed: { used: true, costume: 'pirate' }, standard: { used: false } }, Tom: { standard: { used: true, description: 'x' } } })).not.toContain('Mia:standard');
  });
  it('standardAbsent names the characters the wardrobe gave no day outfit', () => {
    expect(standardAbsent({ Mia: { nightwear: { used: true, description: 'p' } }, Tom: { standard: { used: true, description: 'x' } } }, ['Mia', 'Tom'])).toEqual(['Mia']);
    expect(standardAbsent(null, ['Mia'])).toEqual(['Mia']);
  });
});

describe('the wardrobe step always writes a day outfit: generator and critic read one rule', () => {
  beforeAll(async () => { await loadPromptTemplates(); });
  const input: any = { characters: [{ id: 'a', name: 'Ana', age: 5, gender: 'female' }], mainCharacters: ['a'], language: 'en', pages: 2, storyCategory: 'adventure', storyTheme: 'bedtime', storyDetails: 'A girl goes to bed.', artStyle: 'watercolor' };
  const beats = [{ pageNumber: 1, planLine: 'wide — Ana — Ana brushes her teeth — x' }, { pageNumber: 2, planLine: 'medium — Ana — Ana falls asleep — x' }];
  it('DAY_OUTFIT_DEF reaches the bible writer and the wardrobe reviewer verbatim', () => {
    const bible = PB.buildStoryBibleFromBeatsPrompt(input, beats, '1. A girl goes to bed.');
    const review = PB.buildClothingReviewPrompt(input, { Ana: { nightwear: { used: true, description: 'a pyjama top and bottoms' } } }, beats);
    expect(PB.WARDROBE_RULES.DAY_OUTFIT_DEF).toMatch(/never a pyjama top or bottoms/);
    expect(bible).toContain(PB.WARDROBE_RULES.DAY_OUTFIT_DEF);
    expect(review).toContain(PB.WARDROBE_RULES.DAY_OUTFIT_DEF);
  });
  it('the reviewer may ADD a standard outfit; a plain rewrite of any other unused category stays stray', () => {
    const reqs: any = { Ana: { nightwear: { used: true, description: 'p' } } };
    const added = PB.acceptAddedWardrobeCategory(reqs, 'Ana', { category: 'standard' }, undefined);
    expect(added.used).toBe(true);
    expect(reqs.Ana.standard.used).toBe(true);
    expect(PB.acceptAddedWardrobeCategory({ Ana: {} }, 'Ana', { category: 'costumed' }, undefined)).toBeUndefined();
  });
  it('the review parser reads a `/ standard` heading', () => {
    const r = PB.parseClothingReview('---ANALYSIS---\nx\n---CLOTHING---\n## Ana / standard\nA red jacket, blue trousers, brown boots.\nGARMENTS: [{"slot":"top","name":"jacket","colour":"red"}]');
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0]).toMatchObject({ name: 'Ana', category: 'standard' });
  });
});

describe('the guards that policed the Art Director are gone', () => {
  const read = (p: string) => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
  it('no cover nightwear brief check, no day-outfit plan sentence, no C3 cover sentence', () => {
    expect(cats.COVER_DAY_OUTFIT_FACT).toBeUndefined();
    expect(cats.coverNightwearFindings).toBeUndefined();
    expect(cats.assertCoverClothingIsDay).toBeUndefined();
    expect(read('server/lib/briefChecks.js')).not.toMatch(/cover_nightwear|coverNightwearFindings/);
    for (const t of ['scene-briefs-all.txt', 'scene-expansion.txt']) expect(read(`prompts/${t}`)).not.toMatch(/cover is never `nightwear`/);
  });
});

describe('a failed run keeps the Art Director briefs', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../storyJobPipeline.js'), 'utf8');
  it('checkpointed with covers and their decided places, and read back by the partial save', () => {
    expect(src).toMatch(/saveCheckpoint\(jobId, 'art_director_briefs', \{[\s\S]{0,400}\.\.\.coverScenes\][\s\S]{0,300}jevFixed/);
    expect(src).toMatch(/cp\.step_name === 'art_director_briefs'/);
    expect(src).toMatch(/\r?\n\s+artDirectorBriefs,\r?\n/);
  });
});
