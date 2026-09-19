import { describe, it, beforeAll, expect } from 'vitest';

const pb = require('../../server/lib/promptBuilders');
const { SHOT_DEFINITIONS, POSITION_SHOTS } = require('../../server/lib/shotVocabulary');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');

const input = () => ({
  pages: 18, season: 'autumn', language: 'de-CH', languageLevel: '1st-grade',
  storyDetails: 'x', characters: [{ id: 'a', name: 'Levin', age: 5 }], mainCharacters: ['a'],
});

/**
 * A low angle makes its subject tower — the point of the shot, and exactly wrong
 * pointed at a grown-up or a creature standing over a small child.
 *
 * The creature-tone bands already forbid a creature "leaning or towering over a
 * child" (<=4) and require it "framed at the child's eye level" (5-6) — but they
 * constrain the creature's Visual Bible ENTRY, not the page's camera. The
 * formidable band (7+) explicitly licenses looming, so before this a
 * formidable-band book could be handed a low-angle page with nothing joining the
 * two. That state became reachable the moment camera position became a page
 * field.
 */
describe('a low angle never looks up at someone standing over a child', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the guard rides on the WORD, so every consumer of the vocabulary gets it', () => {
    expect(SHOT_DEFINITIONS).toContain('never up at a grown-up or a creature standing over a child');
    // SHOT_DEFINITIONS is what the illustrator is told the words mean.
    expect(SHOT_DEFINITIONS).toContain('Look up at a thing, a height, a tree or a sky');
  });

  it('the planner carries it too — it is the stage that picks the angle', () => {
    const p = pb.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).toContain('A page looking UP at a grown-up or a creature standing over a child is not one of them');
  });
});

/**
 * A floor with no ceiling is how a correction overshoots: the measured baseline
 * is every page eye level, and the answer to that is not every page angled.
 */
describe('angles are the exception the book earns, not the default', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the planner is given both a floor and a ceiling', () => {
    const p = pb.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    expect(p).toContain('at least one page in the book takes one');
    expect(p).toContain('most pages still stand at eye level');
  });

  it('it is offered the positions by name, injected not hand-typed', () => {
    const p = pb.buildBeatsPrompt(input(), 18, { finalArc: '1. A story.', arcHints: '' });
    for (const id of POSITION_SHOTS) expect(p).toContain(`\`${id}\``);
    expect(p).not.toContain('{SHOT_POSITIONS}');
  });
});

/**
 * C4 is the anti-repetition rule. It named all eight words "camera distance" and
 * pointed its angle axis at the vantage — the place camera position had just
 * stopped living.
 */
describe('C4 names the two axes for what they are', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('separates camera distance from where the camera stands', () => {
    const c4 = String(PROMPT_TEMPLATES.sceneExpansionAll).split('\n').find(l => l.startsWith('C4.')) || '';
    expect(c4).toContain('camera distance ({DISTANCE_SHOTS})');
    expect(c4).toContain('where the camera stands ({SHOT_POSITIONS})');
    expect(c4).not.toContain('the vantage they cite');
  });

  it('renders both lists, and the distance list is only the four distances', () => {
    const built = pb.buildSceneExpansionAllPrompt(input(), [{ pageNumber: 1, planLine: 'medium — Levin — waits — nothing' }], { maxCharactersPerScene: 6, finalArc: '1.' });
    const c4 = built.split('\n').find(l => l.startsWith('C4.')) || '';
    expect(c4).toContain('`close-up`, `medium`, `wide`, `ultra-wide`');
    for (const id of POSITION_SHOTS) expect(c4).toContain(`\`${id}\``);
    // the distance half must not have swallowed the positions
    expect(c4.slice(c4.indexOf('camera distance'), c4.indexOf('where the camera stands'))).not.toContain('aerial');
  });
});

/**
 * Promoting it would spend a re-plan round on EVERY book until the planner
 * adapts: 6 of 1,504 stored shot values carry a position at all.
 */
describe('the camera-position counter is advisory, on purpose', () => {
  it('SHOT_NO_CAMERA_POSITION is not must-fix', () => {
    expect(pb.replanRank({ kind: 'counter', code: 'SHOT_NO_CAMERA_POSITION' })).toBe('also');
  });

  it('and the reason is written where someone would go to change it', () => {
    const lf = (x: string) => x.split(String.fromCharCode(13) + String.fromCharCode(10)).join(String.fromCharCode(10));
    const src = lf(require('fs').readFileSync(require('path').join(__dirname, '../..', 'server', 'lib', 'promptBuilders.js'), 'utf-8'));
    const block = src.slice(src.indexOf('const REPLAN_MUST_FIX_CODES'), src.indexOf('function replanRank'));
    expect(block).toContain('NOT HERE, DELIBERATELY: SHOT_NO_CAMERA_POSITION');
    expect(block).toContain('6 of 1,504');
  });
});
