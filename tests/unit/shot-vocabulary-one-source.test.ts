import { describe, it, beforeAll, expect } from 'vitest';
import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';

const { SHOT_ENUM, SHOT_TYPES } = require('../../server/lib/shotVocabulary');
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');
const PROMPTS = join(__dirname, '../..', 'prompts');

/**
 * 434ea1e89 (2026-09-16) unified the shot vocabulary — "the shot rule survives
 * the cut, from one vocabulary" — and reached the `shot` FIELD rule in all four
 * brief-authoring templates. It left four other hand-typed lists behind, and no
 * two of them were the same:
 *
 *   C4 (anti-repetition)      close-up / medium / wide / aerial
 *   prose checklist x2        close-up / medium / wide / aerial
 *   scene-iteration.txt       close-up / medium / wide / ultra-wide / aerial
 *
 * `aerial` is not a page shot — SHOT_TYPES is four values, all camera DISTANCE.
 * So the rule that stops two consecutive pages sharing a composition watched for
 * a value that cannot occur and was blind to `ultra-wide`, which can and which
 * job_1789759147125_p08djwhbl used on p11 and p18.
 */
describe('one shot vocabulary, injected — never hand-typed', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('ONE field carries distance AND camera position, every option spelled out', () => {
    expect(SHOT_TYPES).toEqual([
      'close-up', 'medium', 'wide', 'ultra-wide',
      'over-the-shoulder', 'high-angle', 'low-angle', 'aerial',
    ]);
    // Spelled out, never abbreviated (owner, 2026-09-19).
    expect(SHOT_ENUM).toContain('over-the-shoulder');
    expect(SHOT_ENUM.split(/[^a-z-]+/)).not.toContain('ots');
  });

  it("the parser folds the words people write onto those ids", () => {
    const { SHOT_PATTERNS } = require('../../server/lib/shotVocabulary');
    const id = (t: string) => (SHOT_PATTERNS.find(([, re]: [string, RegExp]) => re.test(t)) || ['other'])[0];
    expect(id("worm's-eye of the linden")).toBe('low-angle');
    expect(id('wide-low plate')).toBe('low-angle');        // the legacy vantage word
    expect(id("bird's-eye over the roofs")).toBe('aerial');
    expect(id('over-the-shoulder — Levin throws')).toBe('over-the-shoulder');
    expect(id('ultra-wide — the rooftops')).toBe('ultra-wide');
  });

  it('no prompt hand-types a PAGE shot list any more', () => {
    const offenders: string[] = [];
    for (const f of readdirSync(PROMPTS).filter(x => x.endsWith('.txt'))) {
      const t = readFileSync(join(PROMPTS, f), 'utf-8');
      // a slash- or pipe-separated run of shot words, outside the vantage line
      for (const m of t.match(/\(close-up[^)]*\)/g) || []) {
        if (/aerial|wide-low/.test(m)) offenders.push(`${f}: ${m}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('C4 names the real four and points its angle axis at the vantage', () => {
    const t = String(PROMPT_TEMPLATES.sceneExpansionAll);
    const c4 = t.split('\n').find(l => l.startsWith('C4.')) || '';
    // C4 names the two axes separately: the eight-word SHOT_ENUM is not a list
    // of distances, and where the camera stands is the shot word's own business
    // now, not the vantage's.
    expect(c4).toContain('{DISTANCE_SHOTS}');
    expect(c4).toContain('{SHOT_POSITIONS}');
    expect(c4).not.toContain('{SHOT_ENUM}');
    expect(c4).not.toContain('the vantage they cite');
  });


  it('every brief-authoring template fills SHOT_ENUM rather than spelling it', () => {
    for (const k of ['sceneExpansionAll', 'sceneExpansion', 'sceneIteration', 'sceneIterationFree']) {
      expect(String(PROMPT_TEMPLATES[k] || ''), `${k}`).toContain('{SHOT_ENUM}');
    }
  });
});
