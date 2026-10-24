/**
 * NIGHTWEAR, the third outfit category, and the bath-time topic retired (owner decisions 2026-10-24,
 * docs/decisions.md "Nightwear is the third outfit category" and "bath-time retired").
 * Trigger: prod showcase job_1792859316244_6429d0n83 drew the bed and bath pages in the day outfit.
 * Pins behaviour, never prompt wording beyond the rule-reach assertions.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const req = createRequire(import.meta.url);
const ROOT = path.join(__dirname, '../..');
const cats: any = req('../../server/lib/clothingCategories.js');
const sa: any = req('../../server/lib/styledAvatars.js');
const storyAvatars: any = req('../../server/lib/storyAvatars.js');
const PB: any = req('../../server/lib/promptBuilders.js');
const CC: any = req('../../server/lib/clothingCheck.js');
const guards: any = req('../../server/lib/requestGuards.js');
const trialCostumes: any = req('../../server/config/trialCostumes.js');
const { extractSceneMetadata } = req('../../server/lib/sceneMetadata.js');
const { loadPromptTemplates, PROMPT_TEMPLATES } = req('../../server/services/prompts.js');
const { UnifiedStoryParser } = req('../../server/lib/outlineParser');

const IMG = 'data:image/jpeg;base64,/9j/AAAA';
const readPrompt = (f: string) => fs.readFileSync(path.join(ROOT, 'prompts', f), 'utf8');

beforeAll(async () => { await loadPromptTemplates(); });

describe('the category vocabulary', () => {
  it('nightwear is a canonical category; only the exact token maps to it', () => {
    expect([...cats.CANONICAL]).toEqual(['standard', 'costumed', 'nightwear']);
    expect(cats.normalizeClothingCategory('nightwear')).toBe('nightwear');
    expect(cats.normalizeClothingCategory('  Nightwear ')).toBe('nightwear');
    expect(cats.normalizeClothingCategory('[CLO001] nightwear')).toBe('nightwear');
    for (const prose of ['pyjamas', 'nightwear pyjamas', 'a nightwear set', 'Schlafanzug']) {
      expect(cats.normalizeClothingCategory(prose)).toBe('standard');
    }
  });

  it('is not a base avatar slot, and is a no-stand-in category beside the costume', () => {
    expect([...cats.AVATAR_SLOTS]).toEqual(['standard']);
    expect([...cats.NO_STAND_IN_CATEGORIES]).toEqual(['costumed', 'nightwear']);
    expect([...cats.PLAIN_SHEET_CATEGORIES]).toEqual(['standard', 'nightwear']);
    expect([...cats.DAY_CATEGORIES]).toEqual(['standard', 'costumed']);
  });
});

describe('every parser of a category keeps nightwear', () => {
  const brief = (clothing: string) => `Mia sits up in bed.\n\n---METADATA---\n${JSON.stringify({
    sceneIntent: 'Mia sits up.', shot: 'medium', timeOfDay: 'night',
    characters: [{ name: 'Mia', clothing, position: 'center', depth: 'foreground' }],
  })}`;

  it('the prose + metadata format', () => {
    expect(extractSceneMetadata(brief('nightwear'))?.characterClothing?.Mia).toBe('nightwear');
    expect(extractSceneMetadata(brief('standard'))?.characterClothing?.Mia).toBe('standard');
  });

  it('the bare-JSON format', () => {
    const json = JSON.stringify({ scene: { imageSummary: 'Mia in bed.', characters: [{ name: 'Mia', clothing: 'nightwear', position: 'center', depth: 'foreground' }] } });
    expect(extractSceneMetadata(json)?.characterClothing?.Mia).toBe('nightwear');
  });

  it('the trial page parser (JSON scene hint)', () => {
    const hint = JSON.stringify({ scene: { imageSummary: 'Mia in bed.', characters: [{ name: 'Mia', clothing: 'nightwear', position: 'center', depth: 'foreground' }] } });
    const transcript = `---STORY PAGES---\n\n--- Page 1 ---\nTEXT:\nMia goes to bed.\n\nSCENE HINT:\n\`\`\`json\n${hint}\n\`\`\`\n`;
    const pages = new UnifiedStoryParser(transcript, { isTrial: true }).extractPages();
    expect(pages[0].characterClothing.Mia).toBe('nightwear');
  });

  it('the Characters block of a page or cover brief', () => {
    const shared = req('../../server/lib/outlineParser/shared.js');
    const r = shared.parseCharacterClothingBlock('Characters:\n- Mia (left): nightwear, depth: background\n- Ann: standard');
    expect(r.characterClothing.Mia).toBe('nightwear');
    expect(r.characterClothing.Ann).toBe('standard');
    expect(shared.extractCharacterNamesFromScene('Characters:\n- Mia (left): nightwear\n- Tom: costumed\n')).toEqual(['mia', 'tom']);
  });

  it('the Clothing line of a scene description', () => {
    const resolve: any = req('../../server/lib/clothingResolve.js');
    expect(resolve.parseClothingCategory('**Clothing:** nightwear')).toBe('nightwear');
    expect(resolve.parseClothingCategory('Clothing: standard')).toBe('standard');
  });

  it('the wardrobe review: heading, merge, and the prompt-side regex', () => {
    const parsed = PB.parseClothingReview('---ANALYSIS---\nx\n---CLOTHING---\n## Mia / nightwear\nA long-sleeve blue pyjama top and long blue pyjama bottoms.\nGARMENTS: [{"slot":"top","name":"pyjama top","colour":"blue"},{"slot":"bottom","name":"pyjama bottoms","colour":"blue"}]\n');
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0].category).toBe('nightwear');
    // check 9 may ADD the category the bible missed; a plain rewrite of an unused category stays stray
    const reqs: any = { Mia: { standard: { used: true, description: 'red jumper' } } };
    const added = PB.acceptAddedWardrobeCategory(reqs, 'Mia', parsed.entries[0], reqs.Mia.nightwear);
    expect(added.used).toBe(true);
    expect(reqs.Mia.nightwear.used).toBe(true);
    const stray = PB.acceptAddedWardrobeCategory(reqs, 'Mia', { name: 'Mia', category: 'standard' }, undefined);
    expect(stray).toBeUndefined();
  });
});

describe('the sheet: its own key, never a stand-in, persisted', () => {
  const char = (styled: any) => ({ id: 1, name: 'Mia', avatars: { styledAvatars: { pixar: styled } } });

  it('resolveSheetForRef gives nightwear its own key and never the costume sheet', () => {
    const story = { 'styled-standard': 'STD', 'styled-nightwear': 'NIGHT', costumed: 'COS' };
    expect(storyAvatars.resolveSheetForRef(story, { name: 'Mia', clothingCategory: 'nightwear' })).toEqual({ uri: 'NIGHT', slotKey: 'styled-nightwear' });
    // missing nightwear sheet: null, not the costume and not the standard sheet
    const ref: any = { name: 'Mia', clothingCategory: 'nightwear' };
    expect(storyAvatars.resolveSheetForRef({ 'styled-standard': 'STD', costumed: 'COS' }, ref)).toBeNull();
    expect(ref.clothingCategory).toBe('nightwear');
    // the old behaviour is intact for the other two
    expect(storyAvatars.resolveSheetForRef(story, { name: 'Mia', clothingCategory: 'standard' }).slotKey).toBe('styled-standard');
    expect(storyAvatars.resolveSheetForRef(story, { name: 'Mia', clothingCategory: 'costumed' }).slotKey).toBe('costumed');
  });

  it('the story projection carries the nightwear sheet, and a pyjama off-sheet', () => {
    const out = storyAvatars.projectStoryCharacterAvatars([char({ standard: IMG + 'S', nightwear: IMG + 'N' })], 'pixar');
    expect(out.Mia['styled-standard']).toBe(IMG + 'S');
    expect(out.Mia['styled-nightwear']).toBe(IMG + 'N');
  });

  it('the cache export persists it beside standard', async () => {
    await sa.runInCacheScope('t-nightwear-export', async () => {
      sa.setStyledAvatar({ id: 1, name: 'Mia' }, 'standard', 'pixar', IMG + 'S');
      sa.setStyledAvatar({ id: 1, name: 'Mia' }, 'nightwear', 'pixar', IMG + 'N');
      const exported = sa.getStyledAvatarsForCharacter({ id: 1, name: 'Mia' }, 'pixar');
      expect(exported.nightwear).toBe(IMG + 'N');
      expect(exported.standard).toBe(IMG + 'S');
    });
  });

  it('getStyledAvatar substitutes neither way', async () => {
    await sa.runInCacheScope('t-nightwear-no-sub', async () => {
      sa.setStyledAvatar('Mia', 'standard', 'pixar', IMG + 'S');
      expect(sa.getStyledAvatar('Mia', 'nightwear', 'pixar')).toBeNull();
    });
    await sa.runInCacheScope('t-nightwear-no-sub2', async () => {
      sa.setStyledAvatar('Mia', 'nightwear', 'pixar', IMG + 'N');
      expect(sa.getStyledAvatar('Mia', 'standard', 'pixar')).toBeNull();
      expect(sa.getStyledAvatar('Mia', 'nightwear', 'pixar')).toBe(IMG + 'N');
    });
  });

  it('a trial render that asked for pyjamas and got another photo is refused', () => {
    const styledNight = { name: 'Mia', requestedClothingCategory: 'nightwear', photoType: 'styled-nightwear', isStyled: true };
    const dayPhoto = { name: 'Ana', requestedClothingCategory: 'nightwear', photoType: 'clothing-standard' };
    expect(sa.missingCostumedRefs([styledNight, dayPhoto])).toEqual(['Ana']);
  });
});

describe('a required pyjama sheet that was not drawn fails the book (retry happens in the final pass, then this)', () => {
  const mia = { name: 'Mia' };
  const reqs = [{ pageNumber: 1, clothingCategory: 'nightwear', characterNames: ['Mia'] }];

  it('throws MissingRequiredCostumeSheetError, naming the pyjama sheet, when only the day sheet exists', async () => {
    await sa.runInCacheScope('t-night-missing', async () => {
      sa.setStyledAvatar('Mia', 'standard', 'pixar', IMG);
      const err: any = await sa.ensureStyledAvatarCoverage([mia], 'pixar', reqs).catch((e: any) => e);
      expect(err).toBeInstanceOf(sa.MissingRequiredCostumeSheetError);
      expect(err.categories).toEqual(['nightwear']);
      expect(err.message).toMatch(/pyjama sheet for Mia/);
    });
  });

  it('the early pass (final: false) states nothing and does not throw: the final pass retries', async () => {
    await sa.runInCacheScope('t-night-early', async () => {
      sa.setStyledAvatar('Mia', 'standard', 'pixar', IMG);
      await expect(sa.ensureStyledAvatarCoverage([mia], 'pixar', reqs, { final: false })).resolves.toBeUndefined();
    });
  });

  it('passes once the sheet exists; a costume failure keeps its old wording', async () => {
    await sa.runInCacheScope('t-night-ok', async () => {
      sa.setStyledAvatar('Mia', 'standard', 'pixar', IMG);
      sa.setStyledAvatar('Mia', 'nightwear', 'pixar', IMG);
      await expect(sa.ensureStyledAvatarCoverage([mia], 'pixar', reqs)).resolves.toBeUndefined();
    });
    await sa.runInCacheScope('t-costume-wording', async () => {
      sa.setStyledAvatar('Mia', 'standard', 'pixar', IMG);
      const err: any = await sa.ensureStyledAvatarCoverage([mia], 'pixar', [{ pageNumber: 1, clothingCategory: 'costumed:pirate', characterNames: ['Mia'] }]).catch((e: any) => e);
      expect(err.message).toMatch(/costume sheet for Mia/);
      expect(err.categories).toEqual(['costumed']);
    });
  });

  it('a character with only a pyjama sheet has no day avatar: the guarantee still fires for the day outfit', async () => {
    await sa.runInCacheScope('t-night-only', async () => {
      sa.setStyledAvatar('Mia', 'nightwear', 'pixar', IMG);
      const needsBoth = [
        { pageNumber: 1, clothingCategory: 'standard', characterNames: ['Mia'] },
        { pageNumber: 2, clothingCategory: 'nightwear', characterNames: ['Mia'] },
      ];
      // the day sheet is missing and nothing may stand in for it with the pyjama sheet: the seed path runs, no throw
      await expect(sa.ensureStyledAvatarCoverage([mia], 'pixar', needsBoth)).resolves.toBeUndefined();
      expect(sa.getStyledAvatar('Mia', 'standard', 'pixar')).not.toBe(IMG);
    });
  });
});

describe('the checks', () => {
  const REQS = {
    Mia: {
      standard: { used: true, description: 'top: red knitted jumper; bottom: blue denim jeans; footwear: brown leather boots' },
      nightwear: { used: true, description: 'top: blue pyjama top; bottom: green striped shorts; footwear: grey knitted socks' },
    },
  };
  const page = (prose: string, category: string) => ({ pageNumber: 4, prose, shot: 'medium', cast: ['Mia'], perCharClothing: { Mia: category } });

  it('clothing_incomplete does not ask a pyjama page for footwear', () => {
    const prose = 'Mia, in her blue pyjama top and green striped shorts, pulls the blanket up.';
    expect(CC.checkClothingIncomplete(page(prose, 'nightwear'), REQS)).toEqual([]);
  });

  it('the same prose on a day page is still incomplete (footwear is asked there)', () => {
    const prose = 'Mia, in her red knitted jumper and blue denim jeans, runs.';
    expect(CC.checkClothingIncomplete(page(prose, 'standard'), REQS).map((x: any) => x.slots)).toEqual([['footwear']]);
  });

  it('a pyjama page whose prose omits the bottoms is still faulted', () => {
    const prose = 'Mia, in her blue pyjama top, pulls the blanket up.';
    expect(CC.checkClothingIncomplete(page(prose, 'nightwear'), REQS).map((x: any) => x.slots)).toEqual([['bottom']]);
  });
});

describe('covers and primaryClothing are the day outfit, never pyjamas', () => {
  it('the cover reconciler never picks or keeps nightwear', () => {
    const reqs = { Mia: { nightwear: { used: true, description: 'p' }, standard: { used: true, description: 's' } } };
    const hints: any = { frontCover: { characterClothing: { Mia: 'nightwear' } } };
    const { overrides } = cats.reconcileCoverClothingWithRequirements(hints, reqs);
    expect(hints.frontCover.characterClothing.Mia).toBe('standard');
    expect(overrides).toHaveLength(1);
  });

  it('even when nightwear is listed first in the contract', () => {
    const reqs = { Mia: { nightwear: { used: true, description: 'p' }, costumed: { used: true, costume: 'pirate', description: 'c' } } };
    const hints: any = { frontCover: { characterClothing: { Mia: 'standard' } } };
    cats.reconcileCoverClothingWithRequirements(hints, reqs);
    expect(hints.frontCover.characterClothing.Mia).toBe('costumed:pirate');
  });

  it('a full-story cover brief that dresses anyone in pyjamas is stopped, loudly', () => {
    expect(() => cats.assertCoverClothingIsDay({ Mia: 'nightwear' }, 'page -1')).toThrow(/cover shows the day outfit/);
    expect(() => cats.assertCoverClothingIsDay({ Mia: 'standard', Tom: 'costumed:pirate' }, 'page -1')).not.toThrow();
  });

  it('primaryClothing counts day pages only: more pyjama pages than day pages leaves it standard', () => {
    const pageClothing = { 1: { Mia: 'standard' }, 2: { Mia: 'nightwear' }, 3: { Mia: 'nightwear' }, 4: { Mia: 'nightwear' } };
    expect(cats.dominantDayCategory(pageClothing)).toBe('standard');
    expect(cats.dominantDayCategory({ 1: { Mia: 'nightwear' } })).toBeNull();
    expect(cats.dominantDayCategory({ 1: { Mia: 'costumed' }, 2: { Mia: 'costumed' }, 3: { Mia: 'standard' } })).toBe('costumed');
  });
});

describe('the rule reaches the generator, the critic and both Art Director templates', () => {
  it('NIGHTWEAR_DEF is one constant, filled into the bible writer prompt and the wardrobe review prompt', () => {
    expect(PROMPT_TEMPLATES.storyBibleFromBeats).toContain('{NIGHTWEAR_DEF}');
    expect(PROMPT_TEMPLATES.clothingReview).toContain('{NIGHTWEAR_DEF}');
    expect(PB.WARDROBE_RULES.NIGHTWEAR_DEF).toMatch(/two-piece pyjamas/);
    expect(PB.WARDROBE_RULES.NIGHTWEAR_DEF).toMatch(/Never a vest or singlet, a bare chest or midriff, or a one-piece or nightdress/);
    expect(PB.WARDROBE_RULES.CHILD_TOP_DEF).toMatch(/swimwear, costume or nightwear/);
    const built = PB.buildClothingReviewPrompt(
      { characters: [{ id: 1, name: 'Mia', age: 5, gender: 'female' }], mainCharacters: [1], pages: 4, language: 'en', artStyle: 'watercolor', storyCategory: 'life-challenge', storyTopic: 'going-to-bed' },
      { Mia: { standard: { used: true, description: 'a red jumper, blue jeans and brown boots' } } },
      [],
    );
    expect(built).toContain(PB.WARDROBE_RULES.NIGHTWEAR_DEF);
    expect(built).not.toMatch(/\{NIGHTWEAR_DEF\}/);
  });

  it('the bible writer marks nightwear for whoever the plan puts in bed, adults included, and the schema shows the key', () => {
    const t = readPrompt('story-bible-from-beats.txt');
    expect(t).toMatch(/nightwear\.used: true/);
    expect(t).toMatch(/adult too when the plan has them in bed/);
    expect(t).toMatch(/"nightwear": \{ "used": true, "description"/);
  });

  it('the reviewer checks coverage of nightwear and accepts pyjamas without shoes', () => {
    const t = readPrompt('clothing-review.txt');
    expect(t).toMatch(/no `nightwear` entry/);
    expect(t).toMatch(/needs a top and a bottom but no footwear/);
  });

  it('both Art Director templates and both iteration templates know the third key', () => {
    for (const f of ['scene-briefs-all.txt', 'scene-expansion.txt', 'scene-iteration.txt', 'scene-iteration-free.txt']) {
      expect(readPrompt(f), f).toMatch(/nightwear/);
    }
    const c3 = readPrompt('scene-briefs-all.txt');
    expect(c3).toMatch(/Sleep means `nightwear`/);
    expect(c3).toMatch(/until a plan line dresses them for the day again/);
    expect(c3).not.toMatch(/Once a character changes, later pages keep the new one\./);
    expect(c3).toMatch(/A cover is never `nightwear`/);
    expect(readPrompt('scene-expansion.txt')).toMatch(/a cover is never `nightwear`/);
  });
});

describe('the trial: pyjamas for a bedtime topic only, keyed on the typed topic id', () => {
  const input = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures/trial-writer-two-calls/input.json'), 'utf8'));
  const bedtime = { ...input, storyCategory: 'life-challenge', storyTopic: 'going-to-bed', storyTheme: '' };

  it('getTrialNightwear: the typed topic id and the child\'s gender, nothing else', () => {
    expect(trialCostumes.getTrialNightwear({ storyCategory: 'life-challenge', storyTopic: 'going-to-bed', gender: 'female' }).description).toMatch(/pyjama top/);
    expect(trialCostumes.getTrialNightwear({ storyCategory: 'life-challenge', storyTopic: 'going-to-bed', gender: 'male' }).description).toMatch(/pyjama bottoms/);
    expect(trialCostumes.getTrialNightwear({ storyCategory: 'life-challenge', storyTopic: 'being-brave', gender: 'male' })).toBeNull();
    expect(trialCostumes.getTrialNightwear({ storyCategory: 'adventure', storyTopic: 'going-to-bed' })).toBeNull();
    expect(trialCostumes.getTrialNightwear({ storyCategory: 'life-challenge', storyTopic: 'Going to bed' })).toBeNull();
  });

  it('the pages writer offers nightwear, with the rule and the sheet line, on a bedtime trial', () => {
    const p = PB.buildTrialPagesPrompt(bedtime, 6, 'ARC');
    expect(p).toContain('"clothing": "[standard | nightwear]"');
    expect(p).toMatch(/`nightwear` — Long-sleeve soft purple cotton pyjama top/);
    expect(p).toMatch(/puts the character in bed/);
    expect(p).toMatch(/The cover is never `nightwear`/);
    expect(p).not.toMatch(/\{[A-Z][A-Z0-9_]*\}/);
  });

  it('every other trial topic is unchanged: no nightwear anywhere in the pages prompt', () => {
    const p = PB.buildTrialPagesPrompt(input, 6, 'ARC');
    expect(p).toContain('"clothing": "[standard | costumed]"');
    expect(p).not.toMatch(/nightwear/);
  });

  it('a costume AND pyjamas can both be offered', () => {
    const both = { ...bedtime, storyTheme: 'mermaid' };
    const p = PB.buildTrialPagesPrompt(both, 6, 'ARC');
    expect(p).toContain('"clothing": "[standard | costumed | nightwear]"');
  });
});

describe('bath-time is retired: no child bathes, the topic is refused, the old URL redirects', () => {
  it('the topic is gone from the guides, the catalogue, the age windows and the SEO table', () => {
    expect(PB.LIFE_CHALLENGE_GUIDES.has('bath-time')).toBe(false);
    expect(fs.readFileSync(path.join(ROOT, 'shared/topic-age-windows.json'), 'utf8')).not.toMatch(/bath-time/);
    expect(fs.readFileSync(path.join(ROOT, 'server/lib/seoMeta.js'), 'utf8')).not.toMatch(/bath-time/);
    expect(fs.existsSync(path.join(ROOT, 'client/src/constants/themeContent/bath-time.json'))).toBe(false);
    expect(fs.readFileSync(path.join(ROOT, 'client/src/constants/storyTypes.ts'), 'utf8')).not.toMatch(/bath-time/);
  });

  it('the going-to-bed guide has no bath step; the writer is not told to bathe the child', () => {
    const g = PB.getTeachingGuide('life-challenge', 'going-to-bed');
    expect(g).toMatch(/pyjamas, teeth,\s+story, goodnight/);
    expect(g).not.toMatch(/\bbath\b|the water/i);
    expect(readPrompt('adventure-guides.txt')).not.toMatch(/Bath time imagination/);
  });

  it('an unknown life-challenge topic is rejected by name at every door, and a known one passes', () => {
    expect(guards.lifeChallengeTopicError('life-challenge', 'bath-time')).toMatch(/not a known life-challenge topic/);
    expect(guards.lifeChallengeTopicError('life-challenge', 'first-foods')).toBeNull();
    expect(guards.lifeChallengeTopicError('adventure', 'anything-free-form')).toBeNull();
    expect(guards.lifeChallengeTopicError('life-challenge', '')).toBeNull();
    expect(() => PB.assertKnownLifeChallengeTopic('life-challenge', 'bath-time')).toThrow(PB.UnknownLifeChallengeTopicError);
    // the prompt context of a story/Lab replay is built through the same assertion
    expect(() => PB.buildStoryContextFields({ storyCategory: 'life-challenge', storyTopic: 'bath-time', characters: [], language: 'en' })).toThrow(/bath-time/);
  });

  it('the old topic URL is redirected permanently to the shelf', () => {
    const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
    expect(server).toMatch(/'\/themes\/life-challenges\/bath-time': '\/themes\/life-challenges'/);
  });

  it('the wizards ignore an unknown topic deep link instead of opening a guide-less story', async () => {
    const w: any = await import('../../client/src/utils/wizardStoryType');
    expect(w.knownDeepLink('?category=life-challenge&topic=bath-time')).toEqual({ category: '', topic: '' });
    expect(w.knownDeepLink('?category=life-challenge&topic=first-foods')).toEqual({ category: 'life-challenge', topic: 'first-foods' });
    expect(w.knownDeepLink('?category=adventure&topic=whatever')).toEqual({ category: 'adventure', topic: 'whatever' });
  });
});
