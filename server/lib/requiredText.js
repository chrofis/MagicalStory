// server/lib/requiredText.js
// REQUIRED IN-IMAGE TEXT — the one source for every side of "this element
// carries words that must be readable and correctly spelled".
//
// WHY THIS FILE EXISTS. A Visual Bible artifact may declare `text` — "words
// that must be READABLE on the object" (visualBible.js). Until 2026-09-21 that
// field had exactly ONE consumer, referenceSheets.elementTextSentence, which
// renders the VB reference CELL. The glyphs therefore reached the page as
// PIXELS in a reference image and never as a STRING in the prompt:
//
//   * the REQUIRED OBJECTS block is NAME ONLY by ruling (promptBuilders), so a
//     signpost that has to read a four-letter word was listed as
//     `* **crossroads letters** (object) — fills an open hand`;
//   * image-generation.txt bans all lettering with an exception for "text the
//     Visual Bible explicitly specifies", which the model cannot resolve
//     because nothing in the prompt quotes the specified string;
//   * REPAIR_TEXT_GUARD bans lettering in every repaint, so a repair round
//     could not converge on a page whose defect WAS the lettering;
//   * no judge checks that a required string is present and spelled right —
//     D-23 `rendered_text` only penalises lettering nobody asked for, and the
//     blind compliance judge counts a string as asked-for only when the prompt
//     QUOTES it, so a correctly spelled sign scored as a MAJOR defect.
//
// Measured on production job_1789945743706_8ayo2w19e: p14 required an ordered
// letter run and rendered a scrambled one; p15 required a letter pair and
// rendered the wrong pair at 100/100; p16 had to spell a four-letter word on a
// signpost and rendered its letters scattered and incomplete.
//
// THE CONTRACT. One rule sentence (REQUIRED_TEXT_RULE) is injected into the
// generator template AND into all three judge templates, so the illustrator is
// asked for exactly what the judges score. One item builder feeds the
// generator block, the repair clause and the judge TEXT RULES block, so the
// three can never quote different strings.
//
// NO FALLBACK: an element that declares `text` and cannot be resolved to a
// label throws — a declared string is never silently dropped.

const { log } = require('../utils/logger');

// The ONE rule both sides receive. Generator and critic get the same sentence;
// each block below adds only the page's own strings around it.
// The AUTHORING rule. REQUIRED_TEXT_RULE above tells the ILLUSTRATOR and the
// judges what to do with a string that was declared; this one tells the stage
// that writes the Visual Bible WHEN to declare one at all. Until 2026-09-21 no
// authoring template carried a trigger: `text` was an opt-out schema note, so
// on job_1789945743706_8ayo2w19e p14 the element that had to carry an ordered
// run declared `text: null`, p15 listed no text-carrying element at all, and
// p3's recurring lettered class had no entry to hang a string on. Over-
// declaring is the opposite defect — image-generation.txt bans lettering by
// default and a string declared for a picture that needs none forces words
// into it — so the rule names both directions and the recurring-class case.
const REQUIRED_TEXT_AUTHORING_RULE = 'Lettering the reader must actually READ — a signpost a character reads, a labelled door, a numbered house, a name on a gift — is declared: the element carrying it gets an entry whose `text` is the exact characters in the order they must appear. Nothing else declares `text`: writing the story never asks anyone to read stays undeclared and its `description` calls it illegible. A page whose prose has someone read something cites an entry that declares the string, and an entry is written for it when none exists. Many instances of one lettered thing — a row of marked posts, a shelf of labelled jars — are ONE entry with a plural label whose `text` is the whole run in the order it must read across them, and such an entry is never `generic`.';

const REQUIRED_TEXT_RULE = 'Each string listed above is painted on the element named, exactly those characters in that order, left to right, correctly spelled and legible. No other surface in the image carries lettering.';

/**
 * The declared string for one Visual Bible entry, or null.
 * @param {Object} entry
 * @returns {string|null}
 */
function declaredText(entry) {
  const t = entry && typeof entry.text === 'string' ? entry.text.trim() : '';
  return t || null;
}

/**
 * Items for one page: every element on the page that declares `text`.
 *
 * Callers pass whichever shape they hold:
 *  - `entries`: resolved VB entries (the generator already has them, with the
 *    label it emitted into REQUIRED OBJECTS — pass `{entry, label}` pairs);
 *  - `objectIds` + `visualBible`: the stored scene metadata's VB ids, which is
 *    what every eval and repair path holds. Labels resolve through the SAME
 *    `elementLeadLabel` the page prompt's bold lead uses, so the judge quotes
 *    the element by the name the illustrator was given.
 *
 * @returns {Array<{id: string|null, label: string, text: string}>}
 */
