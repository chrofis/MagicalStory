'use strict';

/**
 * ONE defect judge for a finished 2 x 4 character reference sheet (prompts/avatar-sheet-defect-judge.txt).
 *
 * THE check of every avatar sheet (standard and costume, trial and full story; oneCallSheet.js runs it, redoes once on a flag and records
 * it): docs/decisions.md 2026-10-10 "avatar sheets are ONE Grok 2 call". Built with (2026-10-10 "avatar sheet judge"): the owner wants an eval
 * that catches hats that grow or vanish, hair that changes, bald or headless cells and inconsistent costumes.
 * It answers a typed verdict per defect type (closed enums, never prose); the free-text "evidence" field is for
 * humans reading the audit and is never parsed. Classification lives in the PROMPT; code only (a) validates the
 * enums, (b) compares per-cell ENUM answers across cells, and (c) maps verdict words to a defect list.
 *
 * The measurement of its types is scripts/analysis/eval-avatar-sheet-judge.js.
 */

const { PROMPT_TEMPLATES, fillTemplate } = require('../services/prompts');

// Closed answer sets. A word outside its set is a parse failure, never a silent pass.
const VERDICTS = {
  hat: ['ok', 'missing_in_some_cells', 'differs_between_cells', 'deformed', 'unexpected'],
  hair: ['ok', 'colour_differs', 'style_differs', 'differs_from_photo'],
  bald: ['ok', 'bald_cell', 'headless_or_blank_face'],
  costume: ['ok', 'pieces_differ', 'colours_differ', 'emblem_differs'],
  rowMatch: ['ok', 'head_row_differs'],
  held: ['ok', 'object_in_hand'],
  tail: ['ok', 'standing_on_tail'],
  layout: ['ok', 'not_a_grid', 'extra_figures', 'lettering', 'not_illustrated'],
  identity: ['ok', 'different_person', 'not_assessable'],
  age: ['ok', 'much_younger', 'much_older', 'not_assessable'],
};
const DEFECT_TYPES = Object.keys(VERDICTS);

const CELL_ENUMS = {
  headgear: ['none', 'hat', 'hood', 'headband_or_scarf', 'crown_or_tiara', 'other'],
  hairVisible: ['full', 'thin_or_buzzed', 'bald', 'hidden_by_headgear', 'not_in_frame'],
  hairColour: ['black', 'dark_brown', 'brown', 'light_brown', 'blonde', 'red', 'grey_or_white', 'other', 'none'],
  hairStyle: ['down', 'ponytail', 'braids', 'bun', 'short_crop', 'hidden', 'none'],
  head: ['present', 'missing_or_blank_face', 'cut_off'],
  heldObject: ['none', 'something'],
};

const SHEET_KIND_RULES = {
  standard: 'This is the person\'s EVERYDAY-CLOTHES sheet, not a costume. Headgear belongs on it only when the photo shows the person wearing it.',
  costume: 'This is a COSTUME sheet. Headgear is part of a costume: when all 8 cells show the same headgear, that is correct.',
};
const HEADGEAR_EXPECTATIONS = {
  standard: 'this is an everyday-clothes sheet and a hat or other headgear appears that the photo does not show the person wearing (without a photo: a costume-like or unusual hat).',
  costume: 'not used on a costume sheet.',
};

function buildAvatarSheetJudgePrompt({ kind, hasPhoto }) {
  if (!SHEET_KIND_RULES[kind]) throw new Error(`avatarSheetJudge: unknown sheet kind "${kind}" (standard | costume)`);
  const template = PROMPT_TEMPLATES.avatarSheetDefectJudge;
  if (!template) throw new Error('avatarSheetDefectJudge prompt template not loaded');
  return fillTemplate(template, {
    INPUT_IMAGES: hasPhoto
      ? 'You receive two images: Image 1 is the SHEET. Image 2 is a PHOTO of the real person the sheet must show.'
      : 'You receive one image: the SHEET. No photo is given.',
    SHEET_KIND_RULE: SHEET_KIND_RULES[kind],
    HEADGEAR_EXPECTATION: HEADGEAR_EXPECTATIONS[kind],
    AND_PHOTO: hasPhoto ? ' and compared with the photo' : '',
  });
}

