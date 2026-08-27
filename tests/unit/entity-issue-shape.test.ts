import { describe, it, expect } from 'vitest';

// Two footguns in the entity-consistency result shape, both of which produced
// wrong conclusions that were reported as fact before being caught.
//
// 1) `type` used to be the constant 'consistency' on every entity finding, with
//    the evaluator's real type hidden in `subType`. Every consumer already read
//    `subType || type`, so the constant informed nothing and actively misled: an
//    A/B filtering findings on `type` sees zero clothing findings no matter what
//    the evaluator reported, which is how a working prompt fix was judged dead.
//
// 2) A failed evaluation returned `score: 10` — the top of the scale — with zero
//    issues. A caller that did not also check `evalFailed` read a flawless
//    entity. Twelve consecutive API failures once printed as twelve clean grids.
//
// These assert the SHAPE, so neither can silently return.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
// Normalised: the repo checks out CRLF on Windows, so raw \n anchors miss.
const source = readFileSync(path.join(here, '../../server/lib/entityConsistency.js'), 'utf8')
  .replace(/\r\n/g, '\n');

describe('entity issue shape', () => {
  it('carries the evaluator type in `type`, not a constant', () => {
    // The mapping must not hardcode the literal; it falls back to it only when
    // the evaluator gave no type at all.
    expect(source).toContain("type: issue.type || 'consistency'");
    expect(source).not.toContain("        type: 'consistency',\n        subType: issue.type,");
  });

  it('still populates `subType` for stored evaluations and older readers', () => {
    expect(source).toContain('subType: issue.type,');
  });
});

describe('failed entity evaluation', () => {
  it('does not report a perfect score', () => {
    // The fail-closed return sits next to evalFailed: true.
    const at = source.indexOf('consistent: false,\n    evalFailed: true,');
    expect(at, 'fail-closed return not found').toBeGreaterThan(-1);
    const scoreLine = source.slice(at, at + 900).match(/score:\s*(\d+)/);
    expect(scoreLine, 'no score on the fail-closed return').toBeTruthy();
    expect(Number(scoreLine![1]), 'a failure must not score as a clean grid').toBeLessThan(10);
  });
});
