/**
 * TEST LAB ONLY — candidate shapes of the 2×4 sheet style judge
 * (prompts/sheet-2x4-style-eval.txt, character2x4Sheet.evaluateStyledSheetWithGemini).
 *
 * Production is unchanged: it runs arm `current`. The others exist to be
 * MEASURED on the `sheet_style` judge fixtures (docs/judge-fixtures.md) before
 * the owner picks one (diagnosis 2026-10-04, docs/decisions.md "Sheet style
 * judge arms — measured, not adopted"):
 *
 *   current  production as it stands
 *   A        a text label before each image ("Image 2 — …"); prompt unchanged
 *   AB       A + TASK 3 names the medium of every cell, one medium for all 8
 *   ABC      AB + TASK 1 scores each cell's framing against Image 2's same cell
 *   D        ABC, but a wardrobe-state variant is judged against the approved
 *            STYLED base it was edited from (not the realistic Pass-1 sheet).
 *            A sheet with no garment taken off has no styled base: D runs ABC.
 *
 * Every transform replaces a whole TASK block found by its heading and fails
 * loudly when the block is not there, so a template edit can never turn an arm
 * silently into `current`.
 */
'use strict';

const SHEET_JUDGE_ARMS = Object.freeze(['current', 'A', 'AB', 'ABC', 'D']);

const LABELS_PASS1 = Object.freeze([
  'Image 1 — the source face photo:',
  'Image 2 — the realistic Pass-1 sheet (the reference):',
  'Image 3 — the styled sheet being judged:',
]);
const LABELS_STYLED_BASE = Object.freeze([
  'Image 1 — the source face photo:',
  'Image 2 — the approved styled sheet this one was edited from (the reference):',
  'Image 3 — the edited sheet being judged:',
]);

const HEADER_STYLED_BASE = `  - Image 2: the APPROVED styled 2×4 sheet — the reference this sheet was edited from.
  - Image 3: the edited 2×4 sheet — Image 2 with one or more garments taken off.

Image 2 and Image 3 should match cell-for-cell in medium, framing, pose, face, hair and every garment kept on. Only the garments taken off may differ.`;

const TASK1_FRAMING = `TASK 1: LAYOUT PRESERVED
- Image 3 keeps Image 2's grid: 4 columns × 2 rows, head cells on top, full-body cells below, each cell facing the way the same cell of Image 2 faces (front, three-quarter, profile, rear turn).
- In \`layout.reason\`, per cell: the facing in Image 3 and where the figure is cut off at the bottom of the cell (chest, waist, hips, knees, feet), then the same for Image 2's same cell.
- Score 1-10. A wrecked layout (figures crossing the row gutter, cells merged, wrong cell count) = 1-3. A cell whose facing differs from Image 2's same cell = 4-6. A cell cut off at a different place than Image 2's same cell (chest becomes waist or hips) = 4-5.
- \`layoutScore\` is the score.`;

const TASK3_MEDIUM = `TASK 3: STYLE MATCH
- Image 3 is rendered in the requested style: REQUESTED_STYLE.
- In \`style.reason\`, name the medium of each of the 8 cells of Image 3 from what is drawn there: paint washes, ink or pencil lines, flat colour, or photographic.
- All 8 cells are drawn in that one style.
- Score 1-10; the lowest cell decides. A cell that still looks photographic or barely changed from Image 2 = 1-3. A cell in another medium (line art, flat colour) or in a medium the other cells do not share = 1-3. Style partly applied = 4-6. Every cell fully in the requested style = 8-10.
- \`styleScore\` is the score.`;

const TASK3_MEDIUM_VS_BASE = `TASK 3: STYLE MATCH
- Image 2 is in the requested style: REQUESTED_STYLE.
- In \`style.reason\`, name the medium of each of the 8 cells of Image 3 from what is drawn there (paint washes, ink or pencil lines, flat colour, photographic), and the medium of Image 2's same cell.
- Every cell of Image 3 is drawn in the same medium as Image 2's same cell.
- Score 1-10; the lowest cell decides. A cell in a different medium than Image 2's same cell = 1-3. Same medium, slightly different handling = 7-8. The same medium in every cell = 9-10.
- \`styleScore\` is the score.`;

