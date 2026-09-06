/**
 * Removable worn items — one structured per-page state for every Visual Bible
 * entry that is ALSO part of a character's outfit (`wornAs: "Name.slot"`).
 *
 * The problem this solves (staging job_1788641639919_mpjwlzkf1, ART001
 * "Lily's red woollen hat", worn p1-5 + p14, off p6-13):
 *   - p3 rendered TWO hats: the avatar reference wore it AND the element grid
 *     carried a standalone plate of it, with "match its look" in the prompt.
 *   - p8 prose said it lies on the cobbles while the avatar reference and the
 *     page clothing text both still wore it.
 *   - the scene review was handed the fault on 9 pages and fixed 0 of them,
 *     because the finding asked for a sentence of PROSE and nothing read it.
 *
 * The fix is a structured field, not prose. The Art Director declares
 * `wornItems: [{id, owner, state: "worn"|"off", location}]` in the brief's
 * METADATA; this module is the only thing that reads it, and everything
 * downstream (reference packing, REQUIRED OBJECTS, the clothing text, the
 * mechanical check) branches on the parsed value.
 *
 * NOT the rejected 2026-07-31 / 2026-08-08 `filterWornClothingAgainstScene`.
 * That guard INFERRED the state by sieving prose for phrases that sounded
 * off-body, and deleted whatever clause tripped it — 34% of outfits gutted over
 * 30 stories. Here the state is DECLARED, the item is identified by its VB id,
 * and the only text operation is removing the one outfit clause for the slot
 * the `wornAs` link names. Nothing is inferred from prose.
 */

/** Canonical outfit slots (same vocabulary as clothingCheck's SLOT_LABELS). */
const WORN_SLOTS = ['headwear', 'top', 'bottom', 'footwear', 'belt/waist', 'outer layer', 'accessories'];

/**
 * Garment nouns per slot. Used ONLY to locate the clause of an outfit
 * description that belongs to a slot the `wornAs` link already named — never
 * to decide whether something is clothing, and never to decide a state.
 */
const SLOT_NOUNS = {
  headwear: ['hat', 'cap', 'beanie', 'bonnet', 'hood', 'helmet', 'tricorn', 'headscarf', 'headband', 'crown', 'tiara', 'turban', 'cowl', 'bandana'],
  top: ['shirt', 'blouse', 'top', 'jumper', 'sweater', 'hoodie', 'tunic', 'cardigan', 't-shirt', 'pullover'],
  bottom: ['trousers', 'pants', 'shorts', 'skirt', 'breeches', 'jeans', 'leggings', 'dungarees', 'overalls'],
  footwear: ['boots', 'shoes', 'trainers', 'sneakers', 'sandals', 'loafers', 'plimsolls', 'slippers', 'wellies', 'clogs'],
  'belt/waist': ['belt', 'sash', 'apron'],
  'outer layer': ['coat', 'jacket', 'gilet', 'cloak', 'cape', 'parka', 'anorak', 'blazer', 'waistcoat', 'vest', 'poncho', 'shawl'],
  accessories: ['scarf', 'gloves', 'mittens', 'glasses', 'earrings', 'necklace', 'satchel', 'rucksack', 'backpack'],
};

