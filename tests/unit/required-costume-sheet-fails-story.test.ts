import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);
const sa: any = nodeRequire('../../server/lib/styledAvatars.js');
const scoring: any = nodeRequire('../../server/lib/scoring.js');
const buckets: any = nodeRequire('../../server/lib/evalBuckets.js');

const emma = { name: 'Emma' };
const reqs = [{ pageNumber: 1, clothingCategory: 'costumed:mermaid', characterNames: ['Emma'] }];
const IMG = 'data:image/jpeg;base64,/9j/AAAA';

// Staging job_1791222889407_ypl33vk8u: the costumed sheet failed, another bucket's sheet
// substituted and pages drew the costume from text (bare-chested child). Owner: no costume, no book.
describe('a required costumed sheet that was not generated fails the story', () => {
  it('throws MissingRequiredCostumeSheetError when only a standard sheet exists', async () => {
    await sa.runInCacheScope('t-missing-costume', async () => {
      sa.setStyledAvatar('Emma', 'standard', 'pixar', IMG);
      await expect(sa.ensureStyledAvatarCoverage([emma], 'pixar', reqs)).rejects.toBeInstanceOf(sa.MissingRequiredCostumeSheetError);
      await expect(sa.ensureStyledAvatarCoverage([emma], 'pixar', reqs)).rejects.toThrow(/Emma/);
    });
  });
  it('throws when the character has no avatar of any bucket', async () => {
    await sa.runInCacheScope('t-no-avatar', async () => {
      await expect(sa.ensureStyledAvatarCoverage([emma], 'pixar', reqs)).rejects.toBeInstanceOf(sa.MissingRequiredCostumeSheetError);
    });
  });
  it('passes when the costumed sheet exists', async () => {
    await sa.runInCacheScope('t-has-costume', async () => {
      sa.setStyledAvatar('Emma', 'costumed:mermaid', 'pixar', IMG);
      sa.setStyledAvatar('Emma', 'standard', 'pixar', IMG);
      await expect(sa.ensureStyledAvatarCoverage([emma], 'pixar', reqs)).resolves.toBeUndefined();
    });
  });
  it('getStyledAvatar never substitutes another bucket for a costume', async () => {
    await sa.runInCacheScope('t-no-sub', async () => {
      sa.setStyledAvatar('Emma', 'standard', 'pixar', IMG);
      expect(sa.getStyledAvatar('Emma', 'costumed', 'pixar')).toBeNull();
    });
  });
});

describe('child_torso_uncovered is a CRITICAL, repair-routable type', () => {
  it('a MAJOR slip is floored to CRITICAL cost', () => {
    const crit = scoring.deductionPoints({ type: 'clothing_x_unused', severity: 'critical' });
    const major = scoring.deductionPoints({ type: 'child_torso_uncovered', severity: 'major' });
    const plainMajor = scoring.deductionPoints({ type: 'clothing', severity: 'major' });
    expect(major).toBeGreaterThan(plainMajor);
    expect(major).toBe(scoring.deductionPoints({ type: 'child_torso_uncovered', severity: 'critical' }));
    expect(crit).toBeGreaterThan(0);
  });
  it('is in the consolidated vocabulary and routes to a wardrobe repaint', () => {
    expect(buckets.CONSOLIDATED_TYPES).toContain('child_torso_uncovered');
    expect(buckets.TYPE_TO_BUCKET?.child_torso_uncovered ?? buckets.BUCKETS?.child_torso_uncovered).toBeTruthy();
  });
});

// Staging job_1791267520938_essbvehs8: the EARLY avatar pass logged avatar_category_missing (error)
// five minutes before the final top-up generated Emma's costumed sheet. Only the final pass states the final state.
describe('the early avatar pass does not report an error a later pass can still close', () => {
  const gl: any = nodeRequire('../../server/lib/generationLogger.js');
  const events = (l: any) => l.getEntries().map((e: any) => `${e.level}:${e.event}`);
  it('early pass: a pending warn, no error, no throw', async () => {
    await sa.runInCacheScope('t-early', async () => {
      const l = new gl.GenerationLogger(); gl.setCurrentLogger(l);
      sa.setStyledAvatar('Emma', 'standard', 'pixar', IMG);
      await expect(sa.ensureStyledAvatarCoverage([emma], 'pixar', reqs, { final: false })).resolves.toBeUndefined();
      expect(events(l)).toEqual(['warn:avatar_category_pending']);
      gl.clearCurrentLogger();
    });
  });
  it('final pass after the sheet was generated: nothing logged', async () => {
    await sa.runInCacheScope('t-final-ok', async () => {
      const l = new gl.GenerationLogger(); gl.setCurrentLogger(l);
      sa.setStyledAvatar('Emma', 'standard', 'pixar', IMG);
      sa.setStyledAvatar('Emma', 'costumed:mermaid', 'pixar', IMG);
      await sa.ensureStyledAvatarCoverage([emma], 'pixar', reqs, { final: false });
      await sa.ensureStyledAvatarCoverage([emma], 'pixar', reqs);
      expect(events(l)).toEqual([]);
      gl.clearCurrentLogger();
    });
  });
  it('final pass with the sheet still missing: the error and the throw', async () => {
    await sa.runInCacheScope('t-final-bad', async () => {
      const l = new gl.GenerationLogger(); gl.setCurrentLogger(l);
      sa.setStyledAvatar('Emma', 'standard', 'pixar', IMG);
      await expect(sa.ensureStyledAvatarCoverage([emma], 'pixar', reqs)).rejects.toBeInstanceOf(sa.MissingRequiredCostumeSheetError);
      expect(events(l)).toContain('error:avatar_category_missing');
      gl.clearCurrentLogger();
    });
  });
});
