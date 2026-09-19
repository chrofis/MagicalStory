import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { diffCastRemovals, parseCastRemovals, restoreUndeclaredRemovals, castArraySpan } =
  require_('../../server/lib/sceneReviewGuard.js');
const { extractSceneMetadata } = require_('../../server/lib/sceneMetadata.js');

/**
 * Real shape from staging job_1789420511893_zly5rcdej p16: the review rewrite
 * emptied `characters[]` with no REMOVED CAST line. It was detected, logged at
 * error, and rendered anyway — the corrupt cast then produced a phantom
 * CRITICAL extra_character, three repair rounds, and a destroyed original.
 *
 * The 2026-09-15 answer was to revert the WHOLE page brief. Measured cost on
 * staging job_1789584708605_rts4wqupm p18 (owner, 2026-09-17: "too blunt"): the
 * reviewer dropped four names, the page shipped its PRE-REVIEW brief
 * (`namedButNotRewritten: [18]`) and scored 45 where the previous run's
 * reviewed p18 scored 95. Only the dropped cast comes back now; the rest of the
 * reviewed brief stands.
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

const castOf = (text: string) => (extractSceneMetadata(text)?.characters || [])
  .map((c: any) => (typeof c === 'string' ? c : c?.name));

describe('an undeclared cast removal is restored, not shipped and not reverted whole', () => {
  it('puts the dropped names back into the REVIEWED brief', () => {
    const { expansions, sceneDiffs, changed } = makeState();
    const { restored, reverted } = restoreUndeclaredRemovals(expansions, sceneDiffs, changed, auditFor('FAULTED PAGES: 16'));
    expect(reverted).toEqual([]);
    expect(restored).toEqual([{ pageNumber: 16, names: ['Emma', 'Noah', 'Daniel'] }]);
    expect(castOf(expansions[0].brief)).toEqual(['Emma', 'Noah', 'Daniel']);
  });

  it('keeps the rest of the reviewed brief — its prose and its rewritten status', () => {
    const { expansions, sceneDiffs, changed } = makeState();
    restoreUndeclaredRemovals(expansions, sceneDiffs, changed, auditFor('FAULTED PAGES: 16'));
    // THE POINT: the review's own prose survives. The old whole-brief revert
    // threw it away along with every other fix that review made to the page.
    expect(expansions[0].brief).toContain('Three children stand together on the quay at dusk.');
    expect(expansions[0].brief).not.toContain('Emma, Noah and Daniel stand together');
    expect(expansions[0].reviewRewrote).toBe(true);
    expect(changed).toEqual([16]);
    // The diff record follows the patched brief, so nothing downstream reads a
    // stale `after`.
    expect(sceneDiffs[0].after).toBe(expansions[0].brief);
  });

  it('restores into a NON-empty characters[] without disturbing the survivors', () => {
    const after = brief(['Emma'], 'Emma stands with two other children on the quay.');
    const expansions = [{ pageNumber: 16, brief: after, reviewRewrote: true }];
    const sceneDiffs = [{ pageNumber: 16, before: BEFORE, after }];
    const audit = diffCastRemovals(
      [{ pageNumber: 16, beforeCast: ['Emma', 'Noah', 'Daniel'], afterCast: ['Emma'], afterObjects: [] }],
      parseCastRemovals('FAULTED PAGES: 16'),
    );
    const { restored } = restoreUndeclaredRemovals(expansions, sceneDiffs, [16], audit);
    expect(restored[0].names).toEqual(['Noah', 'Daniel']);
    expect(castOf(expansions[0].brief)).toEqual(['Emma', 'Noah', 'Daniel']);
  });

  it('a DECLARED removal is left alone', () => {
    const { expansions, sceneDiffs, changed } = makeState();
    const audit = auditFor('REMOVED CAST: page 16 = Emma, Noah, Daniel: merged into an unnamed crowd\nFAULTED PAGES: 16');
    expect(audit).toEqual([]);
    const { restored, reverted } = restoreUndeclaredRemovals(expansions, sceneDiffs, changed, audit);
    expect(restored).toEqual([]);
    expect(reverted).toEqual([]);
    expect(expansions[0].brief).toBe(AFTER);
    expect(changed).toEqual([16]);
  });

  it('a page with no captured before-brief is left alone', () => {
    const expansions = [{ pageNumber: 16, brief: AFTER, reviewRewrote: true }];
    const changed = [16];
    const { restored, reverted } = restoreUndeclaredRemovals(expansions, [], changed, auditFor('FAULTED PAGES: 16'));
    expect(restored).toEqual([]);
    expect(reverted).toEqual([]);
    expect(expansions[0].brief).toBe(AFTER);
  });

  it('only the offending page is touched', () => {
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
    restoreUndeclaredRemovals(expansions, sceneDiffs, changed, auditFor('FAULTED PAGES: 16'));
    expect(expansions[0].brief).toBe(otherAfter);
    expect(castOf(expansions[1].brief)).toEqual(['Emma', 'Noah', 'Daniel']);
    expect(changed).toEqual([15, 16]);
    expect(sceneDiffs.map(d => d.pageNumber)).toEqual([15, 16]);
  });

  it('FALLBACK — a reviewed brief with no locatable characters[] still reverts whole', () => {
    // The emptied cast must never render; when the array cannot be found
    // structurally the pre-2026-09-17 behaviour stands for that page alone.
    const noMeta = 'Three children stand together on the quay at dusk.';
    const expansions = [{ pageNumber: 16, brief: noMeta, reviewRewrote: true }];
    const sceneDiffs = [{ pageNumber: 16, before: BEFORE, after: noMeta }];
    const changed = [16];
    const { restored, reverted } = restoreUndeclaredRemovals(expansions, sceneDiffs, changed, auditFor('FAULTED PAGES: 16'));
    expect(restored).toEqual([]);
    expect(reverted).toEqual([{ pageNumber: 16, undeclared: ['emma', 'noah', 'daniel'] }]);
    expect(expansions[0].brief).toBe(BEFORE);
    expect(expansions[0].reviewRewrote).toBe(false);
    expect(changed).toEqual([]);
    expect(sceneDiffs).toEqual([]);
  });
});

describe('the characters[] span is bracket-matched, never regex-guessed', () => {
  it('stops at the array close, not at a nested one', () => {
    const text = '---METADATA---\n{"objects":["A"],"characters":[{"name":"Emma","tags":["a","b"]}],"shot":"wide"}';
    const span = castArraySpan(text);
    expect(text.slice(span.open, span.close + 1)).toBe('[{"name":"Emma","tags":["a","b"]}]');
  });

  it('is not fooled by a bracket inside a string value', () => {
    const text = '---METADATA---\n{"characters":[{"name":"Emma","expression":"tense ] look"}]}';
    const span = castArraySpan(text);
    expect(text.slice(span.open, span.close + 1)).toBe('[{"name":"Emma","expression":"tense ] look"}]');
  });

  it('returns null when there is no characters key', () => {
    expect(castArraySpan('---METADATA---\n{"objects":[]}')).toBeNull();
  });
});
