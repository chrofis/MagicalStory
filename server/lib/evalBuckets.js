// server/lib/evalBuckets.js
// Canonical eval BUCKET taxonomy + multi-judge merge — the pure core of the
// three-judge (Gemini / Grok / Qwen) evaluation.
//
// WHY: a free-form `type` string per issue can't be aggregated for stats, and a
// single holistic 0-100 score flickers run-to-run (see docs/decisions and the
// LLM-judge notes). This module turns each judge's `fixable_issues[]` into a
// FIXED dimension vector (one severity per bucket), merges several judges by
// PURE MEDIAN per bucket, and re-emits a deduplicated issue list that the
// EXISTING scorer (server/lib/scoring.js) turns into the final number — so the
// score math stays single-source; this file owns only the taxonomy + merge.
//
// MERGE POLICY (locked with the owner): pure median severity per bucket, with
// "not flagged" treated as severity 0. Critical is treated like any other
// severity — so [critical, major, major] → major, [critical, critical, major]
// → critical, [critical, none, none] → none. A defect only 1 of 3 judges catches
// is intentionally dropped (fewer false alarms; accepts a rare real miss).
// Median over {present-severity, 0} also yields 2-of-3 MAJORITY for binary
// buckets for free — no separate majority path needed.

// Severity ordinal — the only ranking this module needs. The POINTS that turn a
// severity into a score deduction live in scoring.js (SEVERITY_POINTS) and are
// applied downstream; do NOT duplicate them here.
const SEVERITY_RANK = { none: 0, minor: 1, moderate: 2, major: 3, critical: 4, catastrophic: 5 };
const RANK_TO_SEVERITY = ['none', 'minor', 'moderate', 'major', 'critical', 'catastrophic'];
const sevRank = (s) => SEVERITY_RANK[String(s || 'none').toLowerCase()] ?? 0;

