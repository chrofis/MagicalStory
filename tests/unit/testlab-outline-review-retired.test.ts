import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = (...p: string[]) => readFileSync(path.join(root, ...p), 'utf8');

// BEHAVIOUR PINNED: the `outline_review` Test Lab stage is RETIRED (2026-09-13).
//
// It forced `splitOutlineReview: true` and measured buildUnifiedStoryPrompt +
// buildOutlineReviewPrompt. storyJobPipeline gates that branch behind
// `!beatsMode && !inputData.trialMode && splitOutlineReviewEnabled`, and
// server/config/runtime.js sets pipelineMode 'beats' in every environment — so
// production makes neither call. The stage measured a configuration that cannot
// ship. Its beats analogues are their own stages (arc review, text_refine,
// scene review).
//
// Asserted as source text, not by importing testlab.js: that module is a
// high-level pipeline module and importing it here is a known memory hazard.
//
// The server registry and the client mirror must stay in step — a stage in one
// and not the other is either an unstartable dropdown entry or a hidden runner.

const serverSrc = read('server', 'lib', 'testlab.js');
const clientSrc = read('client', 'src', 'services', 'testlabService.ts');

describe('the outline_review Test Lab stage is retired', () => {
  it('is not registered as a stage runner', () => {
    // A registry line is `  <stage>: run<Something>Stage,`. Matching the shape
    // rather than slicing the (very long) object literal keeps this robust.
    const keys = [...serverSrc.matchAll(/^ {2}([a-z0-9_]+): run[A-Za-z0-9]+Stage,$/gm)].map(m => m[1]);
    expect(keys.length).toBeGreaterThan(20);
    expect(keys).not.toContain('outline_review');
    expect(keys).toContain('text_refine'); // the beats-chain analogue stays
  });

  it('has no runner function left in testlab.js', () => {
    expect(serverSrc).not.toContain('runOutlineReviewStage');
  });

  it('is not offered in the client TESTLAB_STAGES mirror', () => {
    const start = clientSrc.indexOf('export const TESTLAB_STAGES');
    expect(start).toBeGreaterThan(-1);
    const block = clientSrc.slice(start, clientSrc.indexOf('\n];', start));
    const ids = [...block.matchAll(/\{\s*id:\s*'([a-z0-9_]+)'/g)].map(m => m[1]);
    expect(ids.length).toBeGreaterThan(20);
    expect(ids).not.toContain('outline_review');
    expect(ids).toContain('text_refine');
  });

  it('still renders STORED outline_review experiments (7 rows on staging)', () => {
    // The detail renderer keys off the stored result shape, never the stage
    // registry — retiring a stage must not break the Lab UI for past runs.
    const page = read('client', 'src', 'pages', 'TestLab.tsx');
    expect(page).toContain("result.stageKind === 'outline_review'");
  });
});
