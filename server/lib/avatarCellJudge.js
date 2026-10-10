'use strict';

/**
 * Cell-level sheet judge (experiment, NOT WIRED; docs/decisions.md 2026-10-10 "cell judge").
 *
 * The one-call-per-sheet judge (avatarSheetJudge.js) filled a hat into every cell and invented belt "differences" between a
 * head cell and a body cell. Here the model only DESCRIBES one cut cell at a time (prompts/avatar-cell-judge.txt: closed enums,
 * no verdicts, no comparison). Whether a hat is in some cells only, whether the hair or an outfit piece changes, or whether the
 * head row wears other clothes than the body row is decided by CODE over those enum answers (metadata, never prose).
 * The sheet is cut by server/lib/sheetCut.js, the one cutter; a sheet it cannot cut is a layout defect (the throw is the verdict).
 * A head cell is only ever compared on what a head cell can show.
 */

const sharp = require('sharp');
const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');
const { cutSheet } = require('./sheetCut');

const CELL_ENUMS = {
  headgear: ['none', 'hat_brimmed', 'hat_pointed', 'cap', 'beanie', 'hood_up', 'headband_scarf', 'crown_tiara', 'other_headgear'],
  hairColour: ['black', 'dark_brown', 'brown', 'light_brown', 'blonde', 'red', 'grey_white', 'other', 'not_visible'],
  hairLength: ['bald', 'buzz', 'short', 'chin', 'shoulder', 'long', 'hidden'],
  hairWorn: ['down', 'tied_up', 'braids', 'hidden'],
  head: ['present', 'missing', 'blank_face'],
  topKind: ['tshirt', 'long_sleeve', 'hoodie', 'sweater_cardigan', 'jacket_coat', 'robe', 'vest_over_shirt', 'dress', 'overalls', 'armour', 'bare_shoulders', 'other'],
  topColour: ['red', 'orange', 'yellow', 'green', 'blue', 'navy', 'purple', 'pink', 'white', 'grey', 'brown', 'beige', 'black', 'striped', 'patterned'],
  held: ['yes', 'no'],
  medium: ['watercolour', 'photograph', 'other'],
  extraPeople: ['yes', 'no'],
  lettering: ['yes', 'no'],
};
const LAYERS = ['vest', 'cape', 'hood_down', 'collar', 'backpack', 'overalls_straps', 'necklace', 'belt', 'pouch', 'sash', 'wristbands', 'sword', 'boots'];
// What a HEAD cell (head and shoulders) can show; a belt, pouch, sword, wristbands or boots never are compared against it.
const HEAD_VISIBLE_LAYERS = ['vest', 'cape', 'hood_down', 'collar', 'backpack', 'overalls_straps', 'necklace'];
// Pieces that stay visible from every side; used for body-vs-body comparison (a front collar or necklace is not seen from behind).
const STABLE_LAYERS = ['vest', 'cape', 'backpack', 'sash'];

const CELL_KIND_RULES = {
  head: 'It is a HEAD cell: head and shoulders only. Lower parts of the body are not in it.',
  body: 'It is a FULL-BODY cell.',
};
const LAYERS_RULE = {
  head: 'This is a head cell: list only pieces you can see at the head, neck and shoulders.',
  body: 'List every one you can see.',
};

function buildCellPrompt(kind) {
  if (!CELL_KIND_RULES[kind]) throw new Error(`avatarCellJudge: unknown cell kind "${kind}"`);
  const t = PROMPT_TEMPLATES.avatarCellJudge;
  if (!t) throw new Error('avatarCellJudge prompt template not loaded');
  return fillTemplate(t, { CELL_KIND_RULE: CELL_KIND_RULES[kind], LAYERS_RULE: LAYERS_RULE[kind] });
}

/** Strict: a word outside its closed list throws. */
function parseCellAnswer(raw, where = 'cell') {
  if (!raw || typeof raw !== 'object') throw new Error(`avatarCellJudge: ${where} answer is not an object`);
  const out = {};
  for (const [f, allowed] of Object.entries(CELL_ENUMS)) {
    if (!allowed.includes(raw[f])) throw new Error(`avatarCellJudge: ${where} ${f} "${raw[f]}" is not one of ${allowed.join('|')}`);
    out[f] = raw[f];
  }
  if (!Array.isArray(raw.layers) || !raw.layers.every(l => LAYERS.includes(l))) {
    throw new Error(`avatarCellJudge: ${where} layers ${JSON.stringify(raw.layers)} must be a list of ${LAYERS.join('|')}`);
  }
  out.layers = [...new Set(raw.layers)];
  return out;
}

// ---------------------------------------------------------------- decisions over the enums (pure)

const COLOUR_SCALE = ['black', 'dark_brown', 'brown', 'light_brown', 'blonde'];
const LENGTH_SCALE = ['bald', 'buzz', 'short', 'chin', 'shoulder', 'long'];
const hairSeen = (c) => c.hairColour !== 'not_visible' && c.hairLength !== 'hidden';

