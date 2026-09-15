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

const { log } = require('../utils/logger');

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
    // `wearer` (2026-09-15) — who carries the item ON THIS PAGE. Absent on every
    // row written before the field existed, and then the wearer is the owner.
    const wearer = String(row.wearer || '').trim();
    out.push({ id, owner: String(row.owner || '').trim(), state, location: location || null, wearer: wearer || null });
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

/** Look one VB id up across the pools that can hold a worn element. */
function findVbEntryById(visualBible, id) {
  const want = String(id || '').trim().toUpperCase();
  if (!want) return null;
  for (const pool of ['artifacts', 'clothing', 'vehicles']) {
    const list = Array.isArray(visualBible && visualBible[pool]) ? visualBible[pool] : [];
    for (const entry of list) {
      if (entry && String(entry.id || '').trim().toUpperCase() === want) return { entry, pool };
    }
  }
  return null;
}

/**
 * Which outfit slot a VB element belongs to, from its own NAME.
 *
 * Read the SLOT_NOUNS caveat above: this never decides whether something is
 * clothing and never decides a state — the Art Director has already DECLARED
 * this id as a worn item of a named owner, and the only open question is which
 * clause of that owner's outfit text the declaration is about. When the name
 * matches nouns from more than one slot, or from none, the answer is null and
 * the caller must treat the item as unmappable rather than guess.
 *
 * The NAME only, never the description: a description ("a scarf-sized square of
 * cloth she ties over her hair") can carry nouns from slots the item is not in.
 */
function deriveSlotFromName(name) {
  const text = String(name || '');
  if (!text.trim()) return null;
  const hits = WORN_SLOTS.filter((slot) => {
    const nouns = SLOT_NOUNS[slot];
    return nouns && new RegExp(`\\b(?:${nouns.join('|')})\\b`, 'i').test(text);
  });
  return hits.length === 1 ? hits[0] : null;
}

/**
 * VB `type` values that ARE an outfit slot. The Art Director types an element
 * freely ("headwear", "boots", "outerwear"), so this maps the ones that can
 * only be a worn garment onto the canonical slot vocabulary. A type that could
 * be anything ("clothing", "garment", "prop") maps to nothing.
 */
const TYPE_SLOTS = {
  headwear: 'headwear', hat: 'headwear', cap: 'headwear', headgear: 'headwear', helmet: 'headwear',
  footwear: 'footwear', shoes: 'footwear', boots: 'footwear',
  outerwear: 'outer layer', 'outer layer': 'outer layer', coat: 'outer layer', cloak: 'outer layer', cape: 'outer layer',
  top: 'top', shirt: 'top',
  bottom: 'bottom', trousers: 'bottom', skirt: 'bottom',
  belt: 'belt/waist', 'belt/waist': 'belt/waist', sash: 'belt/waist',
  accessory: 'accessories', accessories: 'accessories', scarf: 'accessories', gloves: 'accessories',
};

/** The outfit slot a VB element's own `type` declares, or null. */
function slotFromType(type) {
  const t = String(type || '').trim().toLowerCase();
  if (!t) return null;
  if (TYPE_SLOTS[t]) return TYPE_SLOTS[t];
  return WORN_SLOTS.includes(t) ? t : null;
}

/**
 * Elements that are CLEARLY worn but carry no `wornAs` link — GAP 1.
 *
 * The whole removable-item path hangs off the writer emitting `wornAs`, and
 * measured over 59 staging stories only 9 of 482 clothing/artifact/vehicle
 * entries carried one. On staging job_1789420511893_zly5rcdej neither hat had
 * it, so the off-state guard was inert for the story it was built for: the cap
 * the plot hands from one character to another was `type: "headwear"` and
 * linked to nobody.
 *
 * Two deterministic triggers, no prose inference:
 *   'type'   — the element's own `type` IS an outfit slot.
 *   'outfit' — exactly one character's outfit text names the same garment,
 *              through the closed SLOT_NOUNS vocabulary of a slot the element's
 *              NAME also lands in.
 * `owner` is filled only by the second trigger, which actually identifies one.
 */
