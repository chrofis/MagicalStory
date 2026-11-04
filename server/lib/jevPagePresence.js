/**
 * Is a roster member the name scan found in a brief actually DRAWN on that page,
 * or only named (the owner of a garment, someone elsewhere, a memory)?
 *
 * The scan in getCharactersInScene (sceneMetadata.js) runs only when the brief's
 * own cast list resolves to nobody, and a hit proves a name is MENTIONED, not
 * drawn: prod job_1793736454070_0ir5y6hlh p8 ("his tail wrapped in Oma Nicole's
 * scarf", characters []) stored Oma as the page cast, the book review demanded
 * she be added and the redraw damaged the page. The scan stays because a brief
 * with characters [] can describe real cast in prose alone (job_1789207854566_
 * l43qgl34w p7). Owner 2026-11-04: Jev decides which candidates are drawn; code
 * never reads the prose for meaning. Measured, phrasing and threshold:
 * docs/decisions.md 2026-11-04, evals/results/results.jsonl, scripts/analysis/
 * eval-jev-page-presence.js (the question text below is the one measured).
 *
 * No call is made unless the cast came from the scan AND it has a candidate the
 * hint did not commission. A Jev outage waits and retries like every other Jev
 * decision; a call that still fails throws JevDecisionError. There is no
 * fallback to the scan result.
 */
const { sceneCastWithSource, stripSceneMetadata, matchRosterByListedNames } = require('./sceneMetadata');
const J = require('./jevAudit');

/** P(drawn) below this → merely mentioned. Phrasing B, 2026-11-04 measurement. */
const DRAWN_THRESHOLD = 0.5;
const STATE_HEAD = "ONE ILLUSTRATION'S DESCRIPTION:";

const presenceQuestion = name => ({
  type: 'noul',
  instructions: `${name} is physically present in the scene and visible to the viewer, as opposed to only being named, owning an object, being somewhere else, or being remembered.`,
});

/**
 * @param {string} sceneDescription  the page brief (prose + ---METADATA--- block)
 * @param {Array<string|{name:string}>} hintNames  names the outline hint commissioned (never asked about)
 * @param {Array} characters  the story's photo-backed roster
 * @param {{callImpl?: Function}} [opts]  callImpl is jevDecisions.runJevRequests' injectable call (tests)
 * @returns {Promise<Set>} roster records Jev ruled NOT drawn (empty when nothing was asked)
 */
async function rejectedScanCandidates(sceneDescription, hintNames, characters, { callImpl } = {}) {
  const { cast, fromScan } = sceneCastWithSource(sceneDescription, characters);
  if (!fromScan) return new Set();
  const commissioned = matchRosterByListedNames(hintNames, characters);
  const candidates = cast.filter(c => !commissioned.includes(c));
  if (!candidates.length) return new Set();
  const state = `${STATE_HEAD}\n${stripSceneMetadata(sceneDescription)}`;
  const questions = Object.fromEntries(candidates.map((c, i) => [`PRESENT${i}`, presenceQuestion(c.name)]));
  const { runJevRequests } = require('./jevDecisions');
  const ans = await runJevRequests([{ key: 'page_presence', state, questions }], { callImpl, usageLabel: 'jev_decisions_page_presence' });
  const answers = ans.get('page_presence')[0];
  return new Set(candidates.filter((c, i) => J.yesProb(answers[`PRESENT${i}`]) < DRAWN_THRESHOLD));
}

module.exports = { rejectedScanCandidates, presenceQuestion, DRAWN_THRESHOLD };