function colourGap(a, b) {
  if (a === b) return 0;
  const i = COLOUR_SCALE.indexOf(a), j = COLOUR_SCALE.indexOf(b);
  return i < 0 || j < 0 ? 99 : Math.abs(i - j);
}
const modal = (xs) => { const n = {}; xs.forEach(x => { n[x] = (n[x] || 0) + 1; }); return Object.entries(n).sort((a, b) => b[1] - a[1])[0]?.[0]; };

// Each decider returns the list of cell numbers (1-8) that break the rule; empty = fine.
const DECIDERS = {
  hat: {
    // headgear in some cells and not in others
    presence: (cells) => { const w = cells.map(c => c.headgear !== 'none'); const n = w.filter(Boolean).length; return n > 0 && n < 8 ? w.map((x, i) => (x ? -1 : i + 1)).filter(x => x > 0) : []; },
    // ... or a different kind of headgear between the cells that wear one
    presenceOrKind: (cells) => {
      const p = DECIDERS.hat.presence(cells); if (p.length) return p;
      const kinds = new Set(cells.filter(c => c.headgear !== 'none').map(c => c.headgear));
      return kinds.size > 1 ? [1, 2, 3, 4, 5, 6, 7, 8] : [];
    },
  },
  hair: {
    colour: (cells, tol = 0) => { const seen = cells.map((c, i) => [c, i + 1]).filter(([c]) => hairSeen(c)); const m = modal(seen.map(([c]) => c.hairColour)); return seen.filter(([c]) => colourGap(c.hairColour, m) > tol).map(([, n]) => n); },
    colour0: (cells) => DECIDERS.hair.colour(cells, 0),
    colour1: (cells) => DECIDERS.hair.colour(cells, 1),
    colourOrWorn1: (cells) => { const a = DECIDERS.hair.colour(cells, 1); if (a.length) return a; const seen = cells.filter(hairSeen); const worn = new Set(seen.map(c => (c.hairWorn === 'down' ? 'down' : 'up'))); return worn.size > 1 ? [1, 2, 3, 4, 5, 6, 7, 8] : []; },
    colour1OrLength: (cells) => { const a = DECIDERS.hair.colour(cells, 1); if (a.length) return a; const l = cells.filter(hairSeen).map(c => LENGTH_SCALE.indexOf(c.hairLength)); return l.length && Math.max(...l) - Math.min(...l) >= 3 ? [1, 2, 3, 4, 5, 6, 7, 8] : []; },
  },
  bald: {
    // a missing head anywhere, or a bald cell while other cells show hair
    baldOrMissing: (cells) => {
      const bad = cells.map((c, i) => [c, i + 1]).filter(([c]) => c.head !== 'present').map(([, n]) => n);
      const anyHair = cells.some(c => ['short', 'chin', 'shoulder', 'long'].includes(c.hairLength));
      return bad.concat(anyHair ? cells.map((c, i) => [c, i + 1]).filter(([c]) => c.hairLength === 'bald').map(([, n]) => n) : []);
    },
    // a bald scalp is often read as "buzz": a buzz cell beside cells with hair of at least short length counts
    buzzBesideShort: (cells) => {
      const b = DECIDERS.bald.baldOrMissing(cells);
      const hair = cells.some(c => ['short', 'chin', 'shoulder', 'long'].includes(c.hairLength));
      return b.concat(hair ? cells.map((c, i) => [c, i + 1]).filter(([c]) => c.hairLength === 'buzz').map(([, n]) => n) : []);
    },
    // ... also a buzz-cropped cell beside cells with hair at least chin long
    baldBuzzMissing: (cells) => {
      const b = DECIDERS.bald.baldOrMissing(cells);
      const longHair = cells.some(c => ['chin', 'shoulder', 'long'].includes(c.hairLength));
      return b.concat(longHair ? cells.map((c, i) => [c, i + 1]).filter(([c]) => c.hairLength === 'buzz').map(([, n]) => n) : []);
    },
  },
  costume: {
    // top colour differs between cells of the same row ('striped'/'patterned' are their own class)
    colourInRow: (cells) => {
      const bad = [];
      for (const row of [cells.slice(0, 4), cells.slice(4)]) { const m = modal(row.map(c => c.topColour)); row.forEach(c => { if (c.topColour !== m) bad.push(cells.indexOf(c) + 1); }); }
      return bad;
    },
    // a stable piece (vest, cape, backpack, sash) in some body cells and absent in others
    stablePieceBodies: (cells) => STABLE_LAYERS.some(l => { const n = cells.slice(4).filter(c => c.layers.includes(l)).length; return n > 0 && n < 4; }) ? [5, 6, 7, 8] : [],
    stablePieceHeads: (cells) => STABLE_LAYERS.some(l => { const n = cells.slice(0, 4).filter(c => c.layers.includes(l)).length; return n > 0 && n < 4; }) ? [1, 2, 3, 4] : [],
    colourOrStable: (cells) => { const a = DECIDERS.costume.colourInRow(cells); const b = DECIDERS.costume.stablePieceBodies(cells); return [...new Set(a.concat(b, DECIDERS.costume.stablePieceHeads(cells)))]; },
    colourOrStableBodies: (cells) => { const a = DECIDERS.costume.colourInRow(cells); return [...new Set(a.concat(DECIDERS.costume.stablePieceBodies(cells)))]; },
  },
  rowMatch: {
    // head cell k against body cell k+4, only on what a head cell shows: top colour and the head-visible pieces
    colourAndPieces: (cells, minCells = 1) => {
      const bad = [];
      for (let k = 0; k < 4; k++) {
        const h = cells[k], b = cells[k + 4];
        const colourDiff = h.topColour !== b.topColour;
        const piece = HEAD_VISIBLE_LAYERS.some(l => (k < 3 || !['collar', 'necklace', 'overalls_straps'].includes(l)) && h.layers.includes(l) !== b.layers.includes(l));
        if (colourDiff || piece) bad.push(k + 1);
      }
      return bad.length >= minCells ? bad : [];
    },
    anyCell: (cells) => DECIDERS.rowMatch.colourAndPieces(cells, 1),
    twoCells: (cells) => DECIDERS.rowMatch.colourAndPieces(cells, 2),
    piecesOnly: (cells) => { const bad = []; for (let k = 0; k < 4; k++) if (HEAD_VISIBLE_LAYERS.some(l => (k < 3 || !['collar', 'necklace', 'overalls_straps'].includes(l)) && cells[k].layers.includes(l) !== cells[k + 4].layers.includes(l))) bad.push(k + 1); return bad.length >= 2 ? bad : []; },
    colourOrKindFront: (cells) => { const bad = []; for (let k = 0; k < 3; k++) if (cells[k].topColour !== cells[k + 4].topColour || cells[k].topKind !== cells[k + 4].topKind) bad.push(k + 1); return bad.length >= 2 ? bad : []; },
  },
  held: {
    any: (cells) => cells.map((c, i) => [c, i + 1]).filter(([c]) => c.held === 'yes').map(([, n]) => n),
    twoCells: (cells) => { const a = DECIDERS.held.any(cells); return a.length >= 2 ? a : []; },
  },
  layout: {
    any: (cells) => cells.map((c, i) => [c, i + 1]).filter(([c]) => c.medium !== 'watercolour' || c.extraPeople === 'yes' || c.lettering === 'yes').map(([, n]) => n),
    mediumAndPeople: (cells) => cells.map((c, i) => [c, i + 1]).filter(([c]) => c.medium !== 'watercolour' || c.extraPeople === 'yes').map(([, n]) => n),
    mediumOnly: (cells) => cells.map((c, i) => [c, i + 1]).filter(([c]) => c.medium !== 'watercolour').map(([, n]) => n),
  },
};
const DECIDER_TYPES = Object.keys(DECIDERS);