function unlinkedWornCandidates(visualBible, outfitTexts = new Map()) {
  const out = [];
  for (const pool of ['artifacts', 'clothing', 'vehicles']) {
    const list = Array.isArray(visualBible && visualBible[pool]) ? visualBible[pool] : [];
    for (const entry of list) {
      if (!entry || !entry.id || parseWornAs(entry.wornAs)) continue;
      const nameSlot = deriveSlotFromName(entry.name || '');
      const typeSlot = slotFromType(entry.type);
      const slot = typeSlot || nameSlot;
      if (!slot) continue;
      // Which characters' outfits name this same garment, by the element's own
      // name — the same closed vocabulary, never free prose.
      let owner = null;
      if (nameSlot) {
        const nouns = (SLOT_NOUNS[nameSlot] || []).filter(n => new RegExp(`\\b${n}\\b`, 'i').test(String(entry.name || '')));
        if (nouns.length > 0) {
          const re = new RegExp(`\\b(?:${nouns.join('|')})\\b`, 'i');
          const hits = [...outfitTexts.entries()].filter(([, text]) => re.test(String(text || ''))).map(([n]) => n);
          if (hits.length === 1) [owner] = hits;
        }
      }
      if (!typeSlot && !owner) continue;
      out.push({
        id: String(entry.id).toUpperCase(),
        name: entry.name || entry.id,
        pool,
        slot,
        owner,
        pages: Array.isArray(entry.appearsInPages) ? entry.appearsInPages : null,
        reason: owner ? 'outfit' : 'type',
      });
    }
  }
  return out;
}

/**
 * Who wears the item on this page — and what an OFF-CAST wearer means.
 *
 * A `wearer` naming somebody who is not in this page's cast used to fall back
 * to the OWNER, silently: introduced with the handover field on 2026-09-15 and
 * caught the same night. The fallback ASSERTS the defect it was written to
 * prevent — on a page where a correct row said `{ART001, owner: Emma, wearer:
 * Kilian, state: worn}` and Kilian is off-page, the built clause reads "Emma IS
 * wearing… black tricorn hat", which is precisely the hat the page must not
 * draw on her.
 *
 * What the row actually MEANS is that the item is off its owner and in someone
 * else's hands, off-page. That is `state: "off"` with the wearer as the place —
 * the same shape the Art Director would have written by hand — so it is coerced
 * to exactly that, loudly. Never silent: the coercion changes what the page
 * draws.
 *
 * @returns {{wearer: string, state: string|null, location: string|null}}
 */
function resolveWearer({ id, owner, declaredWearer, state, location, castNames, pageLabel }) {
  const wearer = String(declaredWearer || '').trim();
  if (!wearer || sameName(wearer, owner)) return { wearer: owner, state, location };
  if (castNames.some(n => sameName(n, wearer))) return { wearer, state, location };
  const place = location || `held by ${wearer}, who is not in this page's cast`;
  log.error(`[WORN] Page ${pageLabel}: ${id} names wearer "${wearer}", who is not in this page's cast `
    + `(${castNames.join(', ') || 'no cast'}) — read as OFF ${owner}, ${place}. `
    + 'It is NOT put back on the owner: that would draw the very item the row takes off them.');
  return { wearer: owner, state: 'off', location: place };
}

/**
 * Per-page worn state for every worn element whose OWNER is in the page cast.
 *
 * TWO sources, and the second is why e403345b1 was inert in practice
 * (staging job_1789348171785_9oxos7dwv, CLO001 "red zip-up hoodie", declared
 * `off` on six pages and stripped from nothing):
 *
 *  1. `wornAsEntries` — VB entries the STORY WRITER linked with `wornAs`. Only
 *     these are enumerated by default, so an undeclared one defaults to 'worn'
 *     and is reported `missing` by the mechanical check (decisions.md
 *     2026-09-06). That default must stay keyed on the writer's link: it is the
 *     writer that promised the item is part of an outfit on every page.
 *
 *  2. Rows the ART DIRECTOR declared in the brief's `wornItems[]` that point at
 *     a VB id with NO `wornAs` link. The writer emits `wornAs` only for one
 *     narrow documented exception — a prop the plot turns into costume — which
 *     measured 9 of 482 clothing/artifact/vehicle entries over 59 staging
 *     stories, and NEVER on a `clothing`-pool entry (0 of 6; that pool carries
 *     `wornBy` + `howWorn` and has no slot field at all). The Art Director, by
 *     contrast, declares a row for anything it sees worn: 32 of 51 declared
 *     rows over those stories pointed at an unlinked id, 12 of them `off`. Each
 *     of those silently stripped nothing — the generator kept drawing the
 *     garment and every judge kept demanding it.
 *
 *     A declared row is itself authoritative: it names the id AND the owner.
 *     What it does not name is the outfit SLOT, which is derived from the VB
 *     entry's own name through the closed SLOT_NOUNS vocabulary. When no single
 *     slot can be derived the item is UNMAPPABLE — it is left out and, if the
 *     row declared it `off`, logged as an error. Silence here is what made this
 *     bug invisible for a day.
 *
 * `state` is always one of 'worn' | 'off'. Source-2 items are never `missing`:
 * they were declared, and the `removal_unstated` check's scope stays exactly
 * the writer-linked set it has always been.
 */
