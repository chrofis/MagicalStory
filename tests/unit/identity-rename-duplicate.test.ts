import { describe, it, expect, beforeAll } from 'vitest';
import { createRequire } from 'node:module';

const require_ = createRequire(import.meta.url);
const { reconcileIdentity, checkIdentityAgreement } = require_('../../server/lib/identityAgreement');
const { evaluateThreeStage } = require_('../../server/lib/evalPipeline');
const { loadPromptTemplates } = require_('../../server/services/prompts');
const textModels = require_('../../server/lib/textModels');

// THE DEFECT (2026-09-14). A shipped page carried two of its one plot object,
// because a CRITICAL finding asked for a second one to be drawn — and that
// finding named a character the page's spec never cast in that role.
//
// Two independent faults stacked:
//
//   1. The compliance judge read a line of DIALOGUE in STORY_TEXT (a character
//      SAYING they will carry the object) as a staging declaration, and filed
//      "<name> is declared to carry <object> but inventory shows hands empty"
//      as CRITICAL. No stored field — sceneIntent, the brief prose,
//      interactions[] or objects[] — declares that character as the carrier.
//
//   2. The identity reconciler then RENAMED that finding onto a different
//      child, so the invented declaration arrived downstream attached to a name
//      that appears nowhere near it. The rename target was a name an AGREEING
//      match already held: after it, `matches[]` named one child twice and the
//      other not at all.
//
// Every fixture value below is the REAL stored shape pulled from staging story
// job_1789348171785_9oxos7dwv page 7, imageVersions[0] — the evaluator's own
// matches[] and the detector's own figures[], with the stored rename undone so
// the reconciler receives exactly what it received in production. Nothing here
// is hand-built.
const fx = require_('./fixtures/identity-rename-job_1789348171785_9oxos7dwv-p7.json');

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

describe('a rename never fabricates a duplicate identity (real p7 shapes)', () => {
  it('the stored shapes are the ones this defect was measured on', () => {
    // Both sides independently named all five subjects — there was no genuine
    // ambiguity to resolve, only a greedy nearest-centre pairing artefact.
    expect(fx.matches.map((m: any) => m.reference).sort())
      .toEqual(fx.detectorFigures.map((f: any) => f.name).sort());
    // And what production actually stored: one name twice, one name gone.
    expect(fx.storedRenameOutcome.referencesAfterRename)
      .toEqual(['Julian', 'Levin', 'Kiaan', 'Kiaan', 'Nia']);
    expect(fx.storedRenameOutcome.renames).toHaveLength(1);
  });

  it('no longer produces the conflict at all — it was the pairing, not the sides', () => {
    // UPDATED 2026-09-18. The guard below still holds, but on THIS page it now
    // has nothing to refuse: the pairing became a one-to-one assignment whose
    // cost carries the name agreement, so all five subjects land on their own
    // figure and the "conflict" — which the first assertion above already shows
    // was never a disagreement — is gone at the root.
    //
    // The guard is exercised on shapes that still conflict: the two-name swap
    // below, and the refusals in identity-pairing-assignment.test.ts.
    const evalLike = { matches: clone(fx.matches), fixableIssues: clone(fx.fixableIssues) };
    const report = reconcileIdentity(evalLike, clone(fx.detectorFigures));

    expect(report.conflicts).toEqual([]);
    expect(report.agreed).toBe(report.compared);
    expect(report.renamed || 0).toBe(0);
  });

  it('leaves every evaluator name on exactly one figure', () => {
    const evalLike = { matches: clone(fx.matches), fixableIssues: clone(fx.fixableIssues) };
    reconcileIdentity(evalLike, clone(fx.detectorFigures));

    const refs = evalLike.matches.map((m: any) => String(m.reference).toLowerCase());
    expect(new Set(refs).size).toBe(refs.length);          // no duplicate
    expect(refs).toContain('max');                         // and nobody erased
    expect(refs).toContain('kiaan');
  });

  it('does not relabel the CRITICAL finding onto another child', () => {
    const evalLike = { matches: clone(fx.matches), fixableIssues: clone(fx.fixableIssues) };
    reconcileIdentity(evalLike, clone(fx.detectorFigures));

    // Production relabelled two findings, the CRITICAL one included.
    expect(fx.storedRenameOutcome.relabelledFindings.some((f: any) => f.severity === 'CRITICAL')).toBe(true);

    for (const f of evalLike.fixableIssues) {
      expect(f.identityCorrected).toBeFalsy();
    }
    const critical = evalLike.fixableIssues.find((f: any) => f.severity === 'CRITICAL' && f.character);
    expect(critical.character).toBe('Max');   // the evaluator's own name, untouched
  });

  it('still applies a genuine two-name swap', () => {
    // The feature this guard must not break: both sides used the same two names
    // on each other's figures, so one simultaneous permutation is lossless.
    const a = fx.detectorFigures.find((f: any) => f.name === 'Levin');
    const b = fx.detectorFigures.find((f: any) => f.name === 'Max');
    const evalLike = {
      matches: [
        { figure: 1, body_bbox: boxOf(a), reference: 'Max', confidence: 0.9 },
        { figure: 2, body_bbox: boxOf(b), reference: 'Levin', confidence: 0.9 },
      ],
      fixableIssues: [{ character: 'Max', severity: 'MAJOR', description: 'x', fix: 'y' }],
    };
    const report = reconcileIdentity(evalLike, [clone(a), clone(b)]);
    expect(report.uncorrectable).toBeFalsy();
    expect(evalLike.matches.map((m: any) => m.reference)).toEqual(['Levin', 'Max']);
    expect(evalLike.fixableIssues[0].character).toBe('Levin');
  });

  it('reports the names both sides already agreed on', () => {
    const report = checkIdentityAgreement(clone(fx.matches), clone(fx.detectorFigures));
    expect(Array.isArray(report.agreedNames)).toBe(true);
    expect(report.agreedNames.length).toBe(report.agreed);
    // Kiaan is the name an agreeing match held — the one the rename targeted.
    expect(report.agreedNames.map((n: string) => n.toLowerCase())).toContain('kiaan');
  });
});

