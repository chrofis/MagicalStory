/**
 * WORLD SEEDS — one centre and one turn per idea arm, picked in code.
 *
 * Every adventure guide (prompts/adventure-guides.txt) carries two ten-item
 * lists: "Who lives here (pick one):" and "What turns (pick one):". Left to the
 * model, both arms reach for the first item they read, and the same world
 * produces the same inhabitant every time. The pick therefore happens HERE, for
 * the same reason pickPremiseShapes does: the second idea call cannot see the
 * first, so the difference between the arms has to be handed over as a value.
 *
 * A world without the two lists (custom themes, historical — no adventure guide
 * at all) yields null and nothing is injected.
 */

const path = require('path');

/**
 * The idea seed: deterministic from the cast, topic, theme and language.
 * Single source of truth — server/routes/storyIdeas.js imports it for the
 * premise-shape and place-class picks.
 */
function ideaVariantSeed(seedInput) {
  const parts = [];
  for (const c of (seedInput?.characters || [])) parts.push(`${c?.name || ''}:${c?.age || ''}`);
  parts.push(seedInput?.storyTopic || '', seedInput?.storyTheme || '', seedInput?.language || '');
  const key = parts.join('|');
  let h = 5381;
  for (let i = 0; i < key.length; i++) h = ((h * 33) ^ key.charCodeAt(i)) >>> 0;
  return h;
}

const CENTRE_LABEL = 'Who lives here (pick one):';

/**
 * A centre bullet may carry a trailing ` [grown-up]` tag, marking a centre that
 * is an adult with a problem of their own — a person who needs the child, a
 * keeper who is leaving, the cook nobody thanks. Marked by hand across all 32
 * lists (owner, 2026-09-21) because a pattern book for a main aged two or under
 * cannot be built on one: round 23's cell 11 drew "A grandfather who has worked
 * this farm all his life and cannot manage the mornings now" into a book whose
 * contract has no want, no obstacle and no cost. The tag is data for
 * pickWorldSeeds; it never reaches a prompt — the idea path strips the lists
 * whole, and getTeachingGuide strips the tag for the story path.
 */
const GROWNUP_TAG = '[grown-up]';
const TURN_LABEL = 'What turns (pick one):';

/** Bullets that follow `label`, up to the first non-bullet line. */
function _bulletsAfter(lines, label) {
  const start = lines.findIndex(l => l.trim() === label);
  if (start === -1) return null;
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('- ')) out.push(line.slice(2).trim());
    else if (out.length) break;
    else if (line.trim()) break;
  }
  return out.length ? out : null;
}

/**
 * Parse one world's guide text into its two seed lists.
 * @param {string} guideText - the guide body getAdventureGuide returns
 * @returns {{centres: string[], centreGrownUp: boolean[], turns: string[]}|null}
 *   null when either list is absent. `centres` is the text WITHOUT the tag;
 *   `centreGrownUp[i]` says whether centre i carried it.
 */
function parseWorldSeeds(guideText) {
  if (!guideText || typeof guideText !== 'string') return null;
  const lines = guideText.replace(/\r/g, '').split('\n');
  const rawCentres = _bulletsAfter(lines, CENTRE_LABEL);
  const turns = _bulletsAfter(lines, TURN_LABEL);
  if (!rawCentres || !turns) return null;
  const centreGrownUp = rawCentres.map(c => c.endsWith(GROWNUP_TAG));
  const centres = rawCentres.map(c => (c.endsWith(GROWNUP_TAG) ? c.slice(0, -GROWNUP_TAG.length).trim() : c));
  return { centres, centreGrownUp, turns };
}

/** Two different indices into a list of length n, deterministic from h. */
function _twoIndices(h, n) {
  const i1 = h % n;
  const i2 = n < 2 ? i1 : (i1 + 1 + (Math.floor(h / n) % (n - 1))) % n;
  return [i1, i2];
}

/**
 * One centre and one turn for the given arm.
 *
 * @param {object} input
 * @param {string} input.theme      the adventure theme id
 * @param {Array}  [input.characters] @param {string} [input.topic] @param {string} [input.language]
 * @param {number} input.arm        0 or 1; the two arms never share a centre or a turn
 * @param {boolean} [input.pattern] a pattern book (a main aged two or under):
 *   only centres NOT tagged ` [grown-up]` are eligible — creatures, things and
 *   children. Every world keeps at least two such centres, so the two arms
 *   still never share one. The 3+ pool and its index arithmetic are untouched.
 * @returns {{centre: string, turn: string}|null} null when the world has no lists
 */
