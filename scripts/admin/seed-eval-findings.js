#!/usr/bin/env node
/**
 * Seed the eval_findings registry.
 *
 * Every record here is a learning that currently lives INSIDE an evaluator
 * prompt as inline rationale. The point of the registry is that the prompt keeps
 * only `rule_text` (one terse line) while `rationale` — the incident, the
 * measurement, the reason — lives here and is read by humans in the Lab, not
 * re-sent to a model on every page.
 *
 * Idempotent: upserts on slug, so re-running after editing a record updates it.
 *
 * Usage: node scripts/admin/seed-eval-findings.js [--env staging|prod]
 */
'use strict';
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '..', '..', '.env') });
const { Pool } = require('pg');

const env = (process.argv.find(a => a.startsWith('--env=')) || '--env=staging').split('=')[1];
const cs = env === 'prod' ? process.env.DATABASE_URL : process.env.STAGING_DATABASE_URL;

const EVAL = 'image-evaluation.txt';
const COMP = 'image-prompt-compliance.txt';
const CONS = 'feedback-consolidator.txt';
const SEM = 'image-semantic.txt';

const FINDINGS = [
  // ── non-deductions extracted from the prompt ────────────────────────────────
  {
    slug: 'mirror-facing-equivalent', title: 'Left/right mirror is never a defect',
    category: 'non-deduction', prompt_file: EVAL, prompt_section: '§4',
    rule_text: 'Left/right placement, body facing, and which limb performs an action are mirror-equivalent — never deduct.',
    rationale: 'Image models place figures and choose limbs freely; a mirrored composition still reads the same beat to a child. Deducting for it produced a steady stream of findings no repair could satisfy, because a re-generate is equally likely to mirror the other way. Applies even when it contradicts a declared interaction direction.',
    evidence: { commits: ['pose mirror rule'], measurements: 'recurring across stories' },
  },
  {
    slug: 'expression-delta-unrenderable', title: 'Fine expression deltas are not renderable',
    category: 'non-deduction', prompt_file: EVAL, prompt_section: '§4',
    rule_text: 'Do not deduct for a specific facial expression not matching.',
    rationale: 'Image generators cannot render the difference between "calm surprise" and "curious". Only a gross contradiction (broad smile where the beat is fear) is meaningful, and that belongs to the semantic evaluator with a MODERATE/MAJOR cap.',
    evidence: {},
  },
  {
    slug: 'manga-monochrome-exception', title: 'Manga monochrome skips colour deductions',
    category: 'non-deduction', prompt_file: EVAL, prompt_section: 'STEP 2',
    rule_text: 'If the style is manga AND the render is predominantly monochrome, skip clothing-colour and hair-colour deductions.',
    rationale: 'Manga is the only style that legitimately drops colour. Without the carve-out every manga page collected a full set of colour mismatches for doing exactly what the style asked. Garment TYPE and hair LENGTH mismatches still apply.',
    evidence: {},
  },
  {
    slug: 'accessory-detail-cap', title: 'Accessory and small-item detail caps at MODERATE, one per figure',
    category: 'severity-policy', prompt_file: EVAL, prompt_section: 'STEP 2',
    rule_text: 'Eyewear tint, lanyard, shoe/sock colour, belt, watch, jewellery, hairclip, button colour, a missing stripe, a slightly off shade: MODERATE at most, capped at ONE per figure.',
    rationale: 'A reader does not notice a shoe-colour shift, least of all on a dim or distant figure. Uncapped, several such details stacked into the score of a real failure. NOTE: measured as NOT being obeyed — "missing glasses" returned MAJOR five times in one story despite this rule sitting in the same file.',
    evidence: { stories: ['job_1786147254924_8nuyywjii'], measurements: '5x MAJOR glasses findings against an explicit MODERATE cap' },
  },
  {
    slug: 'resting-limb-position', title: 'A correctly-formed limb in a different position is not an anatomy defect',
    category: 'non-deduction', prompt_file: EVAL, prompt_section: 'STEP 2D',
    rule_text: 'A well-formed hand/arm/limb that merely rests differently than the prose described is not an anatomy finding.',
    rationale: 'Anatomy checks were absorbing pose disagreements, double-charging what STEP 5 and the semantic evaluator already cover.',
    evidence: {},
  },
  {
    slug: 'incidental-signage-ok', title: 'Small in-world signage is acceptable',
    category: 'non-deduction', prompt_file: EVAL, prompt_section: 'STEP 3',
    rule_text: 'Small plausible in-world signage (shop sign, book spine, background poster) is acceptable; only prominent unrequested text is a defect.',
    rationale: 'Requiring a text-free world made every street scene fail. The real defect is prominent readable words the prompt never asked for — captions, watermarks, story text painted into the art.',
    evidence: {},
  },
  {
    slug: 'slight-smudge-is-minor', title: 'Slight smudging on a small region is MINOR',
    category: 'severity-policy', prompt_file: EVAL, prompt_section: 'STEP 3',
    rule_text: 'Soft fingertips, one finger fused to another, gentle blur on a hand where the limb still reads: MINOR.',
    rationale: 'Normal stylised brushwork, not a structural defect. Charged higher it competed with genuine fragment/fusion failures.',
    evidence: {},
  },
  {
    slug: 'proportions-scored-once', title: 'Head/body proportions are scored in one place only',
    category: 'detection', prompt_file: EVAL, prompt_section: 'STEP 3',
    rule_text: 'Proportions are scored in STEP 2C — do not duplicate the finding in STEP 3.',
    rationale: 'The same figure was charged twice for one proportion problem because two steps both had authority over it.',
    evidence: {},
  },
  {
    slug: 'face-direction-camera-relative', title: 'Face direction is camera-relative only',
    category: 'detection', prompt_file: EVAL, prompt_section: '§3',
    rule_text: 'Judge front/back/profile relative to the CAMERA. Which character a figure is turned toward is the semantic evaluator\'s job, not a quality defect.',
    rationale: 'Both evaluators were charging character-to-character orientation, and image models cannot reliably stage mutual gaze among three or more figures.',
    evidence: {},
  },
  {
    slug: 'identity-features-not-anachronism', title: 'Canonical character features are never anachronism',
    category: 'non-deduction', prompt_file: EVAL, prompt_section: '§3',
    rule_text: 'Glasses, hearing aid, braces are identity — never flag them against the setting era.',
    rationale: 'A character who wears glasses was being charged with anachronism in a period story, which no repair can fix without breaking their identity.',
    evidence: {},
  },
  {
    slug: 'object-count-minor', title: 'Off-by-1-2 prop counts are MINOR unless the count is the story',
    category: 'severity-policy', prompt_file: EVAL, prompt_section: '§3',
    rule_text: 'Count off by 1-2 with the cluster clearly present: MINOR. MAJOR only when the number is narratively load-bearing.',
    rationale: 'Image models cannot count reliably. A "three apples" page that renders four is not a publishing failure unless the number IS the point (seven dwarfs, a counting book).',
    evidence: {},
  },
  {
    slug: 'presence-is-an-input', title: 'Character presence is an input, never the evaluator\'s judgment',
    category: 'detection', prompt_file: COMP, prompt_section: 'STEP 1',
    rule_text: 'A character in QUALITY_FIGURES.matches[] IS present. Never report them missing, however their appearance differs.',
    rationale: 'Identification happens upstream by reference-photo matching. The compliance evaluator, which has NOT seen the image, was inferring absence from appearance differences and emitting CRITICAL missing-character findings for people plainly in the picture. This is the wording pattern that works in that file — a bold, early, unambiguous rule.',
    evidence: {},
  },

  // ── findings measured in this session ───────────────────────────────────────
  {
    slug: 'art-style-conditional-non-deduction', title: 'Style elements are non-deductible ONLY for the style commissioned',
    category: 'non-deduction', prompt_file: EVAL + ' + ' + COMP, prompt_section: 'style block',
    rule_text: 'Does the supplied ART STYLE call for this KIND of element? Yes → never a finding. No → judged normally. No style supplied → skip the rule.',
    rationale: 'A cyberpunk book was charged 3 CRITICALs for the neon its own art style mandates. A first fix listed neon/glow/holographic as always-ignorable, which owner correctly rejected: neon in a watercolour book IS a defect. A second attempt passed the style and said "read the block; do not assume" — that turned the model into a spec auditor which flagged neon for carrying lettering and for its mounting surface (37 issues vs 13). The wording that works adds: do not police the style\'s fine print (how many, which surface, whether a sign carries letters, whether it suits a rural setting).',
    evidence: { experiments: [412, 413, 414], stories: ['job_1786147254924_8nuyywjii'], measurements: 'baked-in 13 issues/0 neon; "read the block" 37/4; conditional 21/0' },
  },
  {
    slug: 'compliance-truncates-original-prompt', title: 'Compliance truncates ORIGINAL_PROMPT to 3000 chars and loses the art style',
    category: 'input-plumbing', prompt_file: COMP, prompt_section: 'INPUTS',
    rule_text: 'ART STYLE is passed as its own {ART_STYLE} input, never relied on inside ORIGINAL_PROMPT.',
    rationale: 'The compliance evaluator truncates ORIGINAL_PROMPT at 3000 chars while the ART STYLE block sits at the END of a ~7000-char page prompt — so it never saw the style at all, which is the real reason it reported required style elements as "no mention in prompt". Also: the quality path must resolve the style from the UNSTRIPPED prompt, because the cover branch deletes the ART STYLE block as evaluator noise.',
    evidence: { measurements: 'ART STYLE marker at char 7105 of 8892; truncation at 3000' },
  },
  {
    slug: 'judges-not-deterministic', title: 'Pinning temperature does not make the judges reproducible',
    category: 'determinism', prompt_file: null, prompt_section: null,
    rule_text: null,
    rationale: 'Compliance and semantic ran at 0.7 / provider default (~1.0) while only the Gemini visual eval was pinned; all judging calls plus the stage-1 vision inventory are now pinned to EVAL_TEMPERATURE=0. It was NOT sufficient: two identical runs still produced 0 of 6 identical issue sets. Remaining suspects, untested: OpenRouter routes to a different provider per call, and Gemini is not bit-deterministic at 0. CONSEQUENCE FOR ALL FUTURE WORK: never judge a prompt change on a single run — compare over repeats.',
    evidence: { experiments: [403, 404, 397, 399], measurements: '0/6 identical issue sets at temp 0; baseline neon findings 10 vs 4 across identical runs' },
  },
  {
    slug: 'consensus-cap-in-prompt-does-not-work', title: 'Asking the consolidator to cap single-source severities does not work — and code enforcement was rejected',
    category: 'severity-policy', prompt_file: CONS, prompt_section: 'deduped_issues',
    rule_text: 'Set severity by consensus: 2+ evaluators keep the highest; a single-source flag caps at MODERATE.',
    rationale: 'The rule shipped 2026-08-06 and a live story still had 46 of 60 single-source issues above MODERATE — the same 78% as before. Model was ruled out: on identical stored input qwen-plus left 6, qwen3-max 4, claude-sonnet 4. A code-side cap (capSingleSourceSeverity) was written, measured to lift page-best means 63.6→73.6 and 49.7→68.7, and then REVERTED at owner instruction: severity policy stays in the prompt and the pipeline does not rewrite evaluator output. DO NOT re-add the code cap.',
    status: 'active',
    evidence: { experiments: [405, 407, 408], commits: ['a8cd04ed6 (added)', '0312533c3 (reverted)'], measurements: '76% of issues are single-source; model ladder made no difference' },
  },
  {
    slug: 'gemini-flash-fails-as-consolidator', title: 'gemini-2.5-flash returns an empty consolidator plan',
    category: 'severity-policy', prompt_file: CONS, prompt_section: null,
    rule_text: null,
    rationale: 'Configured as the consolidator model it errored and returned zero issues on every page — which would silently zero every deduction in a story rather than fail loudly. Never configure it for this call.',
    status: 'rejected',
    evidence: { experiments: [409] },
  },
  {
    slug: 'entity-crop-misassignment', title: 'Entity check assigns one character\'s crop to another and emits false CATASTROPHIC',
    category: 'detection', prompt_file: null, prompt_section: null,
    rule_text: null,
    rationale: 'p10 charged CATASTROPHIC "Emma rendered as an elderly woman with grey hair" — Emma is the child in the yellow shirt; the grey-haired woman is Margaret standing beside her. p8 charged CRITICAL "Noah is depicted as an elderly person" — same mis-assignment. 225 points of false findings on a cast containing both a preschooler and a grandmother. This is a wrong-crop bug UPSTREAM of scoring, not a severity-tier problem — no prompt change fixes it.',
    evidence: { stories: ['job_1786147254924_8nuyywjii'], pages: [3, 4, 5, 8, 9, 10], measurements: '6 findings, 225 pts, 3 of them CATASTROPHIC' },
  },
  {
    slug: 'standard-clothing-phantom', title: '"standard clothing" is a category KEY, not an outfit description',
    category: 'detection', prompt_file: EVAL + ' + ' + COMP, prompt_section: null,
    rule_text: 'Compare a garment to the clothingRequirements DESCRIPTION for the page\'s category, never to the word "standard".',
    rationale: '15 findings of the form "Emma\'s clothing is non-standard (yellow t-shirt, denim shorts)" and "instead of naturalistic child attire" — 215 points. A yellow t-shirt and denim shorts on a five-year-old IS naturalistic child attire; "standard" is a key in clothingRequirements, not a look. The evaluator is comparing the render against the literal category name.',
    evidence: { stories: ['job_1786147254924_8nuyywjii'], measurements: '15 findings, 215 pts, 16% of all deduction weight' },
  },
  {
    slug: 'garment-name-must-survive', title: 'A garment noun contradicted by its own modifiers is unrepairable',
    category: 'input-plumbing', prompt_file: null, prompt_section: null,
    rule_text: null,
    rationale: 'The writer emitted "light denim shorts — square bib panel over the chest held by two shoulder straps", dropping the word "dungaree". The image model renders the head noun (plain shorts) and the evaluator reads the clause, so the garment is reported wrong on every page forever — and on one page the deduction inverted, charging the render for HAVING the bib. Fix is at the writer: keep the garment name in front of the structural parts. Do NOT reverse commit 516efb97e, which proved terse names alone render wrong.',
    evidence: { stories: ['job_1786024729214_zrjgzqiey'], commits: ['516efb97e'], measurements: '505 pts / 12.3% of deduction weight in one story' },
  },
  {
    slug: 'coherence-gate-was-write-only', title: 'coherence_gate was requested from the model and never read',
    category: 'output-format', prompt_file: EVAL, prompt_section: 'STEP 0',
    rule_text: 'Emit coherence_gate {applied, reason} on every page.',
    rationale: 'The field was requested for a long time and had ZERO readers in the codebase — grep returned only the prompt line asking for it. The redo it exists to force could never happen. Cost: a page framed by a full-perimeter border (an explicit catastrophic trigger) was reported as composition/MINOR instead, scored 68 — best in the book — and shipped. Now parsed and expressed as a CATASTROPHIC issue so it rides the existing catastrophic→iterate route.',
    evidence: { commits: ['ed560e4e5'], stories: ['job_1786024729214_zrjgzqiey'], pages: [6, 7] },
  },
  {
    slug: 'scene-prose-must-not-ban-rendering', title: 'Scene prose may not ban rendering the art style requires',
    category: 'input-plumbing', prompt_file: null, prompt_section: null,
    rule_text: null,
    rationale: 'A page read "Wide shot, clear depth layers, no glowing objects or text" while its own ART STYLE block required neon signage — the page contradicted itself and the evaluator was right either way. The Art Director never sees the art style, and the template\'s own example ends "no other figures in the room", so it generalised the pattern from props to rendering. Rule added to all THREE sites that emit scene prose, not just the fallback template.',
    evidence: { stories: ['job_1786053708336_8cdsca519'], pages: [11], measurements: 'after the fix: 0 of 10 pages ban glow/neon' },
  },
  {
    slug: 'eval-prompt-length-is-a-defect', title: 'image-evaluation.txt is 36k chars and its own rules stop being applied',
    category: 'detection', prompt_file: EVAL, prompt_section: null,
    rule_text: null,
    rationale: '406 lines, 129 bullet rules, 119 instances of "never / do not deduct". Filled for one page: 46,019 chars ~11,500 tokens; a 10-page story spent 862,221 eval input tokens over 109 calls. Three measured consequences: its own §4 accessory cap is ignored (5x MAJOR glasses), two identical runs give 0/6 identical issue sets, and the art-style rule had to be written into four places because no single spot is reliably read. When an eval misfires, check whether a rule already exists and is being ignored BEFORE appending another carve-out.',
    evidence: { measurements: '36,321 chars / 406 lines / 129 bullets / 119 "never"; 86k input tokens per page' },
  },
];

