/**
 * Figure identity cross-check — two independent opinions, joined by geometry.
 *
 * WHO NAMES A DETECTION BOX TODAY
 * -------------------------------
 * `figureDetection.js` (_somIdentifyFigures) composites letter badges onto the
 * scene and asks gemini-2.5-flash which letter is which character. The prompt
 * FORCES a complete assignment ("assign each character to one badge, by
 * elimination if needed"), so the call structurally cannot say "I don't know" —
 * it can only be right or confidently wrong. On staging story
 * job_1786397108357_q1fjbdzbx page 14 it put "Hans" on the far-left man
 * (x 0.075–0.370, actually Daniel in a green coat) and left the real,
 * white-haired Hans in the centre (x 0.475–0.739) as UNKNOWN. The garment
 * recolour then repainted the wrong man's coat; the result scored -80 and lost
 * pick-best, so nothing shipped — but only because that damage happened to be
 * visible.
 *
 * A SECOND OPINION ALREADY EXISTS
 * -------------------------------
 * The quality eval carries its own `figures[]` / `matches[]`
 * (`{figure, reference, confidence, face_bbox}`), persisted per image VERSION
 * since commit 898e4f2f2 (`buildVersionEntry` in repairPipeline.js). On that
 * same page it called the far-left man UNMATCHED (0%) and named the centre
 * figure Hans (80%) — i.e. it was right, and it was willing to abstain.
 *
 * WHICH `matches[]` THIS JOINS ON
 * -------------------------------
 * The version's `matches` are the quality evaluator's, always — identity is not
 * P1's to decide, and `runVisualInventory` no longer emits matches at all. P1
 * still supplies `figures` when the evaluator named nobody, so the two arrays
 * can still come from different producers, and the two number figures
 * DIFFERENTLY (P1 saw 5 figures on a page where the quality parse saw 3). This
 * module therefore NEVER joins through `match.figure` / `figure.id` — the join
 * is purely geometric, on `match.face_bbox`. `evalFigures` is used only to
 * enrich the human-readable `reason`, looked up defensively by id.
 *
 * COORDINATE SYSTEMS (they differ — this is the classic silent bug)
 * ----------------------------------------------------------------
 *   detection figure : faceBox / bodyBox = [ymin, xmin, ymax, xmax], 0-1
 *                      (Gemini order; see images.js normalizeBox and
 *                       figureDetection.js _pxBoxToNorm)
 *   eval match       : face_bbox         = [x1, y1, x2, y2], 0-1
 *                      (prompts/image-evaluation.txt line 209)
 *
 * Pure module: no I/O, no model calls, no requires of pipeline files.
 */

'use strict';

/** Below this the eval's own naming is not evidence of anything. */
const MIN_EVAL_CONFIDENCE = 0.5;

/** References the eval uses to mean "this figure is nobody I was given". */
const UNMATCHED_TOKENS = new Set(['unmatched', 'unknown', 'none', 'no match', 'n/a', '']);

/** Detection's own "I could not name this box". */
const DETECTION_UNKNOWN = 'UNKNOWN';

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/** Detection box [ymin,xmin,ymax,xmax] → {x1,y1,x2,y2}. */
function rectFromDetectionBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || box.some(v => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const [ymin, xmin, ymax, xmax] = box;
  return { x1: Math.min(xmin, xmax), y1: Math.min(ymin, ymax), x2: Math.max(xmin, xmax), y2: Math.max(ymin, ymax) };
}

/** Eval face_bbox [x1,y1,x2,y2] → {x1,y1,x2,y2}. */
function rectFromEvalBox(box) {
  if (!Array.isArray(box) || box.length !== 4 || box.some(v => typeof v !== 'number' || !Number.isFinite(v))) return null;
  const [x1, y1, x2, y2] = box;
  return { x1: Math.min(x1, x2), y1: Math.min(y1, y2), x2: Math.max(x1, x2), y2: Math.max(y1, y2) };
}

const centreOf = (r) => ({ x: (r.x1 + r.x2) / 2, y: (r.y1 + r.y2) / 2 });
const contains = (r, p) => p.x >= r.x1 && p.x <= r.x2 && p.y >= r.y1 && p.y <= r.y2;

