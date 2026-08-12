/**
 * The quality eval's figure identification must survive to the stored story.
 *
 * Every quality eval produces, per image, an INDEPENDENT identification of the
 * people in it:
 *
 *   figures[] : { id, zone, hair, clothing, action, view, items_held }
 *   matches[] : { figure, reference, confidence, face_bbox }
 *
 * That is a SECOND opinion on who is who — separate from the Set-of-Mark naming
 * in server/lib/figureDetection.js that labels the detection boxes. The two
 * demonstrably disagree (staging job_1786287569165_7f75jspcz p8 v1: the
 * detection named the girl in the red bandana "Sarah", the woman in purple
 * "Emma", and put "Hans" on a bearded man in a tricorn — all at
 * confidence: high). The disagreement rate was unmeasurable because figures[]
 * and matches[] were computed, logged to stdout, consumed in-process by the
 * compliance stage, and then dropped: zero occurrences of "reference" in any
 * stored story.
 *
 * Two independent leaks caused that, and both are pinned here:
 *
 *   1. evaluateImageBatch rebuilds a WHITELISTED eval object around
 *      evaluateImageQuality's return, and the whitelist omitted rawOutput /
 *      evalTemplateHash / coherenceGate — which is why the O7 mapping
 *      `qualityRawOutput: finalEval?.rawOutput ?? null` stored null on every
 *      page ever generated. The mapping was never the bug; the whitelist was.
 *   2. buildVersionEntry (repairPipeline) never carried figures/matches onto
 *      the version, and server.js's own scene whitelist drops the page-level
 *      copies, so nothing reached the blob.
 *
 * The version — not the page — is the correct home: figures[] describes ONE
 * specific set of image bytes, exactly like bboxDetection does.
 *
 * Source-level assertions (the established pattern here — see TEST 5 in
 * garmentHueNormalize.test.js): require()-ing repairPipeline.js or images.js
 * initialises services and HANGS. CRLF-normalised, because core.autocrlf=true
 * checks these files out with CR-LF and LF-only needles would never match.
 *
 * Run: node tests/manual/evalFigureIdentityPersist.test.js
 */
'use strict';

const fs = require('fs');

let passed = 0, failed = 0;
const check = (d, c, extra) => c
  ? (passed++, console.log(`  ok  ${d}`))
  : (failed++, console.log(`FAIL  ${d}${extra ? '  — ' + extra : ''}`));

const read = (rel) => fs.readFileSync(require.resolve(rel), 'utf8').replace(/\r\n/g, '\n');
const images = read('../../server/lib/images.js');
// evaluateImageQuality moved verbatim to evalPipeline.js (god-file split);
// evaluateImageBatch and its whitelist stayed in images.js — read both.
const evalSrc = read('../../server/lib/evalPipeline.js');
const pipeline = read('../../server/lib/repairPipeline.js');

// ── The eval's own return still carries the identification ──────────────────
console.log('\nevaluateImageQuality still returns the raw material');
check('figures + matches are returned by the JSON branch',
  /\n\s*figures,\s*\n\s*\/\/ Detected figures/.test(evalSrc)
  || /\n\s*figures,\s*\n\s*matches,\s*\n/.test(evalSrc));
check('so is the verbatim model output',
  /rawOutput: responseText,/.test(evalSrc));

// ── Leak 1: the batch whitelist ─────────────────────────────────────────────
console.log('\nevaluateImageBatch no longer drops the audit fields');
const batchFrom = images.indexOf('const evalResult = {');
const batchTo = images.indexOf('log.debug(`✅ [BATCH EVAL]', batchFrom);
check('the batch eval result object is where we think it is',
  batchFrom > 0 && batchTo > batchFrom);
const batch = images.slice(batchFrom, batchTo);
check('figures survive the whitelist', /figures: qualityResult\?\.figures/.test(batch));
check('matches survive the whitelist', /matches: qualityResult\?\.matches/.test(batch));
check('rawOutput survives the whitelist — the qualityRawOutput=null root cause',
  /rawOutput: qualityResult\?\.rawOutput \?\? null/.test(batch));
check('evalTemplateHash survives too, so a score stays re-derivable',
  /evalTemplateHash: qualityResult\?\.evalTemplateHash \?\? null/.test(batch));
check('and coherenceGate, which buildVersionEntry already reads',
  /coherenceGate: qualityResult\?\.coherenceGate \?\? null/.test(batch));

// ── Leak 2: the version entry ───────────────────────────────────────────────
console.log('\nbuildVersionEntry carries the identification onto the version');
const bveFrom = pipeline.indexOf('const buildVersionEntry = (v) => {');
const bveTo = pipeline.indexOf('imageVersions.push(buildVersionEntry(v))', bveFrom);
check('buildVersionEntry is where we think it is', bveFrom > 0 && bveTo > bveFrom);
const bve = pipeline.slice(bveFrom, bveTo);

check('figures are persisted per version', /\n\s*figures: v\.evaluation\?\.figures \?\? null,/.test(bve));
check('matches are persisted per version', /\n\s*matches: v\.evaluation\?\.matches \?\? null,/.test(bve));
check('object matches ride along', /\n\s*objectMatches: v\.evaluation\?\.objectMatches \?\? null,/.test(bve));

// Absent evidence is not "zero figures": a version whose eval produced nothing
// must store null, never a [] that reads as "the eval saw no people".
check('absent identification stores null, not an invented empty array',
  !/figures: v\.evaluation\?\.figures \|\| \[\]/.test(bve)
  && !/matches: v\.evaluation\?\.matches \|\| \[\]/.test(bve));

// It belongs next to the detection because they describe the same bytes — and
// the pairing is the whole point: SoM naming vs eval naming, same version.
check('it sits alongside the per-version detection it is compared against',
  /bboxDetection: images\(\)\.detectionForVersion\(v\),[\s\S]{0,1400}?figures: v\.evaluation\?\.figures/.test(bve));

// ── IRON RULE: no image bytes in JSONB ──────────────────────────────────────
console.log('\nno image bytes are added to the blob');
const added = bve.split('\n').filter(l => /figures:|matches:|objectMatches:/.test(l)).join('\n');
check('the new fields read only eval text/number/bbox structures',
  /^(?:\s*(?:figures|matches|objectMatches): v\.evaluation\?\.\w+ \?\? null,)+$/m.test(added.replace(/\n/g, '\n')));
check('nothing image-shaped is pulled in',
  !/imageData|bboxOverlayImage|data:image/.test(added));

// ── The page-level O7 mapping is unchanged and now actually gets a value ────
console.log('\nthe page-level O7 mapping is left intact');
check('qualityRawOutput still maps from the picked version’s eval',
  /qualityRawOutput: finalEval\?\.rawOutput \?\? null,/.test(pipeline));
check('and evalTemplateHash beside it',
  /evalTemplateHash: finalEval\?\.evalTemplateHash \?\? null,/.test(pipeline));

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
