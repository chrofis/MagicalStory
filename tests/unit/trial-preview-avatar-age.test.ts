/**
 * The trial's plain "standard" avatar states the declared age and the shared
 * proportion markers. Staging 2026-10-09: Lily (7) was drawn about 4 because
 * the prompt said "young child" with no number, and a 5-year-old was a "toddler".
 */
import { describe, it, expect } from 'vitest';
const { buildTrialPreviewAvatarPrompt } = require('../../server/lib/trialAge');

const p = (age: number) => buildTrialPreviewAvatarPrompt({ age, isFemale: true, hairDescription: 'auburn wavy', standardClothing: 'a plain t-shirt' });

describe('buildTrialPreviewAvatarPrompt', () => {
  it('a 7-year-old is stated as 7 with grade-school proportions, never toddler', () => {
    const t = p(7);
    expect(t).toContain('7-year-old girl');
    expect(t).toContain('AGE: 7 years old');
    expect(t).toContain('early grade-school proportions about 5.5 heads tall');
    expect(t).toContain('NOT toddler proportions');
    expect(t).not.toMatch(/toddler (girl|boy)|young child/);
  });
  it('a 5-year-old is a kindergartner, not a "toddler"', () => {
    const t = p(5);
    expect(t).toContain('kindergarten-age proportions');
    expect(t).not.toMatch(/\btoddler (girl|boy)/);
  });
  it('keeps hair, clothing and the no-text output rule', () => {
    const t = p(9);
    expect(t).toContain('HAIR: auburn wavy');
    expect(t).toContain('CLOTHING: a plain t-shirt');
    expect(t).toContain('No text, no borders');
  });
});
