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
 * Four findings, in the order they matter:
 *   outfit_missing       the prose never names this character's outfit
 *   garment_colour_wrong the prose gives a character's garment a colour their
 *                        contract gives the SAME garment differently
 *   removal_unstated     a tracked garment whose owner is on the page has no
 *                        `wornItems` state (or an "off" state with no place)
 *   worn_link_missing    a Visual Bible element that is clearly a worn garment
 *                        carries no `wornAs` link, so nothing above can see it
 *
 * A fifth, `outfit_misattributed`, lived here from 2026-08-08 to 2026-09-18 and
 * is DELETED — see the block above REVIEWABLE. It decided from prose that one
 * character had been put in another's clothes, which is a language judgement;
 * the rule now lives in prompts/scene-review.txt as `[clothing_owner]`.
 *
 * Deliberately NOT a fixer. It reports; the review rewrites; the caller re-runs
 * it afterwards and logs whatever survived rather than shipping it silently.
 */

const { log } = require('../utils/logger');
const { lookupByName } = require('./castResolver');
const { resolveCharacterReqs } = require('./clothingCategories');
const { resolveWornItemsForPage, unlinkedWornCandidates, trackedWornGarments, missingWornRows } = require('./wornItems');

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

// The garment vocabulary: which nouns name a thing worn on a body. `colourBefore`
// walks it to find the colour a garment carries, `contractPairs` builds the
// (garment, colour) contract from it, and `deriveSlotFromName` in wornItems has
// its own for slots. A word here is a garment; a colour, material or shape is
// not one and never stands in for one — an object described in a page's prose
// ("dark brown planks … round coins") shares those words with every wardrobe in
// the story and attributes nothing.
const GARMENT_NOUNS = new Set([
  'shirt', 'blouse', 'coat', 'jacket', 'vest', 'waistcoat', 'cardigan', 'jumper', 'sweater',
  'hoodie', 'tunic', 'dress', 'skirt', 'trousers', 'pants', 'shorts', 'breeches', 'jeans',
  'leggings', 'dungarees', 'overalls', 'boots', 'shoes', 'trainers', 'sneakers', 'sandals',
  'loafers', 'plimsolls', 'slippers', 'hat', 'cap', 'tricorn', 'bandana', 'headscarf',
  'scarf', 'gloves', 'mittens', 'belt', 'sash', 'apron', 'cloak', 'cape', 'parka', 'blazer',
  'shirts', 'boots', 'socks', 'tights', 'glasses', 'earrings', 'buckle', 'lapels', 'cuffs',
  // Added 2026-08-17: a wizard's robe was invisible to every rule in this file
  // because the list never had the word (job_1786484554633 shipped five
  // identical purple robes past all three checks). Costume staples + the
  // leg-replacing forms.
  'robe', 'robes', 'gown', 'poncho', 'kilt', 'sari', 'kimono', 'pinafore', 'romper', 'jumpsuit',
  'swimsuit', 'trunks', 'shawl', 'headband', 'tiara', 'crown', 'helmet', 'tail', 'fin', 'fins',
]);

// The wardrobe writer is restricted to these colour words (story-bible rule),
// so the contract side of a comparison is always one of them. A shade is not a
// mismatch: "deep purple" and "purple" both resolve to purple.
const COLOUR_WORDS = new Set([
  'red', 'blue', 'green', 'yellow', 'orange', 'purple', 'brown', 'black', 'white', 'grey', 'gray',
]);

/**
 * The colour that belongs to the garment at index i. Materials, cuts and
 * shades sit between them ("blue short-sleeved linen robe", "deep purple
 * robe"), so scan back a few words rather than requiring adjacency — but stop
 * at another garment noun, whose colour is its own ("blue robe over white
 * collared shirt": the shirt is white, not blue).
 */
function colourBefore(words, i) {
  for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
    const w = words[k];
    if (COLOUR_WORDS.has(w)) return w === 'gray' ? 'grey' : w;
    if (GARMENT_NOUNS.has(w)) return null;
  }
  return null;
}

