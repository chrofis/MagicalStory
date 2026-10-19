import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Owner 2026-10-19 ("remove the 6 objects rule"): the trial no longer trims reference cells to 6.
// The cap saved at most one grid call and dropped the plot's central drum and toy chest in 1 of 41
// replayed trials (docs/decisions.md 2026-10-19 "Trial reference cells are not capped").
// generateReferenceSheet needs live image calls, so this pins the wiring: no option, no trim,
// and neither call site passes one.
const root = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

describe('reference cells are not capped', () => {
  it('generateReferenceSheet has no maxElements option and no trim', () => {
    const src = read('server/lib/referenceSheets.js');
    expect(src).not.toMatch(/maxElements/);
    expect(src).not.toMatch(/Limited to top/);
  });

  it('neither the trial nor the full-story call passes a cap', () => {
    const pipe = read('storyJobPipeline.js');
    const calls = [...pipe.matchAll(/generateReferenceSheet\(([\s\S]*?)\n\s*\}\)/g)].map(m => m[1]);
    expect(calls).toHaveLength(2);
    for (const c of calls) expect(c).not.toMatch(/maxElements/);
  });
});