// The CLOSED bucket set. `owner` = which eval is authoritative for it (quality /
// semantic / entity). `kind` = binary (present-or-not) vs graded (0-3 severity).
// `repair` = the method the repair router should reach for. Keeping this list
// closed is what makes per-style / per-genre stats a plain GROUP BY.
const BUCKETS = {
  image_coherence:      { owner: 'quality',  kind: 'binary', repair: 'regen' },
  character_presence:   { owner: 'quality',  kind: 'binary', repair: 'regen_or_composite' },
  character_identity:   { owner: 'quality',  kind: 'binary', repair: 'grok_face' },
  clothing:             { owner: 'quality',  kind: 'graded', repair: 'grok_blended' },
  // Small worn items (eyewear, bandana, belt, badge, footwear, jewellery) as
  // distinct from the MAIN garment. Its own bucket so the ceiling below can be
  // enforced on it without touching real wardrobe failures, and so "how much of
  // our clothing tax is accessory nitpicking?" is a GROUP BY instead of a regex
  // over descriptions. Repair is identical to clothing — routing is unchanged.
  accessory:            { owner: 'quality',  kind: 'graded', repair: 'grok_blended' },
  // Right garment, different cut (sleeve length, collar, cuff, hem). Its own
  // type so the ceiling in scoring.js can bind to it without touching a
  // genuinely wrong garment. Measured on job_1786287569165: 46 of compliance's
  // 78 wardrobe findings were this, worth 670 points, three of them CRITICAL
  // for a rolled sleeve.
  clothing_detail:      { owner: 'quality',  kind: 'graded', repair: 'grok_blended' },
  // An absence the BLIND compliance evaluator inferred from a silent inventory
  // field, having not seen the image. Measured over 154 absence findings across
  // two stories: 55% of compliance's absences were false (the item plainly
  // visible), against 0% for the two evaluators that DO see the image. Its own
  // type so the low ceiling in scoring.js binds only to the unreliable class —
  // a confirmed absence from quality or semantic is untouched.
  unverified_absence:   { owner: 'quality',  kind: 'graded', repair: 'inpaint' },
  anatomy:              { owner: 'quality',  kind: 'graded', repair: 'regen' },
  figure_completeness:  { owner: 'quality',  kind: 'binary', repair: 'regen' },
  // `camera_facing` was MERGED into action_interaction (2026-08-09). It was an
  // axis category — "can we see the face?" — that explicitly forbade the only
  // question ever actually asked of it ("never judge which character a figure
  // is turned toward"). Measured on a 14-page story: of 31 findings, 12 were
  // left/right mirrors and the remaining 19 ALL named a target (a person or an
  // object). Zero were genuine axis claims. Merging also aligns repair with a
  // settled verdict — camera_facing routed to `regen` (full page redo) while
  // SETTLED.md says Grok inpaint handles facing/gaze/body rotation, which is
  // what action_interaction's `inpaint_or_regen` allows.
  action_interaction:   { owner: 'semantic', kind: 'graded', repair: 'inpaint_or_regen' }, // rope slack while pulling, wrong aim, faces away from target
  object_presence:      { owner: 'quality',  kind: 'binary', repair: 'inpaint' },
  object_count:         { owner: 'quality',  kind: 'graded', repair: 'inpaint' },
  // wrong/missing environment detail: location, background, weather, time of day
  setting:              { owner: 'quality',  kind: 'graded', repair: 'inpaint' },
  // Garment colour is corrected mechanically (masked L*a*b* match toward the
  // character's canonical colour), so it routes to that fixer and NEVER costs
  // score — regenerating a character to change a shirt's hue is the expensive
  // wrong answer. scoring.js zeroes its points; the category exists so it is
  // visible in per-category stats instead of hiding on a private channel.
  garment_colour:       { owner: 'entity',   kind: 'graded', repair: 'garment_colour_fix' },
  // Last-resort safety net for a genuinely unclothed figure. Its own bucket
  // rather than a clothing sub-case so it is countable on its own: in a
  // correctly-specified story it should never fire, so a non-zero count is a
  // signal that the CLOTHING contract failed upstream, not just a page defect.
  nudity:               { owner: 'quality',  kind: 'binary', repair: 'regen' },
  // The beat's feeling contradicted. Previously aliased into `naturalness`, so
  // "how much of our tax is emotion?" was unanswerable and the per-character
  // billing could not separate it from every other catch-all finding. This adds
  // a CODE, not a new deduction: the gross-only rule in image-semantic.txt is
  // unchanged (a neutral/mild expression still satisfies the beat, at most one
  // emotion finding per page, never CRITICAL) and image-evaluation's N-03
  // non-deduction stands. Repair is an inpaint — a face repaint fixes an
  // expression; a full regen is the expensive wrong answer.
  emotion:              { owner: 'semantic', kind: 'graded', repair: 'inpaint' },
  // Posing for the camera instead of engaging the scene — the owner's
  // "position / facing" (2026-08-19). Measured over the last 40 stories, 89
  // findings across 43 pages in 19 stories describe exactly this, filed
  // inconsistently as action_interaction (often CRITICAL) or naturalness
  // (MAJOR/MODERATE). It ALREADY deducts; it had no name, so it could be
  // neither capped nor counted, and it inflated action_interaction — the single
  // largest source of mergeable findings (199 extras).
  // NOT the pose-mirror rule on SETTLED.md: left/right stays a non-deduction.
  // Never fires on covers, where gaze at the viewer is code-owned and intended.
  viewer_address:       { owner: 'semantic', kind: 'graded', repair: 'inpaint' },
  style_consistency:    { owner: 'quality',  kind: 'graded', repair: 'style_transfer' },
  // A paste artefact — a hard boundary or cut-out edge where the picture does
  // not continue. Repairs to `regen`, not `inpaint`: the seam IS the previous
  // inpaint, so painting over it again reproduces it. Distinct from
  // style_consistency, which owns the page's MEDIUM, not its continuity.
  composite_seam:       { owner: 'quality',  kind: 'binary', repair: 'regen' },
  composition_textzone: { owner: 'quality',  kind: 'graded', repair: 'iterate_placement' },
  // A vessel, building or vehicle rendered undersized against adjacent figures
  // (image-evaluation D-31). Its own bucket, NOT an alias of `scale`: `scale`
  // covers oversized everyday props and figure age and routes to
  // composition_textzone / iterate_placement, which repositions art — it cannot
  // rebuild an undersized structure. Only a full redo can.
  structure_scale:      { owner: 'quality',  kind: 'graded', repair: 'regen' },
  rendered_text:        { owner: 'quality',  kind: 'binary', repair: 'regen' },
  character_marking:    { owner: 'quality',  kind: 'binary', repair: 'inpaint' },
  anachronism:          { owner: 'quality',  kind: 'binary', repair: 'inpaint' },
  naturalness:          { owner: 'quality',  kind: 'graded', repair: 'regen' },
  other:                { owner: 'quality',  kind: 'graded', repair: 'regen' }, // fallback: unknown type — tracked, never silently dropped
};