function collectRequiredTexts({ entries = null, objectIds = null, visualBible = null, language = 'en' } = {}) {
  const out = [];
  const seen = new Set();
  const push = (id, label, text) => {
    const key = `${String(label || '').toLowerCase()}|${text}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ id: id || null, label: String(label || '').trim(), text });
  };

  if (Array.isArray(entries)) {
    for (const row of entries) {
      const entry = row && row.entry ? row.entry : row;
      const text = declaredText(entry);
      if (!text) continue;
      const label = String((row && row.label) || '').trim();
      if (!label) {
        // Loud, never dropped: a declared string with no name to hang it on
        // would reach the model as free-floating lettering.
        throw new Error(`requiredText: element ${(entry && entry.id) || '(no id)'} declares text "${text}" but no label was resolved`);
      }
      push(entry && entry.id, label, text);
    }
    return out;
  }

  if (Array.isArray(objectIds) && visualBible) {
    // Lazy: promptBuilders is the heavier module and requires this one.
    const { elementLeadLabel } = require('./promptBuilders');
    const pools = [
      ['artifacts', 'object'], ['vehicles', 'vehicle'], ['clothing', 'clothing'], ['animals', 'animal'],
    ];
    const byId = new Map();
    for (const [pool, type] of pools) {
      for (const e of (Array.isArray(visualBible[pool]) ? visualBible[pool] : [])) {
        if (e && e.id) byId.set(String(e.id).toUpperCase(), { entry: e, type });
      }
    }
    for (const raw of objectIds) {
      // A dotted id ("ART004.2") is a STATE of the base entry; text rides the base.
      const id = String(raw || '').trim().toUpperCase().split('.')[0];
      const hit = byId.get(id);
      if (!hit) continue;
      const text = declaredText(hit.entry);
      if (!text) continue;
      const label = elementLeadLabel(hit.entry, { language, type: hit.type });
      if (!label) {
        throw new Error(`requiredText: ${id} declares text "${text}" but elementLeadLabel returned nothing`);
      }
      push(id, label, text);
    }
  }
  return out;
}

/**
 * A cover's own painted lettering (its title, dedication or brand line) as a
 * required-text item, so it rides the SAME channel as a page's declared
 * strings: the generator block, all three judges' {TEXT_RULES}, the
 * consolidator input and the repair clause.
 *
 * Until 2026-09-23 the title reached the quality judge only as a prepended
 * note, while every judge's structured TEXT RULES was empty. On staging
 * job_1790100385959_1nitlympp the semantic judge — told "no lettering" and
 * handed an empty allow-list — filed the correctly painted front-cover title
 * as CRITICAL unrequested text, the repair erased it, and the titleless
 * re-render scored 100 because D-33 skips an empty TEXT RULES.
 *
 * `textMode` / `expectedText` are the structured cover contract
 * (coverTypography.resolveCoverTextContract). 'appOverlay' art is textless by
 * design — the app composites its text later — so it requires nothing here.
 *
 * @returns {Array<{id: null, label: string, text: string}>}
 */
function coverRequiredTexts({ expectedText = null, textMode = null } = {}) {
  if (textMode === 'appOverlay') return [];
  const text = typeof expectedText === 'string' ? expectedText.trim() : '';
  return text ? [{ id: null, label: 'cover', text }] : [];
}

/**
 * Every string one image must show: the Visual Bible elements it cites plus,
 * on a cover, the cover's own painted lettering. The one list the eval and the
 * repair both build from, so the judge scores and the repair keeps the same
 * strings.
 */
function collectImageRequiredTexts({ objectIds = null, visualBible = null, language = 'en', expectedText = null, textMode = null } = {}) {
  return [
    ...coverRequiredTexts({ expectedText, textMode }),
    ...collectRequiredTexts({ objectIds, visualBible, language }),
  ];
}

/** `- on the **signpost**: "WORD"` lines, shared by every block below. */
const itemLines = (items) => items.map(i => `- on the **${i.label}**: "${i.text}"`).join('\n');

/**
 * The GENERATOR block ({REQUIRED_TEXT} in image-generation.txt). Empty string
 * when the page declares none — fillTemplate then strips the placeholder and
 * the prompt is byte-identical to before.
 */
function buildRequiredTextBlock(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `**REQUIRED TEXT:**\n${itemLines(items)}\n${REQUIRED_TEXT_RULE}`;
}

/**
 * The JUDGE block ({TEXT_RULES}): allowed strings named up front, then how to
 * read them. Pages and covers share it — a cover's title arrives as an item
 * from coverRequiredTexts, never as a separate note.
 * SEVERITY IS NOT STATED HERE: the judge templates own classification and
 * severity (docs/SETTLED.md, "classification is the PROMPT's job"); this block
 * supplies only the page's strings and the shared rule.
 */
function buildRequiredTextRulesBlock(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return [
    'TEXT RULES FOR THIS IMAGE:',
    'This page asks for readable lettering. Required text:',
    itemLines(items),
    REQUIRED_TEXT_RULE,
    'Before reporting a required string wrong, RE-READ the rendered lettering character by character against the string above and quote what you read. If you cannot quote it, do not flag it.',
    'Every required string above is permitted lettering — never report it as unrequested rendered text. Any OTHER prominent lettering still is.',
  ].join('\n');
}

/**
 * The REPAIR clause. A repaint whose defect IS the lettering has to be allowed
 * to paint it; REPAIR_TEXT_GUARD's ban carries an exception for text the
 * prompt quotes, and this clause is what quotes it.
 */
function buildRequiredTextRepairClause(items) {
  if (!Array.isArray(items) || items.length === 0) return '';
  return `\n\nRequired text in this illustration:\n${itemLines(items)}\n${REQUIRED_TEXT_RULE}`;
}

/** Log line so a page's declared strings are traceable from the job log. */
function logRequiredTexts(items, pageNumber) {
  if (!Array.isArray(items) || items.length === 0) return;
  log.info(`🔤 [REQUIRED TEXT] Page ${pageNumber === undefined || pageNumber === null ? '?' : pageNumber}: ${items.map(i => `${i.label}="${i.text}"`).join(', ')}`);
}

module.exports = {
  REQUIRED_TEXT_RULE,
  REQUIRED_TEXT_AUTHORING_RULE,
  declaredText,
  collectRequiredTexts,
  coverRequiredTexts,
  collectImageRequiredTexts,
  buildRequiredTextBlock,
  buildRequiredTextRulesBlock,
  buildRequiredTextRepairClause,
  logRequiredTexts,
};
