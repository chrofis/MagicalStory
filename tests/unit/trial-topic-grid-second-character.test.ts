import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { getTrialLifeChallenges, lifeChallenges, trialLifeChallengeIds, TRIAL_GRID_SIZE } from '../../client/src/constants/storyTypes';

/**
 * Owner iPhone /try 2026-10-09: "The selected one jumps to first place. Geschwisterstreit needs a sibling that we do not have in
 * trial." The trial has one character: topics about another family member are flagged (needsSecondCharacter) and never offered; a
 * topic picked from the grid keeps its place. 6 tiles is TRIAL_GRID_SIZE by design (docs/decisions.md 2026-09-13).
 */
const ids = (l: { id: string }[]) => l.map(c => c.id);

describe('trial grid and topics that need a second character', () => {
  it('flags the family-member topics, by data', () => {
    for (const tid of ['sibling-fighting', 'new-sibling']) {
      expect(lifeChallenges.find(c => c.id === tid)?.needsSecondCharacter, tid).toBe(true);
    }
  });
  it('never offers a flagged topic at any age, nor when deep-linked', () => {
    for (let age = 1; age <= 12; age++) {
      for (const linked of [undefined, 'sibling-fighting', 'new-sibling']) {
        const grid = getTrialLifeChallenges(age, linked);
        expect(grid.some(c => c.needsSecondCharacter), `age ${age} link ${linked}`).toBe(false);
      }
    }
    expect(getTrialLifeChallenges(null).some(c => c.needsSecondCharacter)).toBe(false);
  });
  it('keeps the grid at TRIAL_GRID_SIZE tiles', () => {
    for (let age = 1; age <= 12; age++) expect(getTrialLifeChallenges(age).length).toBe(TRIAL_GRID_SIZE);
  });
  it('a topic picked from the grid does not move (same order before and after selecting each tile)', () => {
    for (let age = 1; age <= 12; age++) {
      const before = ids(getTrialLifeChallenges(age));
      for (const picked of before) expect(ids(getTrialLifeChallenges(age, picked)), `age ${age} pick ${picked}`).toEqual(before);
    }
  });
  it('a deep-linked topic outside the grid is still pinned first', () => {
    const grid = ids(getTrialLifeChallenges(7));
    const outside = trialLifeChallengeIds.find(t => !grid.includes(t) && !lifeChallenges.find(c => c.id === t)?.needsSecondCharacter)!;
    expect(ids(getTrialLifeChallenges(7, outside))[0]).toBe(outside);
  });
});

describe('analyze-photo network retry (owner iPhone B)', () => {
  it('retries a network-level failure once and never an HTTP answer', () => {
    const src = fs.readFileSync(path.resolve(__dirname, '../../client/src/pages/trial/TrialCharacterStep.tsx'), 'utf8');
    expect(src).toMatch(/postAnalyzePhoto/);
    expect(src).toMatch(/catch \(err\) \{[\s\S]{0,200}retrying once[\s\S]{0,80}return await send\(\)/);
  });
});