function resolveWornItemsForPage(visualBible, cast, sceneMetadata, options = {}) {
  const castNames = (Array.isArray(cast) ? cast : [])
    .map(c => (typeof c === 'string' ? c : c && c.name))
    .filter(Boolean);
  const declared = new Map(wornItemsFromMetadata(sceneMetadata).map(w => [w.id, w]));
  const pageLabel = options.pageNumber
    ?? (sceneMetadata && (sceneMetadata.pageNumber ?? (sceneMetadata.fullData && sceneMetadata.fullData.pageNumber)))
    ?? '?';
  const out = [];
  const linked = new Set();
  for (const item of wornAsEntries(visualBible)) {
    linked.add(item.id);
    if (!castNames.some(n => sameName(n, item.owner))) continue;
    const d = declared.get(item.id) || null;
    const stateDeclared = d && d.state ? d.state : null;
    const location = (d && d.location) || null;
    // HANDOVER (2026-09-15). `wornAs` names the item's HOME — one owner, one
    // slot — and that is all it ever named. Who wears it on THIS page is the
    // per-page row's business: `wearer`. A row naming a wearer who is on the
    // page and is not the owner means the item changed hands; the owner is then
    // without it (their outfit text loses the clause, their reference is not
    // authoritative) and the wearer carries it.
    // An off-cast wearer is not a handover and is never the owner — see
    // resolveWearer; the row is read as OFF, with that wearer as the place.
    const w = resolveWearer({
      id: item.id, owner: item.owner, declaredWearer: (d && d.wearer) || null,
      state: stateDeclared || 'worn', location, castNames, pageLabel,
    });
    const wearer = w.wearer;
    const handedOver = !sameName(wearer, item.owner);
    const state = w.state;
    // An `off` with no place is still unstated — except when the row named a
    // wearer, which IS the place.
    const missing = !stateDeclared || (state === 'off' && !w.location && !handedOver);
    out.push({
      id: item.id,
      name: item.name,
      owner: item.owner,
      wearer,
      handedOver,
      // The writer LINKED this item to an outfit (`wornAs`), so the owner's
      // avatar reference demonstrably carries it — see referenceCarriesItem.
      wornAsLinked: true,
      slot: item.slot,
      entry: item.entry,
      state,
      location: w.location,
      declared: !!stateDeclared,
      defaulted: !stateDeclared,
      missing,
    });
  }

  // Source 2 — declared rows with no writer link.
  for (const d of declared.values()) {
    if (linked.has(d.id) || !d.state) continue;
    const found = findVbEntryById(visualBible, d.id);
    const entry = found ? found.entry : null;
    const owner = String((entry && entry.wornBy) || d.owner || '').trim();
    const slot = entry ? deriveSlotFromName(entry.name || entry.id) : null;
    if (!entry || !owner || !slot) {
      // Loud, and only for the state that silently changes nothing downstream:
      // an `off` the resolver cannot map leaves the garment in the generator's
      // outfit text AND in every judge's clothing contract. Never kills the run
      // (gates are guidelines) — the page renders, the fault is on the record.
      if (d.state === 'off') {
        const why = !entry
          ? 'no Visual Bible element carries that id'
          : (!owner ? 'the element names no wearer and the row names no owner'
            : `no single outfit slot can be derived from its name "${entry.name || entry.id}"`);
        log.error(`[WORN] Page ${pageLabel}: ${d.id} is declared "off" but cannot be mapped to an outfit — ${why}. `
          + `Nothing is stripped: the image model is still told to draw it and every clothing judge still demands it.`);
      }
      continue;
    }
    if (!castNames.some(n => sameName(n, owner))) continue;
    const w2 = resolveWearer({
      id: d.id, owner, declaredWearer: d.wearer || null,
      state: d.state, location: d.location || null, castNames, pageLabel,
    });
    out.push({
      id: d.id,
      name: entry.name || entry.id,
      owner,
      wearer: w2.wearer,
      handedOver: !sameName(w2.wearer, owner),
      // NO `wornAs` link: nothing promises this item is part of the wearer's
      // wardrobe, so no attached reference shows it on them.
      wornAsLinked: false,
      slot,
      entry,
      state: w2.state,
      location: w2.location,
      declared: true,
      defaulted: false,
      // Declared rows are outside the writer-linked set the `removal_unstated`
      // check governs; flagging them would invent findings on a path that has
      // never produced one.
      missing: false,
    });
  }
  return out;
}