/**
 * JOIN RULE: centre-containment, not IoU.
 *
 * The eval's `face_bbox` is an LLM's freehand estimate; the detection's
 * faceBox comes from GroundingDINO/SAM (or Gemini's bbox pass) and is tight.
 * Two boxes that unambiguously refer to the same face routinely score IoU well
 * under 0.3 when one is loose and offset — an IoU threshold high enough to
 * avoid false joins on a crowded page would drop most true joins, and one low
 * enough to keep them would join neighbours. The centre point is far more
 * stable than the extents: an LLM that has located a face gets its centre
 * roughly right even when the box is sloppy. So: the eval face centre must
 * fall inside the detection's faceBox (preferred) or, failing that, its
 * bodyBox; when several boxes contain it, the nearest centre wins. A face
 * centre landing in nobody's box yields no join → `unverified`, never a guess.
 */
function joinMatchToFigure(match, figures) {
  const evalRect = rectFromEvalBox(match.face_bbox || match.faceBbox);
  if (!evalRect) return -1;
  const p = centreOf(evalRect);

  let best = -1, bestTier = 3, bestDist = Infinity;
  for (let i = 0; i < figures.length; i++) {
    const f = figures[i] || {};
    const face = rectFromDetectionBox(f.faceBox);
    const body = rectFromDetectionBox(f.bodyBox);
    let tier = 3, box = null;
    if (face && contains(face, p)) { tier = 0; box = face; }
    else if (body && contains(body, p)) { tier = 1; box = body; }
    else continue;
    const c = centreOf(box);
    const dist = Math.hypot(c.x - p.x, c.y - p.y);
    if (tier < bestTier || (tier === bestTier && dist < bestDist)) { best = i; bestTier = tier; bestDist = dist; }
  }
  return best;
}

/**
 * Cross-check the Set-of-Mark naming on the detection boxes against the quality
 * eval's independent identification of the same pixels.
 *
 * @param {Array} detectionFigures - bboxDetection.figures: [{name, faceBox, bodyBox, ...}]
 * @param {Array} evalMatches      - version.matches: [{figure, reference, confidence, face_bbox}]
 * @param {Array} [evalFigures]    - version.figures: [{id, zone|position, hair, clothing, ...}] (reason text only)
 * @returns {{perFigure: Array<{name: string, evalName: string|null, verdict: string, confidence: number|null, reason: string}>, disputed: string[]}}
 */
