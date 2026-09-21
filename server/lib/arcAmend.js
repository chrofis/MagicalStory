/**
 * ARC AMEND — repairing the arc in place instead of handing the writer a
 * contradiction.
 *
 * Today a cheap call reads the FROZEN arc and emits three `ISSUE: … → CHANGE: …`
 * directives. The arc is never rewritten (`beatsPipeline.js` assigns
 * `approvedArc` only before the hint pass), so the planner acts on the directive
 * and rewrites its plan lines while the arc keeps asserting the opposite. The
 * page-text writer then holds three documents, and the one labelled "final" is
 * the stale one. Measured 2026-09-20: 12 of 18 hints across 6 stories contradict
 * a fact still standing in the arc.
 *
 * The amend pass replaces the directive with the repaired beat itself, so the
 * change is legible, diffable and boundable — a directive cannot be checked, a
 * replacement beat can. The cheap model is already changing the story today; it
 * just does it through an instruction another model reinterprets.
 *
 * Nothing here is wired into production. It exists to be baked off in the Lab
 * first (owner, 2026-09-20): grok-4.6 is the incumbent, and whether it may
 * rewrite a beat an Opus call wrote is unmeasured.
 */

const { log } = require('../utils/logger');

/** A beat line: `12. The hero crosses the river…` */
const BEAT_LINE = /^\s*(\d+)[.)]\s*(.+)$/;

/**
 * Split an arc into its numbered beats, preserving order.
 * A line that does not open a new beat belongs to the beat above it, so a beat
 * wrapped over several lines survives the round trip.
 *
 * @param {string} arc
 * @returns {Array<{n: number, text: string}>}
 */
function splitArcBeats(arc) {
  const out = [];
  for (const line of String(arc || '').split('\n')) {
    const m = line.match(BEAT_LINE);
    if (m) out.push({ n: parseInt(m[1], 10), text: m[2].trim() });
    else if (out.length && line.trim()) out[out.length - 1].text += ` ${line.trim()}`;
  }
  return out;
}

/**
 * Parse an amend response: the named issues and the rewritten beats.
 *
 * @param {string} raw
 * @returns {{issues: Array<{issue: string, change: string, beats: number[]}>, beats: Map<number, string>}}
 */
function parseArcAmend(raw) {
  const full = String(raw || '');
  const issuesBlock = (full.match(/---\s*ISSUES\s*---\s*([\s\S]*?)(?=---\s*[A-Z]|$)/i) || [])[1] || '';
  const beatsBlock = (full.match(/---\s*AMENDED BEATS\s*---\s*([\s\S]*)$/i) || [])[1] || '';

  const issues = [];
  for (const line of issuesBlock.split('\n')) {
    if (!/ISSUE\s*:/i.test(line)) continue;
    const issue = (line.match(/ISSUE\s*:\s*(.*?)(?:→|->|$)/i) || [])[1] || '';
    const change = (line.match(/CHANGE\s*:\s*(.*?)(?:→|->|$)/i) || [])[1] || '';
    const beatsRaw = (line.match(/BEATS?\s*:\s*(.*)$/i) || [])[1] || '';
    issues.push({
      issue: issue.trim(),
      change: change.trim(),
      beats: (beatsRaw.match(/\d+/g) || []).map(Number),
    });
  }

  // `BEAT 7: …` runs until the next `BEAT n:` or the end.
  const beats = new Map();
  const re = /^\s*BEAT\s+(\d+)\s*:\s*([\s\S]*?)(?=^\s*BEAT\s+\d+\s*:|\s*$(?![\s\S]))/gim;
  let m;
  while ((m = re.exec(beatsBlock)) !== null) {
    beats.set(parseInt(m[1], 10), m[2].replace(/\s+/g, ' ').trim());
  }
  return { issues, beats };
}

/**
 * Everything that must hold before an amendment may be applied. A cheap model
 * rewriting an expensive one's work is bounded by these, not by trust.
 *
 * @param {string} arc - the arc as it stands
 * @param {{issues: Array, beats: Map<number,string>}} parsed
 * @returns {{ok: boolean, violations: string[], applied: number[]}}
 */
function checkAmendGuards(arc, parsed) {
  const original = splitArcBeats(arc);
  const known = new Set(original.map(b => b.n));
  const violations = [];
  const applied = [];

  if (!parsed || !(parsed.beats instanceof Map) || parsed.beats.size === 0) {
    return { ok: false, violations: ['no amended beats were returned'], applied };
  }
  for (const [n, text] of parsed.beats) {
    if (!known.has(n)) { violations.push(`beat ${n} is not in the arc`); continue; }
    if (!text) { violations.push(`beat ${n} came back empty`); continue; }
    const before = original.find(b => b.n === n).text;
    if (text === before) continue;            // a no-op rewrite is not a change
    // A repair that triples a beat is not a repair. 3x is loose on purpose:
    // the bake-off should surface bloat as a judged cost, not hide it here.
    if (text.length > before.length * 3) violations.push(`beat ${n} tripled in length`);
    applied.push(n);
  }
  // Every beat the issues claimed must actually arrive, and nothing else may.
  const claimed = new Set(parsed.issues.flatMap(i => i.beats || []));
  for (const n of parsed.beats.keys()) {
    if (claimed.size && !claimed.has(n)) violations.push(`beat ${n} was rewritten without being named by an issue`);
  }
  return { ok: violations.length === 0, violations, applied };
}

/**
 * Apply the amendment, leaving every beat it does not name byte-identical.
 * Returns the arc unchanged when the guards refuse it — this never silently
 * ships a partial repair.
 *
 * @param {string} arc
 * @param {{issues: Array, beats: Map<number,string>}} parsed
 * @returns {{arc: string, applied: number[], violations: string[]}}
 */
function applyArcAmendment(arc, parsed) {
  const guard = checkAmendGuards(arc, parsed);
  if (!guard.ok) {
    log.warn(`[ARC AMEND] refused: ${guard.violations.join('; ')}`);
    return { arc: String(arc || ''), applied: [], violations: guard.violations };
  }
  const rebuilt = splitArcBeats(arc)
    .map(b => `${b.n}. ${parsed.beats.has(b.n) ? parsed.beats.get(b.n) : b.text}`)
    .join('\n');
  return { arc: rebuilt, applied: guard.applied, violations: [] };
}

module.exports = { splitArcBeats, parseArcAmend, checkAmendGuards, applyArcAmendment };
