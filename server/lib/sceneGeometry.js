/**
 * The GEOMETRY-ONLY view of a page's scene prose, for the background plate —
 * and the SINGLE source of the wording both sides of that grade use.
 *
 * The inline empty-scene QC (`validateEmptyScene`, evalPipeline.js) grades a
 * plate on three composition facts read out of `mainScenePrompt` — the page's
 * scene description: (a) the direction of any path/river/road/corridor/
 * shoreline/horizon, (b) where the vanishing point or opening sits in frame,
 * and (c) the lighting direction. The plate GENERATOR was never handed that
 * prose: `buildEmptyScenePrompt` receives only the brief's `emptyScenePrompt`.
 * So every geometry failure was a wasted plate regeneration — the model was
 * graded on facts it had never been told.
 *
 * `GEOMETRY_DIMENSIONS` below is that pair's one source of truth: each entry
 * carries the author sentence rendered into `prompts/empty-scene.txt` via
 * `{SCENE_GEOMETRY}` and the judge sentence rendered into the QC prompt. Judge
 * and author therefore name the same three dimensions in the same words. Adding
 * a fourth check means adding a fourth entry here — a check with no author
 * sentence re-creates the blind grade.
 *
 * Selection is per-dimension, not first-three-sentences: one sentence is taken
 * for EACH dimension before any remaining slot is filled. LIGHTING is taken
 * first (owner, 2026-09-15: "the author should know the lighting") — a scene
 * whose prose opens with three perspective sentences used to push the lighting
 * fact out of the block entirely.
 *
 * What it must NOT forward is the reason the prose was withheld in the first
 * place: the cast, their actions and their props. A plate that gains a figure
 * is worse than a plate with the wrong path direction — the placement pass
 * keeps the plate's pixels. A sentence that mixes a geometry fact with a person
 * is not discarded outright (that is how lighting went missing): its clauses are
 * split and only the people-free geometry clauses survive, after which the whole
 * salvaged line is re-checked against the figure and cast-name filters.
 */

// (a) perspective / path direction
const PATH_RE = new RegExp([
  'path|paths|river|stream|road|lane|track|trail|corridor|hallway|tunnel|shoreline|shore|coast|bank|quay',
  'horizon|ridge|slope|incline|stair|stairs|staircase|steps|bridge|pier|jetty|aisle|row of|avenue',
  'perspective|diagonal|recede|recedes|receding|stretches|leads|runs|winds|curves|climbs|descends|rises|falls away',
].join('|'), 'i');

// (b) vanishing point / opening
const OPENING_RE = /vanishing point|opening|archway|arch|doorway|door|gateway|gate|window|mouth of|gap|clearing/i;

// (c) lighting direction
const LIGHT_RE = new RegExp([
  'light|lights|lit|sunlight|sunbeam|sunlit|moonlight|lamplight|lantern|torchlight|glow|backlit|shadow|shadows|silhouette',
  'dawn|dusk|sunset|sunrise|midday|noon|overcast|storm|stormy|fog|mist|twilight|night|daylight',
].join('|'), 'i');

/**
 * The three graded dimensions, in judge order. `author` is what the plate
 * generator is told; `judge` is what the QC asks. Same dimension, same words.
 */
const GEOMETRY_DIMENSIONS = [
  {
    key: 'path',
    match: PATH_RE,
    author: 'Path / perspective direction — run any path, river, road, corridor, shoreline or horizon in the direction and gradient named above.',
    judge: 'Path / perspective direction — does any path, river, road, corridor, shoreline, horizon or major perspective line run in the direction the main scene prose describes (e.g. "stretches to the right background", "diagonal from lower-left to upper-right")?',
  },
  {
    key: 'opening',
    match: OPENING_RE,
    author: 'Vanishing point / opening position — put the vanishing point, opening or gap at the frame position named above.',
    judge: 'Vanishing point / opening position — is it at the frame position the main scene implies (e.g. main scene says "sliver of light at far right background" → the opening sits at the upper-right, not centred or on the left)?',
  },
  {
    key: 'lighting',
    match: LIGHT_RE,
    author: 'Lighting direction — take the light from the direction named above, consistent with the time of day and the named light source; every shadow falls the same way.',
    judge: 'Lighting direction — does the light come from the direction the main scene names, consistent with its time of day and declared light source, with every shadow falling the same way?',
  },
];

