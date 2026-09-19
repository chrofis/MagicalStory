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