// Detector boxes are [ymin, xmin, ymax, xmax]; evaluator boxes are
// [x1, y1, x2, y2]. Convert so a constructed swap pairs on the same centres the
// real records do.
function boxOf(f: any) {
  const b = f.bodyBox;
  return [b[1], b[0], b[3], b[2]];
}

describe('the compliance judge is told STORY_TEXT declares nothing', () => {
  beforeAll(async () => { await loadPromptTemplates(); });

  // BUILT prompt, not the template: evaluateThreeStage is driven for real with
  // the model call stubbed, so this pins what the judge is actually sent.
  const buildCompliancePrompt = async () => {
    const original = textModels.callTextModel;
    let captured = '';
    textModels.callTextModel = async (input: string) => {
      captured = input;
      return { text: '{"verdict":"PASS","fixable_issues":[]}', usage: { input_tokens: 1, output_tokens: 1 } };
    };
    try {
      await evaluateThreeStage('data:image/jpeg;base64,AAAA', fx.sceneIntent, fx.sceneIntent, {
        pageContext: `PAGE ${fx.pageNumber}`,
        storyText: fx.storyText,
        inventoryPromise: Promise.resolve({
          figures: [], objects: [], interactions: [], setting: null,
          lettering: [], rendering: {}, inputTokens: 0, outputTokens: 0,
        }),
        qualityFiguresPromise: Promise.resolve({ figures: [], matches: [] }),
      });
    } finally {
      textModels.callTextModel = original;
    }
    return captured;
  };

  it('carries the rule, and carries the real page prose it fires on', async () => {
    const built = await buildCompliancePrompt();
    expect(built).toContain('STORY_TEXT DECLARES NOTHING');
    expect(built).toMatch(/Dialogue is not staging/);
    expect(built).toMatch(/never the sole basis of a `fixable_issues\[\]` entry/);
    // The page whose dialogue produced the invented declaration is in there.
    expect(built).toContain(fx.storyText.trim().slice(0, 40));
  });

  it('the page it fired on really does declare no such carrier', () => {
    // The dialogue the judge mined, and the total absence of a matching
    // declaration in any stored spec field — this is why the finding was
    // invented rather than merely wrong.
    const declaredSubjects = (fx.declaredInteractions || [])
      .flatMap((i: any) => String(i.character || '').split('+').map((s: string) => s.trim()));
    const speaker = fx.storedRenameOutcome.relabelledFindings
      .find((f: any) => f.severity === 'CRITICAL').from;          // 'Max'

    expect(fx.storyText).toContain(speaker);                      // named in the prose
    expect(/trage|carry/i.test(fx.storyText)).toBe(true);         // and in a spoken line
    // ...but no interaction declares a carry at all, for anyone.
    expect((fx.declaredInteractions || []).some((i: any) => /carr|trag|hold/i.test(i.action || ''))).toBe(false);
    expect(declaredSubjects).toContain(speaker);                  // only as a walker
    // ...and the brief names a different character as the one holding it.
    expect(fx.sceneIntent).toMatch(/carrying the egg/);
    expect(fx.sceneIntent.split('carrying')[0]).not.toContain(speaker);
  });
});
