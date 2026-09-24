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

// Clothing and body parts. A garment clause is not geometry, but it reaches the
// block anyway because the colour words it carries hit the lighting list
// ("a LIGHT grey shirt"), and it names no person, so the figure filter passes
// it. Measured 2026-09-21 on a stored 18-page story: one plate's geometry list
// opened with "wearing a yellow quilted gilet over a light grey shirt." — a
// costume instruction painted into an EMPTY scene. Vetoed outright, whole
// sentence or salvaged clause.
const GARMENT_RE = /\b(wear|wears|wearing|worn|dressed|outfit|outfits|costume|costumes|clothes|clothing|garment|garments|shirt|shirts|blouse|sweater|jumper|pullover|hoodie|cardigan|gilet|vest|waistcoat|jacket|jackets|coat|coats|parka|anorak|raincoat|cloak|cape|scarf|scarves|shawl|apron|dress|dresses|skirt|gown|trousers|pants|jeans|shorts|leggings|tights|socks|stockings|shoe|shoes|boot|boots|sandals|sneakers|slippers|hat|hats|cap|caps|beanie|hood|helmet|glove|gloves|mitten|mittens|belt|buckle|collar|cuff|cuffs|sleeve|sleeves|hem|zipper|button|buttons|backpack|rucksack|satchel|handbag|glasses|spectacles|braid|braids|ponytail|hair|beard|moustache|mustache|face|faces|cheek|cheeks|eyes|hands|shoulders|knees)\b/i;

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

// Longer than this and a sentence is never forwarded whole: only its
// people-free geometry clauses are (sanitizeGeometrySentence).
const MAX_WHOLE_SENTENCE = 240;

// A cut clause that OPENS on a verb, an adverb or a body part lost its subject
// to the cut — and in a scene brief that subject is a figure: "stands seen from
// behind on the steep slope", "leaning slightly forward", "head tilted toward
// the egg". Measured 2026-09-24 over 54 stored staging pages: once long
// sentences were salvaged, 12 of the 17 pages whose facts changed gained a
// figure-action fragment of this shape. A place clause opens on its own noun or a preposition.
const ELIDED_SUBJECT_RE = /^(?!(?:morning|evening|ceiling|building|lightning|spring|opening|clearing|railing|landing|swing|ring|string|wing|thing|nothing|something|everything|early|only)\b)(?:[a-z]+ing|[a-z]+ly|stands?|sits?|kneels?|crouch(?:es)?|looks?|leans?|steps?|walks?|runs?|climbs?|lands?|holds?|reaches?|pulls?|pushes?|turns?|waits?|watches?|stares?|bends?|bent|tilted|seen|lies|lay|smiles?|carries|grips?|presses?|hurries|rides?|stumbles?|jumps?|faces?|head|arms?|legs?|feet|body|white|red|blue|green|yellow|brown|black|grey|gray|orange|pink|purple)\b/i;

function namesIn(castNames) {
  return (castNames || [])
    .map(c => (typeof c === 'string' ? c : c?.name))
    .filter(n => typeof n === 'string' && n.trim().length > 1)
    .map(n => n.trim().toLowerCase());
}