/** Every (garment, colour) pair a contract slot states. */
function contractPairs(parts) {
  const pairs = new Map();   // garment -> Set(colours)
  for (const part of parts) {
    const words = String(part.text || '').toLowerCase().split(/[^a-z-]+/).filter(Boolean);
    for (let i = 0; i < words.length; i++) {
      const g = words[i];
      if (!GARMENT_NOUNS.has(g)) continue;
      const c = colourBefore(words, i);
      if (!c) continue;
      if (!pairs.has(g)) pairs.set(g, new Set());
      pairs.get(g).add(c);
    }
  }
  return pairs;
}

// Prose only states an outfit where it ATTACHES clothing to a body. Rule 3
// reads a colour only inside a window that carries one of these — a window that
// merely names a character, without dressing anyone, states no garment colour to
// disagree with.
const ATTACHES = /\b(wearing|wears|dressed in|clad in|in (?:his|her|their|a|an|the))/i;

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
 * ONE removal_unstated finding, for both the linked and the unlinked path. The
 * remedy text is the whole value of this finding — the scene review acts on it
 * verbatim — so it is built in one place rather than copied per path.
 */
function removalUnstated(pageNumber, item, what) {
  return {
    pageNumber, type: 'removal_unstated', character: item.owner, slot: item.slot || null,
    artifactId: item.id,
    detail: `"${item.name}" is ${item.owner}'s ${item.slot || 'costume'} AND a Visual Bible element; this page ${what}. `
      + `Add to this page's METADATA \`wornItems\`: {"id": "${item.id}", "owner": "${item.owner}", "state": "worn"} `
      + `if ${item.owner} wears it here, {"id": "${item.id}", "owner": "${item.owner}", "state": "worn", "wearer": "<the character on this page who wears it>"} `
      + `if someone else wears it here, or {"id": "${item.id}", "owner": "${item.owner}", "state": "off", "location": "<where it lies or who holds it>"} if nobody does. `
      + `The prose must agree with whichever you choose.`,
  };
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
    const category = (lookupByName(perChar, name, null) || {}).value || null;  // RESOLVE
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

  // The page's worn rows, resolved once: the removal check further down reads
  // this list.
  const vbForWorn = opts.visualBible || { artifacts: opts.artifacts || [], clothing: opts.clothing || [] };
  const wornRows = resolveWornItemsForPage(vbForWorn, cast, { wornItems: page.wornItems || [] }, { pageNumber: page.pageNumber });

  // 2. DELETED 2026-09-18 — `outfit_misattributed`, "a garment belonging to A is
  // described on B". It read the page's PROSE and decided, from token overlap
  // against the story's wardrobe text, that one character had been put in
  // another's clothes. That is a language judgement, and the owner's rule is
  // that language belongs in the prompt, not in code: the rule now lives in
  // prompts/scene-review.txt as check 3c `[clothing_owner]` (same ruling, same
  // week, as the `element_uncited` removal in ea8e36198).
  //
  // MEASURED before removal, over all 120 stored staging stories / 1,322 brief
  // pages (the 70 stories that kept `sceneReviewReport.briefsIn` replayed from
  // the exact pre-review briefs the check ran on): 9 fires on staging, 9 FALSE,
  // 0 true. In PRODUCTION it never fired at all. Every fire cost a mandatory
  // rewrite of a correct page — scene-review check 0 forbids declining a
  // mechanical finding ("facts, not opinions") — and a rewritten brief becomes
  // the image prompt, so each one changed a picture.
  //
  // Three false-fire mechanisms, none of them tunable:
  //   - The attribution test was vacuous whenever the owner was not named in
  //     the prose: the Art Director routinely writes a figure by appearance
  //     ("the preschooler little girl … wearing a red quilted gilet"), and then
  //     every sentence passes "carries `other`'s name and not `owner`'s",
  //     INCLUDING the one describing the owner. 6 of the 9 were this shape.
  //     e1bd11014 narrowed it with a `namedInProse` precondition the same day;
  //     this deletion supersedes that stopgap.
  //   - The evidence was gathered per SENTENCE, split on `/(?<=[.!?])\s+/`,
  //     which cuts a character description at a `.` inside a parenthetical and
  //     hands half a figure's clothing to whoever is named in the other half.
  //   - Colour words counted toward the ≥3-token evidence threshold although
  //     this file's own GARMENT_NOUNS comment says colours attribute nothing:
  //     only ONE of the three matches had to be a garment noun, so "brown" out
  //     of "brown eyes" was evidence that a garment had moved.
  // The first two die with the rule. The colour-word reading survives in
  // `colourBefore`, which rule 3 below uses on a different basis — per garment,
  // inside one character's own window — and is not this defect.

  // 3. garment_colour_wrong — the prose gives a character's garment a colour
  // their contract gives the SAME garment differently. The five-identical-robes
  // failure (job_1786484554633) passed every check above: the prose was verbose
  // (so nothing was "missing") and every character shared "robe"/"hat"/"shoes"
  // (so no token was distinctive enough to misattribute). Colour was the only
  // signal, and nothing read it. Compared PER GARMENT, never per character: a
  // colour the contract never attaches to that garment — a prop, a wall, a
  // slot the contract leaves colourless — is not a finding.
  for (const [name, { parts }] of outfits) {
    const pairs = contractPairs(parts);
    if (pairs.size === 0) continue;
    // Window = from this character's name to the next cast member's name (or
    // 400 chars), across sentence boundaries: the clothing usually sits AFTER
    // the em-dash physical block, which is why characterProse() is wrong here.
    const own = characterWindow(prose, name, cast);
    if (!own || !ATTACHES.test(own)) continue;
    const words = own.toLowerCase().split(/[^a-z-]+/).filter(Boolean);
    const seen = new Set();
    for (let i = 0; i < words.length; i++) {
      const g = words[i];
      const expected = pairs.get(g);
      if (!expected) continue;                 // garment the contract never colours
      const c = colourBefore(words, i);
      if (!c || expected.has(c)) continue;     // no colour stated, or it matches
      const key = `${g}/${c}`;
      if (seen.has(key)) continue;
      seen.add(key);
      findings.push({
        pageNumber: page.pageNumber, type: 'garment_colour_wrong', character: name, slot: g,
        detail: `${name}'s ${g} is described as ${c}; their outfit gives it ${[...expected].join(' / ')}. `
          + `Rewrite the ${g} in ${name}'s own colour — never move another character's colour onto them.`,
      });
    }
  }

  // 3. removal_unstated — STRUCTURED since 2026-09-06 (owner ruling). A VB
  // entry that is also part of a character's outfit (`wornAs: "Name.slot"`)
  // must carry an explicit per-page state in the brief's METADATA
  // `wornItems[]` whenever its owner is on the page: `worn`, or `off` WITH the
  // place it now lies. Nothing here reads prose.
  //
  // The prose version of this check (2026-08-08 → 2026-09-06) asked the review
  // to write a sentence and then looked for the words "without" / "not
  // wearing" / "no longer wear" anywhere on the page. On staging
  // job_1788641639919_mpjwlzkf1 it faulted 9 pages and the review fixed 0 of
  // them — a finding no downstream code could act on, phrased as a request for
  // prose, is a finding that ships. The state is now a field, and the packing,
  // REQUIRED OBJECTS, clothing-text and prompt paths all branch on it.
  for (const r of wornRows) {
    if (!r.missing) continue;
    findings.push(removalUnstated(page.pageNumber, r, r.declared
      ? 'declares it "off" but names no place for it'
      : 'has no wornItems entry for it'));
  }

  // 3b. The same fault on an UNLINKED garment (2026-09-19). `wornRows` above is
  // resolveWornItemsForPage, whose two sources are the writer's `wornAs`
  // entries and THE ROWS THIS PAGE DECLARES. An undeclared state on a garment
  // the writer never linked is in neither: no row to enumerate, no link to
  // default. It resolved to WORN by silence — the outfit contract kept the
  // garment and the attached reference wore it — with no log and no finding,
  // on 39 of the 45 measured page/garment gaps. See trackedWornGarments.
  //
  // Same TYPE, same remedy, same severity: the population widens, the
  // classification does not. The garments are the ones this brief set already
  // declares rows for, so a garment no page tracks stays rule 4's business.
  for (const t of missingWornRows(opts.trackedWorn, cast, { wornItems: page.wornItems || [] })) {
    findings.push(removalUnstated(page.pageNumber, t, 'has no wornItems entry for it'));
  }

  // 4. worn_link_missing — the element IS a garment and nothing links it to an
  // outfit. Everything above (and the whole per-page worn-state path) hangs off
  // `wornAs`, and the writer emitted one on 9 of 482 entries across 59 staging
  // stories: on job_1789420511893_zly5rcdej the cap the plot hands from one
  // character to another was typed `headwear` and linked to nobody, so the
  // off-state guard never saw it. Deterministic — the element's own `type` is
  // an outfit slot, or exactly one character's outfit names the same garment.
  const outfitTexts = new Map([...outfits].map(([name, o]) => [name, o.parts.map(x => x.text).join('; ')]));
  for (const c of unlinkedWornCandidates(vbForWorn, outfitTexts)) {
    if (c.owner ? !cast.includes(c.owner) : !(c.pages || []).includes(page.pageNumber)) continue;
    findings.push({
      pageNumber: page.pageNumber, type: 'worn_link_missing', character: c.owner || null, slot: c.slot,
      artifactId: c.id,
      detail: `"${c.name}" (${c.id}) is a ${c.slot} item but its Visual Bible entry has no \`wornAs\` link, `
        + `so no page can state who wears it or take it off. `
        + (c.owner
          ? `Add \`"wornAs": "${c.owner}.${c.slot}"\` to ${c.id} — ${c.owner}'s outfit already describes it.`
          : `Add \`"wornAs": "<CharacterName>.${c.slot}"\` to ${c.id}, naming the character whose outfit it belongs to, and describe the same item in that slot of their outfit.`),
    });
  }

  return findings;
}

