/**
 * DECLARED EMOTION vs OBSERVED EMOTION — a comparison, not a judge.
 *
 * The brief declares each character's `emotion` and the prompt-blind inventory
 * reports each figure's `emotion`, both from the one closed list in
 * emotionVocabulary.js. This module pairs figure to character with the same
 * position-based assignment the gaze check uses (the inventory never names
 * anyone, and nothing here renames a figure), and maps each pair to a severity
 * with compareEmotion. Nothing is read from prose.
 *
 * It REPLACES the semantic judge's prose `emotion` rule (image-semantic.txt,
 * 2026-09-22), which over-charged on dragon run 6 (job_1790100385959_1nitlympp):
 * the judge compared the brief's expression words against its own reading of
 * the same picture it had the brief for. The blind reader cannot echo a brief it
 * never saw.
 */
'use strict';

const { pairInventoryFiguresToNames } = require('./identityAgreement');
const { compareEmotion, normalizeEmotion } = require('./emotionVocabulary');

const norm = (s) => String(s == null ? '' : s).trim().toLowerCase();

/**
 * @param {Object} args
 * @param {Array}  args.declared   brief characters[]: {name, emotion, expression}
 * @param {Object} args.inventory  the prompt-blind inventory JSON (figures[].emotion)
 * @param {Array}  args.matches    the eval's figure→character pairing (reference + body_bbox)
 * @returns {Array} findings, each {type:'emotion', severity, character, source, description, fix}
 */
function checkDeclaredEmotion({ declared, inventory, matches } = {}) {
  const chars = Array.isArray(declared) ? declared : [];
  const figures = Array.isArray(inventory?.figures) ? inventory.figures : [];
  if (!chars.length || !figures.length) return [];

  // character name -> the inventory figure standing where that character stands
  const labelOf = new Map([...pairInventoryFiguresToNames(matches, figures)]
    .map(([label, name]) => [norm(name), label]));

  const findings = [];
  for (const c of chars) {
    const name = String(c?.name || '').trim();
    const intended = normalizeEmotion(c?.emotion);
    if (!name || !intended) continue;
    const label = labelOf.get(norm(name));
    if (!label) continue;                                   // no figure paired — skip
    const fig = figures.find(f => norm(f?.label) === norm(label));
    const seen = normalizeEmotion(fig?.emotion);
    const severity = compareEmotion(intended, seen);
    if (!severity) continue;

    const cue = String(c?.expression || '').trim();
    findings.push({
      type: 'emotion',
      severity,
      character: name,
      source: 'emotion-check',
      description: `${name} is declared ${intended}, but the face reads ${seen}.`,
      fix: `Repaint ${name}'s face as ${intended}: remove the ${seen} look${cue ? ` and show ${cue}` : ''}.`,
    });
  }
  return findings;
}

module.exports = { checkDeclaredEmotion };
