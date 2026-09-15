import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { diffCastRemovals, parseCastRemovals, revertUndeclaredRemovals } = require_('../../server/lib/sceneReviewGuard.js');

/**
 * Real shape from staging job_1789420511893_zly5rcdej p16: the review rewrite
 * emptied `characters[]` with no REMOVED CAST line. It was detected, logged at
 * error, and rendered anyway — the corrupt cast then produced a phantom
 * CRITICAL extra_character, three repair rounds, and a destroyed original.
 */
const brief = (cast: string[], prose: string) =>
  `${prose}\n---METADATA---\n${JSON.stringify({ characters: cast.map(name => ({ name })), objects: [] })}`;

const BEFORE = brief(['Emma', 'Noah', 'Daniel'], 'Emma, Noah and Daniel stand together on the quay at dusk.');
const AFTER = brief([], 'Three children stand together on the quay at dusk.');

const makeState = () => {
  const expansions = [{ pageNumber: 16, brief: AFTER, reviewRewrote: true }];
  const sceneDiffs = [{ pageNumber: 16, before: BEFORE, after: AFTER }];
  const changed = [16];
  return { expansions, sceneDiffs, changed };
};

const auditFor = (declaredText: string) => diffCastRemovals(
  [{ pageNumber: 16, beforeCast: ['Emma', 'Noah', 'Daniel'], afterCast: [], afterObjects: [] }],
  parseCastRemovals(declaredText),
).filter((r: { undeclared: string[] }) => r.undeclared.length > 0);

describe('an undeclared cast removal is reverted, not shipped', () => {
  it('restores the pre-review brief and un-marks the page as rewritten', () => {
    const { expansions, sceneDiffs, changed } = makeState();
    const reverted = revertUndeclaredRemovals(expansions, sceneDiffs, changed, auditFor('FAULTED PAGES: 16'));
    expect(reverted).toEqual([{ pageNumber: 16, undeclared: ['emma', 'noah', 'daniel'] }]);
    expect(expansions[0].brief).toBe(BEFORE);
    expect(expansions[0].reviewRewrote).toBe(false);
    // The page is no longer counted as rewritten, so the faulted-but-not-fixed
    // check downstream sees it as unfixed — which it now is.
    expect(changed).toEqual([]);
    expect(sceneDiffs).toEqual([]);
  });

  it('a DECLARED removal is left alone', () => {
    const { expansions, sceneDiffs, changed } = makeState();
    const audit = auditFor('REMOVED CAST: page 16 = Emma, Noah, Daniel: merged into an unnamed crowd\nFAULTED PAGES: 16');
    expect(audit).toEqual([]);
    const reverted = revertUndeclaredRemovals(expansions, sceneDiffs, changed, audit);
    expect(reverted).toEqual([]);
    expect(expansions[0].brief).toBe(AFTER);
    expect(changed).toEqual([16]);
  });

  it('a page with no captured before-brief is left alone', () => {
    const expansions = [{ pageNumber: 16, brief: AFTER, reviewRewrote: true }];
    const changed = [16];
    const reverted = revertUndeclaredRemovals(expansions, [], changed, auditFor('FAULTED PAGES: 16'));
    expect(reverted).toEqual([]);
    expect(expansions[0].brief).toBe(AFTER);
  });

  it('only the offending page is reverted', () => {
    const otherBefore = brief(['Emma'], 'Emma waits.');
    const otherAfter = brief(['Emma'], 'Emma waits by the rope.');
    const expansions = [
      { pageNumber: 15, brief: otherAfter, reviewRewrote: true },
      { pageNumber: 16, brief: AFTER, reviewRewrote: true },
    ];
    const sceneDiffs = [
      { pageNumber: 15, before: otherBefore, after: otherAfter },
      { pageNumber: 16, before: BEFORE, after: AFTER },
    ];
    const changed = [15, 16];
    revertUndeclaredRemovals(expansions, sceneDiffs, changed, auditFor('FAULTED PAGES: 16'));
    expect(expansions[0].brief).toBe(otherAfter);
    expect(expansions[1].brief).toBe(BEFORE);
    expect(changed).toEqual([15]);
    expect(sceneDiffs.map(d => d.pageNumber)).toEqual([15]);
  });
});
