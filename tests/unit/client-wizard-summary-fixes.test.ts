import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

const read = (p: string) => fs.readFileSync(path.join(__dirname, '../../client/src', p), 'utf8');

describe('editing the selected idea card keeps its index (world + story shape)', () => {
  it('the textarea onChange passes the card index to onSelectIdea', () => {
    const src = read('pages/wizard/WizardStep6Summary.tsx');
    expect(src).toMatch(/if \(isSelected\) \{\s*onSelectIdea\(full, index\);/);
    expect(src).not.toMatch(/onSelectIdea\(full\);/);
  });
  it('the custom-theme path still passes no index', () => {
    expect(read('pages/wizard/WizardStep6Summary.tsx')).toContain('onSelectIdea(customThemeText);');
  });
});

describe('topic age hints reach the live wizard', () => {
  it('StoryWizard derives focusAge from pickMainCharacters (same source as CharacterList) and passes it down', () => {
    const src = read('pages/StoryWizard.tsx');
    expect(src).toMatch(/pickMainCharacters\(/);
    const step3 = src.slice(src.indexOf('<WizardStep4StoryType'), src.indexOf('/>', src.indexOf('<WizardStep4StoryType')));
    expect(step3).toMatch(/focusAge=\{/);
  });
  it('WizardStep4StoryType forwards focusAge to StoryCategorySelector', () => {
    const src = read('pages/wizard/WizardStep4StoryType.tsx');
    expect(src).toMatch(/focusAge\?: number \| null/);
    const sel = src.slice(src.indexOf('<StoryCategorySelector'));
    expect(sel).toMatch(/focusAge=\{focusAge\}/);
  });
});

describe('reading-level label has one source', () => {
  it('the summary reads the translation keys step 2 uses, with no hard-coded names', () => {
    const src = read('pages/wizard/WizardStep6Summary.tsx');
    const fn = src.slice(src.indexOf('const getReadingLevelLabel'), src.indexOf('const getSeasonLabel'));
    expect(fn).toContain('levelT.firstGrade');
    expect(fn).toContain('levelT.standard');
    expect(fn).toContain('levelT.advanced');
    expect(fn).not.toMatch(/Young Adult|Jugendbuch|Chapter Book/);
  });
});