// Free-form `type` (and common synonyms the prompts / evaluators emit) → bucket.
// Unknown types fall through to `other` so a new type surfaces in stats instead
// of vanishing.
const TYPE_TO_BUCKET = {
  image_coherence: 'image_coherence',
  missing_character: 'character_presence', character_presence: 'character_presence',
  duplicate_character: 'character_presence', extra_character: 'character_presence',
  character_identity: 'character_identity', identity: 'character_identity', reference: 'character_identity',
  clothing: 'clothing', color: 'clothing', garment: 'clothing',
  // hair is NOT clothing: typing it so put ponytail/parting complaints in the
  // clothing bucket, where the repair repaints a garment and cannot fix hair.
  hair: 'character_identity',
  // MINOR-capped nuance types (scoring.js MAX_SEVERITY_TYPES), registered
  // explicitly: without these entries they only resolved via the
  // compound-splitter's first token by accident, and a spelling variant
  // would fall silently to `other`. cutout_artifact is deliberately NOT
  // mapped here — it is zero-point and describes OUR crop extraction, not
  // the page; wherever the splitter files it, it never charges and must not
  // inherit a bucket whose repair route would repaint a healthy page.
  hair_nuance: 'character_identity',
  face_drift: 'character_identity',
  anatomy: 'anatomy', proportion: 'anatomy',
  incomplete_figure: 'figure_completeness', figure_completeness: 'figure_completeness',
  // Facing vocabulary → action_interaction (merge 2026-08-09). Kept as ALIASES,
  // never deleted: every stored finding typed `camera_facing` still routes.
  camera_facing: 'action_interaction', face_direction: 'action_interaction', view: 'action_interaction',
  action_interaction: 'action_interaction', interaction: 'action_interaction',
  action: 'action_interaction', orientation: 'action_interaction', physics: 'action_interaction',
  object: 'object_presence', object_presence: 'object_presence',
  // missing_element: two images.js paths key on this string to look up a Visual
  // Bible reference image for the absent item, so the prompt must keep emitting
  // it; map it here so it routes to inpaint instead of falling through to 'other'.
  missing_element: 'object_presence', object_quality: 'object_presence',
  object_count: 'object_count', count: 'object_count',
  style: 'style_consistency', style_consistency: 'style_consistency', style_drift: 'style_consistency',
  composite_seam: 'composite_seam', seam: 'composite_seam', cutout_edge: 'composite_seam',
  paste_edge: 'composite_seam', composite_artifact: 'composite_seam',
  composition: 'composition_textzone', position_and_scale: 'composition_textzone',
  scale: 'composition_textzone', position: 'composition_textzone', textzone: 'composition_textzone',
  structure_scale: 'structure_scale', undersized_structure: 'structure_scale',
  rendered_text: 'rendered_text', text: 'rendered_text',
  character_marking: 'character_marking', marking: 'character_marking',
  anachronism: 'anachronism',
  naturalness: 'naturalness', artifact: 'naturalness',
  // ── Absorbed 2026-08-08 after measuring 5 stories / 62 pages / 4 art styles.
  // These are the singular types the evaluators actually emit. Only 73% (quality)
  // and 36% (compliance) of findings used a known code; everything else fell to
  // `other` and was routed to a full regenerate instead of a targeted repair.
  face: 'character_identity', facial_hair: 'character_identity',
  appearance: 'character_identity', age_appearance: 'character_identity',
  age: 'character_identity', character_identification: 'character_identity',
  // Accessory detail is its own bucket (see BUCKETS.accessory) — it carries a
  // MODERATE ceiling in scoring.js that must NOT apply to main-garment failures.
  clothing_detail: 'clothing_detail', sleeve: 'clothing_detail', collar: 'clothing_detail',
  unverified_absence: 'unverified_absence', inferred_absence: 'unverified_absence',
  accessory: 'accessory', glasses: 'accessory', eyewear: 'accessory',
  bandana: 'accessory', jewellery: 'accessory', jewelry: 'accessory',
  footwear: 'accessory',
  // Same bucket (same repair), different TYPE — scoring.js gives the two
  // different ceilings: wrong-version is MODERATE, contract-named-and-absent
  // may reach MAJOR.
  accessory_missing: 'accessory', missing_accessory: 'accessory',
  costume: 'clothing', headwear: 'clothing',
  pose: 'action_interaction', main_action: 'action_interaction',
  gesture: 'action_interaction', holding: 'action_interaction',
  // gaze/gaze_direction were ALREADY target claims mis-filed into the axis
  // bucket by these very aliases — the routing bug that hid the merge case.
  facing: 'action_interaction', gaze: 'action_interaction', gaze_direction: 'action_interaction',
  object_missing: 'object_presence', object_placement: 'object_presence',
  object_mismatch: 'object_presence', object_detail: 'object_presence',
  object_quality: 'object_presence', prop: 'object_presence',
  prop_placement: 'object_presence', extra_object: 'object_presence',
  extra_objects: 'object_presence', unauthorized_objects: 'object_presence',
  setting: 'setting', environment: 'setting', background: 'setting',
  background_placement: 'setting', lighting: 'setting', weather: 'setting',
  // Emotion has its own bucket since 2026-08-19 (owner). The rules that make
  // expression nuance a NON-DEDUCTION are unchanged and live where they belong,
  // in the prompts (image-evaluation N-03; image-semantic's gross-only rule,
  // one per page, never CRITICAL). This only decides where a finding that DOES
  // arrive is grouped and repaired — cost still comes from its severity.
  expression: 'emotion', emotion: 'emotion',
  // Posing for the camera instead of engaging the scene. DELIBERATELY NOT
  // wired to `camera_facing`: that alias was merged into action_interaction on
  // 2026-08-09 after measuring that 12 of 31 of its findings were left/right
  // mirrors and the other 19 all named a target — it was an axis category.
  // viewer_address is a different question (is the figure addressing the camera
  // when the beat or a declared interaction needs their attention?), so it is a
  // new type, not a revival. Re-pointing camera_facing here would reverse that
  // merge.
  viewer_address: 'viewer_address',
  // entity-consistency-check.txt emits its own closed vocabulary; map it here so
  // cross-page consistency findings route like everything else.
  garment_colour: 'garment_colour', garment_color: 'garment_colour',
  nudity: 'nudity', undressed: 'nudity', nude: 'nudity',
  implausible_placement: 'action_interaction', placement: 'action_interaction',
  face_mismatch: 'character_identity', hair_change: 'character_identity',
  skin_tone: 'character_identity', age_shift: 'character_identity',
  clothing_inconsistent: 'clothing', color_change: 'clothing',
  shape_change: 'object_presence',
};

