/**
 * A Test Lab redo rebuilds the ORIGINAL unit (code review 2026-10-04 L2), and a
 * redo counts as busy work (L1). The set member's params and a pinned version
 * live on the experiment's targets, not on the result entry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { unitFor, originalTargetOf } = require_('../../server/lib/testlabUnit.js');

describe('unitFor', () => {
  it('merges base, set-member and variant params in that order and keeps the pin', () => {
    const { target, unitParams } = unitFor({ a: 1, b: 1 }, { storyId: 's', pageNumber: 2, versionIndex: 3, _params: { b: 2, c: 2 } }, { c: 3 });
    expect(target).toEqual({ storyId: 's', pageNumber: 2, versionIndex: 3 });
    expect(unitParams).toEqual({ a: 1, b: 2, c: 3, versionIndex: 3 });
  });
  it('an explicit params.versionIndex beats the target pin', () => {
    expect(unitFor({ versionIndex: 9 }, { storyId: 's', versionIndex: 3 }, null).unitParams.versionIndex).toBe(9);
  });
});

describe('originalTargetOf', () => {
  const targets = [
    { storyId: 's', pageNumber: 1, versionIndex: 4, _params: { x: 1 } },
    { storyId: 's', pageNumber: 2 },
    { storyId: 's', pageNumber: 2, versionIndex: 7 },
  ];
  it('reads the target by targetIndex, with pin and member params', () => {
    // the result's own versionIndex (0) must not replace the target's pin (4)
    const t = originalTargetOf({ targets }, { storyId: 's', pageNumber: 1, versionIndex: 0, targetIndex: 0 });
    expect(t.versionIndex).toBe(4);
    expect(t._params).toEqual({ x: 1 });
  });
  it('a legacy entry is matched by story and page only when unique', () => {
    expect(originalTargetOf({ targets }, { storyId: 's', pageNumber: 1 }).versionIndex).toBe(4);
    expect(() => originalTargetOf({ targets }, { storyId: 's', pageNumber: 2 })).toThrow(/cannot identify/);
  });
});

describe('redo is visible to the push gate', () => {
  const src = readFileSync('server/routes/admin/testlab.js', 'utf8');
  it('registers a busy probe and brackets the redo with an analyzer session', () => {
    expect(src).toMatch(/registerBusyProbe\('testlab-redo'/);
    expect(src).toMatch(/sessionBegin\(sessionName\)/);
    expect(src).toMatch(/sessionEnd\(sessionName\)/);
  });
  it('the set run claims its slot before any await', () => {
    const run = src.slice(src.indexOf("router.post('/sets/:id/run'"));
    expect(run.indexOf('runningExperiments++')).toBeLessThan(run.indexOf('await dbQuery'));
    expect(run).toMatch(/target_count/);
  });
});
