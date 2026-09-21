/**
 * PATTERN SEEDS — the mechanism a toddler book (a main aged two or under) is
 * built on, picked in code, one per idea arm.
 *
 * Round 22 shipped the pattern contract and measured its one hazard: with no
 * shape to build on, the band with least to go on copied the worked example
 * hardest (cell 7 arm 1 came back as a translation of the example's fence, its
 * answering animals, its brown pony and its «Komm her!»). The example is
 * therefore gone from both templates and the mechanism is handed over as a
 * VALUE instead — the same reason pickPremiseShapes and pickWorldSeeds exist:
 * the second idea call cannot see the first, so the difference between the arms
 * has to be a value, not an instruction to differ.
 *
 * World-neutral by construction: the world seed supplies the creature, this
 * file supplies the mechanism.
 */

const path = require('path');
const { ideaVariantSeed } = require('./worldSeeds');

const SEED_FILE = path.join(__dirname, '../../prompts', 'pattern-seeds.txt');
const FIELDS = ['name', 'pattern', 'variation', 'resists', 'refrain'];

let PATTERN_SEEDS = null;

/** The ten seeds, parsed once. Throws when the file cannot supply two. */
function loadPatternSeeds() {
  if (PATTERN_SEEDS) return PATTERN_SEEDS;
  const raw = require('fs').readFileSync(SEED_FILE, 'utf-8');
  PATTERN_SEEDS = raw.replace(/\r/g, '').split('\n')
    .filter(l => l.trim() && !l.startsWith('#'))
    .map(l => l.split('|').map(s => s.trim()))
    .filter(f => f.length >= 6 && f.slice(0, 6).every(Boolean))
    .map(f => ({ id: Number(f[0]), name: f[1], pattern: f[2], variation: f[3], resists: f[4], refrain: f[5] }));
  if (PATTERN_SEEDS.length < 2) throw new Error('pattern-seeds.txt: fewer than two usable seeds');
  return PATTERN_SEEDS;
}

/**
 * One seed per arm, DETERMINISTIC from the same seed the premise shapes and the
 * world seeds use, and always two different seeds.
 * @returns {Array<object>} [arm0, arm1]
 */
function pickPatternSeeds(seedInput = {}) {
  const pool = loadPatternSeeds();
  const h = ideaVariantSeed(seedInput);
  const i1 = h % pool.length;
  const i2 = (i1 + 1 + (Math.floor(h / pool.length) % (pool.length - 1))) % pool.length;
  return [pool[i1], pool[i2]];
}

/** The prompt line. Empty for a cast that is not on the pattern contract. */
function patternSeedInstruction(seed) {
  if (!seed) return '';
  return `This book's pattern: ${seed.name} — ${seed.pattern}. What changes: ${seed.variation}. The one that resists: ${seed.resists}. Refrain shape: ${seed.refrain}`;
}

module.exports = { loadPatternSeeds, pickPatternSeeds, patternSeedInstruction, PATTERN_SEED_FIELDS: FIELDS };