/** `config[type]` names the decider; the first listed is the default. */
function decideSheet(cells, config = {}) {
  if (!Array.isArray(cells) || cells.length !== 8) throw new Error('avatarCellJudge: decideSheet needs 8 parsed cells');
  const out = {};
  for (const t of DECIDER_TYPES) {
    const name = config[t] || Object.keys(DECIDERS[t])[0];
    const fn = DECIDERS[t][name];
    if (!fn) throw new Error(`avatarCellJudge: no decider ${t}.${name}`);
    out[t] = fn(cells);
  }
  return out;
}
const defectsOfCells = (cells, config) => Object.entries(decideSheet(cells, config)).filter(([, v]) => v.length).map(([t]) => t);

// ---------------------------------------------------------------- the calls

const CELL_LONG_SIDE = 640;

/**
 * Cut a sheet (sheetCut.js) and describe the 8 cells in parallel. A sheet the cutter cannot cut throws; the caller reports it as a
 * layout defect. Returns { cells (parsed), raw (8 answers), cutMs, callMs }.
 */
async function describeSheetCells({ sheetBuf, model, usageTracker = null, apiKey = null }) {
  const { askSheetJudge } = require('./character2x4Sheet')._internal;
  const t0 = Date.now();
  const crops = await cutSheet(sheetBuf);
  const cutMs = Date.now() - t0;
  const t1 = Date.now();
  const raw = await Promise.all(crops.map(async (png, i) => {
    const kind = i < 4 ? 'head' : 'body';
    const jpg = await sharp(png).resize(CELL_LONG_SIDE, CELL_LONG_SIDE, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 88 }).toBuffer();
    const prompt = buildCellPrompt(kind);
    const parts = [{ inline_data: { mime_type: 'image/jpeg', data: jpg.toString('base64') } }, { text: prompt }];
    return askSheetJudge({ model, parts, prompt, label: `avatar cell judge ${i + 1}`, usageTracker, usageFn: 'avatar_cell_judge', apiKey: apiKey || process.env.GEMINI_API_KEY });
  }));
  return { cells: raw.map((r, i) => parseCellAnswer(r, `cell ${i + 1}`)), raw, cutMs, callMs: Date.now() - t1 };
}

module.exports = { CELL_ENUMS, LAYERS, DECIDERS, DECIDER_TYPES, buildCellPrompt, parseCellAnswer, decideSheet, defectsOfCells, describeSheetCells };
