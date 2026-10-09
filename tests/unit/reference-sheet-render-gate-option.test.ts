import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// Trial reference sheets run with NO cell render gate (owner, 2026-10-09; docs/decisions.md
// "Trial reference sheets: no render gate"); a full story keeps it. The gate is an explicit option
// the caller passes, never a mode sniff inside the module. generateReferenceSheet needs live image
// calls, so this pins the wiring: the default is gated, both gate paths (state batch, per-cell loop)
// read the option, the trial call passes false and the full-story call passes nothing.
const root = path.resolve(__dirname, '../..');
const read = (f: string) => fs.readFileSync(path.join(root, f), 'utf8');

describe('generateReferenceSheet renderGate option', () => {
  const src = read('server/lib/referenceSheets.js');

  it('defaults to gated, so a caller that says nothing keeps the gate', () => {
    expect(src).toMatch(/renderGate = true,/);
  });

  it('both gate paths are behind the option', () => {
    expect(src).toMatch(/if \(renderGate && isStateBatch\)/);
    expect(src).toMatch(/!isStateBatch && renderGate; i\+\+/);
  });

  it('the trial call passes renderGate: false and the full-story call does not', () => {
    const pipe = read('storyJobPipeline.js');
    const calls = [...pipe.matchAll(/generateReferenceSheet\(([\s\S]*?)\n\s*\}\)/g)].map(m => m[1]);
    expect(calls).toHaveLength(2);
    const trial = calls.find(c => c.includes('streamingVisualBible'))!;
    const full = calls.find(c => !c.includes('streamingVisualBible'))!;
    expect(trial).toMatch(/renderGate: false/);
    expect(full).not.toMatch(/renderGate/);
  });
});