function pickWorldSeeds({ theme, characters, topic, storyTopic, language, arm = 0, pattern = false } = {}) {
  if (!theme) return null;
  const { getAdventureGuide } = require(path.join(__dirname, 'promptBuilders'));
  const seeds = parseWorldSeeds(getAdventureGuide(theme));
  if (!seeds) return null;
  const centrePool = pattern
    ? seeds.centres.filter((_, i) => !seeds.centreGrownUp[i])
    : seeds.centres;
  if (!centrePool.length) return null;
  const h = ideaVariantSeed({
    characters,
    storyTopic: topic ?? storyTopic,
    storyTheme: theme,
    language,
  });
  const idx = arm === 1 ? 1 : 0;
  const [c1, c2] = _twoIndices(h, centrePool.length);
  // A second, independent offset for the turns, so a world's centre list and
  // turn list are not walked in lockstep across casts.
  const [t1, t2] = _twoIndices((h * 2654435761) >>> 0, seeds.turns.length);
  return {
    centre: centrePool[idx === 0 ? c1 : c2],
    turn: seeds.turns[idx === 0 ? t1 : t2],
  };
}

/**
 * The guide text as the IDEA prompt should see it: its own pick, not the menu.
 *
 * The two ten-item lists exist for the picker in this file. Shipping them as
 * well hands the model twenty alternatives next to the one value it was given,
 * and 1,324 of the round-15 space prompt's characters were that menu. The lists
 * stay in prompts/adventure-guides.txt — getAdventureGuide still returns them
 * whole, so the beats/story path is untouched — and this strip runs only where
 * the idea prompt's guide section is assembled.
 *
 * @param {string} guideText @returns {string} the guide without the two lists
 */