// Lighting first: the owner's named priority, and the dimension the
// first-three-sentences rule used to drop.
const SELECTION_ORDER = ['lighting', 'path', 'opening'];

const GEOMETRY_RE = new RegExp(`${PATH_RE.source}|${OPENING_RE.source}|${LIGHT_RE.source}`, 'i');

// Anything that could put a figure on the plate. Deliberately broad: a false
// negative costs one geometry fact, a false positive costs a painted character.
const FIGURE_RE = /\b(character|characters|person|people|figure|figures|crowd|crowds|boy|boys|girl|girls|man|men|woman|women|child|children|kid|kids|baby|adult|adults|villager|villagers|soldier|soldiers|guard|guards|sailor|sailors|crew|rider|riders|dog|dogs|cat|cats|horse|horses|bird|birds|creature|creatures|dragon|he|she|they|him|her|his|hers|their|them)\b/i;

// Where a sentence may be cut so a geometry clause can be kept without the
// person sharing the sentence with it.
const CLAUSE_SPLIT_RE = /\s*(?:[,;:]|—|--|\bwhile\b|\bwhere\b|\bas\b|\bwhich\b|\bwhen\b|\band\b)\s+/i;

// A salvaged FRAGMENT has to earn its place: without a position/direction cue
// or a lighting word it is scene mood, not geometry ("watching the gap", "casting deep
// shadows"), and it costs the author a slot the graded facts need. A whole
// clean sentence is kept as written — this test applies only to cut clauses.
const DIRECTION_RE = /\b(left|right|upper|lower|top|bottom|foreground|background|middle|centre|center|front|back|behind|above|below|beneath|beyond|toward|towards|across|along|down|up|diagonal|diagonally|horizon|distance|overhead|from the|onto|into|parallel|edge|far|near)\b/i;

// The scene prose stored on a page carries an Art Director tail
// (`---METADATA--- {...}` with sceneIntent / Preview / Intent strings) and
// bracketed Visual Bible ids. Both are machine text, both name the cast, and a
// fragment of either painted onto the plate is a VB-id leak — cut before the
// prose is ever split into sentences.
const METADATA_TAIL_RE = /---\s*METADATA\s*---[\s\S]*$/i;
const VB_ID_RE = /\[[A-Z]{2,4}\d{1,4}(?:\.\d+)?\]/g;
const MACHINE_FIELD_RE = /\b(sceneIntent|Preview:|Intent:|emptyScenePrompt|textPosition)\b/i;

function namesIn(castNames) {
  return (castNames || [])
    .map(c => (typeof c === 'string' ? c : c?.name))
    .filter(n => typeof n === 'string' && n.trim().length > 1)
    .map(n => n.trim().toLowerCase());
}

function isClean(text, names) {
  if (FIGURE_RE.test(text)) return false;
  const lower = text.toLowerCase();
  return !names.some(n => lower.includes(n));
}

/**
 * The people-free geometry content of one sentence, or null.
 * Keeps the whole sentence when it is already clean; otherwise keeps only the
 * clauses that carry geometry and no person, and re-checks the join.
 */
