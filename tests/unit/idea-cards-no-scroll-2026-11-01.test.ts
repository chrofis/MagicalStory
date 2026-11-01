/**
 * IDEA CARDS NEVER SCROLL (owner, 2026-11-01): "the ideas need scrolling, make the boxes so
 * big that scrolling is not needed. The longer story decides the box length so they are the
 * same size." Every idea text is an AutoGrowTextarea (as tall as its text) inside a flex-1
 * wrapper, so a desktop row stretches to the longest card and a phone stacks each card at
 * its own full height. One AutoGrowTextarea, shared by the trial and the full wizard.
 */
import fs from 'fs';
import path from 'path';
import { describe, it, expect } from 'vitest';

const read = (...p: string[]) => fs.readFileSync(path.join(__dirname, '..', '..', 'client', 'src', ...p), 'utf8');

describe('idea cards are as tall as their text', () => {
  it('the full wizard idea cards and the Own story card use the shared AutoGrowTextarea in a flex-1 wrapper', () => {
    for (const file of [['pages', 'wizard', 'WizardStep6Summary.tsx'], ['pages', 'wizard', 'OwnStoryCard.tsx']]) {
      const src = read(...file);
      expect(src, file.join('/')).toMatch(/import \{[^}]*\bAutoGrowTextarea\b[^}]*\} from '@\/components\/common';/);
      expect(src, file.join('/')).toMatch(/<div className=\{`flex-1 [^`]*`\}>\s*<AutoGrowTextarea/);
      expect(src, file.join('/')).not.toMatch(/rows=\{10\}/);
    }
  });

  it('the trial uses the same shared component, not its own copy', () => {
    const trial = read('pages', 'trial', 'TrialIdeasStep.tsx');
    expect(trial).toMatch(/import \{[^}]*\bAutoGrowTextarea\b[^}]*\} from '@\/components\/common';/);
    expect(trial).not.toMatch(/function AutoGrowTextarea/);
    expect(read('components', 'common', 'index.ts')).toContain("export { AutoGrowTextarea } from './AutoGrowTextarea';");
  });
});
