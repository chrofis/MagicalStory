/**
 * The cut order the docs show is the one the code runs (owner, 2026-09-24:
 * "code and docs must read from the same list; no second copy").
 * docs/image-generation-methods.html and docs/prompt-inventory.md carry a
 * section generated from images.js PROMPT_CUT_ORDER / PROMPT_NEVER_CUT; this
 * fails when either doc no longer matches. Fix: node scripts/admin/sync-prompt-cut-order-docs.js
 */
import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const sync = require('../../scripts/admin/sync-prompt-cut-order-docs.js');

describe('prompt cut order docs', () => {
  it('both docs carry the generated section, up to date with the code', () => {
    expect(sync.sync({ check: true })).toEqual([]);
  });

  it('the rendered list is the code list, in order', () => {
    const data = sync.cutOrder();
    const md = sync.renderMarkdown(data);
    data.steps.forEach((s: any, i: number) => expect(md).toContain(`${i + 1}. **${s.label}**`));
    // The caps shown are the config's (UTF-8 bytes; raised 2026-10-04, decisions.md "Grok prompt caps are 16,000 / 64,000 bytes").
    expect(data.grokCaps.length).toBeGreaterThan(0);
    for (const cap of data.grokCaps) expect(md).toContain(cap.toLocaleString('en-US'));
    expect(md).toContain('15,900');
  });
});
