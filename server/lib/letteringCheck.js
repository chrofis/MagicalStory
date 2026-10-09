/**
 * UNDECLARED LETTERING — a comparison, not a judge.
 *
 * The prompt-blind inventory already lists every piece of writing it can see
 * (`lettering[]`: the quoted text, the surface, the position, where it sits and
 * how it is spelled). The page already knows which strings it ASKED for: the
 * Visual Bible elements it stages that declare `text` (requiredText.js). Writing
 * the page did not ask for is a defect unless it is correctly spelled writing on
 * an object that carries such writing in the real world.
 *
 * WHY IT IS CODE (owner, 2026-09-23: "text must be captured and become
 * feedback"). The detector used to be the blind compliance judge, switched off
 * on 2026-09-19 — and the sighted quality judge does not see captions reliably:
 * p6 of dragon run 6 (job_1790100385959_1nitlympp) carried a large English label
 * "TENSE BUT QUIET STANDOFF" and scored 100 with zero findings, while the blind
 * inventory recorded it exactly ("white rectangular label in bottom-right
 * corner"). The observation was there on every page; nothing read it.
 *
 * SEVERITY. The inventory classifies each string on two axes (the prompt does
 * the classifying; this file only maps the pair to a severity):
 *   placement: overlay (caption/watermark on top of the picture) | fits (on an
 *              object that carries writing of that kind in the real world) |
 *              misplaced (on something that would not carry it)
 *   spelling:  correct | misspelled | scribble
 *
 *   declared                    -> nothing. An ABC book asks for its letters.
 *   overlay                     -> CRITICAL, whatever it says.
 *   misspelled, anywhere        -> CRITICAL. A misspelled sign reads as a mistake.
 *   misplaced, legible          -> CRITICAL.
 *   scribble (fits / misplaced) -> MINOR, D-23's class for garbled signage.
 *   fits + correct              -> nothing. A taxi may say TAXI (owner, 2026-09-23:
 *                                  "text on signs I would allow").
 *   unclassified                -> logged, no finding: the inventory did not
 *                                  answer the question this check needs.
 */
'use strict';

const { log } = require('../utils/logger');

/** placement -> spelling -> severity; null = allowed. */
const SEVERITY = {
  overlay:   { correct: 'CRITICAL', misspelled: 'CRITICAL', scribble: 'CRITICAL' },
  misplaced: { correct: 'CRITICAL', misspelled: 'CRITICAL', scribble: 'MINOR' },
  fits:      { correct: null,       misspelled: 'CRITICAL', scribble: 'MINOR' },
};

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
 * @param {Array}    args.lettering  inventory `lettering[]`: {text, surface, position, placement, spelling}
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
    const severity = SEVERITY[l?.placement]?.[l?.spelling];
    if (severity === undefined) {
      log.error(`[LETTERING] unclassified lettering "${text}" (placement=${l?.placement}, spelling=${l?.spelling}) — no finding`);
      continue;
    }
    if (!severity) continue;
    const where = [l?.surface, l?.position].filter(Boolean).join(', ');
    const at = where ? ` (${where})` : '';
    const description = l.placement === 'overlay'
      ? `A caption "${text}" is laid over the picture${at}; nothing on the page asks for it.`
      : l.spelling === 'misspelled'
        ? `Misspelled lettering "${text}"${at}.`
        : l.spelling === 'scribble'
          ? `Scribble that reads as writing${at}; it spells nothing.`
          : `Lettering "${text}" is painted on something that would not carry it${at}.`;
    findings.push({
      type: 'rendered_text',
      severity,
      character: null,
      source: 'lettering-check',
      description,
      // When the page declares lettering, the repair that paints this one over
      // must not take it with it: the inventory can misread a declared string
      // (staging job_1791145238223_50osg2osm read the painted title
      // "Löwenatem" as "Lövenatem", so the title was charged as a caption and
      // the repair erased it). The sentence is structural, not a text match:
      // declared lettering is excluded whatever this finding quotes.
      fix: `Paint over the lettering${l?.surface ? ` on ${l.surface}` : ''} as continuous scene material — no readable writing.${declaredSquashed.length ? ' The required lettering stated in the repair instructions is not this lettering and is left exactly as it is.' : ''}`,
    });
  }
  return findings;
}

