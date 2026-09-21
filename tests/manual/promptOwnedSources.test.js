/**
 * The beats pipeline's rule lists live in files the beats pipeline OWNS.
 *
 * WHY THIS EXISTS
 * Two lists the beats chain enforces used to be SLICED out of the "legacy"
 * unified templates at runtime (rule-survival audit 2026-09-03, items M1+M2):
 *   - the DO-NOT-WRITE list, read from prompts/do-not-write-list.txt by
 *     buildDoNotWriteSection() for the beats text writer AND the refiner;
 *   - the text review CRITERIA, cut out of outline-analysis-imagefirst.txt by
 *     buildTextRefinePrompt().
 * Deleting either "unused" file as dead code would therefore have stripped the
 * ban list and every text review criterion from production — silently, because
 * the do-not-write builder returned '' and the refiner returns null.
 *
 * The list itself now lives in prompts/do-not-write-list.txt, which the unified
 * templates read back through their {DO_NOT_WRITE_LIST} placeholder, so there is
 * exactly ONE copy. The analysis templates are still sliced for the criteria —
 * this test pins that they carry what the refiner needs and that the slicing
 * contract has not drifted.
 *
 * Run: node tests/manual/promptOwnedSources.test.js
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');

let passed = 0, failed = 0;
const ok = (label, fn) => {
  try { fn(); passed++; console.log(`  ✓ ${label}`); }
  catch (err) { failed++; console.log(`  ✗ ${label}\n      ${err.message}`); }
};
const norm = s => String(s || '').replace(/\r\n/g, '\n');
const ROOT = path.join(__dirname, '..', '..');
const readPrompt = f => fs.readFileSync(path.join(ROOT, 'prompts', f), 'utf8');

(async () => {
  const { loadPromptTemplates, PROMPT_TEMPLATES } = require('../../server/services/prompts');
  const failures = await loadPromptTemplates();
  const PB = require('../../server/lib/promptBuilders');

  console.log('\n── The template loader ──');
  ok('every registered template loads', () =>
    assert.deepStrictEqual(failures && failures.length ? failures : [], []));
  ok('the owned do-not-write list is registered and non-empty', () =>
    assert.ok(String(PROMPT_TEMPLATES.doNotWriteList || '').trim().length > 500));

  console.log('\n── M2: the DO-NOT-WRITE list has exactly one copy ──');
  {
    const list = norm(PROMPT_TEMPLATES.doNotWriteList).trim();
    ok('the file holds the list BODY, not the heading', () => {
      assert.ok(!/^##\s*DO-NOT-WRITE LIST/m.test(list), 'the heading belongs to the consuming template');
      assert.ok(/^These appear nowhere/.test(list));
    });
    ok('every ban category is present', () => {
      for (const k of ['Gestures (banned outright)', 'Phrases (banned outright)', 'Page 1 openings (banned)',
        'Trait labels in story text (banned)', 'Aesthetic buzzwords (banned everywhere)', 'Humor (banned)',
        'Plot formulas (banned)', 'Gesture re-use cap', 'Scene prose verbs', 'Use instead']) {
        assert.ok(list.includes(k), `missing: ${k}`);
      }
    });
    ok('buildDoNotWriteSection returns the file under its own heading', () =>
      assert.strictEqual(norm(PB.buildDoNotWriteSection()), `# DO-NOT-WRITE LIST\n\n${list}`));

    // story-unified.txt / story-unified-imagefirst.txt read the list through
    // {DO_NOT_WRITE_LIST} and were pinned here until 2026-09-15, when both were
    // deleted as unreachable (docs/decisions.md). The live consumers are
    // buildDoNotWriteSection (beats writer + refiner, pinned above) and the
    // split-review reviewer prompt.
  }

  console.log('\n── M1: the text slice carries section D\'s TEXT-fix checks ──');
  {
    const body = PROMPT_TEMPLATES.outlineAnalysisImageFirst;
    const text = norm(PB.sliceAnalysisAspect(body, 'text'));
    const scene = norm(PB.sliceAnalysisAspect(body, 'scene'));
    const both = norm(PB.sliceAnalysisAspect(body, 'both'));

    ok('the marked checks exist in the template', () => {
      const raw = norm(body);
      assert.strictEqual((raw.match(/<!-- TEXT_ASPECT_BEGIN -->/g) || []).length, 2);
      assert.strictEqual((raw.match(/<!-- TEXT_ASPECT_END -->/g) || []).length, 2);
    });
    ok('TEXT carries check 18 (action match — the text bends)', () =>
      assert.ok(/18\. \*\*Action match/.test(text)));
    ok('TEXT carries check 24c (agents in text vs the locked scene)', () =>
      assert.ok(/24c\. \*\*Agents in TEXT/.test(text)));
    ok('TEXT keeps A/B/C and E', () => {
      for (const s of ['**A. ', '**B. ', '**C. ', '**E. ']) assert.ok(text.includes(s), s);
    });
    ok('TEXT still drops the metadata-only D checks', () => {
      for (const s of ['19a. ', '19b. ', '20. **Text position distribution', '24b. ']) {
        assert.ok(!text.includes(s), `should not carry: ${s}`);
      }
    });
    ok('SCENE is unchanged — full D, no A/B/C/E', () => {
      assert.ok(scene.includes('**D. '));
      assert.ok(scene.includes('19b. '));
      for (const s of ['**A. ', '**B. ', '**C. ', '**E. ']) assert.ok(!scene.includes(s), s);
    });
    ok('no marker leaks into any slice', () =>
      assert.ok(!/TEXT_ASPECT/.test(text + scene + both)));
    ok("'both' still returns the whole body (markers aside)", () =>
      assert.strictEqual(both, norm(body).replace(/[ \t]*<!-- TEXT_ASPECT_(BEGIN|END) -->\n?/g, '')));
    // The refiner stopped slicing this body on 2026-09-21 (A7): its criteria
    // are written for its own inputs and its own answer, in text-refine.txt.
    // What it still OWNS from here is the shared do-not-write list.
    // tests/unit/text-refine-own-criteria.test.ts pins the criteria themselves.
    ok('the refiner prompt builds and carries the shared do-not-write list', () => {
      const p = norm(PB.buildTextRefinePrompt(
        { characters: [{ name: 'A', gender: 'female', age: 8 }], language: 'de', languageLevel: '1st-grade', pages: 12 },
        [{ pageNumber: 1, text: 'Ein Text.', sceneBrief: 'a brief' }], '', 'the arc'));
      assert.ok(p.includes('# DO-NOT-WRITE LIST'), 'do-not-write section missing from the refiner');
      assert.ok(!p.includes('FIXES REQUIRED'), 'the reviewer output contract leaked into the refiner');
    });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed ? 1 : 0);
})();
