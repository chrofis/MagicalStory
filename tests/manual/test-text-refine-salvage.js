/**
 * refineStoryText publishes each completed step, so a caller that gives up
 * waiting still ships the work already paid for.
 *
 * Regression for staging job_1787514666616_yw9qsv1vf: the stage ran a grok
 * audit (18,396 output tokens) and a deepseek round (29,931) — $0.236 — then
 * the pipeline's bounded join fired while the next step was in flight, the
 * all-or-nothing return was discarded, and the ORIGINAL text shipped with
 * textRefineReport null.
 *
 * The chain is two parallel audits → one repair → one lector (owner ruling
 * 2026-09-03), so the step a deadline now lands on is the LECTOR: the audits
 * and the repair must both survive it.
 *
 * Run: node tests/manual/test-text-refine-salvage.js
 */

const assert = require('assert');
const Module = require('module');

// Stub the model call before textRefine resolves it: both audits and the repair
// answer, the lector never settles (the in-flight step the deadline lands on).
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './textModels' || request === '../lib/textModels') {
    return {
      callTextModelStreaming: async (prompt, maxOut, _x, model, opts) => {
        const label = opts?.usageLabel;
        if (label === 'text_audit') {
          return { text: 'FAULT[ASSUMED]: p1 — the reason for the journey is never stated.\nFAULTS: 1', usage: { output_tokens: 10 } };
        }
        if (label === 'text_audit_blind') {
          return { text: 'FAULT[CONFUSION]: p1 — a listener cannot tell why they set out.\nFAULTS: 1', usage: { output_tokens: 10 } };
        }
        if (label === 'text_refine' || label === 'text_refine_stub') {
          // parseRefinedText's real contract: an analysis section, the
          // "--- STORY TEXT ---" marker, then "## Page N" headings. Only
          // rewritten pages come back; omission means "keep as is".
          return {
            text: '---ANALYSIS---\np1 states no reason.\n--- STORY TEXT ---\n## Page 1\nEin ganz neuer erster Satz.\n',
            usage: { output_tokens: 10 },
            modelId: 'stub-model',
          };
        }
        return new Promise(() => {});   // the lector: in flight forever
      },
    };
  }
  return origLoad.apply(this, arguments);
};

const { refineStoryText } = require('../../server/lib/textRefine');

(async () => {
  const pages = [
    { pageNumber: 1, text: 'Der alte erste Satz.' },
    { pageNumber: 2, text: 'Seite zwei bleibt.' },
  ];
  const storyData = { title: 'T', language: 'de-ch', languageLevel: 'standard', sceneImages: [] };

  const snapshots = [];
  const promise = refineStoryText(storyData, pages, {
    // No model override: the keys must exist in TEXT_MODELS for the cap lookup.
    // The calls themselves are stubbed above, so no provider is contacted.
    onProgress: (s) => snapshots.push(s),
  });

  // The caller's bounded join: give up while the lector is still running.
  const TIMED_OUT = Symbol('t');
  const raced = await Promise.race([promise, new Promise(r => setTimeout(() => r(TIMED_OUT), 1500))]);
  assert.strictEqual(raced, TIMED_OUT, 'the lector is still in flight, so the join times out');

  const latest = snapshots[snapshots.length - 1];
  assert.ok(latest, 'the chain published at least one snapshot before the deadline');
  assert.strictEqual(latest.partial, true, 'a published snapshot is marked partial');

  // BOTH audits survive even though the run never returned, and their findings
  // are merged into the list the repair answered.
  assert.strictEqual(latest.audits.length, 2, 'both audits are in the snapshot');
  assert.ok(latest.audits.every(a => a.ok), 'both audits reported findings');
  assert.strictEqual(latest.mergedFindings.length, 2, 'two different faults on p1 stay two findings');

  // The repair's rewrite survives, and untouched pages keep their text.
  assert.deepStrictEqual(latest.changed, [1], 'the repair pass rewrote page 1');
  assert.strictEqual(latest.pages.find(p => p.pageNumber === 1).text, 'Ein ganz neuer erster Satz.');
  assert.strictEqual(latest.pages.find(p => p.pageNumber === 2).text, 'Seite zwei bleibt.');
  assert.strictEqual(latest.rounds.length, 1, 'only the completed repair step is reported');
  assert.strictEqual(latest.rounds[0].kind, 'repair');

  console.log(`✓ two audits + the repair step survive a join timeout (${snapshots.length} snapshots)`);
  process.exit(0);
})();
