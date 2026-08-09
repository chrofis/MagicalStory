/**
 * Clothing check — does each page's PROSE state what its characters wear?
 *
 * The scene prose is the contract twice over: the image model renders from it,
 * and the quality evaluator judges the render against it. So a page whose prose
 * omits an outfit is not merely under-specified — it is scored against an
 * expectation nobody wrote, and the repair rounds then regenerate against the
 * same silence. Staging `job_1786193650012_7baiaeftb` lost fifteen findings and
 * 215 points that way: pirates rendered without pirate clothing because the
 * prose never named the costume and the mechanical `wears:` line had been
 * gutted by the worn-vs-held filter.
 *
 * This module is PURE and free — no API call, no image. It compares the
 * canonical `clothingRequirements` text against the prose and returns findings
 * for the scene review to fix (owner decision 2026-08-08: findings go to the
 * scene review, and nowhere else).
 *
 * Three findings, in the order they matter:
 *   outfit_missing       the prose never names this character's outfit
 *   outfit_misattributed a garment of character A appears on character B
 *   removal_unstated     the scene puts a garment off-body without saying the
 *                        wearer is WITHOUT it (story-unified.txt's own rule)
 *
 * Deliberately NOT a fixer. It reports; the review rewrites; the caller re-runs
 * it afterwards and logs whatever survived rather than shipping it silently.
 */

const { log } = require('../utils/logger');
const { resolveCharacterReqs } = require('./clothingCategories');

// Slot labels the writer emits. A slot the character does not wear is OMITTED
// (owner decision 2026-08-08) — `none` values are legacy and skipped below.
const SLOT_LABELS = ['headwear', 'top', 'bottom', 'footwear', 'belt/waist', 'outer layer', 'accessories'];

// Words that carry no wardrobe identity — they match everything and would make
// any prose look like it describes an outfit.
const STOPWORDS = new Set([
  'with', 'and', 'the', 'that', 'this', 'from', 'over', 'under', 'onto', 'into', 'front', 'back',
  'left', 'right', 'side', 'small', 'large', 'long', 'short', 'wide', 'narrow', 'plain', 'simple',
  'worn', 'wearing', 'wears', 'dressed', 'length', 'colour', 'color', 'material', 'style',
  'none', 'slot', 'chest', 'waist', 'shoulder', 'sleeve', 'sleeves', 'cotton', 'linen',
]);

/** Significant lowercase tokens (≥4 chars, not stopwords). */
function tokens(text) {
  return new Set(
    String(text || '')
      .toLowerCase()
      .split(/[^a-zäöüàéèêç]+/)
      .filter(w => w.length >= 4 && !STOPWORDS.has(w))
  );
}

/**
 * Split a slot-labelled outfit description into {slot, text} parts. Falls back
 * to one unlabelled part when the description is a plain sentence (the normal
 * standard/summer/winter shape) — the check works the same either way.
 */
function splitSlots(description) {
  const raw = String(description || '').trim();
  if (!raw) return [];
  const labelRe = new RegExp(`(?:^|[;,])\\s*(${SLOT_LABELS.map(l => l.replace('/', '\\/')).join('|')})\\s*:`, 'gi');
  const marks = [];
  let m;
  while ((m = labelRe.exec(raw)) !== null) marks.push({ slot: m[1].toLowerCase(), at: m.index, end: labelRe.lastIndex });
  if (marks.length === 0) return [{ slot: null, text: raw }];
  return marks.map((mark, i) => {
    const text = raw.slice(mark.end, i + 1 < marks.length ? marks[i + 1].at : raw.length)
      .replace(/[;,.\s]+$/, '').trim();
    return { slot: mark.slot, text };
  }).filter(part => part.text && !/^none$/i.test(part.text));
}

/**
 * Is this outfit present in the prose? A slot counts as stated when at least
 * two of its significant tokens appear. Two, not one, because a single common
 * word ("striped", "brown") collides across garments.
 */
function slotStated(slotText, proseTokens) {
  const t = [...tokens(slotText)];
  if (t.length === 0) return true; // nothing identifying to look for
  const hits = t.filter(w => proseTokens.has(w)).length;
  return hits >= Math.min(2, t.length);
}

