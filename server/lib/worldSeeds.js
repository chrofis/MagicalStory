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

module.exports = { parseWorldSeeds, pickWorldSeeds, worldSeedInstruction, ideaVariantSeed };
