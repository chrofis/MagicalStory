/**
 * UNDECLARED LETTERING — a comparison, not a judge.
 *
 * The prompt-blind inventory already lists every piece of writing it can see
 * (`lettering[]`: the quoted text, the surface, the position, and whether it
 * spells real words). The page already knows which strings it ASKED for: the
 * Visual Bible elements it stages that declare `text` (requiredText.js). Any
 * readable string the inventory saw that the page did not ask for is a defect.
 *
 * WHY IT IS CODE (owner, 2026-09-23: "text must be captured and become
 * feedback"). The detector used to be the blind compliance judge, switched off
 * on 2026-09-19 — and the sighted quality judge does not see captions reliably:
 * p6 of dragon run 6 (job_1790100385959_1nitlympp) carried a large English label
 * "TENSE BUT QUIET STANDOFF" and scored 100 with zero findings, while the blind
 * inventory recorded it exactly ("white rectangular label in bottom-right
 * corner"). The observation was there on every page; nothing read it.
 *
 * SEVERITY maps onto the evaluator's own D-23 using only the inventory's
 * structured `readable` flag — no prose is classified here:
 *   readable, undeclared   -> CRITICAL. D-23 puts prominent lettering at
 *                             CATASTROPHIC; code cannot measure prominence, so
 *                             it takes the level that always reaches a repair
 *                             without forcing a full regeneration.
 *   unreadable scribble    -> MINOR, D-23's own class for garbled signage.
 *   declared               -> nothing. An ABC book asks for its letters.
 *
 * Text is no longer forbidden outright (owner): a page that declares a string
 * may show it. What it may not show is writing nobody asked for.
 */
'use strict';

/** Letters and digits only, lower-cased — "A B C", "a-b-c" and "ABC" are one string. */
const squash = (s) => String(s == null ? '' : s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

/**
 * Is this seen string one the page asked for? Either containing the other
 * counts: the describer may quote a declared word inside a longer run
 * ("Bakery — open") or only part of a declared phrase it could read.
 */
function isDeclared(seen, declaredSquashed) {
  const s = squash(seen);
  if (!s) return true;                      // nothing legible to charge
  return declaredSquashed.some(d => d && (s.includes(d) || d.includes(s)));
}

/**
 * @param {Object}   args
 * @param {Array}    args.lettering  inventory `lettering[]`: {text, surface, position, readable}
 * @param {string[]} args.declared   strings the page declares (requiredText.collectRequiredTexts().map(r => r.text))
 * @returns {Array} findings, each {type:'rendered_text', severity, character:null, source, description, fix}
 */
function checkUndeclaredLettering({ lettering, declared } = {}) {
  const seen = Array.isArray(lettering) ? lettering : [];
  const declaredSquashed = (Array.isArray(declared) ? declared : []).map(squash).filter(Boolean);
  const findings = [];
  for (const l of seen) {
    const text = String(l?.text || '').trim();
    if (!text || isDeclared(text, declaredSquashed)) continue;
    const readable = l?.readable !== false;
    const where = [l?.surface, l?.position].filter(Boolean).join(', ');
    findings.push({
      type: 'rendered_text',
      severity: readable ? 'CRITICAL' : 'MINOR',
      character: null,
      source: 'lettering-check',
      description: readable
        ? `Unrequested lettering "${text}" is painted into the picture${where ? ` (${where})` : ''}; the page asks for no such text.`
        : `Unreadable scribble that reads as writing${where ? ` (${where})` : ''}; the page asks for no text there.`,
      fix: `Paint over the lettering${where ? ` on the ${l?.surface || 'surface'}` : ''} as continuous scene material — no readable writing.`,
    });
  }
  return findings;
}

module.exports = { checkUndeclaredLettering, isDeclared, squash };
