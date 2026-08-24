/**
 * refineStoryText publishes each completed step, so a caller that gives up
 * waiting still ships the work already paid for.
 *
 * Regression for staging job_1787514666616_yw9qsv1vf: the stage ran a grok
 * audit (18,396 output tokens) and a deepseek round (29,931) — $0.236 — then
 * the pipeline's bounded join fired while round 2 was in flight, the
 * all-or-nothing return was discarded, and the ORIGINAL text shipped with
 * textRefineReport null.
 *
 * Run: node tests/manual/test-text-refine-salvage.js
 */

const assert = require('assert');
const Module = require('module');

// Stub the model call before textRefine resolves it: round 1 returns a rewrite,
// round 2 never settles (the in-flight round the deadline lands on).
let neverResolveHit = false;
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === './textModels' || request === '../lib/textModels') {
    return {
      callTextModelStreaming: async (prompt, maxOut, _x, model, opts) => {
        if (opts?.usageLabel === 'text_audit') {
          return { text: 'FAULT: p1 — the reason for the journey is never stated.\nFAULTS: 1', usage: { output_tokens: 10 } };
        }
        if (!neverResolveHit) {
          neverResolveHit = true;
          // parseRefinedText's real contract: an analysis section, the
          // "--- STORY TEXT ---" marker, then "## Page N" headings. Only
          // rewritten pages come back; omission means "keep as is".
          return {
            text: '---ANALYSIS---\np1 states no reason.\n--- STORY TEXT ---\n## Page 1\nEin ganz neuer erster Satz.\n',
            usage: { output_tokens: 10 },
            modelId: 'stub-model',
          };
        }
        return new Promise(() => {});   // round 2: in flight forever
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
    rounds: 2,
    // No model override: the key must exist in TEXT_MODELS for the cap lookup.
    // The call itself is stubbed above, so no provider is contacted.
    onProgress: (s) => snapshots.push(s),
  });

  // The caller's bounded join: give up while round 2 is still running.
  const TIMED_OUT = Symbol('t');
  const raced = await Promise.race([promise, new Promise(r => setTimeout(() => r(TIMED_OUT), 1500))]);
  assert.strictEqual(raced, TIMED_OUT, 'round 2 is still in flight, so the join times out');

  const latest = snapshots[snapshots.length - 1];
  assert.ok(latest, 'the refiner published at least one snapshot before the deadline');
  assert.strictEqual(latest.partial, true, 'a published snapshot is marked partial');

  // The audit survives even though the run never returned.
  assert.ok(/FAULT: p1/.test(latest.audit), 'the completed audit is in the snapshot');

  // Round 1's rewrite survives, and untouched pages keep their text.
  assert.deepStrictEqual(latest.changed, [1], 'round 1 rewrote page 1');
  assert.strictEqual(latest.pages.find(p => p.pageNumber === 1).text, 'Ein ganz neuer erster Satz.');
  assert.strictEqual(latest.pages.find(p => p.pageNumber === 2).text, 'Seite zwei bleibt.');
  assert.strictEqual(latest.rounds.length, 1, 'only the completed round is reported');

  // The first snapshot is the audit alone — published before any round, so an
  // audit still counts when round 1 itself is the one that never lands.
  assert.ok(/FAULT: p1/.test(snapshots[0].audit), 'the audit is published before round 1 runs');
  assert.deepStrictEqual(snapshots[0].changed, [], 'the audit-only snapshot rewrites nothing');

  console.log(`✓ audit + ${latest.rounds.length} completed round(s) survive a join timeout (${snapshots.length} snapshots)`);
  console.log('\nAll text-refine salvage assertions passed.');
  process.exit(0);
})().catch(err => { console.error('\n✗ FAILED:', err.message); process.exit(1); });
