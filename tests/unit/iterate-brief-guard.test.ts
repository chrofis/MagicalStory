/**
 * The iterate round must never persist a truncated / metadata-less brief.
 *
 * Pinned failure: staging `job_1789207854566_l43qgl34w` page 7 — the
 * `scene_iterate` reply stopped mid-word at 1884 characters inside a character
 * description and carried no `---METADATA---` block. It was stored anyway, so
 * the page's cast/objects/positions/text-placement were empty downstream.
 *
 * These tests pin BEHAVIOUR (which replies are usable, and that an unusable one
 * refuses rather than overwrites), never prompt wording.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { assessIterateBrief, describeIterateBrief } = require('../../server/lib/iterateBriefGuard');

const META = '---METADATA---';

/** A well-formed brief: prose, then the metadata block with sceneIntent. */
function goodBrief(extra: Record<string, unknown> = {}) {
  const meta = JSON.stringify({
    sceneIntent: 'The main character stands at the rim of an opening.',
    shot: 'medium',
    characters: ['Main Character'],
    objects: [],
    ...extra,
  });
  return `The main character stands at the left of the frame, facing right.\n\n${META}\n${meta}`;
}

/** The stored p7 shape: prose cut mid-word, no metadata block at all. */
const TRUNCATED_P7 =
  'Frau Amrein — a fifty-five-year-old tall, slim woman — stands at the left rim of the shaft. ' +
  'A second figure stands at the right rim, facing left. A third figure — a young adult young woman with dark';

describe('assessIterateBrief — which replies are usable', () => {
  it('accepts a well-formed prose + metadata + sceneIntent brief', () => {
    const a = assessIterateBrief(goodBrief());
    expect(a.usable).toBe(true);
    expect(a.reason).toBeNull();
  });

  it('REJECTS the stored p7 reply: cut mid-sentence, no metadata block', () => {
    const a = assessIterateBrief(TRUNCATED_P7);
    expect(a.usable).toBe(false);
    expect(a.reason).toBe('no_metadata_block');
    // the operator must be able to see WHERE it stopped
    expect(a.detail).toContain('with dark');
    expect(a.detail).toContain(String(TRUNCATED_P7.length));
  });

  it('accepts the FENCED form (prose + ```json), which has no ---METADATA--- marker', () => {
    // Real stored shape: job_1787991502308_i9ah2221i. Requiring the marker
    // would reject complete briefs, so the contract is "parseable metadata
    // carrying sceneIntent", not "the marker is present".
    const fenced = 'Medium shot framing the figures from the waist up.\n\n```json\n'
      + JSON.stringify({ sceneIntent: 'Two figures face each other.', shot: 'medium', characters: [] })
      + '\n```';
    const a = assessIterateBrief(fenced);
    expect(a.usable).toBe(true);
  });

  it('rejects an empty reply', () => {
    expect(assessIterateBrief('').reason).toBe('empty');
    expect(assessIterateBrief('   \n ').reason).toBe('empty');
    expect(assessIterateBrief(null).usable).toBe(false);
  });

  it('rejects a metadata block whose JSON is itself cut off', () => {
    const a = assessIterateBrief(`Some prose.\n\n${META}\n{"sceneIntent": "a scene", "charac`);
    expect(a.usable).toBe(false);
    expect(a.reason).toBe('metadata_unparseable');
  });

  it('rejects parseable metadata that omits sceneIntent (the pre-existing contract)', () => {
    const a = assessIterateBrief(
      `Some prose.\n\n${META}\n${JSON.stringify({ shot: 'medium', characters: [] })}`,
    );
    expect(a.usable).toBe(false);
    expect(a.reason).toBe('no_scene_intent');
  });

  it('rejects a brief the text truncation guard already suspects, even when it parses', () => {
    const a = assessIterateBrief(goodBrief(), {
      truncation: { suspected: true, reason: 'stop_reason', stopReason: 'length', outputTokens: 500, capInForce: 32768 },
    });
    expect(a.usable).toBe(false);
    expect(a.reason).toBe('reply_truncated');
  });

  it('a NOT-suspected truncation verdict does not block a good brief', () => {
    const a = assessIterateBrief(goodBrief(), { truncation: { suspected: false, reason: null } });
    expect(a.usable).toBe(true);
  });

  it('never throws, whatever it is handed', () => {
    for (const v of [undefined, null, 0, {}, [], 'x', META]) {
      expect(() => assessIterateBrief(v as any)).not.toThrow();
    }
  });

  it('surfaces a parser that throws as metadata_unparseable rather than propagating', () => {
    const a = assessIterateBrief(`prose\n\n${META}\n{}`, {
      extractSceneMetadata: () => { throw new Error('boom'); },
    });
    expect(a.reason).toBe('metadata_unparseable');
    expect(a.detail).toContain('boom');
  });
});

describe('describeIterateBrief — the loud log line', () => {
  it('names the reason and the detail for an unusable brief', () => {
    const line = describeIterateBrief(assessIterateBrief(TRUNCATED_P7));
    expect(line).toContain('no_metadata_block');
    expect(line).toContain('no parseable scene metadata');
  });

  it('says so plainly for a usable one', () => {
    expect(describeIterateBrief(assessIterateBrief(goodBrief()))).toBe('usable brief');
  });
});

describe('the iterate path refuses rather than overwrites', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../../server/lib/images.js'),
    'utf8',
  );

  it('iteratePageCore consults the guard on the first scene_iterate reply', () => {
    expect(src).toContain("require('./iterateBriefGuard')");
    expect(src).toMatch(/assessIterateBrief\(newSceneDescription, \{ truncation: sceneResult\.truncation \}\)/);
  });

  it('it retries once and then THROWS — a cut brief is never returned', () => {
    const block = src.slice(src.indexOf('assessIterateBrief'), src.indexOf('Extract previewMismatches'));
    expect(block).toContain("usageLabel: 'scene_iterate_retry'");
    expect(block).toMatch(/throw new Error\(`iterate brief unusable for page/);
    // the retry reply is checked by the SAME guard, not waved through
    expect(block).toMatch(/assessIterateBrief\(retry\.text/);
  });

  it('the failure is logged at ERROR level before it throws', () => {
    const block = src.slice(src.indexOf('assessIterateBrief'), src.indexOf('Extract previewMismatches'));
    const errIdx = block.indexOf('log.error');
    const throwIdx = block.indexOf('throw new Error');
    expect(errIdx).toBeGreaterThan(-1);
    expect(errIdx).toBeLessThan(throwIdx);
  });
});