/**
 * Does a reference already attached to this page's call show the item ON its
 * wearer? Everything that used to test `!handedOver` asks THIS instead.
 *
 * `wornAs` is the item's HOME — one owner, one outfit slot — and it is the only
 * promise anywhere in the pipeline that a character's avatar/outfit reference
 * carries the item. Two things break that promise:
 *   - a HANDOVER: the wearer is not the owner, so the owner's reference is the
 *     wrong body and the wearer's reference does not have the item at all;
 *   - NO LINK AT ALL: a row the Art Director declared against a bare Visual
 *     Bible element. The item is in nobody's wardrobe contract, so the wearer's
 *     reference shows whatever their outfit actually says.
 *
 * Measured on staging job_1789420511893_zly5rcdej: ART002, a navy captain's cap
 * the plot has the child FIND, was declared `{id: ART002, owner: Emma, state:
 * worn}` on nine pages and carried no `wornAs` link. The old `!handedOver` test
 * read that as "her avatar already wears it", dropped the rendered ART002 plate
 * from all nine pages and omitted the item from REQUIRED OBJECTS — while Emma's
 * outfit text and her attached cell both still showed her OWN black tricorn.
 * The call then held one text line naming a cap and one picture of a tricorn,
 * and pages 13 and 14 rendered a navy TRICORN: the cap's colour and gold anchor
 * from the words, the silhouette from the picture.
 *
 * The drop stays exactly where its precedent put it (job_1788641639919 p3, two
 * red hats on one page): a LINKED item on its OWN owner, whose avatar wears it.
 */
function referenceCarriesItem(r) {
  return !!(r && r.wornAsLinked && !r.handedOver);
}

/**
 * Is this item OFF the named character on this page?
 *
 * Two ways, and the second is the handover: state `off` takes it off everyone,
 * and a `worn` state whose wearer is someone else takes it off its owner. The
 * owner's outfit text and reference must lose it in both cases.
 */
