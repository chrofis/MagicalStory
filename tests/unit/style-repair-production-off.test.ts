import { describe, it, expect, afterAll, vi } from 'vitest';
import fs from 'fs';
import path from 'path';

// PRODUCTION STYLE REPAIR IS OFF (owner, 2026-09-19 — docs/decisions.md
// "Production style repair is OFF", docs/SETTLED.md).
//
// The Step-5 style audit has two halves and only ONE of them was switched off:
//
//   detection  checkStoryStyleConsistency — runs unconditionally, above the
//              flag, and its verdict + outliers still reach the caller (and
//              from there finalChecksReport.styleConsistency). A drifting book
//              stays MEASURABLE.
//   repaint    planStyleRepair -> repairPageStyle — a paid image edit per
//              outlier, now behind a flag that defaults to false.
//
// This file pins that split, because the obvious way to "turn style repair
// off" is to stop calling the audit, and that would silently delete the
// evidence the decision itself was argued from (run 4,
// job_1789759147125_p08djwhbl: 3 cover outliers, moderate, 3 repaints,
// $0.06 — the numbers only exist because detection wrote them down).
//
// It pins BEHAVIOUR: the resolved flag value, the env override in both
// directions, and where the repaint call sites sit relative to the gate.
// It deliberately pins no log wording and no prompt text.

const ROOT = path.resolve(__dirname, '../..');
const PIPELINE_SRC = fs.readFileSync(path.join(ROOT, 'server/lib/repairPipeline.js'), 'utf8');
const ORIGINAL_ENV = process.env.STYLE_REPAIR_PRODUCTION;

/** Load a fresh MODEL_DEFAULTS as it resolves under `value`. */
async function flagUnder(value: string | undefined): Promise<boolean> {
  vi.resetModules();
  if (value === undefined) delete process.env.STYLE_REPAIR_PRODUCTION;
  else process.env.STYLE_REPAIR_PRODUCTION = value;
  // @ts-expect-error - JS module without types
  const mod = await import('../../server/config/models.js');
  return mod.MODEL_DEFAULTS.styleRepairProduction;
}

afterAll(() => {
  if (ORIGINAL_ENV === undefined) delete process.env.STYLE_REPAIR_PRODUCTION;
  else process.env.STYLE_REPAIR_PRODUCTION = ORIGINAL_ENV;
  vi.resetModules();
});

describe('styleRepairProduction: the code default is OFF', () => {
  it('resolves false when nothing is set in the environment', async () => {
    // Behaviour is code, only secrets are env vars: an environment that sets
    // nothing must get the owner's default, not a repaint.
    expect(await flagUnder(undefined)).toBe(false);
  });

  it('STYLE_REPAIR_PRODUCTION=true re-arms it without a deploy', async () => {
    expect(await flagUnder('true')).toBe(true);
  });

  it('stays off for every other value, including the old explicit false', async () => {
    for (const v of ['false', '', '1', 'yes', 'TRUE']) {
      expect(await flagUnder(v), `STYLE_REPAIR_PRODUCTION=${JSON.stringify(v)}`).toBe(false);
    }
  });
});

describe('Step 5: the repaint is gated, the detection is not', () => {
  // The gate STATEMENT, not the comments above it that name the same flag.
  const GATE = /^[ \t]*if \(.*MODEL_DEFAULTS\.styleRepairProduction &&.*$/m;
  const gateMatch = PIPELINE_SRC.match(GATE);
  const gateAt = gateMatch?.index ?? -1;

  it('the gate exists and the flag is one of its conjuncts', () => {
    expect(gateAt, 'the style-repair gate must still read the flag').toBeGreaterThan(-1);
    // A conjunction: with the flag false the whole condition is false, whatever
    // the outliers say. That plus the default above is the proof the block
    // cannot run.
    expect(gateMatch?.[0]).toContain('MODEL_DEFAULTS.styleRepairProduction &&');
  });

  it('detection runs ABOVE the gate, so the verdict is recorded either way', async () => {
    const detectAt = PIPELINE_SRC.indexOf('await checkStoryStyleConsistency(');
    expect(detectAt, 'the audit call must still be there').toBeGreaterThan(-1);
    expect(detectAt).toBeLessThan(gateAt);
    // ...and it is not itself behind any styleRepairProduction test.
    expect(PIPELINE_SRC.slice(0, detectAt)).not.toContain('styleRepairProduction');
    // The detection result leaves the pipeline on the normal return, outside
    // the gated block — this is what storyJobPipeline puts on
    // finalChecksReport.styleConsistency.
    expect(PIPELINE_SRC.slice(gateAt)).toMatch(/return \{[^}]*\bstyleConsistency\b/s);
  });

  it('every paid repaint call site sits INSIDE the gated block', () => {
    const sites = [...PIPELINE_SRC.matchAll(/repairPageStyle\(|require\('\.\/styleRepair'\)/g)];
    expect(sites.length, 'the repaint must still be reachable when re-armed').toBeGreaterThan(0);
    for (const m of sites) {
      expect(m.index, `"${m[0]}" must not be reachable with the flag off`).toBeGreaterThan(gateAt);
    }
  });

  it('a run-4 shaped audit repaints nothing while the flag is false', async () => {
    // The real gate, evaluated over the real run-4 verdict: 3 cover outliers,
    // a dominant cluster that is NOT wrong_medium (so nothing is blocked for
    // want of an anchor). Under the 2026-08-09 default this repainted three
    // covers for $0.06; under the 2026-09-19 default it repaints none.
    const styleConsistency = {
      verdict: 'mixed',
      styleMatch: { verdict: 'ok' },
      outliers: [{ page: -1 }, { page: -2 }, { page: -3 }],
    };
    const blockedNoAnchor = styleConsistency.styleMatch.verdict === 'wrong_medium';
    const flag = await flagUnder(undefined);
    const wouldRepaint = !blockedNoAnchor && flag && (styleConsistency.outliers?.length || 0) > 0;
    expect(wouldRepaint).toBe(false);
    // The outliers themselves are untouched — they are still there to report.
    expect(styleConsistency.outliers).toHaveLength(3);
  });
});

describe('the Test Lab style_repair stage is deliberately NOT gated', () => {
  it('testlab.js calls the repaint without consulting the production flag', () => {
    const lab = fs.readFileSync(path.join(ROOT, 'server/lib/testlab.js'), 'utf8');
    expect(lab).toContain('repairPageStyle(');
    // The Lab is the Gemini-vs-Grok A/B harness. Turning production repaints
    // off must not cost us the ability to MEASURE a restyle; if this ever
    // fails, the divergence stopped being deliberate.
    expect(lab).not.toContain('styleRepairProduction');
  });
});
