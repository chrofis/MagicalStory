/**
 * The trial-showcase harness may only post what the /try wizard can submit
 * (TrialWizard.tsx completeness rule). Two 2026-10-09 runs posted a theme-less
 * adventure; prepare-title answered 400 and the runs skipped the costumed sheet.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { missingWizardPicks } = require('../../scripts/admin/trial-showcase.js');

describe('trial-showcase: wizard completeness', () => {
  it('an adventure needs a theme', () => {
    expect(missingWizardPicks({ storyCategory: 'adventure', storyTopic: '', storyTheme: '' })).toHaveLength(1);
    expect(missingWizardPicks({ storyCategory: 'adventure', storyTheme: 'pirate' })).toEqual([]);
  });

  it('a life challenge needs a topic and a theme', () => {
    expect(missingWizardPicks({ storyCategory: 'life-challenge', storyTopic: 'first-school', storyTheme: '' })).toHaveLength(1);
    expect(missingWizardPicks({ storyCategory: 'life-challenge', storyTopic: '', storyTheme: 'forest' })).toHaveLength(1);
    expect(missingWizardPicks({ storyCategory: 'life-challenge', storyTopic: 'first-school', storyTheme: 'forest' })).toEqual([]);
  });

  it('every rotation entry is a request the wizard can send', () => {
    const { entries } = JSON.parse(fs.readFileSync(path.join(__dirname, '../helpers/trial-rotation.json'), 'utf8'));
    expect(entries.filter((e: any) => missingWizardPicks(e).length).map((e: any) => e.index)).toEqual([]);
  });
});