function asCellList(v, where) {
  if (!Array.isArray(v) || !v.every(n => Number.isInteger(n) && n >= 1 && n <= 8)) {
    throw new Error(`avatarSheetJudge: ${where}.cells must be a list of cell numbers 1-8, got ${JSON.stringify(v)}`);
  }
  return [...new Set(v)].sort((a, b) => a - b);
}

/** Validate a raw judge answer against the closed enums. Throws on anything outside them. */
function parseAvatarSheetVerdict(raw) {
  if (!raw || typeof raw !== 'object') throw new Error('avatarSheetJudge: verdict is not an object');
  const verdicts = {};
  for (const t of DEFECT_TYPES) {
    const e = raw[t];
    if (!e || !VERDICTS[t].includes(e.verdict)) {
      throw new Error(`avatarSheetJudge: ${t}.verdict "${e && e.verdict}" is not one of ${VERDICTS[t].join('|')}`);
    }
    verdicts[t] = { verdict: e.verdict, cells: asCellList(e.cells ?? [], t) };
  }
  if (!Array.isArray(raw.cells) || raw.cells.length !== 8) {
    throw new Error(`avatarSheetJudge: cells must list all 8 cells, got ${Array.isArray(raw.cells) ? raw.cells.length : typeof raw.cells}`);
  }
  const cells = raw.cells.map((c, i) => {
    if (!c || c.cell !== i + 1) throw new Error(`avatarSheetJudge: cells[${i}] must be cell ${i + 1}`);
    const out = { cell: c.cell, top: String(c.top ?? ''), extras: String(c.extras ?? '') };
    for (const [f, allowed] of Object.entries(CELL_ENUMS)) {
      if (!allowed.includes(c[f])) throw new Error(`avatarSheetJudge: cell ${c.cell} ${f} "${c[f]}" is not one of ${allowed.join('|')}`);
      out[f] = c[f];
    }
    return out;
  });
  return { verdicts, cells, evidence: String(raw.evidence ?? '') };
}

/**
 * Second signal, computed from the judge's own per-cell ENUM answers (no free text is read):
 * the same cell-by-cell facts the verdict words summarise, compared mechanically.
 */
function cellSignals(cells) {
  const out = {};
  const gear = cells.map(c => c.headgear);
  const hasGear = gear.filter(g => g !== 'none');
  // Headgear present in some cells and absent in others, or a different kind between cells.
  out.hat = hasGear.length > 0 && (hasGear.length < 8 || new Set(hasGear).size > 1);
  // Any cell where the head is bald / has no head, while another cell shows hair.
  const anyHair = cells.some(c => c.hairVisible === 'full' || c.hairVisible === 'thin_or_buzzed');
  out.bald = cells.some(c => c.head !== 'present' || (c.hairVisible === 'bald' && anyHair));
  out.held = cells.some(c => c.heldObject === 'something');
  const colours = new Set(cells.filter(c => c.hairVisible === 'full' || c.hairVisible === 'thin_or_buzzed').map(c => c.hairColour));
  out.hair = colours.size > 1;
  return out;
}

// Verdict words that need the PHOTO to be true (the sheet is consistent with itself but not with the person).
const PHOTO_WORDS = { hat: ['unexpected'], hair: ['differs_from_photo'], identity: ['different_person'], age: ['much_younger', 'much_older'] };

/**
 * Defect types the sheet fails. `use[type]` picks the signal that counts for that type:
 *   verdict           the judge's verdict word (default)
 *   consistency       the verdict word, except the photo-only words (the sheet against ITSELF)
 *   cells             the per-cell enum comparison (cellSignals)
 *   either            verdict or cells;  eitherConsistency = consistency or cells
 */