/** `wornAs: "Lily.headwear"` -> {owner: 'Lily', slot: 'headwear'}; null when malformed. */
function parseWornAs(wornAs) {
  const raw = String(wornAs || '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const owner = raw.slice(0, dot).trim();
  const slot = raw.slice(dot + 1).trim().toLowerCase();
  if (!owner || !slot) return null;
  return { owner, slot };
}

const sameName = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();

/**
 * Normalise the brief's declared `wornItems[]`. Rows without a usable id are
 * dropped; a row with an unrecognised state keeps `state: null` so the
 * mechanical check sees it as undeclared rather than silently guessing.
 */
function parseWornItems(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  const seen = new Set();
  for (const row of raw) {
    if (!row || typeof row !== 'object') continue;
    const id = String(row.id || '').trim().toUpperCase();
    if (!/^[A-Z]{2,4}\d+$/.test(id) || seen.has(id)) continue;
    seen.add(id);
    const stateRaw = String(row.state || '').trim().toLowerCase();
    const state = (stateRaw === 'worn' || stateRaw === 'off') ? stateRaw : null;
    const location = String(row.location || '').trim();
    out.push({ id, owner: String(row.owner || '').trim(), state, location: location || null });
  }
  return out;
}

/** The declared wornItems of a page, from scene metadata (parsed or raw). */
function wornItemsFromMetadata(sceneMetadata) {
  if (!sceneMetadata) return [];
  if (Array.isArray(sceneMetadata.wornItems)) return parseWornItems(sceneMetadata.wornItems);
  if (Array.isArray(sceneMetadata.fullData && sceneMetadata.fullData.wornItems)) {
    return parseWornItems(sceneMetadata.fullData.wornItems);
  }
  return [];
}

/** Every VB entry carrying a `wornAs` link, across the pools that can hold one. */
function wornAsEntries(visualBible) {
  const out = [];
  for (const pool of ['artifacts', 'clothing', 'vehicles']) {
    const list = Array.isArray(visualBible && visualBible[pool]) ? visualBible[pool] : [];
    for (const entry of list) {
      const link = parseWornAs(entry && entry.wornAs);
      if (!link || !entry || !entry.id) continue;
      out.push({ entry, id: String(entry.id).toUpperCase(), name: entry.name || entry.id, owner: link.owner, slot: link.slot, pool });
    }
  }
  return out;
}

/**
 * Per-page worn state for every wornAs item whose OWNER is in the page cast.
 *
 * `state` is always one of 'worn' | 'off'. When the brief declared nothing (or
 * declared an off state with no location) the entry is marked `missing` — the
 * mechanical check reports it, the review gets one fed-back retry, and if it
 * still comes back undeclared the state DEFAULTS TO 'worn', because the avatar
 * reference wears the full outfit (decisions.md 2026-09-06).
 */
function resolveWornItemsForPage(visualBible, cast, sceneMetadata) {
  const castNames = (Array.isArray(cast) ? cast : [])
    .map(c => (typeof c === 'string' ? c : c && c.name))
    .filter(Boolean);
  const declared = new Map(wornItemsFromMetadata(sceneMetadata).map(w => [w.id, w]));
  const out = [];
  for (const item of wornAsEntries(visualBible)) {
    if (!castNames.some(n => sameName(n, item.owner))) continue;
    const d = declared.get(item.id) || null;
    const stateDeclared = d && d.state ? d.state : null;
    const location = (d && d.location) || null;
    const missing = !stateDeclared || (stateDeclared === 'off' && !location);
    out.push({
      id: item.id,
      name: item.name,
      owner: item.owner,
      slot: item.slot,
      entry: item.entry,
      state: stateDeclared || 'worn',
      location,
      declared: !!stateDeclared,
      defaulted: !stateDeclared,
      missing,
    });
  }
  return out;
}

/** Map id -> resolved entry, for the O(1) lookups the packing/prompt paths want. */
function wornStateById(resolved) {
  const m = new Map();
  for (const r of (resolved || [])) m.set(String(r.id).toUpperCase(), r);
  return m;
}

/**
 * The explicit two-direction instruction the owner asked for (2026-09-06):
 * "we need a hat but the avatar has none; we do not need a hat but the avatar
 * has one" — the reference image is not authoritative for a removable item, so
 * the prompt says which way to go in words the model cannot read past.
 */
function buildWornStateLines(resolved) {
  const lines = [];
  for (const r of (resolved || [])) {
    const item = String(r.name || '').trim();
    if (!item) continue;
    // The item NAME sits at the end of its own clause on purpose: every VB name
    // in a prompt is substituted for an English description-derived ref by
    // sanitizeVbIdsInPrompt, and that ref can end mid-phrase. At a clause
    // boundary a ragged ref costs nothing; mid-sentence it garbles the
    // instruction this block exists to deliver.
    if (r.state === 'off') {
      const where = r.location ? ` — ${r.location}.` : ' — it is elsewhere in the scene.';
      lines.push(`- ${r.owner} is NOT wearing this on this page: ${item}. Leave it off ${r.owner} even if the attached reference shows it worn${where}`);
    } else {
      lines.push(`- ${r.owner} IS wearing this on this page: ${item}. Draw it on ${r.owner} even if the attached reference shows ${r.owner} without it.`);
    }
  }
  return lines;
}

/** Rendered block for the image prompt, or '' when the page has no worn items. */
function buildWornStateBlock(resolved) {
  const lines = buildWornStateLines(resolved);
  if (lines.length === 0) return '';
  return `\n**WORN ITEMS ON THIS PAGE (the attached references are not authoritative for these):**\n${lines.join('\n')}\n`;
}

/** Split an outfit description into top-level clauses. */
function splitClauses(description) {
  return String(description || '')
    .split(/,(?![^()]*\))/)
    .map(s => s.trim())
    .filter(Boolean);
}

