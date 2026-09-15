import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const SRC = fs.readFileSync(path.join(ROOT, 'server/lib/beatsPipeline.js'), 'utf8');

/**
 * The re-plan merge restores every page no finding named from the division that
 * stands. It used to be gated on `namedPages.size > 0`, so when no finding named
 * a page — a whole-book finding, or one whose page reference could not be read —
 * the merge was skipped entirely and a partial answer fell through to the
 * page-count guard, which discarded the round without a word.
 *
 * Source-scan: the merge is inline in a long orchestration function and cannot
 * be called on its own; pinning its shape is what stops the gate coming back.
 */
describe('beats re-plan merge scope', () => {
  it('the merge is no longer gated on a finding having named a page', () => {
    expect(SRC).not.toMatch(/if \(namedPages\.size > 0\) \{/);
    expect(SRC).toMatch(/const scopeAll = namedPages\.size === 0;/);
  });

  it('with no named page every returned page is accepted', () => {
    expect(SRC).toMatch(/if \(scopeAll \|\| namedPages\.has\(pg\.pageNumber\)/);
  });

  it('a page the return omits is still filled from the standing division', () => {
    expect(SRC).toMatch(/for \(const \[num, pg\] of standing\) if \(!kept\.some/);
  });

  it('the unnamed-page warning is not raised when the whole book was in scope', () => {
    expect(SRC).toMatch(/const overridden = scopeAll \? 0 :/);
  });
});