/**
 * The record stored on a page version: exactly what the check compared. Each
 * inventory item keeps only the five fields the check reads, each string
 * capped at 200 characters so a runaway model answer cannot bloat the row.
 * @returns {{items: Array<{text, surface, position, placement, spelling}>, declared: string[]}}
 */
function letteringRecord({ lettering, declared } = {}) {
  const str = (v) => (v == null ? null : String(v).slice(0, 200));
  const items = (Array.isArray(lettering) ? lettering : []).map(l => ({
    text: str(l?.text),
    surface: str(l?.surface),
    position: str(l?.position),
    placement: str(l?.placement),
    spelling: str(l?.spelling),
  }));
  return { items, declared: (Array.isArray(declared) ? declared : []).map(str).filter(Boolean) };
}

/**
 * UNREQUESTED LETTERING NEVER GOES TO THE IMAGE MODEL AS LETTERS.
 *
 * An image model paints the word it reads in its instruction. Staging
 * job_1791531449494_o0kaatvmq p3: the judge's inventory misread an ornament
 * band as "BANZ" and filed a CRITICAL rendered_text finding; the repair
 * instruction quoted it ("Paint over 'BANZ' on stone bands ..."), and Grok
 * PAINTED "BANZ" onto both towers — the repair created the defect it was told
 * to remove. The finding's description keeps the quote (humans and judges read
 * it); every text that is SENT to an image model is passed through here first,
 * so it says where the lettering is (the surface, from the sentence around it)
 * and never what it reads.
 *
 * What is removed is exactly the strings the lettering inventory itself read
 * from this image (record.items[].text) — a mechanical match against the
 * evaluator's own output, never a reading of the finding's prose. A string the
 * page DECLARES (record.declared; requiredText.js) is not touched: repainting
 * required lettering correctly has to name it.
 *
 * @param {string} text   an instruction / issue line bound for an image model
 * @param {{items?: Array<{text}>, declared?: string[]}|null} record  letteringRecord() of the same image
 * @returns {string}
 */
function redactReadLettering(text, record) {
  if (typeof text !== 'string' || !text) return text;
  const items = Array.isArray(record?.items) ? record.items : [];
  const declaredSquashed = (Array.isArray(record?.declared) ? record.declared : []).map(squash).filter(Boolean);
  const seen = [...new Set(items.map(i => String(i?.text || '').trim()).filter(Boolean))]
    .filter(t => !isDeclared(t, declaredSquashed))
    .sort((a, b) => b.length - a.length);
  if (!seen.length) return text;
  const QUOTE = '["\'“”‘’«»„‹›`]';
  const NOUN = '(?:the\\s+)?(?:(?:lettering|letters|text|words?|writing|caption|label|inscription)\\s+)?';
  const keepCase = (m, repl) => (/^\p{Lu}/u.test(m) ? repl.charAt(0).toUpperCase() + repl.slice(1) : repl);
  let out = text;
  for (const t of seen) {
    const body = t.split(/\s+/).map(w => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('\\s+');
    const quoted = new RegExp(NOUN + QUOTE + '\\s*' + body + '\\s*' + QUOTE, 'giu');
    out = out.replace(quoted, (m) => keepCase(m, 'the lettering'));
    // A bare mention ("the word BANZ"): only a string long enough to be a word,
    // so a one-letter reading cannot eat ordinary prose.
    if (squash(t).length >= 3) {
      const bare = new RegExp(NOUN + '(?<![\\p{L}\\p{N}])' + body + '(?![\\p{L}\\p{N}])', 'giu');
      out = out.replace(bare, (m) => keepCase(m, 'the lettering'));
    }
  }
  return out.replace(/(the lettering)(\s+the lettering)+/gi, '$1');
}

module.exports = { checkUndeclaredLettering, letteringRecord, redactReadLettering, isDeclared, squash };