const STYLE_SHAPE_LINE = '"style":    {"score": <1-10>, "reason": "cell1: <medium>; cell2: <medium>; and so on to cell8"},';
const LAYOUT_SHAPE_LINE = '"layout":   {"score": <1-10>, "reason": "cell1: <facing, cut off at> vs Image 2 <facing, cut off at>; and so on to cell8"},';

/** Replace the TASK block that starts at `heading` and ends at its score line. */
function replaceTask(template, heading, scoreKey, block) {
  const re = new RegExp(`${heading.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n[\\s\\S]*?- \`${scoreKey}\` is the score\\.`);
  if (!re.test(template)) throw new Error(`sheetJudgeArms: "${heading}" block not found in the style-eval template`);
  return template.replace(re, () => block);
}
function replaceLine(template, startsWith, line) {
  const re = new RegExp(`^\\s*${startsWith.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}.*$`, 'm');
  if (!re.test(template)) throw new Error(`sheetJudgeArms: JSON shape line "${startsWith}" not found in the style-eval template`);
  return template.replace(re, () => `  ${line}`);
}
function replaceHeader(template) {
  const re = /  - Image 2: the REALISTIC[^\n]*\n  - Image 3: the STYLED[^\n]*\n\nImage 2 and Image 3 should match[^\n]*/;
  if (!re.test(template)) throw new Error('sheetJudgeArms: the image header (Image 2 / Image 3 lines) not found in the style-eval template');
  return template.replace(re, () => HEADER_STYLED_BASE);
}

/**
 * The arm as it runs on one sheet.
 * @param {string} arm one of SHEET_JUDGE_ARMS
 * @param {string} template the CURRENT style-eval template (PROMPT_TEMPLATES.sheet2x4StyleEval)
 * @param {{variant: boolean}} sheet — variant = a garment is taken off on this sheet
 * @returns {{arm, applied, reference: 'pass1'|'styledBase', template: string|null, imageLabels: string[]|null}}
 *          template null = production's own template (no override).
 */
function resolveArm(arm, template, { variant = false } = {}) {
  if (!SHEET_JUDGE_ARMS.includes(arm)) throw new Error(`sheetJudgeArms: unknown arm "${arm}" (known: ${SHEET_JUDGE_ARMS.join(', ')})`);
  if (arm === 'current') return { arm, applied: 'current', reference: 'pass1', template: null, imageLabels: null };
  if (!template) throw new Error('sheetJudgeArms: style-eval template not loaded');
  const applied = arm === 'D' && !variant ? 'ABC' : arm;
  if (applied === 'A') return { arm, applied, reference: 'pass1', template: null, imageLabels: [...LABELS_PASS1] };
  if (applied === 'D') {
    let t = replaceHeader(template);
    t = replaceTask(t, 'TASK 1: LAYOUT PRESERVED', 'layoutScore', TASK1_FRAMING);
    t = replaceTask(t, 'TASK 3: STYLE MATCH', 'styleScore', TASK3_MEDIUM_VS_BASE);
    t = replaceLine(t, '"style":', STYLE_SHAPE_LINE);
    t = replaceLine(t, '"layout":', LAYOUT_SHAPE_LINE);
    return { arm, applied, reference: 'styledBase', template: t, imageLabels: [...LABELS_STYLED_BASE] };
  }
  let t = replaceTask(template, 'TASK 3: STYLE MATCH', 'styleScore', TASK3_MEDIUM);
  t = replaceLine(t, '"style":', STYLE_SHAPE_LINE);
  if (applied === 'ABC') {
    t = replaceTask(t, 'TASK 1: LAYOUT PRESERVED', 'layoutScore', TASK1_FRAMING);
    t = replaceLine(t, '"layout":', LAYOUT_SHAPE_LINE);
  }
  return { arm, applied, reference: 'pass1', template: t, imageLabels: [...LABELS_PASS1] };
}

module.exports = { SHEET_JUDGE_ARMS, resolveArm, LABELS_PASS1, LABELS_STYLED_BASE };
