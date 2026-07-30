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
  anatomy:              { owner: 'quality',  kind: 'graded', repair: 'regen' },
  figure_completeness:  { owner: 'quality',  kind: 'binary', repair: 'regen' },
  camera_facing:        { owner: 'quality',  kind: 'binary', repair: 'regen' },
  action_interaction:   { owner: 'semantic', kind: 'graded', repair: 'inpaint_or_regen' }, // rope slack while pulling, wrong aim, faces away from target
  object_presence:      { owner: 'quality',  kind: 'binary', repair: 'inpaint' },
  object_count:         { owner: 'quality',  kind: 'graded', repair: 'inpaint' },
  style_consistency:    { owner: 'quality',  kind: 'graded', repair: 'style_transfer' },
  composition_textzone: { owner: 'quality',  kind: 'graded', repair: 'iterate_placement' },
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
  anatomy: 'anatomy', proportion: 'anatomy',
  incomplete_figure: 'figure_completeness', figure_completeness: 'figure_completeness',
  camera_facing: 'camera_facing', face_direction: 'camera_facing', view: 'camera_facing',
  action_interaction: 'action_interaction', interaction: 'action_interaction',
  action: 'action_interaction', orientation: 'action_interaction', physics: 'action_interaction',
  object: 'object_presence', object_presence: 'object_presence',
  object_count: 'object_count', count: 'object_count',
  style: 'style_consistency', style_consistency: 'style_consistency', style_drift: 'style_consistency',
  composition: 'composition_textzone', position_and_scale: 'composition_textzone',
  scale: 'composition_textzone', position: 'composition_textzone', textzone: 'composition_textzone',
  rendered_text: 'rendered_text', text: 'rendered_text',
  character_marking: 'character_marking', marking: 'character_marking',
  anachronism: 'anachronism',
  naturalness: 'naturalness', artifact: 'naturalness',
};

function bucketForType(type) {
  return TYPE_TO_BUCKET[String(type || '').toLowerCase()] || 'other';
}

/**
 * One judge's fixable_issues[] → { bucket: {severity, count, samples[]} }.
 * Per bucket keep the MAX severity (a page's worst instance of that defect) and
 * a couple of descriptions for the audit trail. Missing buckets are absent
 * (treated as severity 0 downstream).
 */
function mapIssuesToBuckets(fixableIssues = []) {
  const vec = {};
  for (const issue of Array.isArray(fixableIssues) ? fixableIssues : []) {
    const bucket = bucketForType(issue.type);
    const rank = sevRank(issue.severity);
    if (!vec[bucket]) vec[bucket] = { severity: 'none', rank: 0, count: 0, samples: [] };
    vec[bucket].count++;
    if (issue.description && vec[bucket].samples.length < 3) vec[bucket].samples.push(issue.description);
    if (rank > vec[bucket].rank) { vec[bucket].rank = rank; vec[bucket].severity = RANK_TO_SEVERITY[rank]; }
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
    merged[bucket] = {
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
  return Object.entries(merged).map(([bucket, m]) => ({
    type: bucket,
    severity: m.severity,
    description: m.samples[0] || bucket,
    repair: BUCKETS[bucket]?.repair || 'regen',
    owner: BUCKETS[bucket]?.owner || 'quality',
    agreement: m.agreement,
    votes: m.votes,
  }));
}

module.exports = {
  BUCKETS, TYPE_TO_BUCKET, SEVERITY_RANK, RANK_TO_SEVERITY,
  sevRank, bucketForType, mapIssuesToBuckets, mergeJudges, bucketsToIssues, medianRank,
};
