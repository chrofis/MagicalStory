/**
 * The GEOMETRY-ONLY view of a page's scene prose, for the background plate.
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
 * `scene-expansion.txt` rule (the `emptyScenePrompt` section) already tells the
 * Art Director to mirror that geometry into the plate prose, but the brief has
 * no structured geometry FIELD, so there is nothing to forward verbatim. This
 * module derives the minimal geometry statement in code from what does exist:
 * the page's `shot` (the one camera fact the brief states explicitly) plus the
 * sentences of the scene prose that carry a geometry fact.
 *
 * What it must NOT forward is the reason the prose was withheld in the first
 * place: the cast, their actions and their props. A plate that gains a figure
 * is worse than a plate with the wrong path direction — the placement pass
 * keeps the plate's pixels. So a sentence is kept only when it carries a
 * geometry keyword AND names no cast member and no person/figure word, and the
 * block re-states the people-free rule after the facts.
 */

// A sentence qualifies only if it states one of the three graded facts.
const GEOMETRY_RE = new RegExp([
  // (a) perspective / path direction
  'path|paths|river|stream|road|lane|track|trail|corridor|hallway|tunnel|shoreline|shore|coast|bank|quay',
  'horizon|ridge|slope|incline|stair|stairs|staircase|steps|bridge|pier|jetty|aisle|row of|avenue',
  'perspective|diagonal|recede|recedes|receding|stretches|leads|runs|winds|curves|climbs|descends|rises|falls away',
  // (b) vanishing point / opening
  'vanishing point|opening|archway|arch|doorway|door|gateway|gate|window|mouth of|gap|clearing',
  // (c) lighting direction
  'light|lights|lit|sunlight|sunbeam|sunlit|moonlight|lamplight|lantern|torchlight|glow|backlit|shadow|shadows|silhouette',
  'dawn|dusk|sunset|sunrise|midday|noon|overcast|storm|stormy|fog|mist|twilight|night|daylight',
].join('|'), 'i');

// Anything that could put a figure on the plate. Deliberately broad: a false
// negative costs one geometry fact, a false positive costs a painted character.
const FIGURE_RE = /\b(character|characters|person|people|figure|figures|crowd|crowds|boy|boys|girl|girls|man|men|woman|women|child|children|kid|kids|baby|adult|adults|villager|villagers|soldier|soldiers|guard|guards|sailor|sailors|crew|rider|riders|dog|dogs|cat|cats|horse|horses|bird|birds|creature|creatures|dragon|he|she|they|him|her|his|hers|their|them)\b/i;

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
  const names = (castNames || [])
    .map(c => (typeof c === 'string' ? c : c?.name))
    .filter(n => typeof n === 'string' && n.trim().length > 1)
    .map(n => n.trim().toLowerCase());

  const facts = [];
  if (typeof mainScenePrompt === 'string' && mainScenePrompt.trim()) {
    const sentences = mainScenePrompt
      .replace(/\s+/g, ' ')
      .split(/(?<=[.!?])\s+/)
      .map(s => s.trim())
      .filter(Boolean);
    for (const s of sentences) {
      if (facts.length >= maxFacts) break;
      if (s.length > 240) continue;            // a paragraph-long sentence carries more than geometry
      if (!GEOMETRY_RE.test(s)) continue;
      if (FIGURE_RE.test(s)) continue;
      const lower = s.toLowerCase();
      if (names.some(n => lower.includes(n))) continue;
      facts.push(s);
    }
  }

  if (facts.length === 0 && !shot) return '';

  const lines = [];
  if (shot) lines.push(`- Camera framing: ${shot}.`);
  for (const f of facts) lines.push(`- ${f}`);

  return `**SCENE GEOMETRY (the populated page is composited onto this plate — match it):**
${lines.join('\n')}
Match the direction and gradient of any path, road, river, shoreline or horizon named above, the frame position of the opening or vanishing point, and the direction the light comes from. These are facts about the SPACE only: no character, animal or figure from the page appears on this plate — paint the place empty.`;
}

module.exports = { extractSceneGeometry };