(async () => {
  if (!cs) { console.error(`No connection string for env=${env}`); process.exit(1); }
  const pool = new Pool({ connectionString: cs, ssl: { rejectUnauthorized: false } });
  let ins = 0, upd = 0;
  for (const f of FINDINGS) {
    const r = await pool.query(
      `INSERT INTO eval_findings (slug, title, category, prompt_file, prompt_section, rule_text, rationale, evidence, status, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'claude')
       ON CONFLICT (slug) DO UPDATE SET
         title=EXCLUDED.title, category=EXCLUDED.category, prompt_file=EXCLUDED.prompt_file,
         prompt_section=EXCLUDED.prompt_section, rule_text=EXCLUDED.rule_text,
         rationale=EXCLUDED.rationale, evidence=EXCLUDED.evidence, status=EXCLUDED.status,
         updated_at=NOW()
       RETURNING (xmax = 0) AS inserted`,
      [f.slug, f.title, f.category, f.prompt_file || null, f.prompt_section || null,
       f.rule_text || null, f.rationale, JSON.stringify(f.evidence || {}), f.status || 'active']
    );
    r.rows[0].inserted ? ins++ : upd++;
  }
  const tot = await pool.query('SELECT category, status, COUNT(*)::int n FROM eval_findings GROUP BY category, status ORDER BY category');
  console.log(`seeded ${env}: ${ins} inserted, ${upd} updated`);
  tot.rows.forEach(r => console.log(`  ${r.category.padEnd(18)} ${r.status.padEnd(11)} ${r.n}`));
  await pool.end();
  process.exit(0);
})().catch(e => { console.error('FAILED:', e.message); process.exit(1); });
