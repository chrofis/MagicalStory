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
 * @returns {{centres: string[], turns: string[]}|null} null when either list is absent
 */
function parseWorldSeeds(guideText) {
  if (!guideText || typeof guideText !== 'string') return null;
  const lines = guideText.replace(/\r/g, '').split('\n');
  const centres = _bulletsAfter(lines, CENTRE_LABEL);
  const turns = _bulletsAfter(lines, TURN_LABEL);
  if (!centres || !turns) return null;
  return { centres, turns };
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
 * @returns {{centre: string, turn: string}|null} null when the world has no lists
 */
function pickWorldSeeds({ theme, characters, topic, storyTopic, language, arm = 0 } = {}) {
  if (!theme) return null;
  const { getAdventureGuide } = require(path.join(__dirname, 'promptBuilders'));
  const seeds = parseWorldSeeds(getAdventureGuide(theme));
  if (!seeds) return null;
  const h = ideaVariantSeed({
    characters,
    storyTopic: topic ?? storyTopic,
    storyTheme: theme,
    language,
  });
  const idx = arm === 1 ? 1 : 0;
  const [c1, c2] = _twoIndices(h, seeds.centres.length);
  // A second, independent offset for the turns, so a world's centre list and
  // turn list are not walked in lockstep across casts.
  const [t1, t2] = _twoIndices((h * 2654435761) >>> 0, seeds.turns.length);
  return {
    centre: seeds.centres[idx === 0 ? c1 : c2],
    turn: seeds.turns[idx === 0 ? t1 : t2],
  };
}

/** The prompt line, terse. */
function worldSeedInstruction(seeds) {
  if (!seeds) return '';
  return `This idea starts from this centre and this turn. Centre: ${seeds.centre}. Turn: ${seeds.turn}. Swap one only if it cannot fit the cast or the topic; keep the other.`;
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

module.exports = { parseWorldSeeds, parseWorldPlaces, pickWorldPlace, worldPlaceInstruction, pickWorldSeeds, worldSeedInstruction, ideaVariantSeed };