function sanitizeGeometrySentence(sentence, names) {
  const s = String(sentence || '').replace(VB_ID_RE, '').replace(/\s+/g, ' ').trim();
  if (!s || MACHINE_FIELD_RE.test(s)) return null;
  if (!GEOMETRY_RE.test(s)) return null;
  if (isClean(s, names)) return s;

  const kept = s
    .split(CLAUSE_SPLIT_RE)
    .map(c => c.trim().replace(/[.!?,;:"']+$/, '').trim())
    .filter(c => c.length > 3 && GEOMETRY_RE.test(c) && (DIRECTION_RE.test(c) || LIGHT_RE.test(c)) && isClean(c, names));
  if (kept.length === 0) return null;

  const joined = `${kept.join(', ')}.`;
  return isClean(joined, names) ? joined : null;
}

/**
 * @param {object} opts
 * @param {string|null} opts.mainScenePrompt - the page's scene description (the
 *   same string the QC grades the plate against).
 * @param {string[]} [opts.castNames] - names of characters staged on this page.
 * @param {string|null} [opts.shot] - 'close-up' | 'medium' | 'wide'.
 * @param {number} [opts.maxFacts] - how many geometry sentences to forward.
 * @returns {string} a prompt block, or '' when nothing qualifies.
 */
function extractSceneGeometry(opts = {}) {
  const { mainScenePrompt, castNames = [], shot = null, maxFacts = 3 } = opts;
  const names = namesIn(castNames);

  /** @type {{text:string, dims:string[]}[]} */
  const candidates = [];
  if (typeof mainScenePrompt === 'string' && mainScenePrompt.trim()) {
    const sentences = mainScenePrompt
      .replace(METADATA_TAIL_RE, ' ')
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean);
    for (const s of sentences) {
      if (s.length > 240) continue;            // a paragraph-long sentence carries more than geometry
      const text = sanitizeGeometrySentence(s, names);
      if (!text) continue;
      const dims = GEOMETRY_DIMENSIONS.filter(d => d.match.test(text)).map(d => d.key);
      if (dims.length === 0) continue;
      candidates.push({ text, dims });
    }
  }

  // One sentence per dimension first (lighting first), then fill what is left
  // in prose order. Without this pass a lighting fact three sentences deep is
  // silently dropped while the author is still graded on it.
  const facts = [];
  const taken = new Set();
  const take = (c) => {
    if (!c || taken.has(c.text) || facts.length >= maxFacts) return;
    taken.add(c.text);
    facts.push(c.text);
  };
  for (const key of SELECTION_ORDER) {
    take(candidates.find(c => !taken.has(c.text) && c.dims.includes(key)));
  }
  for (const c of candidates) take(c);

  if (facts.length === 0 && !shot) return '';

  const lines = [];
  if (shot) lines.push(`- Camera framing: ${shot}.`);
  for (const f of facts) lines.push(`- ${f}`);

  return `**SCENE GEOMETRY (the populated page is composited onto this plate — match it):**
${lines.join('\n')}
${GEOMETRY_DIMENSIONS.map(d => `- ${d.author}`).join('\n')}
These are facts about the SPACE only: no character, animal or figure from the page appears on this plate — paint the place empty.`;
}

/**
 * The QC's lettered geometry checks — same three dimensions, same wording as
 * the author block above.
 * @param {number} n - the list number this check takes in the QC prompt.
 */
function buildGeometryJudgeChecks(n) {
  const letters = 'abcdefghij';
  const items = GEOMETRY_DIMENSIONS
    .map((d, i) => `   ${letters[i]}. ${d.judge}`)
    .join('\n');
  return `\n${n}. Composition geometry — does this empty scene support the main scene's geometry? The plate's author was given these same three facts, so a disagreement is a real defect. Check:
${items}
   FAIL with a specific fix instruction if any of them disagree. The issue description must name WHAT geometry is wrong AND the corrected direction/position. Example: "path runs front-to-center instead of diagonally to the upper-right; regenerate with the path angled toward the upper-right corner".`;
}

module.exports = {
  extractSceneGeometry,
  buildGeometryJudgeChecks,
  sanitizeGeometrySentence,
  GEOMETRY_DIMENSIONS,
};
