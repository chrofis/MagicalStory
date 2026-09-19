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

  it('SHOT_TYPES is distance only — no angle hides in it', () => {
    expect(SHOT_TYPES).toEqual(['close-up', 'medium', 'wide', 'ultra-wide']);
    expect(SHOT_ENUM).not.toMatch(/aerial|worm|low angle|over-the-shoulder/i);
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
    expect(c4).toContain('{SHOT_ENUM}');
    expect(c4).not.toContain('aerial');
    expect(c4).toContain('camera angle (the vantage they cite)');
  });

  it('the VANTAGE list keeps its angles — a vantage IS a camera angle on a place', () => {
    // wide-low and aerial are legitimate there and are used: across ~420 stored
    // vantages, wide-low x4 and aerial x1. ultra-wide was used x4 while NOT
    // being offered, so the list now carries it.
    const t = String(PROMPT_TEMPLATES.sceneExpansionAll);
    expect(t).toContain('`wide|medium|close-up|ultra-wide|wide-low|aerial`');
    expect(t).toContain('a vantage is a camera ANGLE on the place');
  });

  it('every brief-authoring template fills SHOT_ENUM rather than spelling it', () => {
    for (const k of ['sceneExpansionAll', 'sceneExpansion', 'sceneIteration', 'sceneIterationFree']) {
      expect(String(PROMPT_TEMPLATES[k] || ''), `${k}`).toContain('{SHOT_ENUM}');
    }
  });
});