/**
 * Remove exactly the clause of an outfit description that belongs to `slot`.
 *
 * Two routes, both keyed on the STRUCTURED slot the `wornAs` link gave us:
 *   1. slot-labelled contracts ("headwear: a red woollen hat; top: …") — drop
 *      the labelled part. Unambiguous.
 *   2. plain-sentence contracts (the ordinary standard/summer/winter shape) —
 *      drop the ONE clause containing a noun from that slot's closed
 *      vocabulary. If zero or more than one clause matches, nothing is removed
 *      and the reason is returned: a wrong deletion is far worse than a
 *      redundant mention, and the explicit "is NOT wearing" prompt line still
 *      carries the instruction.
 *
 * Never removes more than one clause. That bound is what separates it from the
 * rejected 2026-08-08 filter, which sieved EVERY clause against prose.
 */
function removeWornItemFromOutfit(description, slot) {
  const raw = String(description || '').trim();
  const key = String(slot || '').trim().toLowerCase();
  if (!raw || !key) return { text: raw, removed: false, reason: 'no-input' };

  // Route 1: slot-labelled contract.
  const labelRe = new RegExp(`(?:^|[;,])\\s*(${WORN_SLOTS.map(l => l.replace('/', '\\/')).join('|')})\\s*:`, 'gi');
  const marks = [];
  let m;
  while ((m = labelRe.exec(raw)) !== null) marks.push({ slot: m[1].toLowerCase(), at: m.index, end: labelRe.lastIndex });
  if (marks.length > 0) {
    const hit = marks.findIndex(x => x.slot === key);
    if (hit === -1) return { text: raw, removed: false, reason: 'slot-not-in-contract' };
    const parts = marks.map((mark, i) => ({
      slot: mark.slot,
      text: raw.slice(mark.end, i + 1 < marks.length ? marks[i + 1].at : raw.length).replace(/[;,.\s]+$/, '').trim(),
    }));
    const kept = parts.filter((_, i) => i !== hit).filter(p => p.text);
    if (kept.length === 0) return { text: raw, removed: false, reason: 'would-empty-outfit' };
    return { text: kept.map(p => `${p.slot}: ${p.text}`).join('; '), removed: true, reason: 'labelled-slot' };
  }

  // Route 2: plain sentence — exactly one clause must own the slot.
  const nouns = SLOT_NOUNS[key];
  if (!nouns) return { text: raw, removed: false, reason: 'unknown-slot' };
  const clauses = splitClauses(raw);
  if (clauses.length < 2) return { text: raw, removed: false, reason: 'single-clause-outfit' };
  const nounRe = new RegExp(`\\b(?:${nouns.join('|')})\\b`, 'i');
  const hits = clauses.map((c, i) => (nounRe.test(c) ? i : -1)).filter(i => i >= 0);
  if (hits.length !== 1) {
    return { text: raw, removed: false, reason: hits.length === 0 ? 'slot-clause-not-found' : 'slot-clause-ambiguous' };
  }
  const kept = clauses.filter((_, i) => i !== hits[0]);
  let text = kept.join(', ').replace(/^\s*and\s+/i, '').trim();
  // Restore sentence shape: the dropped clause may have carried the capital.
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (/[.!?]$/.test(raw) && !/[.!?]$/.test(text)) text += '.';
  return { text, removed: true, reason: 'slot-clause' };
}

/**
 * Apply every OFF item to one character's outfit text. Returns the text
 * unchanged when nothing is off or nothing could be removed structurally.
 */
function stripOffItemsFromOutfit(description, resolved, characterName) {
  let text = String(description || '');
  const removals = [];
  for (const r of (resolved || [])) {
    if (r.state !== 'off') continue;
    if (!sameName(r.owner, characterName)) continue;
    const res = removeWornItemFromOutfit(text, r.slot);
    removals.push({ id: r.id, slot: r.slot, removed: res.removed, reason: res.reason });
    if (res.removed) text = res.text;
  }
  return { text, removals };
}

module.exports = {
  WORN_SLOTS,
  SLOT_NOUNS,
  parseWornAs,
  parseWornItems,
  wornItemsFromMetadata,
  wornAsEntries,
  resolveWornItemsForPage,
  wornStateById,
  buildWornStateLines,
  buildWornStateBlock,
  removeWornItemFromOutfit,
  stripOffItemsFromOutfit,
  sameName,
};