// Compound types were the long tail: `pose_clothing_age`, `position_and_appearance`,
// `clothing, prop`, `facing/interaction` — 60 distinct strings across 5 stories,
// each seen once or twice. Rather than alias every permutation, split on the
// separators the models actually use and resolve to the FIRST recognised token.
// One finding gets one bucket, which is the contract anyway: one defect, one entry.
const COMPOUND_SPLIT = /\s*(?:_and_|_&_|\/|,|\+|\s+and\s+)\s*|_(?=[a-z])/;

function normalizeType(type) {
  const raw = String(type || '').toLowerCase().trim();
  if (!raw) return '';
  if (TYPE_TO_BUCKET[raw]) return raw;
  // whole-string didn't match — try the pieces, left to right
  for (const part of raw.split(COMPOUND_SPLIT)) {
    const t = part.trim();
    if (t && TYPE_TO_BUCKET[t]) return t;
  }
  return raw;
}

function bucketForType(type) {
  return TYPE_TO_BUCKET[normalizeType(type)] || 'other';
}

/**
 * One judge's fixable_issues[] → { bucket: {severity, count, samples[]} }.
 * Per bucket keep the MAX severity (a page's worst instance of that defect) and
 * a couple of descriptions for the audit trail. Missing buckets are absent
 * (treated as severity 0 downstream).
 */
/**
 * @param {object} [opts]
 * @param {boolean} [opts.bySubject=false] key by (bucket, subject) instead of
 *   bucket alone. OPT-IN because the two callers need different shapes: the
 *   eval_findings stats writer groups per bucket for a plain GROUP BY, while the
 *   multi-judge jury must NOT collapse two characters' findings of one class into
 *   one entry — scoring bills per (class, subject), so collapsing them silently
 *   reverts every page to a single charge per class. Entries always carry
 *   `bucket` and `subject`, so a caller never has to parse the key back apart.
 */