function isClean(text, names) {
  if (FIGURE_RE.test(text)) return false;
  if (GARMENT_RE.test(text)) return false;
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
  // A paragraph-long sentence carries more than geometry, so it is never kept
  // whole — but its geometry clauses are salvaged like any mixed sentence's.
  // It used to be skipped outright: a 247-char sentence carrying "at night"
  // was lost from a plate (prod job_1790107559778_fcmlfa8kn p10).
  if (s.length <= MAX_WHOLE_SENTENCE && isClean(s, names)) return s;

  const kept = s
    .split(CLAUSE_SPLIT_RE)
    .map(c => c.trim().replace(/[.!?,;:"']+$/, '').trim())
    .filter(c => c.length > 3 && GEOMETRY_RE.test(c) && (DIRECTION_RE.test(c) || LIGHT_RE.test(c)) && isClean(c, names)
      && !ELIDED_SUBJECT_RE.test(c));
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
function selectGeometryFacts(opts = {}) {
  const { mainScenePrompt, castNames = [], maxFacts = 3 } = opts;
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
  const foundDims = new Set();
  const taken = new Set();
  // A dimension is FOUND only by a fact that names a direction or position:
  // every author line says "from the direction named above", and on staging
  // job_1790100385959_1nitlympp p14 the only lighting fact was "The harsh
  // yellow streetlamp light cuts through the dark autumn night" — the line
  // pointed at a direction nobody named, and the judge graded it. Such a fact
  // is still listed; it just earns no author line and no judge check.
  const directed = (c) => DIRECTION_RE.test(c.text);
  const take = (c) => {
    if (!c || taken.has(c.text) || facts.length >= maxFacts) return;
    taken.add(c.text);
    facts.push(c.text);
    if (directed(c)) for (const k of c.dims) foundDims.add(k);
  };
  for (const key of SELECTION_ORDER) {
    const open = candidates.filter(c => !taken.has(c.text) && c.dims.includes(key));
    take(open.find(directed) || open[0]);
  }
  for (const c of candidates) take(c);

  return { facts, dims: GEOMETRY_DIMENSIONS.map(d => d.key).filter(k => foundDims.has(k)) };
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
  const { shot = null } = opts;
  const { facts, dims } = selectGeometryFacts(opts);

  if (facts.length === 0 && !shot) return '';

  // Only a dimension an actual fact was found for gets its author line. Each
  // line ends "named above", so a dimension with no fact above it points at
  // nothing: the plate generator is told to match a direction, a vanishing
  // point or a light source the prompt never names. Measured 2026-09-21 over a
  // stored 18-page story: all three lines were emitted on every page.
  // buildGeometryJudgeChecks takes the same keys, so the judge grades only
  // what the author was told.
  const authorLines = GEOMETRY_DIMENSIONS.filter(d => dims.includes(d.key)).map(d => `- ${d.author}`);

  const lines = [];
  if (shot) lines.push(`- Camera framing: ${shot}.`);
  for (const f of facts) lines.push(`- ${f}`);
  lines.push(...authorLines);

  return `**SCENE GEOMETRY (the populated page is composited onto this plate — match it):**
${lines.join('\n')}
These are facts about the SPACE only: no character, animal or figure from the page appears on this plate — paint the place empty.`;
}

/**
 * The QC's lettered geometry checks — the SAME dimensions the plate author was
 * given, never more. `dims` is the key list `selectGeometryFacts` returned for
 * this page: a dimension with no fact in the scene prose reaches neither side,
 * so the judge cannot deduct for geometry the author was never told (the blind
 * grade this module exists to end).
 * @param {number} n - the list number this check takes in the QC prompt.
 * @param {string[]} dims - dimension keys from selectGeometryFacts().dims.
 * @returns {string} the check block, or '' when no dimension was found.
 */
function buildGeometryJudgeChecks(n, dims) {
  if (!Array.isArray(dims)) throw new Error('buildGeometryJudgeChecks: dims[] is required — pass selectGeometryFacts().dims');
  const letters = 'abcdefghij';
  const active = GEOMETRY_DIMENSIONS.filter(d => dims.includes(d.key));
  if (active.length === 0) return '';
  const items = active
    .map((d, i) => `   ${letters[i]}. ${d.judge}`)
    .join('\n');
  return `\n${n}. Composition geometry — does this empty scene support the main scene's geometry? The plate's author was given these same facts, so a disagreement is a real defect. Check:
${items}
   FAIL with a specific fix instruction if any of them disagree. The issue description must name WHAT geometry is wrong AND the corrected direction/position. Example: "path runs front-to-center instead of diagonally to the upper-right; regenerate with the path angled toward the upper-right corner".`;
}

module.exports = {
  extractSceneGeometry,
  selectGeometryFacts,
  buildGeometryJudgeChecks,
  sanitizeGeometrySentence,
  GEOMETRY_DIMENSIONS,
};
