import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');
// @ts-ignore — CommonJS module
import { compareEmotion, normalizeEmotion, EMOTIONS, EMOTION_ENUM_PHRASE } from '../../server/lib/emotionVocabulary.js';
// @ts-ignore — CommonJS module
import { checkDeclaredEmotion } from '../../server/lib/emotionCheck.js';
// @ts-ignore — CommonJS module
import { EXPRESSION_FIELD_RULE } from '../../server/lib/promptBuilders.js';

/**
 * Emotion is one closed list on both sides (owner, 2026-09-23): the brief's
 * `characters[].emotion` and the blind inventory's `figures[].emotion`. Code
 * maps the pair to a severity — opposite tone CRITICAL, a different feeling of
 * the same tone MINOR — and reads no prose.
 */
describe('compareEmotion', () => {
  it('opposite tone is CRITICAL, both ways', () => {
    for (const neg of ['sad', 'angry', 'afraid', 'disgusted']) {
      expect(compareEmotion('happy', neg)).toBe('CRITICAL');
      expect(compareEmotion(neg, 'happy')).toBe('CRITICAL');
    }
  });

  it('two different negatives are MINOR', () => {
    expect(compareEmotion('sad', 'angry')).toBe('MINOR');
    expect(compareEmotion('afraid', 'disgusted')).toBe('MINOR');
  });

  it('surprised against any other non-neutral feeling is MINOR', () => {
    for (const e of ['happy', 'sad', 'angry', 'afraid', 'disgusted']) {
      expect(compareEmotion('surprised', e)).toBe('MINOR');
      expect(compareEmotion(e, 'surprised')).toBe('MINOR');
    }
  });

  it('same feeling, neutral on either side, unreadable, missing or off-list is no finding', () => {
    for (const e of EMOTIONS) expect(compareEmotion(e, e)).toBeNull();
    expect(compareEmotion('angry', 'neutral')).toBeNull();
    expect(compareEmotion('neutral', 'happy')).toBeNull();
    expect(compareEmotion('sad', 'unreadable')).toBeNull();
    expect(compareEmotion(undefined, 'happy')).toBeNull();
    expect(compareEmotion('happy', null)).toBeNull();
    expect(compareEmotion('furious', 'happy')).toBeNull();
  });

  it('normalises case and stray punctuation, nothing more', () => {
    expect(normalizeEmotion(' Happy. ')).toBe('happy');
    expect(normalizeEmotion('cannot tell at this size')).toBeNull();
  });
});

describe('both sides are given the same list the eval compares', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  it('the blind inventory template is filled with the list at load', () => {
    const t = PROMPT_TEMPLATES.imageInventoryUnified;
    expect(t).toContain(EMOTION_ENUM_PHRASE);
    expect(t).not.toContain('{EMOTION_ENUM}');
  });

  it('EXPRESSION_FIELD_RULE carries every emotion in the vocabulary', () => {
    expect(EXPRESSION_FIELD_RULE).toContain(EMOTION_ENUM_PHRASE);
    for (const e of EMOTIONS) expect(EMOTION_ENUM_PHRASE).toContain(`\`${e}\``);
  });
});

// Two children side by side; the evaluator named them, the blind inventory
// described them by garment. Pairing is by position only.
const MATCHES = [
  { reference: 'Mia', body_bbox: [0.10, 0.20, 0.35, 0.90] },
  { reference: 'Tom', body_bbox: [0.60, 0.20, 0.85, 0.90] },
];
const inventory = (left: string, right: string) => ({
  figures: [
    { label: 'the girl in yellow', body_bbox: [0.11, 0.21, 0.34, 0.89], emotion: left },
    { label: 'the boy in blue', body_bbox: [0.61, 0.21, 0.84, 0.89], emotion: right },
  ],
});

describe('checkDeclaredEmotion', () => {
  it('a smile where the brief declares sadness is one CRITICAL emotion finding naming the intended feeling', () => {
    const findings = checkDeclaredEmotion({
      declared: [
        { name: 'Mia', emotion: 'sad', expression: 'wet eyes, mouth turned down' },
        { name: 'Tom', emotion: 'happy' },
      ],
      inventory: inventory('happy', 'happy'),
      matches: MATCHES,
    });
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f).toMatchObject({ type: 'emotion', severity: 'CRITICAL', character: 'Mia', source: 'emotion-check' });
    expect(f.description).toContain('sad');
    expect(f.fix).toContain('sad');
    expect(f.fix).toContain('wet eyes, mouth turned down');
  });

  it('pairs by position, not by list order', () => {
    const findings = checkDeclaredEmotion({
      declared: [{ name: 'Tom', emotion: 'afraid' }, { name: 'Mia', emotion: 'afraid' }],
      inventory: inventory('afraid', 'angry'),
      matches: MATCHES,
    });
    expect(findings.map((f: any) => [f.character, f.severity])).toEqual([['Tom', 'MINOR']]);
  });

  it('neutral or unreadable faces, and characters without a declared emotion, produce nothing', () => {
    expect(checkDeclaredEmotion({
      declared: [{ name: 'Mia', emotion: 'angry' }, { name: 'Tom' }],
      inventory: inventory('neutral', 'sad'),
      matches: MATCHES,
    })).toEqual([]);
    expect(checkDeclaredEmotion({
      declared: [{ name: 'Mia', emotion: 'happy' }],
      inventory: inventory('unreadable', 'happy'),
      matches: MATCHES,
    })).toEqual([]);
  });

  it('a character no figure pairs with is skipped', () => {
    expect(checkDeclaredEmotion({
      declared: [{ name: 'Lena', emotion: 'sad' }],
      inventory: inventory('happy', 'happy'),
      matches: MATCHES,
    })).toEqual([]);
  });
});