function mapIssuesToBuckets(fixableIssues = [], { bySubject = false } = {}) {
  const vec = {};
  for (const issue of Array.isArray(fixableIssues) ? fixableIssues : []) {
    const bucket = bucketForType(issue.type);
    const subject = bySubject
      ? String(issue.character || issue.name || issue.element || '').trim().toLowerCase()
      : '';
    const key = subject ? `${bucket}|${subject}` : bucket;
    const rank = sevRank(issue.severity);
    if (!vec[key]) vec[key] = { bucket, subject: subject || null, severity: 'none', rank: 0, count: 0, samples: [] };
    vec[key].count++;
    if (issue.description && vec[key].samples.length < 3) vec[key].samples.push(issue.description);
    if (rank > vec[key].rank) { vec[key].rank = rank; vec[key].severity = RANK_TO_SEVERITY[rank]; }
  }
  return vec;
}

/** Median of three (or N) severity ranks, treating absent as 0. */
function medianRank(ranks) {
  const sorted = [...ranks].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]; // middle of an odd count; lower-middle for even
}

/**
 * Merge several judges' bucket vectors by PURE MEDIAN severity per bucket.
 * Returns { bucket: {severity, votes:[sev,…], agreement:'3/3'|'2/3'|'1/3', samples[]} }
 * for every bucket ANY judge flagged. `agreement` = how many judges landed on
 * the merged severity — the confidence signal (route low agreement to an extra
 * pass instead of trusting one number).
 */
function mergeJudges(judgeVectors = []) {
  const judges = judgeVectors.filter(Boolean);
  const n = judges.length || 1;
  const allBuckets = new Set();
  for (const v of judges) for (const b of Object.keys(v)) allBuckets.add(b);

  const merged = {};
  for (const bucket of allBuckets) {
    const ranks = judges.map(v => (v[bucket] ? v[bucket].rank : 0));
    while (ranks.length < n) ranks.push(0);
    const mRank = medianRank(ranks);
    const severity = RANK_TO_SEVERITY[mRank];
    if (mRank === 0) continue; // median says not a defect → drop (the "1-of-3 → dropped" rule)
    const agreeCount = ranks.filter(r => r === mRank).length;
    const samples = [];
    for (const v of judges) if (v[bucket]?.samples) for (const s of v[bucket].samples) if (samples.length < 3) samples.push(s);
    // `bucket` here is the VECTOR KEY, which is `${bucket}|${subject}` when the
    // vectors were built with bySubject. Carry the entry's own bucket/subject
    // through so bucketsToIssues never has to parse the key apart.
    const first = judges.find(v => v[bucket])?.[bucket] || {};
    merged[bucket] = {
      bucket: first.bucket || bucket,
      subject: first.subject || null,
      severity,
      votes: ranks.map(r => RANK_TO_SEVERITY[r]),
      agreement: `${agreeCount}/${n}`,
      // low confidence = the judges split completely (only one landed on the
      // merged severity) → route to an extra pass rather than trusting it.
      lowConfidence: agreeCount <= 1,
      samples,
    };
  }
  return merged;
}

/**
 * Merged bucket vector → deduplicated fixable_issues[] (one entry per flagged
 * bucket), the shape scoring.js / the repair router / the stats writer already
 * consume. This is the ONLY bridge back to the existing pipeline — the score
 * math stays in scoring.js.
 */
function bucketsToIssues(merged = {}) {
  return Object.entries(merged).map(([key, m]) => {
    const bucket = m.bucket || key;
    return {
      type: bucket,
      // WHO the merged defect is about. Null when the vectors were built without
      // bySubject. Without this the jury hands scoring.js a subjectless finding,
      // which bills one charge per class for the whole page, and hands
      // bboxDetection nothing to aim a repair at.
      character: m.subject || null,
      severity: m.severity,
      description: m.samples[0] || bucket,
      repair: BUCKETS[bucket]?.repair || 'regen',
      owner: BUCKETS[bucket]?.owner || 'quality',
      agreement: m.agreement,
      votes: m.votes,
    };
  });
}

module.exports = {
  BUCKETS, TYPE_TO_BUCKET, SEVERITY_RANK, RANK_TO_SEVERITY,
  sevRank, bucketForType, normalizeType, mapIssuesToBuckets, mergeJudges, bucketsToIssues, medianRank,
};