function crossCheckFigureIdentity(detectionFigures, evalMatches, evalFigures) {
  const figures = Array.isArray(detectionFigures) ? detectionFigures : [];
  const matches = Array.isArray(evalMatches) ? evalMatches : [];
  const evFigs = Array.isArray(evalFigures) ? evalFigures : [];

  // Geometric join first: detection index → the eval match that landed on it.
  // A detection box claimed by two eval matches keeps the more confident one
  // (the other stays unjoined → its figure reads `unverified`).
  const joined = new Map();
  for (const m of matches) {
    if (!m || typeof m !== 'object') continue;
    const idx = joinMatchToFigure(m, figures);
    if (idx < 0) continue;
    const prev = joined.get(idx);
    if (!prev || (Number(m.confidence) || 0) > (Number(prev.confidence) || 0)) joined.set(idx, m);
  }

  const describeEvalFigure = (m) => {
    const f = evFigs.find(x => x && String(x.id) === String(m.figure));
    if (!f) return '';
    const bits = [f.hair, f.clothing, f.zone || f.position].filter(Boolean);
    return bits.length ? ` (eval figure #${m.figure}: ${bits.join(', ')})` : '';
  };

  const perFigure = [];
  const disputed = [];
  const addDisputed = (n) => { if (n && !disputed.some(d => norm(d) === norm(n))) disputed.push(n); };

  for (let i = 0; i < figures.length; i++) {
    const f = figures[i] || {};
    const detName = f.name || DETECTION_UNKNOWN;
    const detIsUnknown = norm(detName) === norm(DETECTION_UNKNOWN);
    const m = joined.get(i);

    if (!m) {
      perFigure.push({
        name: detName, evalName: null, verdict: 'unverified', confidence: null,
        reason: 'no eval match joined to this detection box (no face_bbox landed inside it)',
      });
      continue;
    }

    const confidence = Number.isFinite(Number(m.confidence)) ? Number(m.confidence) : null;
    const evalNameRaw = m.reference == null ? '' : String(m.reference).trim();
    const evalIsUnmatched = UNMATCHED_TOKENS.has(norm(evalNameRaw));

    if (evalIsUnmatched) {
      perFigure.push({
        name: detName, evalName: null, verdict: 'unverified', confidence,
        reason: `eval calls this figure UNMATCHED${describeEvalFigure(m)}`,
      });
      continue;
    }
    if (confidence != null && confidence < MIN_EVAL_CONFIDENCE) {
      perFigure.push({
        name: detName, evalName: evalNameRaw, verdict: 'unverified', confidence,
        reason: `eval says ${evalNameRaw} but only at ${Math.round(confidence * 100)}% (< ${Math.round(MIN_EVAL_CONFIDENCE * 100)}% threshold)${describeEvalFigure(m)}`,
      });
      continue;
    }
    if (detIsUnknown) {
      perFigure.push({
        name: detName, evalName: evalNameRaw, verdict: 'adopted', confidence,
        reason: `detection could not name this figure; eval names it ${evalNameRaw}${confidence != null ? ` at ${Math.round(confidence * 100)}%` : ''}${describeEvalFigure(m)}`,
      });
      continue;
    }
    if (norm(evalNameRaw) === norm(detName)) {
      perFigure.push({
        name: detName, evalName: evalNameRaw, verdict: 'agree', confidence,
        reason: `both name this figure ${detName}`,
      });
      continue;
    }

    perFigure.push({
      name: detName, evalName: evalNameRaw, verdict: 'disputed', confidence,
      reason: `Set-of-Mark says ${detName}, eval says ${evalNameRaw}${confidence != null ? ` at ${Math.round(confidence * 100)}%` : ''}${describeEvalFigure(m)}`,
    });
    // BOTH names are unsafe, not just the detection's. If the eval puts Hans on
    // the box the detection calls Emma, then whatever box the detection calls
    // Hans is also suspect — the two opinions have swapped at least one pair,
    // and acting on either name can repaint the wrong person.
    addDisputed(detName);
    addDisputed(evalNameRaw);
  }

  // CROSS-BOX CONFLICT — the exact p14 signature, and invisible to the
  // per-figure rules above. There, the eval ABSTAINED on the box the detection
  // called "Hans" (→ unverified) and confidently named a DIFFERENT, UNKNOWN box
  // Hans at 80% (→ adopted). Neither row is `disputed` on its own, yet the two
  // opinions plainly place Hans on different figures — and recolouring "Hans"
  // would repaint whichever box the detection picked. So: an `adopted` name
  // that the detection has already spent on another figure promotes BOTH rows
  // to `disputed`. Same logic for a confident eval name that agrees on one box
  // while the detection also carries that name elsewhere is impossible (the SoM
  // answer is rejected on duplicate names), so only the adopted case needs it.
  for (const row of perFigure) {
    if (row.verdict !== 'adopted') continue;
    const clash = perFigure.filter(r => r !== row && norm(r.name) === norm(row.evalName));
    if (!clash.length) continue;
    row.verdict = 'disputed';
    row.reason = `eval names this figure ${row.evalName}${row.confidence != null ? ` at ${Math.round(row.confidence * 100)}%` : ''}, but the detection put ${row.evalName} on a different figure — the two opinions place ${row.evalName} in different places`;
    for (const c of clash) {
      c.verdict = 'disputed';
      c.reason = `detection names this figure ${c.name}, but the eval names ${row.evalName} on a different figure (${c.reason})`;
    }
    addDisputed(row.evalName);
  }

  return { perFigure, disputed };
}

/** True when `name` is on the disputed list of a cross-check result. */
function isIdentityDisputed(result, name) {
  if (!result || !Array.isArray(result.disputed) || !name) return false;
  return result.disputed.some(d => norm(d) === norm(name));
}

/**
 * TODO (not implemented — gated off behind MODEL_DEFAULTS.identityTiebreak).
 *
 * Intended design, from the owner:
 *
 *   On disagreement, send the SAM cutout of the disputed figure plus the
 *   candidate styled avatars and ask which avatar it is. If it genuinely
 *   cannot be distinguished, assign one arbitrarily but STABLY (e.g.
 *   left-to-right order) and flag the page for character repair — because if a
 *   reader cannot tell them apart either, WHO BECOMES WHO IS IRRELEVANT; what
 *   matters is that each figure consistently matches some character, and
 *   character repair then enforces it.
 *
 * Until that is built this returns null, which every call site must treat as
 * "no resolution" and fall back to the conservative skip. Deliberately does NOT
 * call any model.
 *
 * @returns {Promise<null>}
 */
async function resolveIdentityTiebreak(/* { imageData, figure, candidates, artStyle, pageLabel } */) {
  return null;
}

module.exports = {
  crossCheckFigureIdentity,
  isIdentityDisputed,
  resolveIdentityTiebreak,
  MIN_EVAL_CONFIDENCE,
};