/**
 * Check one page.
 *
 * @param {Object} page
 * @param {number} page.pageNumber
 * @param {string} page.prose            the scene brief's prose (metadata stripped)
 * @param {Array}  page.cast             [{name}] characters on this page
 * @param {Object} page.perCharClothing  {Name: category} for this page
 * @param {Object} clothingRequirements  story-level requirements
 * @param {Object} [opts]
 * @param {Array}  [opts.artifacts]      visualBible.artifacts (for `wornAs` links)
 * @returns {Array<{pageNumber, type, character, slot, detail}>}
 */
function checkPage(page, clothingRequirements, opts = {}) {
  const findings = [];
  const prose = String(page?.prose || '');
  if (!prose.trim()) return findings;
  const proseTokens = tokens(prose);
  const cast = (page.cast || []).map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean);
  const perChar = page.perCharClothing || {};

  // Outfit text per character on this page.
  const outfits = new Map();
  for (const name of cast) {
    const catKey = Object.keys(perChar).find(k => k.trim().toLowerCase() === name.trim().toLowerCase());
    const category = catKey ? perChar[catKey] : null;
    if (!category) continue; // no per-page category is a different check's problem
    const reqs = resolveCharacterReqs(clothingRequirements, name);
    const entry = reqs && (reqs[category] || (String(category).startsWith('costumed') ? reqs.costumed : null));
    const text = entry && (entry.signature && entry.signature !== 'none' ? entry.signature : entry.description);
    if (text) outfits.set(name, { category, parts: splitSlots(text) });
  }

  // 1. outfit_missing — TOTAL silence only. A partial omission is normal and
  // usually right: a close-up has no reason to mention shoes, and the prose is
  // prose, not an inventory. Measured over 25 stories, faulting partials fired
  // on stories scoring 74 and 84 — noise that would send the reviewer rewriting
  // pages that are fine. Only "the prose says nothing about what this character
  // wears" is unambiguously a defect.
  for (const [name, { category, parts }] of outfits) {
    if (parts.length === 0) continue;
    const stated = parts.filter(p => slotStated(p.text, proseTokens));
    if (stated.length === 0) {
      findings.push({
        pageNumber: page.pageNumber, type: 'outfit_missing', character: name, slot: null,
        detail: `The prose never says what ${name} is wearing. Their ${category} outfit is: ${parts.map(p => (p.slot ? `${p.slot}: ` : '') + p.text).join('; ')}.`,
      });
    }
  }

  // 2. outfit_misattributed — a garment belonging to A is described on B.
  // Only slots distinctive enough to be identifiable are tested, and only when
  // the owner is NOT on this page or is not the one the prose attaches it to.
  // Tokens shared by two or more characters on this page cannot attribute
  // anything — matching pirate crews wear the same striped shirts, and a shared
  // word then "proves" every character is wearing everyone else's clothes.
  // Measured: without this, one 4-page story produced 28 misattributions.
  const tokenOwners = new Map();
  for (const [owner, { parts }] of outfits) {
    for (const part of parts) {
      for (const w of tokens(part.text)) {
        if (!tokenOwners.has(w)) tokenOwners.set(w, new Set());
        tokenOwners.get(w).add(owner);
      }
    }
  }
  const distinctive = (w) => (tokenOwners.get(w)?.size || 0) === 1;

  for (const [owner, { parts }] of outfits) {
    for (const part of parts) {
      const t = [...tokens(part.text)].filter(distinctive);
      if (t.length < 3) continue;
      for (const other of cast) {
        if (other === owner) continue;
        // "<Other> … <≥3 of owner's slot tokens>" inside one sentence.
        const sentences = prose.split(/(?<=[.!?])\s+/);
        for (const sentence of sentences) {
          if (!new RegExp(`\\b${other.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(sentence)) continue;
          if (new RegExp(`\\b${owner.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(sentence)) continue;
          const st = tokens(sentence);
          const hits = t.filter(w => st.has(w)).length;
          if (hits >= 3) {
            // WORD THE FAULT AS THE FIX. The first version said "the prose puts
            // Sarah's blouse on Hans" — and Hans was not wearing a blouse, he was
            // wearing a burgundy COAT. The reviewer looked for a blouse, found
            // none, and left it (Lab #446: 14 pages rewritten, 0 faults fixed).
            // What is actually wrong is that words belonging only to another
            // character's outfit appear on this one, so name those words and
            // state this character's own outfit as the replacement.
            const borrowed = t.filter(w => st.has(w));
            const ownOutfit = outfits.get(other);
            const ownText = ownOutfit ? ownOutfit.parts.map(x => (x.slot ? `${x.slot}: ` : '') + x.text).join('; ') : null;
            findings.push({
              pageNumber: page.pageNumber, type: 'outfit_misattributed', character: other, slot: part.slot,
              detail: `${other} is described with wording that belongs to ${owner}'s outfit (${borrowed.map(w => `"${w}"`).join(', ')}). `
                + (ownText
                  ? `Rewrite ${other}'s description to their own outfit: ${ownText}. `
                  : `${other} has no outfit of their own in this story — say nothing about their clothing. `)
                + `Do not reuse any of ${owner}'s garments or colours on ${other}.`,
            });
            break;
          }
        }
      }
    }
  }

  // 3. removal_unstated — a prop that is also a costume slot (`wornAs`) is
  // named in the prose while the wearer is still described wearing it, with no
  // statement that they are WITHOUT it. story-unified.txt requires that
  // statement; nothing enforced it, and the worn-vs-held filter silently
  // deleted the garment instead.
  for (const art of (opts.artifacts || [])) {
    const wornAs = String(art?.wornAs || '').trim();
    if (!wornAs.includes('.')) continue;
    const [ownerRaw, slotRaw] = wornAs.split('.');
    const owner = (ownerRaw || '').trim();
    if (!owner || !cast.some(n => n.toLowerCase() === owner.toLowerCase())) continue;
    const artTokens = [...tokens(art.name)].concat([...tokens(art.extractedDescription || art.description)]);
    const named = artTokens.filter(w => proseTokens.has(w)).length >= 2;
    if (!named) continue;
    const withoutStated = new RegExp(`\\bwithout\\b[^.]{0,60}|\\bnot wearing\\b|\\bno longer wear`, 'i').test(prose);
    if (!withoutStated) {
      findings.push({
        pageNumber: page.pageNumber, type: 'removal_unstated', character: owner, slot: (slotRaw || '').trim() || null,
        detail: `"${art.name}" is both ${owner}'s ${(slotRaw || 'costume').trim()} and a prop in this scene. Say explicitly whether ${owner} is wearing it or is WITHOUT it and where it lies — never leave both possible.`,
      });
    }
  }

  return findings;
}

/**
 * Check every page. Returns findings plus a per-page index the review prompt
 * renders directly.
 */
function checkScenes(pages, clothingRequirements, opts = {}) {
  const all = [];
  for (const page of (pages || [])) {
    try {
      all.push(...checkPage(page, clothingRequirements, opts));
    } catch (err) {
      log.warn(`[CLOTHING-CHECK] page ${page?.pageNumber}: ${err.message}`);
    }
  }
  const byPage = new Map();
  for (const f of all) {
    if (!byPage.has(f.pageNumber)) byPage.set(f.pageNumber, []);
    byPage.get(f.pageNumber).push(f);
  }
  return { findings: all, byPage };
}

// Which findings are worth a reviewer's time. MEASURED over the 25 most recent
// staging stories, not assumed:
//   outfit_misattributed — fires on the two worst stories (avg 11 and 17) and
//     is silent on every story scoring ≥60. Real signal. SENT.
//   removal_unstated     — rare and unambiguous by construction (it needs a
//     `wornAs` link, which only exists where the writer declared the duality). SENT.
//   outfit_missing       — 24% of pages in stories scoring <40 versus 21% in
//     stories scoring ≥60. NO discriminating power: prose omitting the outfit is
//     normal and harmless while the canonical `wears:` line still carries it.
//     Sending it would have the reviewer rewriting one page in five for nothing.
//     Kept as a diagnostic, NOT sent.
const REVIEWABLE = new Set(['outfit_misattributed', 'removal_unstated']);

/** Render findings as the {CLOTHING_FINDINGS} block for scene-review.txt. */
function renderFindingsBlock(byPage) {
  if (!byPage || byPage.size === 0) return '';
  const lines = [];
  for (const pageNumber of [...byPage.keys()].sort((a, b) => a - b)) {
    const sendable = byPage.get(pageNumber).filter(f => REVIEWABLE.has(f.type));
    if (sendable.length === 0) continue;
    lines.push(`- Page ${pageNumber}:`);
    for (const f of sendable) lines.push(`  - [${f.type}] ${f.detail}`);
  }
  if (lines.length === 0) return '';
  return [
    '# MECHANICAL CLOTHING FAULTS',
    '',
    "Found by exact comparison against this story's clothing requirements. Every page listed here is faulted and MUST be rewritten under ---SCENES---.",
    '',
    ...lines,
    '',
    'For each page above: move the garment onto its rightful owner, or state the outfit the fault says is missing. Change nothing else on the page.',
  ].join('\n');
}

/**
 * The slice of page prose that describes ONE character.
 *
 * Whole-page prose cannot answer "is Emma dressed": on a five-character pirate
 * page every outfit shares its vocabulary, so Noah's shorts make Emma's shorts
 * look stated. Measured on job_1786235099497_ytd5c7eek p12 — the prose dresses
 * Emma in a shirt and nothing else, and every clause of her outfit scored as
 * present because four other pirates were on the page.
 *
 * The scene templates introduce a character as `Name — appearance — action`,
 * and the appearance span is where clothing lives. Take that span when it is
 * there; fall back to the whole prose when it is not, which is the old,
 * conservative behaviour (misses rather than false-fires).
 */
function characterProse(prose, characterName) {
  const text = String(prose || '');
  if (!characterName) return text;
  const esc = String(characterName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // `Name — … —` (em dash, en dash or a double hyphen)
  const m = new RegExp(`${esc}\\s*[—–]\\s*([\\s\\S]{0,600}?)\\s*[—–]`, 'i').exec(text);
  return m ? m[1] : text;
}

/**
 * Which garments of an outfit the prose fails to state.
 *
 * Outfit descriptions arrive in two shapes and BOTH must be handled here, in
 * one place — a caller that only understood the labelled shape reported
 * "nothing missing" for a girl the prose dressed in a shirt and a hat, whose
 * page then rendered her in underwear (job_1786235099497_ytd5c7eek p10):
 *
 *   labelled    "top: …; bottom: …; footwear: …"   → check the required slots
 *   unlabelled  "A striped shirt; navy shorts; …"  → check every clause
 *
 * Returns the missing garment names (slot label, or the clause's first words
 * when unlabelled). Empty means the prose dresses this character.
 *
 * @param {string} clothingDescription  the canonical outfit
 * @param {string} prose                the scene brief's prose
 * @param {string[]} [requiredSlots]    labelled shape only; default top/bottom/footwear
 */
function missingGarments(clothingDescription, prose, requiredSlots = ['top', 'bottom', 'footwear'], characterName = null) {
  const parts = splitSlots(clothingDescription);
  if (parts.length === 0) return [];
  const proseTokens = tokens(characterProse(prose, characterName));

  const labelled = parts.filter(p => p.slot);
  if (labelled.length > 0) {
    return labelled
      .filter(p => requiredSlots.includes(p.slot) && !slotStated(p.text, proseTokens))
      .map(p => p.slot);
  }

  // Unlabelled: each semicolon-separated clause is a garment in its own right,
  // so "any one clause matched" is not evidence the character is dressed.
  // Accessories are skipped, matching the labelled path — it requires only
  // top/bottom/footwear, and a belt or a hat going unmentioned in prose is
  // normal. Without this the check fired on 64.9% of character-pages, which is
  // a warning nobody reads.
  const ACCESSORY = /\b(belt|sash|hat|cap|bandana|tricorn|headband|scarf|glove|mitten|earring|badge|feather|brooch|necklace|bracelet|watch|apron|bow)\b/i;
  return String(clothingDescription || '')
    .split(/\s*;\s*/)
    .map(s => s.replace(/^[Aa]n?\s+/, '').trim())
    .filter(Boolean)
    .filter(clause => !ACCESSORY.test(clause))
    .filter(clause => !slotStated(clause, proseTokens))
    .map(clause => clause.split(/\s+/).slice(0, 3).join(' '));
}

// slotStated + missingGarments are exported so the image-prompt clothing check
// (storyHelpers buildImagePrompt) uses THIS definition of "is this garment in
// the prose" rather than growing a second one.
module.exports = { checkPage, checkScenes, renderFindingsBlock, splitSlots, slotStated, missingGarments, characterProse, tokens };