function defectsOf(parsed, use = {}) {
  const sig = cellSignals(parsed.cells);
  const found = [];
  for (const t of DEFECT_TYPES) {
    const word = parsed.verdicts[t].verdict;
    const verdictBad = word !== 'ok' && word !== 'not_assessable';
    const consistencyBad = verdictBad && !(PHOTO_WORDS[t] || []).includes(word);
    const cellBad = Boolean(sig[t]);
    const mode = use[t] || 'verdict';
    const bad = { verdict: verdictBad, consistency: consistencyBad, cells: cellBad, either: verdictBad || cellBad, eitherConsistency: consistencyBad || cellBad }[mode];
    if (bad === undefined) throw new Error(`avatarSheetJudge: unknown signal mode "${mode}"`);
    if (bad) found.push(t);
  }
  return found;
}

/**
 * Judge one sheet. `sheet` / `photo` are data URIs or base64 strings with a data: prefix (as askSheetJudge expects).
 * Returns { parsed, raw, prompt }. Throws when the judge fails; the caller decides what a failed judge means
 * (the pipeline wiring proposal in docs/decisions.md: fail loudly).
 */
async function judgeAvatarSheet({ sheet, photo = null, kind, model, usageTracker = null, apiKey = null }) {
  const { askSheetJudge, inlinePartOf } = require('./character2x4Sheet')._internal;
  const prompt = buildAvatarSheetJudgePrompt({ kind, hasPhoto: Boolean(photo) });
  const parts = [inlinePartOf(sheet)];
  if (photo) parts.push(inlinePartOf(photo));
  parts.push({ text: prompt });
  const raw = await askSheetJudge({ model, parts, prompt, label: 'avatar sheet defect judge', usageTracker, usageFn: 'avatar_sheet_defect_judge', apiKey: apiKey || process.env.GEMINI_API_KEY });
  return { parsed: parseAvatarSheetVerdict(raw), raw, prompt };
}

// What a sheet is redone for (docs/decisions.md 2026-10-10 "Trial standard sheet: whole-sheet judge, one redo" and "avatar sheets are ONE
// Grok 2 call"): a bald or headless cell, a held object, a broken layout (not a grid, a second person, lettering, a photograph) and a
// tail costume drawn standing without a fin. Hat, hair, costume and head-row questions stay off: measured precision 5-28%
// (decisions 2026-10-10 "Avatar sheet defect judge"), a redo on every second clean sheet. Signal per type as tuned there.
const SHEET_CHECK_SIGNALS = { bald: 'verdict', held: 'cells', layout: 'verdict', tail: 'verdict' };

/** The redo-worthy defects of a parsed verdict: [{ type, word, cells }]; `cells` are the numbers the judge named. */
function sheetDefects(parsed) {
  const found = defectsOf(parsed, SHEET_CHECK_SIGNALS).filter(t => t in SHEET_CHECK_SIGNALS);
  return found.map(type => {
    const v = parsed.verdicts[type];
    // held is decided from the per-cell enum answers, so its cells come from there
    const cells = type === 'held' ? parsed.cells.filter(c => c.heldObject === 'something').map(c => c.cell) : v.cells;
    return { type, word: type === 'held' ? 'object_in_hand' : v.verdict, cells };
  });
}

/** The better of two judged sheets: fewer defect types, then fewer flagged cells; a tie keeps `a` (the first). */
function betterSheet(a, b) {
  const size = (d) => [d.length, d.reduce((n, x) => n + x.cells.length, 0)];
  const [ta, ca] = size(a.defects); const [tb, cb] = size(b.defects);
  return (tb < ta || (tb === ta && cb < ca)) ? b : a;
}

module.exports = { SHEET_CHECK_SIGNALS, sheetDefects, betterSheet, VERDICTS, DEFECT_TYPES, CELL_ENUMS, buildAvatarSheetJudgePrompt, parseAvatarSheetVerdict, cellSignals, defectsOf, judgeAvatarSheet };