function _stripBulletBlocks(guideText, labels) {
  if (!guideText || typeof guideText !== 'string') return guideText;
  const lines = guideText.replace(/\r/g, '').split('\n');
  const out = [];
  let skipping = false;
  for (const line of lines) {
    const t = line.trim();
    if (labels.includes(t)) { skipping = true; continue; }
    if (skipping) {
      if (line.startsWith('- ') || !t) continue;
      skipping = false;
    }
    out.push(line);
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripSeedLists(guideText) {
  return _stripBulletBlocks(guideText, [CENTRE_LABEL, TURN_LABEL]);
}

/**
 * The prompt line, terse. ONE centre, and no turn.
 *
 * The turn is still picked — it rides in the idea_generated telemetry and it is
 * what keeps the two arms provably different — but it is not handed to the
 * model. Round 12 measured the turn supplying a PLACE (a ruin at dusk, a broken
 * wall, an outer hull) and peril's height class went 1 -> 4 on it, and a "turn"
 * asked of a five-sentence back cover is a middle to narrate.
 *
 * In the short band the centre IS the idea's one strange thing: a ten-page back
 * cover that carries a world seed and a hook of its own reads as two ideas
 * competing (round 20's pirate arm — a ship on a ruin, a parrot, a waiting
 * island child and a boy alone on deck, in four sentences). So the line says so.
 *
 * @param {object|null} seeds @param {object} [opts] @param {number} [opts.pages]
 */
function worldSeedInstruction(seeds, { pages, pattern = false } = {}) {
  if (!seeds) return '';
  // A pattern book (a main aged two or under) has no want and no obstacle to
  // build anything on — the contract forbids both — so the centre is handed
  // over as what it can actually be at that age: the one that answers, or the
  // one that resists. Round 22 measured the old line reaching a toddler cell
  // and contradicting the contract it sits next to (docs/decisions.md).
  if (pattern) {
    return `Someone in this book: ${seeds.centre}. They are the one that answers, or the one that resists.`;
  }
  const only = (typeof pages === 'number' && pages <= 10)
    ? ' This is the only strange thing in the idea.'
    : '';
  return `Someone in this idea: ${seeds.centre}. Build the want or the obstacle on them.${only}`;
}

const ANGLE_LABEL = 'STORY ANGLES:';

/**
 * The angles named on a historical guide's STORY ANGLES block.
 * @param {string} sheet - a historical guide, whole sheet or idea view
 * @returns {string[]|null} null when the sheet has no angles block
 */
function parseHistoricalAngles(sheet) {
  if (!sheet || typeof sheet !== 'string') return null;
  return _bulletsAfter(sheet.replace(/\r/g, '').split('\n'), ANGLE_LABEL);
}

/**
 * One story angle for the given arm — historical's answer to the adventure
 * worlds' centre. Historical has no adventure guide and therefore no centre
 * list; its guide's STORY ANGLES block is the same kind of material. Same
 * determinism as every other idea pick: the two calls run in parallel and
 * cannot see each other, so the difference is handed over as a value, and the
 * two arms never share an angle.
 *
 * @param {object} input
 * @param {string} input.sheet - the historical guide text
 * @param {Array} [input.characters] @param {string} [input.topic]
 * @param {string} [input.language] @param {number} input.arm
 * @returns {string|null}
 */
function pickHistoricalAngle({ sheet, characters, topic, storyTopic, language, arm = 0 } = {}) {
  const angles = parseHistoricalAngles(sheet);
  if (!angles) return null;
  const h = ideaVariantSeed({
    characters,
    storyTopic: topic ?? storyTopic,
    storyTheme: 'historical',
    language,
  });
  const [a1, a2] = _twoIndices(h, angles.length);
  return angles[arm === 1 ? a2 : a1];
}

/**
 * The historical idea guide as the IDEA prompt should see it: its own angle,
 * not the menu. Exactly the reason stripSeedLists exists on the adventure side —
 * one angle is picked here in code and injected as {WORLD_SEED}, and printing
 * the other five beside it hands the model a list to answer instead. The STORY
 * path reads the sheet whole (getTeachingGuide), and getIdeaGuide still builds
 * the block WITH its angles so pickHistoricalAngle can read them; this strip
 * runs after the pick, where the prompt's topic-guide section is assembled.
 *
 * @param {string} guideText @returns {string} the block without STORY ANGLES
 */
function stripAngleList(guideText) {
  return _stripBulletBlocks(guideText, [ANGLE_LABEL]);
}

/** The prompt line for a historical arm. Same slot as worldSeedInstruction. */
function historicalAngleInstruction(angle) {
  if (!angle) return '';
  return `This idea is seen from here: ${angle}. Build the want or the obstacle on it.`;
}


/**
 * WORLD PLACE — one concrete place from the guide's own setting line.
 *
 * The location arm is handed named landmarks; the fantasy arm was handed
 * nothing and invented its scenery in the first sentence, which the round-10
 * blind read at 3.63 against the location arm's 4.08. Every adventure guide's
 * "Story guidance:" block opens with a setting line ("- Set in castles,
 * enchanted forests, medieval villages"), a comma list of the world's real
 * places. One is picked HERE, for the same reason the centre and the turn are:
 * the model left to itself reaches for the first item, and the two arms cannot
 * see each other.
 *
 * A world with no setting line (detective, ninja) and a theme with no adventure
 * guide at all (custom, historical) yield null, and nothing is injected.
 */

/** Split on commas that are not inside parentheses. */
function _splitTopLevel(text) {
  const out = [];
  let depth = 0, cur = '';
  for (const c of text) {
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += c;
  }
  out.push(cur);
  return out;
}

const SETTING_PREFIX = /^-\s*Set\b\s*/;
// The line and each of its items open with a preposition ("Set on ships, ... at
// harbours and jetties"); the place is what follows it.
const PLACE_PREPOSITION = /^(?:up\s+in|out\s+on|inside|aboard|among|along|under|over|near|in|on|at)\s+/i;

/**
 * The places named on one world's setting line.
 * @param {string} guideText - the guide body getAdventureGuide returns
 * @returns {string[]|null} null when the guide has no setting line
 */
function parseWorldPlaces(guideText) {
  if (!guideText || typeof guideText !== 'string') return null;
  const line = guideText.replace(/\r/g, '').split('\n').find(l => SETTING_PREFIX.test(l.trim()));
  if (!line) return null;
  let body = line.trim().replace(SETTING_PREFIX, '');
  // "Set in ancient Rome: marble forums, villas..." — the places are after the
  // colon; the words before it are the era, not a place the action happens at.
  const colon = body.indexOf(':');
  if (colon !== -1) body = body.slice(colon + 1);
  const places = _splitTopLevel(body)
    .map(part => part
      .replace(/\([^)]*\)/g, '')       // "agora (marketplace)" -> "agora"
      .replace(/^\s*(?:or|and)\s+/i, '')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(PLACE_PREPOSITION, '')
      .replace(/[.;]+$/, ''))
    .filter(Boolean);
  return places.length ? places : null;
}

/**
 * One place for the given arm, deterministic from the same seed the shapes and
 * the world seeds use. The two arms never share a place.
 *
 * @param {object} input
 * @param {string} input.theme @param {Array} [input.characters]
 * @param {string} [input.topic] @param {string} [input.language] @param {number} input.arm
 * @returns {string|null} null when the world names no places
 */
function pickWorldPlace({ theme, characters, topic, storyTopic, language, arm = 0 } = {}) {
  if (!theme) return null;
  const { getAdventureGuide } = require(path.join(__dirname, 'promptBuilders'));
  const places = parseWorldPlaces(getAdventureGuide(theme));
  if (!places) return null;
  const h = ideaVariantSeed({
    characters,
    storyTopic: topic ?? storyTopic,
    storyTheme: theme,
    language,
  });
  // A third independent offset, so the place list is not walked in lockstep
  // with the centre list or the turn list.
  const [p1, p2] = _twoIndices((h * 40503) >>> 0, places.length);
  return places[arm === 1 ? p2 : p1];
}

/** The prompt line, terse. Empty when the world names no places. */
function worldPlaceInstruction(place) {
  if (!place) return '';
  return `The scene is ${place}. Name it where the action is; do not describe it.`;
}

module.exports = { parseWorldSeeds, GROWNUP_TAG, stripSeedLists, stripAngleList, parseWorldPlaces, pickWorldPlace, worldPlaceInstruction, pickWorldSeeds, worldSeedInstruction, parseHistoricalAngles, pickHistoricalAngle, historicalAngleInstruction, ideaVariantSeed };