function isOffForCharacter(r, name) {
  if (!r || !name) return false;
  if (r.state === 'off') return sameName(r.owner, name) || sameName(r.wearer || r.owner, name);
  return sameName(r.owner, name) && !sameName(r.wearer || r.owner, name);
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
/**
 * The bible's own description of a worn item, appended to its NAME in the worn
 * clause (2026-09-15).
 *
 * The clause used to carry the name alone — "navy-blue captain's cap" — while
 * the bible held "stiff black visor, flat crown, gold anchor emblem". A name is
 * a label, and a label loses a silhouette fight against an attached picture:
 * on staging job_1789420511893_zly5rcdej p13/p14 the words said cap, the
 * attached cell showed the child's own tricorn, and the render took the colour
 * and the anchor from the words and the SHAPE from the picture. The
 * construction detail is the half that was missing.
 *
 * First sentence only, capped — this is a rider on an instruction line, not a
 * second REQUIRED OBJECTS block.
 */
function wornItemLook(r) {
  const entry = r && r.entry;
  const raw = String((entry && (entry.extractedDescription || entry.description)) || '').trim();
  if (!raw) return '';
  const first = (raw.split(/(?<=[.!?])\s+/)[0] || raw).trim().replace(/[.\s]+$/, '');
  if (!first) return '';
  const capped = first.length > 220 ? `${first.slice(0, 217).trim()}…` : first;
  // Never repeat the name back at itself when the description IS the name.
  return sameName(capped, r.name) ? '' : capped;
}

function buildWornStateLines(resolved) {
  const lines = [];
  for (const r of (resolved || [])) {
    const name = String(r.name || '').trim();
    if (!name) continue;
    const look = wornItemLook(r);
    const item = look ? `${name} — ${look}` : name;
    // The item NAME sits at the end of its own clause on purpose: every VB name
    // in a prompt is substituted for an English description-derived ref by
    // sanitizeVbIdsInPrompt, and that ref can end mid-phrase. At a clause
    // boundary a ragged ref costs nothing; mid-sentence it garbles the
    // instruction this block exists to deliver.
    if (r.state === 'off') {
      const where = r.location ? ` — ${r.location}.` : ' — it is elsewhere in the scene.';
      lines.push(`- ${r.owner} is NOT wearing this on this page: ${item}. Leave it off ${r.owner} even if the attached reference shows it worn${where}`);
    } else if (r.handedOver) {
      // The item is on the page, on the other character. Both halves are said
      // in one clause: nobody but the wearer carries it.
      lines.push(`- ${r.wearer} IS wearing this on this page, and ${r.owner} is NOT: ${item}. `
        + `Draw it on ${r.wearer} only, and leave it off ${r.owner} even if the attached references show the opposite.`);
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

/**
 * Split an outfit description into top-level clauses.
 *
 * SEMICOLONS COUNT (2026-09-15). The stored contracts the outline writes are
 * semicolon-delimited — "A black felt tricorn hat with a red cockade; a red
 * long-sleeved cotton pirate shirt; …" is the real Emma contract of staging
 * job_1789420511893_zly5rcdej. Splitting on commas alone read that whole
 * six-garment outfit as ONE clause, so Route 2 bailed out with
 * `single-clause-outfit` and nothing was ever stripped from a semicolon
 * contract — the shape the current writer emits for every costumed character.
 */
function splitClauses(description) {
  return String(description || '')
    .split(/[;,](?![^()]*\))/)
    .map(s => s.trim())
    .filter(Boolean);
}

/** Every garment noun in the closed vocabulary, across all slots. */
const ALL_GARMENT_NOUNS = [...new Set(Object.values(SLOT_NOUNS).flat())];

/** The layering connectives an outfit sentence uses to stack two garments. */
const LAYER_SPLIT_RE = /\s*\b(?:worn\s+(?:over|under|beneath|underneath)|layered\s+over|on\s+top\s+of|over|under|beneath|underneath)\b\s*/i;

const garmentNounsIn = (text, vocab) =>
  vocab.filter(n => new RegExp(`\\b${n}\\b`, 'i').test(String(text || '')));

/**
 * How many distinct garments a phrase names — SPANS, not vocabulary hits. The
 * vocabulary overlaps itself ("shirt" sits inside "t-shirt", "hood" inside
 * "hoodie"), so counting matched nouns reads one garment as two and every
 * clause looks layered.
 */
function countGarments(text) {
  const src = String(text || '');
  const re = new RegExp(`\\b(?:${ALL_GARMENT_NOUNS.join('|')})\\b`, 'gi');
  const spans = [];
  let m;
  while ((m = re.exec(src)) !== null) {
    const start = m.index;
    const end = start + m[0].length;
    const prev = spans[spans.length - 1];
    if (prev && start < prev.end) prev.end = Math.max(prev.end, end);
    else if (prev && adjacentSlotNounPair(src, prev, { start, end })) prev.end = end;
    else spans.push({ start, end });
  }
  return spans.length;
}

/**
 * Two vocabulary hits that are ONE garment: a garment word qualified by its own
 * slot noun — "tricorn hat", "cap … " in "captain's cap", "knee-high boots".
 *
 * Measured on staging job_1789420511893_zly5rcdej: the Emma contract opens with
 * "A black felt tricorn hat with a red cockade". "tricorn" and "hat" are both
 * headwear nouns, so the counter read two garments, found no layering
 * connective between them, and refused the strip with
 * `slot-clause-carries-another-garment` — on a clause that names exactly one
 * hat.
 *
 * Deliberately narrow, because this counter is the guard that stops a strip
 * from taking a second real garment out of a shared clause: the two hits must
 * be separated by nothing but whitespace, a hyphen or a possessive, AND both
 * must belong to one and the same slot. "a hoodie worn over a pullover" and
 * "a red shirt and black trousers" keep counting as two, and stay refused.
 */
function adjacentSlotNounPair(src, prev, next) {
  const gap = src.slice(prev.end, next.start);
  if (!/^[\s\-]*(?:'s[\s\-]*)?$/.test(gap)) return false;
  const a = src.slice(prev.start, prev.end);
  const b = src.slice(next.start, next.end);
  return WORN_SLOTS.some((slot) => {
    const nouns = SLOT_NOUNS[slot] || [];
    const has = (w) => nouns.some(n => n.toLowerCase() === w.toLowerCase());
    return has(a) && has(b);
  });
}

/**
 * What is left of ONE outfit clause once the declared item is taken out of it.
 *
 * Three answers, and the third is the one that keeps this bounded:
 *   `null`  — the clause is only about this item; drop the whole clause.
 *   string  — the clause layered this item over another garment; this is the
 *             other garment's half, and it stays in the outfit.
 *   `false` — the clause names another garment but no connective separates
 *             them, so no part of it can be removed without taking a garment
 *             the page never declared off. Nothing is removed; the explicit
 *             "is NOT wearing" prompt line still carries the instruction.
 *
 * `slotNouns` identifies the declared item when the element name is unknown.
 */
function clauseRemainderWithoutItem(clause, slotNouns, itemName) {
  if (countGarments(clause) <= 1) return null;
  const itemNouns = (itemName ? garmentNounsIn(itemName, slotNouns) : []);
  const mine = itemNouns.length > 0 ? itemNouns : garmentNounsIn(clause, slotNouns);
  if (mine.length === 0) return false;
  const mineRe = new RegExp(`\\b(?:${mine.join('|')})\\b`, 'i');
  const parts = String(clause).split(LAYER_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  if (parts.length < 2) return false;
  const dropped = parts.filter(p => mineRe.test(p));
  const keptParts = parts.filter(p => !mineRe.test(p));
  // Every part must land on exactly one side, and something must survive.
  if (dropped.length === 0 || keptParts.length === 0) return false;
  // A surviving part with no garment noun is a fragment, not a garment.
  if (!keptParts.every(p => countGarments(p) > 0)) return false;
  return keptParts.join(', ');
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
function removeWornItemFromOutfit(description, slot, itemName = null) {
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
  let hits = clauses.map((c, i) => (nounRe.test(c) ? i : -1)).filter(i => i >= 0);
  // A slot can hold two garments at once — a hoodie over a t-shirt, a cape over
  // a jacket — and then the slot alone cannot say which clause the declaration
  // is about. The ELEMENT'S OWN NAME can. Narrow by the garment nouns the name
  // itself carries, drawn from the same closed vocabulary; nothing is inferred
  // from prose and the one-clause bound below still holds.
  if (hits.length > 1 && itemName) {
    const nameNouns = nouns.filter(n => new RegExp(`\\b${n}\\b`, 'i').test(String(itemName)));
    if (nameNouns.length > 0) {
      const nameRe = new RegExp(`\\b(?:${nameNouns.join('|')})\\b`, 'i');
      const narrowed = hits.filter(i => nameRe.test(clauses[i]));
      if (narrowed.length === 1) hits = narrowed;
    }
  }
  if (hits.length !== 1) {
    return { text: raw, removed: false, reason: hits.length === 0 ? 'slot-clause-not-found' : 'slot-clause-ambiguous' };
  }
  // A layered clause names TWO garments at once ("a hoodie worn over a
  // pullover"), and dropping the whole clause takes the undeclared one with it
  // — measured on staging job_1789348171785_9oxos7dwv p9/p13/p14, where a
  // whole-clause drop left the character with no top at all. Split the clause
  // on its layering connective and keep the part the declaration is NOT about.
  const survivor = clauseRemainderWithoutItem(clauses[hits[0]], nouns, itemName);
  if (survivor === false) {
    return { text: raw, removed: false, reason: 'slot-clause-carries-another-garment' };
  }
  const kept = clauses.map((c, i) => (i === hits[0] ? survivor : c)).filter(c => c !== null && c !== '');
  if (kept.length === 0) return { text: raw, removed: false, reason: 'would-empty-outfit' };
  // Rejoin with the delimiter the contract itself used: a semicolon contract
  // that comes back comma-joined is a different string from the one every other
  // reader holds, and item 3 compares those strings.
  const joiner = /;(?![^()]*\))/.test(raw) ? '; ' : ', ';
  let text = kept.join(joiner).replace(/^\s*and\s+/i, '').trim();
  // Restore sentence shape: the dropped clause may have carried the capital.
  text = text.charAt(0).toUpperCase() + text.slice(1);
  if (/[.!?]$/.test(raw) && !/[.!?]$/.test(text)) text += '.';
  return { text, removed: true, reason: survivor === null ? 'slot-clause' : 'slot-clause-layer' };
}

/**
 * Apply every OFF item to one character's outfit text. Returns the text
 * unchanged when nothing is off or nothing could be removed structurally.
 */
function stripOffItemsFromOutfit(description, resolved, characterName) {
  let text = String(description || '');
  const removals = [];
  for (const r of (resolved || [])) {
    if (!isOffForCharacter(r, characterName)) continue;
    const res = removeWornItemFromOutfit(text, r.slot, r.name);
    removals.push({ id: r.id, slot: r.slot, removed: res.removed, reason: res.reason });
    if (res.removed) text = res.text;
  }
  return { text, removals };
}

/**
 * THE OUTFIT THIS PAGE WAS ACTUALLY GENERATED AGAINST — one resolver for every
 * eval-side clothing contract.
 *
 * The generator already strips a page's OFF items out of the outfit text it
 * sends to the image model (promptBuilders.buildImagePrompt → a LOCAL
 * `effectiveReferencePhotos` copy). Nothing persisted that stripped copy, so
 * every judge kept receiving the story-level outfit and scored the render
 * against a garment the brief had deliberately removed. Measured on staging
 * job_1789207854566_l43qgl34w p12 (ART008 Sarah `off` "lost in the dark
 * shaft", ART009 Facundo `off`): two MAJOR findings — "missing red sash / add
 * red sash at waist" and the orange-sash equivalent — survived the
 * consolidator and rode into `imageVersions[1]` = `iterate-round-1`, a PAID
 * repair round ordering the pipeline to repaint both sashes. p10 same shape.
 *
 * So the eval side RECOMPUTES the same strip from the page's declared
 * `wornItems[]` + the story outfit, through the same `stripOffItemsFromOutfit`
 * the generator uses — no new prompt channel, no new field plumbed through the
 * pipeline, no second implementation that can drift. Same shape as
 * sceneMetadata.resolveEvalSceneHint (3b3070dce) for the identical class of
 * bug on scene hints.
 *
 * Only the named character's own items are considered, so the cast never has
 * to be plumbed to the call site. `sceneMetadatas` (plural) is for a contract
 * that spans several pages — the entity-consistency grid judges one
 * character×clothing group across every page it appears on, and a single
 * expected-clothing string cannot say "off on p12 only". There the union is
 * taken: an item off on ANY page of the group is not demanded on the grid,
 * because a demanded-but-absent garment costs a paid repair round while a
 * silent one costs nothing.
 *
 * Returns the text unchanged whenever anything is missing or the strip is not
 * structurally unambiguous — see removeWornItemFromOutfit.
 */
function resolveGeneratedOutfit(outfitText, ownerName, { visualBible = null, sceneMetadata = null, sceneMetadatas = null, pageNumber = null } = {}) {
  const text = String(outfitText || '');
  if (!text.trim() || !ownerName || !visualBible) return text;
  const metas = Array.isArray(sceneMetadatas) ? sceneMetadatas : (sceneMetadata ? [sceneMetadata] : []);
  if (metas.length === 0) return text;
  const seen = new Set();
  const off = [];
  for (const meta of metas) {
    if (!meta) continue;
    for (const r of resolveWornItemsForPage(visualBible, [ownerName], meta, { pageNumber: pageNumber || undefined })) {
      if (!isOffForCharacter(r, ownerName) || seen.has(r.id)) continue;
      seen.add(r.id);
      off.push(r);
    }
  }
  if (off.length === 0) return text;
  const { text: stripped } = stripOffItemsFromOutfit(text, off, ownerName);
  return stripped;
}

module.exports = {
  WORN_SLOTS,
  SLOT_NOUNS,
  parseWornAs,
  parseWornItems,
  wornItemsFromMetadata,
  wornAsEntries,
  findVbEntryById,
  deriveSlotFromName,
  slotFromType,
  unlinkedWornCandidates,
  isOffForCharacter,
  referenceCarriesItem,
  resolveWearer,
  resolveWornItemsForPage,
  wornStateById,
  wornItemLook,
  buildWornStateLines,
  buildWornStateBlock,
  removeWornItemFromOutfit,
  stripOffItemsFromOutfit,
  resolveGeneratedOutfit,
  sameName,
};
