import { describe, it, expect } from 'vitest';
// @ts-expect-error - JS module without types
import { expressionEditBlocked } from '../../server/lib/repairLogic.js';

describe('expressionEditBlocked — no expression edits on faces that cannot carry one', () => {
  const figures = [{ name: 'Mia', faceBox: [0.2, 0.2, 0.3, 0.3] }, { name: 'Noa', faceBox: [0.2, 0.5, 0.215, 0.52] }];
  it('allows a normal visible face', () => {
    expect(expressionEditBlocked({ types: ['emotion'], characterName: 'Mia', figures })).toBeNull();
  });
  it('blocks a back-turned figure (declared pose)', () => {
    const sceneMetadata = { characterPerspectives: { Mia: { pose: 'back' } } };
    expect(expressionEditBlocked({ types: ['emotion'], characterName: 'Mia', sceneMetadata, figures })).toMatch(/turned away/);
  });
  it('blocks the over-the-shoulder near figure', () => {
    const sceneMetadata = { characterPerspectives: { Mia: { perspective: 'over-the-shoulder' } } };
    expect(expressionEditBlocked({ types: ['emotion'], characterName: 'Mia', sceneMetadata })).toMatch(/over-the-shoulder/);
  });
  it('blocks a tiny face', () => {
    expect(expressionEditBlocked({ types: ['emotion'], characterName: 'Noa', figures })).toMatch(/tall/);
  });
  it('never blocks a non-expression type', () => {
    expect(expressionEditBlocked({ types: ['object_presence'], characterName: 'Noa', figures })).toBeNull();
    expect(expressionEditBlocked({ types: ['emotion', 'action_interaction'], characterName: 'Noa', figures })).toBeNull();
  });
});
