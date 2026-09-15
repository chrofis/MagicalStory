/**
 * The sibling gate's decision core, including the vouching marker.
 *
 * WHY VOUCHING EXISTS — 2026-09-15. The honest catch-up case cannot use the
 * same-commit marker. A commit fixes the sibling of a fix that was already
 * pushed, so the push range cannot cover the counterpart, and the gate blocks it.
 * Rewording that commit means a rebase, which rewrites every hash after it —
 * hashes that handoff notes cite. A LATER commit in the same push may therefore
 * vouch for an earlier one by sha, which adds history instead of rewriting it.
 *
 * The rules that keep it from becoming a loophole are the ones tested here: the
 * prefix must resolve, resolve uniquely, and name a commit inside the push; a
 * commit may not vouch for itself; and the reason is mandatory.
 */
import { describe, it, expect } from 'vitest';

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { analyze } = require('../../scripts/admin/check-sibling-paths.js');

const SET = {
  id: 'lector-and-diff-pass',
  axis: 'lector prompt vs diff-pass prompt',
  reason: 'same parser and applier',
  members: ['prompts/story-text-proofread.txt', 'prompts/story-text-diff.txt'],
  severity: 'block',
};

const partial = (sha: string, message: string) => ({
  sha,
  message,
  files: ['prompts/story-text-diff.txt'],
});

describe('sibling gate: vouching', () => {
  it('blocks a one-sided commit with no marker', () => {
    const r = analyze([partial('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'fix: diff lector')], [SET]);
    expect(r.vouchErrors).toEqual([]);
    expect(r.blocks.map((b: any) => b.set.id)).toEqual(['lector-and-diff-pass']);
  });

  it('passes when a later commit in the range vouches for it, and names the voucher', () => {
    const r = analyze(
      [
        partial('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'fix: diff lector'),
        {
          sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          message: 'chore: vouch\n\nSiblings-Checked: aaaaaaa — sibling fixed in already-pushed 9a41a6c67',
          files: [],
        },
      ],
      [SET]
    );
    expect(r.vouchErrors).toEqual([]);
    expect(r.blocks).toEqual([]);
    expect(r.warns).toHaveLength(1);
    expect(r.warns[0].excused).toBe(true);
    expect(r.warns[0].vouch.by).toBe('bbbbbbbbb');
    expect(r.warns[0].vouch.reason).toContain('9a41a6c67');
  });

  it('rejects a vouch for a sha outside the push range', () => {
    const r = analyze(
      [
        partial('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'fix: diff lector'),
        {
          sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          message: 'chore: vouch\n\nSiblings-Checked: 9a41a6c — already pushed, not in this range',
          files: [],
        },
      ],
      [SET]
    );
    expect(r.vouchErrors).toHaveLength(1);
    expect(r.vouchErrors[0]).toContain('not a commit in this push range');
  });

  it('rejects an ambiguous sha prefix rather than guessing', () => {
    const r = analyze(
      [
        partial('abc1234000000000000000000000000000000000', 'fix a'),
        partial('abc1234fffffffffffffffffffffffffffffffff', 'fix b'),
        {
          sha: 'cccccccccccccccccccccccccccccccccccccccc',
          message: 'chore: vouch\n\nSiblings-Checked: abc1234 — ambiguous on purpose',
          files: [],
        },
      ],
      [SET]
    );
    expect(r.vouchErrors).toHaveLength(1);
    expect(r.vouchErrors[0]).toContain('ambiguous');
  });

  it('rejects a commit vouching for itself', () => {
    const sha = 'dddddddddddddddddddddddddddddddddddddddd';
    const r = analyze(
      [{ ...partial(sha, `fix: diff lector\n\nSiblings-Checked: ${sha.slice(0, 8)} — me, myself`), sha }],
      [SET]
    );
    expect(r.vouchErrors).toHaveLength(1);
    expect(r.vouchErrors[0]).toContain('vouches for itself');
  });

  it('a vouch line does not silently excuse the vouching commit own siblings', () => {
    const r = analyze(
      [
        partial('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'fix: diff lector'),
        {
          // This commit is ALSO one-sided, and carries only a vouch for another
          // commit — that must not double as its own excuse.
          sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
          message: 'fix: another one-sided change\n\nSiblings-Checked: aaaaaaa — sibling already pushed',
          files: ['prompts/story-text-diff.txt'],
        },
      ],
      [SET]
    );
    expect(r.vouchErrors).toEqual([]);
    expect(r.blocks.map((b: any) => b.sha)).toEqual(['bbbbbbbbb']);
  });

  it('still honours the plain same-commit marker', () => {
    const r = analyze(
      [partial('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'fix: diff lector\n\nSiblings-Checked: the lector contract is unchanged')],
      [SET]
    );
    expect(r.blocks).toEqual([]);
    expect(r.warns[0].excused).toBe(true);
  });

  it('requires a reason after the sha', () => {
    const r = analyze(
      [
        partial('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'fix: diff lector'),
        { sha: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb', message: 'chore\n\nSiblings-Checked: aaaaaaa —', files: [] },
      ],
      [SET]
    );
    expect(r.blocks).toHaveLength(1);
  });
});
