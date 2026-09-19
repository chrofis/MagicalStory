import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const { buildThemePlaySentence, THEME_PLAY, themeKind } =
  require('../../server/config/storyThemes.js');

const ROOT = path.resolve(__dirname, '../..');

/**
 * The theme arrives from the wizard as a catalogue ID. Dropping the raw ID into
 * prose produced "The child plays at being a farm" / "a mothers-day" / "a ocean"
 * in every built life-skill idea prompt. The contract pinned here is not the
 * wording — it is that each of the three KINDS of theme gets a sentence that is
 * grammatical, and that the two sites that emit it emit the same bytes.
 */
describe('theme play sentence', () => {
  it('a role theme reads as a role', () => {
    expect(buildThemePlaySentence('pirate')).toBe(
      'The child plays at being a pirate; that play is where the struggle happens.');
    expect(themeKind('pirate')).toBe('role');
  });

  it('a place theme is somewhere the make-believe goes, never someone to be', () => {
    const s = buildThemePlaySentence('farm');
    expect(themeKind('farm')).toBe('place');
    expect(s).toBe("The child's make-believe takes them to a farm; that play is where the struggle happens.");
    expect(s).not.toContain('plays at being');
  });

  it('an occasion theme is a day the story sits on, never a role', () => {
    const s = buildThemePlaySentence('mothers-day');
    expect(themeKind('mothers-day')).toBe('occasion');
    expect(s).toBe("The story happens around Mother's Day; that occasion is where the struggle happens.");
    expect(s).not.toContain('plays at being');
  });

  it('no theme emits its raw ID or a broken article', () => {
    for (const id of Object.keys(THEME_PLAY)) {
      const s = buildThemePlaySentence(id);
      if (id.includes('-')) expect(s, id).not.toContain(id); // "a mothers-day"
      if (themeKind(id) !== 'role') expect(s, id).not.toContain('plays at being');
      expect(s, id).not.toMatch(/\ba [aeiou]/i);   // "a ocean"
      expect(THEME_PLAY[id][1], id).not.toBe(id); // the phrase is prose, not the key
      expect(s, id).toMatch(/^The .+ happens\.$/);
    }
  });

  it('no wrapper means no sentence; an unknown id is quoted, never inflected', () => {
    expect(buildThemePlaySentence('realistic')).toBe('');
    expect(buildThemePlaySentence('')).toBe('');
    expect(buildThemePlaySentence(undefined)).toBe('');
    expect(buildThemePlaySentence('a brand new theme')).toBe(
      'The story\'s make-believe is "a brand new theme"; that play is where the struggle happens.');
  });

  /**
   * The trial route and its Test Lab mirror hand-kept a copy of this sentence
   * each, which is how the raw ID survived. Both must read it from the shared
   * builder — a literal copy at either site is the regression.
   */
  it('both sites build the sentence from the shared table, not a literal', () => {
    for (const rel of ['server/routes/trial.js', 'server/lib/testlab.js']) {
      const src = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      expect(src, rel).toContain("buildThemePlaySentence(storyTheme)");
      expect(src, rel).toContain('${themeSentence ? ` ${themeSentence}` : \'\'}');
      expect(src, rel).not.toContain('plays at being a ${storyTheme}');
    }
  });
});

/**
 * The make-believe arm said "a make-believe ${themeId} world". Two faults: the
 * raw ID reached the prompt, and — the one that mattered — a ROLE was handed to
 * the model as a WORLD. "A make-believe firefighter world" is not an elsewhere,
 * so the make-believe card came back as a helmet in a bedroom and converged on
 * the own-town card that was given the very same theme. Pinned here is the
 * CONTRACT, never the wording: a role never reads as a world, every kind is
 * grammatical, and no raw ID survives.
 */
describe('fantasy world sentence', () => {
  const { buildFantasyWorldSentence, FANTASY_WORLD_SENTENCE } =
    require('../../server/config/storyThemes.js');

  it('a place theme IS the world', () => {
    expect(buildFantasyWorldSentence('ocean')).toBe('That make-believe is the deep ocean.');
    expect(buildFantasyWorldSentence('farm')).toBe('That make-believe is a farm.');
  });

  it('a role theme is never handed as a world — the place is invented instead', () => {
    for (const id of Object.keys(THEME_PLAY).filter(k => themeKind(k) === 'role')) {
      const s = buildFantasyWorldSentence(id);
      const phrase = THEME_PLAY[id][1];
      expect(s, id).toBe(`That make-believe is where ${phrase} belongs; invent that place — the role itself is not a world.`);
      // the regression: "a make-believe pirate world" / "That make-believe is a pirate."
      expect(s, id).not.toMatch(new RegExp(`${phrase}\\s+world`, 'i'));
      expect(s, id).not.toBe(`That make-believe is ${phrase}.`);
    }
  });

  it('an occasion is a day, not a place — the world is invented freely', () => {
    expect(buildFantasyWorldSentence('mothers-day')).toBe(
      "That make-believe is freely invented; Mother's Day is the day it happens on, not a place.");
    expect(buildFantasyWorldSentence('christmas')).toContain('not a place');
  });

  it('every theme yields one grammatical sentence and never its raw ID', () => {
    for (const id of Object.keys(THEME_PLAY)) {
      const s = buildFantasyWorldSentence(id);
      if (id.includes('-')) expect(s, id).not.toContain(id); // "a make-believe mothers-day world"
      expect(s, id).not.toMatch(/\ba [aeiou]/i);             // "a ocean"
      expect(s, id).toMatch(/^That make-believe .+\.$/);
      expect(s, id).not.toMatch(/world of .*? world|world world/);
    }
  });

  it('no wrapper means no sentence; an unknown id is quoted, never inflected', () => {
    expect(buildFantasyWorldSentence('realistic')).toBe('');
    expect(buildFantasyWorldSentence('')).toBe('');
    expect(buildFantasyWorldSentence(undefined)).toBe('');
    expect(buildFantasyWorldSentence('a brand new theme')).toBe(
      'That make-believe grows out of "a brand new theme".');
  });

  it('one sentence per KIND, and no template names a theme', () => {
    expect(Object.keys(FANTASY_WORLD_SENTENCE).sort()).toEqual(['occasion', 'place', 'role']);
    for (const [kind, fn] of Object.entries(FANTASY_WORLD_SENTENCE)) {
      const rendered = (fn as (p: string) => string)('<PHRASE>');
      for (const id of Object.keys(THEME_PLAY)) expect(rendered, kind).not.toContain(id);
    }
  });

  /**
   * Both live emitters of this sentence — the idea arm and the trial writer
   * that follows it — read it from the shared table. A literal at either site
   * is the regression that let the raw ID ship for months.
   */
  it('both make-believe-world sites build from the shared table', () => {
    const src = fs.readFileSync(path.join(ROOT, 'server/lib/promptBuilders.js'), 'utf8');
    expect(src.match(/buildFantasyWorldSentence\(/g)?.length).toBe(2); // the idea arm and the trial writer
    expect(src).not.toContain('A make-believe ${theme}world');
    expect(src).not.toContain('make-believe ${storyTheme');
  });
});