/**
 * Check every page. Returns findings plus a per-page index the review prompt
 * renders directly.
 */
function checkScenes(pages, clothingRequirements, opts = {}) {
  const all = [];
  // Which garments this brief set tracks, from every page's own rows — a
  // per-page check cannot know that page 16 is the one page of eighteen that
  // left a declared garment out. Computed once; see trackedWornGarments.
  const vbForTracked = opts.visualBible || { artifacts: opts.artifacts || [], clothing: opts.clothing || [] };
  const trackedWorn = trackedWornGarments(vbForTracked, (pages || []).map(p => (p && p.wornItems) || []));
  const pageOpts = { ...opts, trackedWorn };
  for (const page of (pages || [])) {
    try {
      all.push(...checkPage(page, clothingRequirements, pageOpts));
    } catch (err) {
      log.warn(`[CLOTHING-CHECK] page ${page?.pageNumber}: ${err.message}`);
    }
  }
  const unlinked = new Map();
  for (const f of all) if (f.type === 'worn_link_missing') unlinked.set(f.artifactId, f);
  for (const f of unlinked.values()) {
    log.warn(`[CLOTHING-CHECK] ${f.artifactId} "${f.slot}" has no wornAs link — the per-page worn-state path cannot see it. ${f.detail}`);
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
//   outfit_misattributed — was SENT from 2026-08-08 to 2026-09-18 on the claim
//     that it "fires on the two worst stories and is silent on every story
//     scoring ≥60". A full replay over all 120 stored staging stories found 9
//     fires, 9 of them false and none in production, each one costing a
//     mandatory rewrite of a correct page. DELETED, not demoted — see the
//     block where rule 2 used to run. `[clothing_owner]` in scene-review.txt
//     is the replacement.
//   removal_unstated     — rare and unambiguous by construction (it needs a
//     garment this brief set already declares a `wornItems` row for somewhere,
//     or a `wornAs` link). MEASURED after the 2026-09-19 widening to unlinked
//     garments: 45 fires over the 14 of 126 stored staging stories that track a
//     garment at all, and 0 over the other 112.
//     Since 2026-09-06 it is a MISSING-FIELD fault, so it is also mechanically
//     verifiable after the rewrite and drives a targeted second round. SENT.
//   outfit_missing       — 24% of pages in stories scoring <40 versus 21% in
//     stories scoring ≥60. NO discriminating power: prose omitting the outfit is
//     normal and harmless while the canonical `wears:` line still carries it.
//     Sending it would have the reviewer rewriting one page in five for nothing.
//     Kept as a diagnostic, NOT sent.
//   worn_link_missing    a Visual Bible fault, not a page fault: the scene
//     review rewrites pages and cannot add a field to the bible, so sending it
//     would ask for a fix the reviewer has no way to make. Reported and LOGGED
//     (checkScenes) so the miss is on the record, NOT sent.
const REVIEWABLE = new Set(['removal_unstated']);

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
    'For each page above: make the change the fault asks for, in the field it names, with the prose agreeing. Change nothing else on the page.',
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
 * The stretch of prose that describes ONE character: from their name up to the
 * next cast member's name. Unlike characterProse() this deliberately spans the
 * em-dash block AND the clothing clause that follows it, because a brief reads
 * "Name — age, hair, eyes — in his blue robe and green sash": the colours live
 * outside the dashes.
 */
function characterWindow(prose, name, cast = []) {
  const text = String(prose || '');
  const esc = (n) => String(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const start = text.search(new RegExp(`\\b${esc(name)}\\b`, 'i'));
  if (start < 0) return '';
  let end = Math.min(text.length, start + 400);
  for (const other of cast) {
    if (!other || other.toLowerCase() === String(name).toLowerCase()) continue;
    const i = text.slice(start + name.length).search(new RegExp(`\\b${esc(other)}\\b`, 'i'));
    if (i >= 0) end = Math.min(end, start + name.length + i);
  }
  return text.slice(start, end);
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

/**
 * ── Wardrobe contract vs Visual Bible ────────────────────────────────────────
 *
 * The wardrobe (`clothingRequirements[name].<category>.description`) and the
 * Visual Bible are two independent descriptions of the same body. Nothing
 * compared them, so a story could carry a THIRD garment in a slot the bible
 * already owns: staging job_1789420511893_zly5rcdej dressed a ship's captain
 * in "a black tricorn hat" while ART002, a navy captain's cap with a gold
 * anchor, was the object the plot turns on and was assigned to nine of her
 * pages. Every page carried both, the clothing review said "no fault" (it only
 * checks garments WITHIN one outfit), and the covers hid it entirely because
 * the cover dedupe suppressed the artifact as a duplicate of the coat.
 *
 * THE CONTRACT OWNS GARMENT WORDING (owner, 2026-09-23). A garment the bible
 * links to a character's slot (`wornAs`) and the outfit already names is the
 * SAME garment: the bible entry takes the contract's words (`adopt`), the
 * contract is never touched and no avatar is re-rendered. The Art Director
 * selects outfits and worn states; it does not reword them.
 *
 * A DIFFERENT garment in an occupied slot (`conflict`) is a NEW OUTFIT VERSION
 * (owner, 2026-09-24): the bible entry is marked `outfitVersion` (the clause it
 * replaces, its own words, the version's full outfit), the default contract is
 * untouched and its avatar is never re-rendered. The page that needs the
 * garment selects the version (wornItems / wardrobeVariants); every other page
 * keeps the default.
 *
 * Deterministic, no API call. Scope is deliberately narrow:
 *   - only headwear / footwear / outer layer — the slots whose items are named
 *     as whole objects. Tops and bottoms collide with every prose noun.
 *   - only an entry ATTRIBUTED to that character: an explicit `wornAs` link, or
 *     two significant tokens of its name inside that character's outfit text
 *     (one is noise — "black" alone attributes nothing).
 *   - only when the wardrobe actually STATES that slot. Silence is not a
 *     contradiction; the bible simply adds the item.
 *   - not when the two name the same garment noun ("tricorn hat" vs "black
 *     tricorn hat" is one hat, described twice).
 */

const { WORN_SLOTS, SLOT_NOUNS, parseWornAs, deriveSlotFromName, slotFromType, indexOfElementAmong, sameName, spliceClause, CLAUSE_LEAD_RE, outfitVersionOf } = require('./wornItems');

// The slots this check arbitrates. See the scope note above.
const ARBITRATED_SLOTS = ['headwear', 'footwear', 'outer layer'];

// VB pools whose entries can be worn on a body.
const WEARABLE_POOLS = ['artifacts', 'clothing'];

/** The outfit description as garment clauses (semicolon shape, comma fallback). */
function outfitClauses(description) {
  const raw = String(description || '').trim();
  if (!raw) return [];
  let parts = raw.split(/\s*;\s*/).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) parts = raw.split(/\s*,\s*/).map(s => s.trim()).filter(Boolean);
  return parts.map(s => s.replace(/\.\s*$/, '').trim()).filter(Boolean);
}

/** Garment nouns of one slot present in a piece of text. */
function slotNounsIn(slot, text) {
  const nouns = SLOT_NOUNS[slot] || [];
  const lower = String(text || '').toLowerCase();
  return nouns.filter(n => new RegExp(`\\b${n}\\b`, 'i').test(lower));
}

/**
 * Which slot a VB entry occupies — DECLARED fields first (2026-09-23): the
 * `wornAs` link's own slot, then the entry's `type` through the one type map
 * (wornItems.slotFromType), and only then its name through the slot nouns.
 * This used to read `type` only when it was literally a slot name and otherwise
 * guess from the name, so a garment typed "outerwear", linked `Max.outer layer`
 * and named "hooded sweatshirt" (no slot noun) had no slot and was never
 * compared at all (staging job_1790100385959_1nitlympp ART005).
 */
function bibleEntrySlot(entry) {
  const link = parseWornAs(entry?.wornAs);
  if (link && link.slotKnown) return link.slot;
  return slotFromType(entry?.type) || deriveSlotFromName(entry?.label || entry?.name);
}

// spliceClause / CLAUSE_LEAD_RE live in wornItems: the page resolver splices an
// outfit version in with the same function that built the version's text.
/** A clause without its joiner and article — what "the same words" compares. */
const clauseBody = (text) => String(text || '').replace(CLAUSE_LEAD_RE, '').trim().toLowerCase();

/** The plain colour words a text names, shades folded (`rust-brown` → brown). */
function colourSet(text) {
  const out = new Set();
  for (const w of String(text || '').toLowerCase().split(/[^a-z]+/)) {
    if (COLOUR_WORDS.has(w)) out.add(w === 'gray' ? 'grey' : w);
  }
  return out;
}

/** Every wearable bible entry, across the pools that can hold one. */
function wearableBibleEntries(visualBible) {
  const out = [];
  for (const pool of WEARABLE_POOLS) {
    for (const entry of (Array.isArray(visualBible?.[pool]) ? visualBible[pool] : [])) {
      if (!entry || !(entry.name || entry.label)) continue;
      const slot = bibleEntrySlot(entry);
      if (!slot || !ARBITRATED_SLOTS.includes(slot)) continue;
      out.push({ entry, slot });
    }
  }
  return out;
}

/**
 * Contradictions between the wardrobe contract and the Visual Bible.
 *
 * @param {Object} clothingRequirements  {Name: {category: {used, description}}}
 * @param {Object} visualBible
 * @returns {Array<{kind, character, category, slot, elementId, elementLabel, elementText, wardrobeClause, contractText?, versionOutfit?, element}>}
 */
function checkWardrobeAgainstBible(clothingRequirements, visualBible) {
  const findings = [];
  if (!clothingRequirements || !visualBible) return findings;
  const wearables = wearableBibleEntries(visualBible);
  if (wearables.length === 0) return findings;

  for (const [character, categories] of Object.entries(clothingRequirements)) {
    for (const [category, entry] of Object.entries(categories || {})) {
      if (!entry || !entry.used || !entry.description) continue;
      const description = String(entry.description);
      const outfitTokens = tokens(description);
      const clauses = outfitClauses(description);

      for (const { entry: el, slot } of wearables) {
        // Already this character's outfit version: settled, not a disagreement.
        // (Its link now names the slot it was marked in; re-checking it would
        // read the version's own garment as an `adopt` of the default clause.)
        const version = outfitVersionOf(el);
        if (version && sameName(version.character, character)) continue;
        const link = parseWornAs(el.wornAs);
        if (link && !sameName(link.owner, character)) continue;      // someone else's item
        const elName = el.label || el.name;
        // Name AND label: the authored label is the short image-facing string
        // ("captain's cap") and carries too few tokens to attribute on its own.
        const elText = `${el.name || ''} ${el.label || ''}`;
        if (!link) {
          const hits = [...tokens(elText)].filter(t => outfitTokens.has(t)).length;
          if (hits < 2) continue;                                     // not this character's
        }
        // A LINKED element's own clause is found by its own declared words
        // (wornItems.indexOfElementAmong over name/label/aliases — never its
        // description, which shares cut words like "long-sleeve" with other
        // garments). That answers "which clause IS this garment" for any
        // wording, including garments no slot noun names ("sweatshirt").
        // Otherwise — no link, or its words do not single a clause out — the
        // clause that OCCUPIES the slot is the one it would displace.
        const own = link
          ? indexOfElementAmong(clauses, { name: el.name, label: el.label, aliases: el.aliases })
          : -1;
        const clause = own >= 0 ? clauses[own] : clauses.find(c => deriveSlotFromName(c) === slot);
        if (!clause) continue;                                        // wardrobe silent — the bible just adds it
        const elNouns = slotNounsIn(slot, elText);
        const clauseNouns = slotNounsIn(slot, clause);
        // Found by its own words is the same garment unless the two name
        // different garment nouns of the slot ("parka" vs "jacket" found by a
        // shared colour) — then it is a different garment.
        const nounsDisagree = elNouns.length > 0 && clauseNouns.length > 0 && !elNouns.some(n => clauseNouns.includes(n));
        const sameGarment = (own >= 0 && !nounsDisagree) || elNouns.some(n => clauseNouns.includes(n));
        const bibleText = String(el.description || elName).trim().replace(/\.\s*$/, '');
        if (sameGarment && !link) continue;                           // the same garment, twice
        if (sameGarment) {
          // `adopt`: the linked entry IS this outfit's garment, so it carries
          // the outfit's words. Already identical → nothing to do.
          const contractText = clause.replace(CLAUSE_LEAD_RE, '').trim();
          if (clauseBody(clause) === clauseBody(bibleText)) continue;
          findings.push({
            kind: 'adopt', character, category, slot,
            elementId: el.id || null, elementLabel: elName, elementText: bibleText,
            wardrobeClause: clause, contractText, element: el,
          });
          continue;
        }
        findings.push({
          kind: 'conflict',
          character,
          category,
          slot,
          elementId: el.id || null,
          elementLabel: elName,
          elementText: bibleText,
          wardrobeClause: clause,
          // The VERSION's outfit: the default with this one clause replaced.
          // Never written back into the contract.
          versionOutfit: spliceClause(description, clause, bibleText),
          element: el,
        });
      }
    }
  }
  return findings;
}

/**
 * Run the check and apply it, in place. Neither kind touches the contract:
 *   - `adopt` rewrites the bible entry to the contract's words;
 *   - `conflict` marks the bible entry as a NEW OUTFIT VERSION of that
 *     character (owner, 2026-09-24): `entry.outfitVersion = {character,
 *     category, slot, replaces, garment, outfit}`, and an entry attributed by
 *     name alone is linked (`wornAs`) to the slot it was found in, so the whole
 *     per-page worn machinery can see it. The page that needs the garment
 *     selects the version (wornItems.resolveWornItemsForPage — a declared row
 *     or an `objects[]` citation); every other page keeps the default. The
 *     version gets its own sheet (wardrobeVariants), the default avatar is
 *     never re-rendered.
 * Loud by construction: every change logs character, slot and both texts.
 *
 * @returns {{findings: Array, applied: Array, versions: Array, unresolved: Array}}
 */
function applyWardrobeBibleCorrections(clothingRequirements, visualBible, opts = {}) {
  const logger = opts.log || log;
  const findings = checkWardrobeAgainstBible(clothingRequirements, visualBible);
  const applied = [];
  const versions = [];
  // An entry adopts once: a character dressed in two categories that word the
  // same garment differently would otherwise flip it back and forth.
  const adopted = new Set();
  const open = () => checkWardrobeAgainstBible(clothingRequirements, visualBible)
    .filter(f => !(f.kind === 'adopt' && adopted.has(f.element)));
  // One change at a time, re-deriving after each: an adopt rewrites the entry
  // a later finding reads, and a version mark takes its entry out of the check.
  for (let pass = 0; pass < findings.length + 1; pass++) {
    const pending = open();
    if (pending.length === 0) break;
    const f = pending[0];
    const el = f.element;
    if (f.kind === 'adopt') {
      adopted.add(el);
      el.description = f.contractText;
      // A short name that states a colour the contract does not is the same
      // disagreement in fewer words; it takes the contract's words too.
      const contractColours = colourSet(f.contractText);
      for (const key of ['name', 'label']) {
        if (el[key] && [...colourSet(el[key])].some(c => !contractColours.has(c))) el[key] = f.contractText;
      }
      applied.push(f);
      logger.warn(`🧥 [WARDROBE-BIBLE] ${f.character}/${f.slot}: ${f.elementId || 'the bible'} "${f.elementLabel}" is declared worn in this slot — its description now carries the contract's words "${f.contractText}" (was "${f.elementText}")`);
      continue;
    }
    // `conflict` → a new outfit version. The element carries it; the contract
    // does not change.
    el.outfitVersion = {
      character: f.character,
      category: f.category,
      slot: f.slot,
      replaces: f.wardrobeClause,
      garment: f.elementText,
      outfit: f.versionOutfit,
    };
    if (!parseWornAs(el.wornAs)) el.wornAs = `${f.character}.${f.slot}`;
    versions.push(f);
    logger.warn(`🧥 [WARDROBE-BIBLE] ${f.character}/${f.slot}: ${f.elementId || 'the bible'} "${f.elementLabel}" is a DIFFERENT garment from the contract's "${f.wardrobeClause}" — a new outfit version (${f.category}); the default outfit is unchanged, and only a page that declares or cites ${f.elementId || 'it'} wears the version`);
  }
  const unresolved = checkWardrobeAgainstBible(clothingRequirements, visualBible);
  for (const f of unresolved) {
    logger.warn(`⚠️ [WARDROBE-BIBLE] ${f.character}/${f.slot}: contract and bible still disagree (${f.elementId || '?'} "${f.elementLabel}" vs "${f.wardrobeClause}") — NOT resolved`);
  }
  return { findings, applied, versions, unresolved };
}

// slotStated + missingGarments are exported so the image-prompt clothing check
// (storyHelpers buildImagePrompt) uses THIS definition of "is this garment in
// the prose" rather than growing a second one.
module.exports = { GARMENT_NOUNS, checkPage, checkWardrobeAgainstBible, applyWardrobeBibleCorrections, outfitClauses, checkScenes, renderFindingsBlock, splitSlots, slotStated, missingGarments, characterProse, characterWindow, tokens, contractPairs, colourBefore };
