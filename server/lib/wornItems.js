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

/**
 * `wornAs: "Lily.headwear"` -> {owner: 'Lily', slot: 'headwear', slotKnown: true};
 * null when malformed.
 *
 * `slotKnown` IS THE FLAG, AND THE LINK IS NEVER DROPPED (2026-09-18). The
 * writer can name a slot that does not exist — staging
 * job_1789681157795_wkt20ckod linked `Levin.hands` (mittens) and `Levin.neck`
 * (a scarf), neither of which is in WORN_SLOTS, and the parse accepted both
 * without a word. Rejecting the link here was the obvious repair and is the
 * WRONG one: `wornAsEntries` would then not enumerate the entry at all, so the
 * page would lose its "is NOT wearing this" prompt line, the item would keep
 * its reference cell on its own owner, and the strip would never even be
 * attempted — strictly worse than the silent no-op it replaces, and it would
 * take the element-identity route below out of reach for the one case it can
 * still answer. So the parse MARKS and never drops; the loud failure lives
 * where it can be acted on (`auditVisualBibleContract`, at authoring time) and
 * where it actually costs something (`stripOffItemsFromOutfit`, when a garment
 * the page took off stays in the contract).
 */
function parseWornAs(wornAs) {
  const raw = String(wornAs || '').trim();
  const dot = raw.indexOf('.');
  if (dot <= 0 || dot === raw.length - 1) return null;
  const owner = raw.slice(0, dot).trim();
  const slot = raw.slice(dot + 1).trim().toLowerCase();
  if (!owner || !slot) return null;
  return { owner, slot, slotKnown: WORN_SLOTS.includes(slot) };
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
    // `redressNote` (2026-09-19) — the Art Director's own wardrobe instruction
    // for the avatar sheet this `off` needs: which garments stay, which comes
    // off, what becomes visible under it. Absent on every row written before
    // the field existed, and then the mechanical builder derives it instead.
    const redressNote = String(row.redressNote || '').trim();
    out.push({
      id, owner: String(row.owner || '').trim(), state,
      location: location || null, wearer: wearer || null,
      redressNote: redressNote || null,
    });
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
      out.push({ entry, id: String(entry.id).toUpperCase(), name: entry.name || entry.id, owner: link.owner, slot: link.slot, slotKnown: link.slotKnown, pool });
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
 * WHAT THIS IS NOT (corrected 2026-09-18 — the previous note here was wrong and
 * the error mattered). It used to claim the caller has always pre-filtered to an
 * id the Art Director declared worn, so the function "never decides whether
 * something is clothing". Three of its six call sites do no such thing: they
 * sweep RAW Visual Bible pools and this regex is the only thing standing between
 * a prop and an outfit slot —
 *   - `unlinkedWornCandidates` below (every unlinked artifact/clothing/vehicle);
 *   - `clothingCheck.bibleEntrySlot` (every artifact/clothing entry);
 *   - `coverIterate`'s `artifactMeta` (every artifact).
 * Two more pass an outfit CLAUSE rather than a name (`clothingCheck` line ~637,
 * `coverIterate` line ~407), against the paragraph below.
 *
 * So it DOES decide, and it is wrong on names where a slot noun is not the
 * garment: measured over 937 stored staging elements it derives a slot for 64,
 * and 4 of those are props — "bottle cap" and "Gessler's hat pole" land in
 * headwear, "Knotted sash line" in belt/waist (jobs job_1788551692337_bc479p945
 * ART004, job_1785513128428_fw26s7r7y ART003, job_1777923092665_wkhxd3mg9
 * ART001, job_1789207854566_l43qgl34w ART007). None of the four reached a
 * consumer — every call site applies a second gate — so the measured shipped
 * damage is zero, but the matcher is not the safe lookup this note used to
 * promise. The standing proposal is to have the writer/Art Director emit the
 * slot as a closed enum and retire the regex; until that is ruled on, a DECLARED
 * `type` always wins over this (see `slotFromType`, and source 2 of
 * `resolveWornItemsForPage`).
 *
 * When the name matches nouns from more than one slot, or from none, the answer
 * is null and the caller must treat the item as unmappable rather than guess.
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
function resolveWearer({ id, owner, declaredWearer, state, location, castNames, pageLabel, castComplete = true }) {
  const wearer = String(declaredWearer || '').trim();
  if (!wearer || sameName(wearer, owner)) return { wearer: owner, state, location };
  if (castNames.some(n => sameName(n, wearer))) return { wearer, state, location };
  // NO OFF-PAGE NAME IN A PROMPT-FACING STRING. `location` is read back into the
  // image prompt, and "held by <Name>" invites the model to draw the very person
  // this page's cast excludes. The fact the prompt needs is that the item is not
  // on the owner and not in frame; who has it is a log-side detail.
  const place = location || 'not on this page';
  // castComplete === false: the caller passed only the owner (the eval-side
  // recompute, which walks one character at a time and has no cast). Every
  // genuine handover then looks off-cast, so this is a debug line there — an
  // error would fire once per page per character and mask the real coercions.
  const message = `[WORN] Page ${pageLabel}: ${id} names wearer "${wearer}", who is not in this page's cast `
    + `(${castNames.join(', ') || 'no cast'}) — read as OFF ${owner}, ${place}. `
    + 'It is NOT put back on the owner: that would draw the very item the row takes off them.';
  if (castComplete) log.error(message);
  else log.debug(`${message} (cast not supplied by this caller)`);
  return { wearer: owner, state: 'off', location: place };
}

/**
 * Does this page's cast keep a worn row? (2026-09-19)
 *
 * THE GATE TESTS THE PERSON THE ROW CHANGES, NOT ONLY THE OWNER. `wornAs` names
 * the item's HOME — one owner, one slot — and until now both resolver sources
 * gated on that home alone: `castNames.some(n => sameName(n, item.owner))`. A
 * HANDOVER row (2026-09-15) names a different `wearer`, and when the owner is
 * off this page the row was discarded before `resolveWearer` ever saw it, so
 * the page shipped with no WORN ITEMS block at all and the garment was drawn
 * wherever the references put it. Measured on staging:
 * `job_1789759147125_p08djwhbl` p17 and p9 (CLO002, a jacket handed to another
 * child while its owner is off-page) and `job_1789348171785_9oxos7dwv` p10 —
 * all three resolved to `[]`.
 *
 * This COMPLETES the handover feature; it does not reverse it. The schema, the
 * prompt line, `applyWornItemsToOutfit`'s swap and `resolveWearer` all already
 * supported a wearer who is not the owner — only the gate did not.
 *
 * ONE predicate for both resolver sources on purpose: the fork it replaces is
 * exactly the class of hand-maintained copy that drifts.
 *
 * A row neither of whose named people is on the page is correctly dropped — but
 * a HANDOVER dropped that way is loud, because it means the brief wrote a
 * garment transfer between two characters the page does not contain. An
 * ordinary row whose owner is simply elsewhere stays silent: that is the common
 * case on every page of every story.
 *
 * @returns {boolean} keep the row
 */
function castKeepsWornRow({ castNames, owner, declaredWearer, id, pageLabel }) {
  const inCast = (n) => !!String(n || '').trim() && castNames.some(x => sameName(x, n));
  if (inCast(owner)) return true;
  const wearer = String(declaredWearer || '').trim();
  if (!wearer || sameName(wearer, owner)) return false;
  if (inCast(wearer)) return true;
  log.warn(`[WORN] Page ${pageLabel}: ${id} declares a handover from "${owner}" to "${wearer}" and NEITHER is in this page's cast `
    + `(${castNames.join(', ') || 'no cast'}) — the row is dropped. Nothing is stripped or swapped on this page.`);
  return false;
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
 *     What it does not name is the outfit SLOT, which comes from the VB entry's
 *     own declared `type` when that IS a slot, and only otherwise from its name
 *     through the closed SLOT_NOUNS vocabulary. When neither yields a single
 *     slot the item is UNMAPPABLE — it is left out and, if the row declared it
 *     `off`, logged as an error. Silence here is what made this bug invisible
 *     for a day.
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
    const d = declared.get(item.id) || null;
    // The gate tests the person the row CHANGES — owner OR declared wearer.
    // See castKeepsWornRow.
    if (!castKeepsWornRow({ castNames, owner: item.owner, declaredWearer: d && d.wearer, id: item.id, pageLabel })) continue;
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
      castComplete: options.castComplete !== false,
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
      // Is the OWNER on this page? A handover row survives the gate on its
      // WEARER alone, and then the owner's name must not reach a prompt-facing
      // string — see buildWornStateLines and commit 2193438b6.
      ownerInCast: castNames.some(n => sameName(n, item.owner)),
      // The writer LINKED this item to an outfit (`wornAs`), so the owner's
      // avatar reference demonstrably carries it — see referenceCarriesItem.
      wornAsLinked: true,
      slot: item.slot,
      // The writer's slot is not necessarily one of ours — see parseWornAs.
      slotKnown: item.slotKnown,
      entry: item.entry,
      state,
      location: w.location,
      declared: !!stateDeclared,
      defaulted: !stateDeclared,
      missing,
      redressNote: (d && d.redressNote) || null,
    });
  }

  // Source 2 — declared rows with no writer link.
  for (const d of declared.values()) {
    if (linked.has(d.id) || !d.state) continue;
    const found = findVbEntryById(visualBible, d.id);
    const entry = found ? found.entry : null;
    const owner = String((entry && entry.wornBy) || d.owner || '').trim();
    // DECLARED TYPE FIRST (2026-09-18). `unlinkedWornCandidates` has always read
    // `slotFromType(entry.type) || deriveSlotFromName(entry.name)`; this path —
    // the one that actually strips and swaps a rendered outfit line — read the
    // name regex alone, so the same element could be slotted two different ways
    // by two functions in this file. The declaration is the Art Director's own
    // word for what the element IS; the regex is a guess at English made from
    // its label, and it is the guess that mis-slots props (see
    // deriveSlotFromName). Over every stored staging/prod story the two never
    // disagreed (0 of 937 + 777 elements), so this changes no shipped outfit —
    // it removes the fork, and puts the declared field in front of the regex on
    // the path where a wrong slot deletes a garment.
    const slot = entry ? (slotFromType(entry.type) || deriveSlotFromName(entry.name || entry.id)) : null;
    if (!entry || !owner || !slot) {
      // Loud, and only for the state that silently changes nothing downstream:
      // an `off` the resolver cannot map leaves the garment in the generator's
      // outfit text AND in every judge's clothing contract. Never kills the run
      // (gates are guidelines) — the page renders, the fault is on the record.
      if (d.state === 'off') {
        const why = !entry
          ? 'no Visual Bible element carries that id'
          : (!owner ? 'the element names no wearer and the row names no owner'
            : `its type "${entry.type || ''}" is not an outfit slot and no single slot can be derived from its name "${entry.name || entry.id}"`);
        log.error(`[WORN] Page ${pageLabel}: ${d.id} is declared "off" but cannot be mapped to an outfit — ${why}. `
          + `Nothing is stripped: the image model is still told to draw it and every clothing judge still demands it.`);
      }
      continue;
    }
    if (!castKeepsWornRow({ castNames, owner, declaredWearer: d.wearer, id: d.id, pageLabel })) continue;
    const w2 = resolveWearer({
      id: d.id, owner, declaredWearer: d.wearer || null,
      state: d.state, location: d.location || null, castNames, pageLabel,
      castComplete: options.castComplete !== false,
    });
    out.push({
      id: d.id,
      name: entry.name || entry.id,
      owner,
      wearer: w2.wearer,
      handedOver: !sameName(w2.wearer, owner),
      ownerInCast: castNames.some(n => sameName(n, owner)),
      // NO `wornAs` link: nothing promises this item is part of the wearer's
      // wardrobe, so no attached reference shows it on them.
      wornAsLinked: false,
      slot,
      // Source 2 derives the slot from `slotFromType` / `deriveSlotFromName`,
      // both of which only ever answer with a member of WORN_SLOTS.
      slotKnown: true,
      entry,
      state: w2.state,
      location: w2.location,
      declared: true,
      defaulted: false,
      redressNote: d.redressNote || null,
      // Declared rows are outside the writer-linked set the `removal_unstated`
      // check governs; flagging them would invent findings on a path that has
      // never produced one.
      missing: false,
    });
  }
  return out;
}

/**
 * WHICH garments this brief set tracks, and who owns each — from the Art
 * Director's OWN rows (2026-09-19).
 *
 * THE HOLE THIS CLOSES. `resolveWornItemsForPage` has two sources, and neither
 * can see an UNDECLARED state on an UNLINKED garment:
 *   - source 1 enumerates the writer's `wornAs` entries, so a page missing a row
 *     for one of them yields `defaulted: true, missing: true` and
 *     `clothingCheck` rule 3 reports it;
 *   - source 2 enumerates the ROWS THAT EXIST. No row, nothing to enumerate.
 * So for a garment the writer never linked, a page with no row produced no
 * resolved item, no prompt line, and no finding — while the item stayed in the
 * outfit contract and the attached reference wore it. The state resolved to
 * WORN by silence, which is the one thing this module refuses to do anywhere it
 * can see (see parseWornItems: an unreadable state stays null rather than
 * guessing).
 *
 * MEASURED by replaying `clothingCheck` over 126 stored staging stories
 * (2026-07-19..2026-09-18) in the shape beatsPipeline calls it: 14 stories
 * declare `wornItems` rows at all, and across them 45 page/garment pairs have
 * the owner in cast and no row. SIX are writer-linked and were already
 * reported; the other 39 produced nothing at all. The remaining 112 stories
 * gain nothing. On `job_1789759147125_p08djwhbl` the consequence is in the
 * data: p10 shipped v0 with no jacket and a v1 repair wearing it — a coin flip
 * on one page.
 *
 * THE OWNER COMES FROM THE BRIEF SET, NOT FROM PROSE. A row the Art Director
 * wrote on any page names `{id, owner}`; the Visual Bible entry may also name
 * `wornBy`. Both are declared fields. Nothing here reads a sentence, and no
 * vocabulary of English garment nouns is consulted — the question is never "is
 * this a garment?" but "which garment did this brief set already say it
 * tracks?". A garment NO page declares is outside this entirely: that is a
 * Visual Bible fault and `worn_link_missing` owns it.
 *
 * Precedence between the two owner fields is the same as source 2's
 * (`entry.wornBy || row.owner`) on purpose — one answer per file.
 *
 * @param {Object} visualBible
 * @param {Array<Array>} pagesWornItems  each page's raw `wornItems` array
 * @returns {Map<string, {id, name, owner, slot, entry, linked}>}
 */
function trackedWornGarments(visualBible, pagesWornItems) {
  const linkedIds = new Set(wornAsEntries(visualBible).map(e => e.id));
  const out = new Map();
  for (const rows of (pagesWornItems || [])) {
    for (const d of parseWornItems(rows)) {
      if (out.has(d.id)) continue;
      const found = findVbEntryById(visualBible, d.id);
      const entry = found ? found.entry : null;
      const owner = String((entry && entry.wornBy) || d.owner || '').trim();
      if (!entry || !owner) continue;  // no element, or nothing names whose it is
      // UNMAPPABLE IS NOT TRACKED. A row is not by itself evidence the element
      // is clothing: over the stored staging stories the Art Director wrote
      // `wornItems` rows against a soft toy and against two map props, and an
      // element with no outfit slot is exactly what source 2 refuses to act on
      // (it leaves the garment in the contract and logs an error on an `off`).
      // Demanding a row for one would ask for a row the resolver then discards,
      // and would print "<a soft toy> is <the child>'s costume" at a reviewer.
      // Same slot question as source 2, in the same precedence — declared
      // `type` first, the name regex only otherwise.
      const slot = slotFromType(entry.type) || deriveSlotFromName(entry.name || entry.id);
      if (!slot) continue;
      out.set(d.id, {
        id: d.id,
        name: entry.name || entry.id,
        owner,
        slot,
        entry,
        linked: linkedIds.has(d.id),
      });
    }
  }
  return out;
}

/**
 * Tracked garments whose owner is on THIS page and which this page declares no
 * row for — the gap `resolveWornItemsForPage` structurally cannot see.
 *
 * Writer-LINKED ids are excluded: source 1 already resolves them with
 * `missing: true` and rule 3 already reports them. Reporting them twice would
 * double every existing finding.
 *
 * DETECTION ONLY. This returns nothing to the prompt, the packing or the outfit
 * text: an undeclared state stays undeclared, and the page renders exactly as it
 * does today. Inventing a `worn` row here would be the silent default this
 * exists to expose, and inventing an `off` one would delete a garment nobody
 * took off.
 */
function missingWornRows(tracked, cast, sceneMetadata) {
  const castNames = (Array.isArray(cast) ? cast : [])
    .map(c => (typeof c === 'string' ? c : c && c.name))
    .filter(Boolean);
  const declared = new Set(wornItemsFromMetadata(sceneMetadata).map(w => w.id));
  const out = [];
  for (const t of (tracked ? tracked.values() : [])) {
    if (t.linked || declared.has(t.id)) continue;
    if (!castNames.some(n => sameName(n, t.owner))) continue;
    out.push(t);
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

/**
 * Carry a page's declared worn states across a brief rewrite (2026-09-16).
 *
 * scene-iteration.txt / scene-iteration-free.txt do not emit `wornItems`, and
 * the metadata parser turns an absent field into `[]`. An undeclared row makes
 * resolveWornItemsForPage default the item to `worn`, so an iterated page that
 * had taken an item OFF came back carrying the affirmative "IS wearing this"
 * override and the item painted back on. Same class as era / textZoneDescription
 * / aboard / crowdExpected in iteratePageCore: context the rewriter never
 * re-decides. A non-empty emission still wins.
 */
function carryForwardWornItems(newSceneMetadata, savedSceneMetadata) {
  const nonEmpty = (v) => (Array.isArray(v) && v.length > 0 ? v : null);
  const saved = savedSceneMetadata || {};
  const savedRows = nonEmpty(saved.wornItems)
    || nonEmpty(saved.fullData && saved.fullData.wornItems)
    || [];
  const fresh = nonEmpty(newSceneMetadata && newSceneMetadata.wornItems);
  if (!fresh) {
    return savedRows.length > 0
      ? savedRows
      : (Array.isArray(newSceneMetadata && newSceneMetadata.wornItems) ? newSceneMetadata.wornItems : []);
  }
  // A non-empty emission wins the STATE — but a rewriter that re-states the row
  // and drops `redressNote` would delete the authored wardrobe instruction for
  // the rest of that page's life (the class of loss docs/decisions.md:3049
  // records). Per id, an absent note inherits the saved one.
  const savedNotes = new Map();
  for (const r of savedRows) {
    const id = String((r && r.id) || '').trim().toUpperCase();
    const note = String((r && r.redressNote) || '').trim();
    if (id && note) savedNotes.set(id, note);
  }
  if (savedNotes.size === 0) return fresh;
  return fresh.map((r) => {
    if (!r || typeof r !== 'object') return r;
    if (String(r.redressNote || '').trim()) return r;
    const note = savedNotes.get(String(r.id || '').trim().toUpperCase());
    return note ? { ...r, redressNote: note } : r;
  });
}

function buildWornStateLines(resolved) {
  const lines = [];
  for (const r of (resolved || [])) {
    const name = String(r.name || '').trim();
    if (!name) continue;
    const look = wornItemLook(r);
    const item = look ? `${name} — ${look}` : name;
    // OWNER OFF THIS PAGE (2026-09-19). The row survived the cast gate on its
    // WEARER; naming the owner here would put an off-page name into a
    // prompt-facing string and invite the model to draw the absent character —
    // the fault commit 2193438b6 exists to prevent. Say only what the page
    // needs: this character is wearing it, draw it on them. `=== false` on
    // purpose — a row built without the field keeps the old rendering.
    if (r.ownerInCast === false && r.handedOver) {
      lines.push(`- ${r.wearer} IS wearing this on this page: ${item}. Draw it on ${r.wearer}.`);
      continue;
    }
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

/** Every garment noun in the closed vocabulary, across all slots. */
const ALL_GARMENT_NOUNS = [...new Set(Object.values(SLOT_NOUNS).flat())];

const ANY_GARMENT_RE = new RegExp(`\\b(?:${ALL_GARMENT_NOUNS.join('|')})\\b`, 'i');

/** Does this text name a garment at all, through the closed vocabulary? */
const namesAGarment = (text) => ANY_GARMENT_RE.test(String(text || ''));

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
 *
 * A COMMA ONLY SEPARATES TWO GARMENTS (2026-09-18). Treating every comma as a
 * clause boundary cut INSIDE a clause, and the caller then deleted an orphan
 * fragment as if it were a garment. Measured on staging
 * job_1789506283204_3kxqshifx (Levin, pages 8/9/11/13/15/17/18): the contract
 * opens "a solid red, visibly hand-knitted wool cap with a small rolled-up brim
 * around the bottom edge, shaped slightly oversized and wide;" — ONE hat, with
 * its colour in front of it and its fit behind it. Splitting on the commas made
 * three clauses of it, only the middle one carried a headwear noun, and taking
 * the cap off left "A solid red; shaped slightly oversized and wide; …" standing
 * in the outfit as two free-floating garments. Same shape on
 * job_1789584708605_rts4wqupm, where the comma inside "red fleece fabric
 * garment with a full front zipper, ribbed cuffs and hem — worn over a white
 * long-sleeve shirt" separated the fleece from its own layering phrase.
 *
 * So the delimiters are ranked, and the rank is structural, not statistical:
 *   - a SEMICOLON is always a top-level boundary — over 833 stored staging and
 *     prod outfit contracts it is never used inside a garment description;
 *   - a COMMA is a boundary only between two texts that each NAME a garment,
 *     through the same closed SLOT_NOUNS vocabulary every other decision in
 *     this module uses. A fragment that names no garment is not a clause: it is
 *     a colour, a fit or a trim belonging to the garment beside it, and it is
 *     merged back into it (into the clause before it, or — when it opens the
 *     contract — into the one after).
 *
 * The bias is deliberate. Over-splitting DELETES a garment; under-splitting only
 * makes `removeWornItemFromOutfit` refuse the strip (the merged clause names a
 * second garment with no layering connective → `slot-clause-carries-another-
 * garment`), and the explicit "is NOT wearing" prompt line still carries the
 * instruction. Nothing is inferred from prose: the only question asked of a
 * fragment is whether the closed vocabulary appears in it.
 *
 * Clause text is returned verbatim from the source, separators and all, so a
 * caller that drops one clause and rejoins the rest changes nothing else.
 *
 * A DEPENDENT SEGMENT IS NOT A CLAUSE, IT BELONGS TO THE ONE BEFORE IT
 * (2026-09-19). Measured on staging job_1789759147125_p08djwhbl, Levin's
 * contract reads "… a forest-green zip-up fleece jacket with a wide body and
 * two front pockets, worn open in scenes where the jacket becomes the egg's
 * bed; …". The second half of that comma pair carries a garment noun, so the
 * comma rule above made it a top-level clause — and taking the jacket out left
 * it standing in the outfit as a free-floating fragment, still talking about
 * the garment that had just been removed, now dangling off the cap beside it.
 *
 * The test is SYNTACTIC and asks only how the segment OPENS: a top-level item
 * of an outfit list is a noun phrase, and a segment that begins with a
 * preposition or a past participle of wearing/attachment cannot head one. Nothing is read from what the segment MEANS. Such a segment is
 * attached to the clause before it as a DEPENDENT: it stays in the clause text,
 * so a caller that keeps the clause keeps it verbatim, and it leaves with the
 * clause when the clause is removed.
 *
 * A dependent is excluded from the clause's HEAD, which is the only part any
 * garment question is asked of — how many garments the clause names, which
 * clause the declared element is, where the layering connective falls. That is
 * the clause-ownership model: the head names the garment, the dependents
 * describe it, and the two are removed together.
 *
 * The one thing a dependent may NOT do is bring a second garment with it. If a
 * dependent names a garment noun its head does not, the caller refuses the
 * strip rather than drop a garment nobody declared off — the same safety bias
 * as everywhere else in this module, and the same closed vocabulary.
 */
function splitClauses(description) {
  return splitClausesDetailed(description).map(c => c.text);
}

/**
 * The openers that make a segment DEPENDENT on the clause before it. Closed,
 * and every member is a preposition or a participle — a word class that cannot
 * be the head of the noun phrase an outfit list item is. Two kinds of word are
 * deliberately absent: the list conjunctions ("and a rust-orange scarf" is the
 * last ITEM of a list, not a tail on the one before it), and the participial
 * ADJECTIVES that can premodify a noun ("matching brown boots").
 */
const DEPENDENT_OPENER_RE = /^\s*(?:with|without|over|under|beneath|underneath|in|on|at|worn|wearing|layered|tucked|wrapped|rolled|folded|fastened|buttoned|zipped|pulled|slung|draped|cut|trimmed|lined|paired|held|secured|finished|topped)\b/i;

/**
 * Clauses as {text, head}: `text` is the whole clause including its dependents,
 * `head` is the part that names the garment. See splitClauses.
 */
function splitClausesDetailed(description) {
  const raw = String(description || '');
  if (!raw.trim()) return [];

  // Candidate boundaries: ';' or ',' at parenthesis depth 0.
  const segments = [];
  let depth = 0;
  let start = 0;
  let sepBefore = null;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ';' || ch === ',')) {
      segments.push({ text: raw.slice(start, i), sepBefore });
      sepBefore = ch;
      start = i + 1;
    }
  }
  segments.push({ text: raw.slice(start), sepBefore });

  const clauses = [];
  let current = null;
  for (const seg of segments) {
    if (!seg.text.trim()) continue;
    const garment = namesAGarment(seg.text);
    if (current === null) { current = { text: seg.text, head: seg.text, garment }; continue; }
    // A dependent opener never starts a clause, whatever it names.
    if (DEPENDENT_OPENER_RE.test(seg.text)) {
      current.text += seg.sepBefore + seg.text;
      continue;
    }
    if (seg.sepBefore === ';' || (current.garment && garment)) {
      clauses.push(current);
      current = { text: seg.text, head: seg.text, garment };
    } else {
      current.text += seg.sepBefore + seg.text;
      current.head += seg.sepBefore + seg.text;
      current.garment = current.garment || garment;
    }
  }
  if (current) clauses.push(current);
  return clauses
    .map(c => ({ text: c.text.trim(), head: c.head.trim() }))
    .filter(c => c.text);
}

/**
 * Does a clause's dependent tail bring a garment its head does not name? Then
 * the two cannot be removed together — see splitClauses.
 */
function dependentCarriesOtherGarment(clause) {
  if (!clause || clause.text === clause.head) return false;
  const tail = clause.text.slice(clause.head.length);
  const inHead = new Set(garmentNounsIn(clause.head, ALL_GARMENT_NOUNS).map(n => n.toLowerCase()));
  return garmentNounsIn(tail, ALL_GARMENT_NOUNS).some(n => !inHead.has(n.toLowerCase()));
}

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
 * Function words, which identify nothing. Everything else a Visual Bible
 * element declares about itself — colour, material, cut, fastening — is
 * identifying, because a collision on one of those is handled below (a word two
 * texts share simply stops discriminating) rather than by pruning the list.
 * Words of two letters or fewer never reach this set; they are dropped by length.
 */
const IDENTITY_STOPWORDS = new Set([
  'the', 'and', 'but', 'nor', 'for', 'yet', 'with', 'without', 'from', 'into', 'onto', 'upon',
  'its', 'his', 'her', 'their', 'our', 'your', 'this', 'that', 'these', 'those', 'them',
  'are', 'was', 'were', 'been', 'being', 'has', 'have', 'had', 'not', 'all', 'any', 'each',
  'both', 'one', 'two', 'three', 'four', 'some', 'such', 'also', 'plus', 'than', 'then',
  'when', 'while', 'which', 'who', 'whose', 'over', 'under', 'worn', 'wearing', 'wears',
]);

const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The DECLARED identifying words of a Visual Bible element — its own `name`,
 * `label`, any `aliases`, and its own description.
 *
 * Every one of these is a field the writer or Art Director WROTE for this
 * element. None of it is inferred from the outfit prose, and none of it is a
 * closed vocabulary of English garment nouns: the question this answers is
 * never "is this a garment?" but "is this ART004?".
 */
function elementIdentityTerms(element) {
  if (!element || typeof element !== 'object') return [];
  const sources = [
    element.name, element.label,
    ...(Array.isArray(element.aliases) ? element.aliases : []),
    element.extractedDescription, element.description,
  ];
  const terms = new Set();
  for (const src of sources) {
    for (const raw of String(src || '').toLowerCase().split(/[^a-z0-9'’-]+/)) {
      const word = raw.replace(/^[-'’]+|[-'’]+$/g, '');
      if (word.length < 3 || IDENTITY_STOPWORDS.has(word)) continue;
      terms.add(word);
    }
  }
  return [...terms];
}

/** The minimum number of the element's own words that must single one text out. */
const MIN_DISCRIMINATING_TERMS = 2;

/**
 * WHICH of these texts is the declared element — asked of the element itself.
 *
 * THE RULING THIS IMPLEMENTS (2026-09-18). The module used to ask a closed list
 * of English garment nouns "is this a garment?" and take the answer as "this is
 * the item the page declared off". That fails whenever the contract names the
 * garment in words the list does not hold: on staging
 * job_1789584708605_rts4wqupm the writer linked ART004, *named* "fleece jacket",
 * as `Levin.top`, and Levin's contract describes it as "red fleece fabric
 * garment with a full front zipper … worn over a white long-sleeve shirt". Not
 * one word of "red fleece fabric garment" is in SLOT_NOUNS, so the vocabulary
 * counted ONE garment in that clause — the shirt — concluded the clause was
 * only about the declared item, and dropped it whole. Levin lost the shirt on
 * p15/p17/p18 as well as the jacket he had actually taken off. Worse, had the
 * vocabulary been consulted for WHICH half to cut, the only `top` noun in the
 * clause is "shirt", so it would have cut the shirt and kept the jacket.
 *
 * The element is declared, structured data that cannot drift, so it is asked
 * directly. A term DISCRIMINATES only when it appears in exactly one of the
 * texts: a word every text shares (a colour both garments happen to be) says
 * nothing, and a word no text carries says nothing. Every discriminating term
 * must point the same way.
 *
 * TWO discriminating terms at least, because an element's identity is the
 * CONJUNCTION of the words declared for it, never any single one of them. One
 * word shared between two English garment descriptions is a coincidence —
 * colours and materials recur constantly — and a lone "red" pointing at a clause
 * is not evidence the red thing in it is this element. An element whose declared
 * name is a single word therefore never answers here at all, and the caller
 * falls back to exactly the behaviour it had before this route existed.
 *
 * This is the safety bias `splitClauses` states, applied to identity: a wrong
 * answer deletes a garment, while no answer only makes the caller refuse — and
 * a refusal is visible in `removals[].reason` and recoverable, with the
 * explicit "is NOT wearing" prompt line still carrying the instruction.
 *
 * @returns index of the text that IS the element, or -1 when its own declared
 *          words cannot tell them apart.
 */
function indexOfElementAmong(texts, element) {
  const list = (Array.isArray(texts) ? texts : []).map(t => String(t || ''));
  if (list.length < 2) return -1;
  const terms = elementIdentityTerms(element);
  if (terms.length < MIN_DISCRIMINATING_TERMS) return -1;
  let winner = -1;
  let support = 0;
  for (const term of terms) {
    const re = new RegExp(`\\b${escapeRe(term)}\\b`, 'i');
    let only = -1;
    let count = 0;
    for (let i = 0; i < list.length; i++) {
      if (!re.test(list[i])) continue;
      count += 1;
      only = i;
    }
    if (count !== 1) continue;               // absent, or shared — says nothing
    if (winner === -1) winner = only;
    else if (winner !== only) return -1;     // its own words point two ways
    support += 1;
  }
  return support >= MIN_DISCRIMINATING_TERMS ? winner : -1;
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
 * `element` is the Visual Bible entry the page declared off, and it is asked
 * FIRST — see indexOfElementAmong. `slotNouns` / `itemName` are the older
 * closed-vocabulary route, and answer only when the element cannot.
 */
function clauseRemainderWithoutItem(clause, slotNouns, itemName, element = null) {
  const parts = String(clause).split(LAYER_SPLIT_RE).map(s => s.trim()).filter(Boolean);
  // NO SLOT, NO VOCABULARY (2026-09-18). The caller reaches here with
  // `slotNouns: null` when the writer named a slot outside WORN_SLOTS and only
  // Route A could identify the clause. Route B then has nothing to consult, and
  // an empty vocabulary makes it refuse — which is the right answer and the one
  // the safety bias asks for, never a crash on `null.filter`.
  const vocab = Array.isArray(slotNouns) ? slotNouns : [];

  // ROUTE A — the declared element identifies its own half of the clause.
  // Ahead of the whole-clause shortcut below on purpose: that shortcut counts
  // garments through the closed vocabulary, and a garment the vocabulary cannot
  // see is exactly the case this route exists for.
  if (parts.length >= 2) {
    const mine = indexOfElementAmong(parts, element);
    if (mine >= 0) {
      const rest = parts.filter((_, i) => i !== mine);
      const withGarment = rest.filter(p => countGarments(p) > 0);
      // Everything left of the connective names a garment → it survives.
      if (withGarment.length === rest.length) return rest.join(', ');
      // Nothing left names a garment → the rest is this item's own trim, its
      // fit or where it sits; the clause is about this item alone. Drop it whole.
      if (withGarment.length === 0) return null;
      // Mixed: one real garment and one loose fragment. Which garment the
      // fragment belongs to is not declared anywhere — refuse rather than guess.
      return false;
    }
  }

  // ROUTE B — closed vocabulary. Unchanged, and reached only when the element's
  // own declared words could not tell the halves apart.
  if (countGarments(clause) <= 1) return null;
  const itemNouns = (itemName ? garmentNounsIn(itemName, vocab) : []);
  const mine = itemNouns.length > 0 ? itemNouns : garmentNounsIn(clause, vocab);
  if (mine.length === 0) return false;
  const mineRe = new RegExp(`\\b(?:${mine.join('|')})\\b`, 'i');
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
 *
 * `element` is the Visual Bible entry itself. When the caller has one, the
 * element's own declared words pick the clause and the half of it to cut, and
 * the slot vocabulary is only the fallback — see indexOfElementAmong.
 */
function removeWornItemFromOutfit(description, slot, itemName = null, element = null) {
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
  //
  // AN UNKNOWN SLOT NO LONGER PRE-EMPTS IDENTITY (2026-09-18). `wornAs` is
  // free text the writer composes, and it can name a slot this module has never
  // heard of: staging job_1789681157795_wkt20ckod links `Levin.hands` for
  // mittens and `Levin.neck` for a scarf — both of them `accessories` in the
  // one vocabulary that exists — and the bare `SLOT_NOUNS[key]` miss returned
  // `unknown-slot` before anything else was tried. Nothing was stripped on nine
  // pages: the generator kept drawing the scarf the page had wrapped around
  // something else, and every clothing judge kept demanding it back.
  //
  // The element-identity route does not need a slot at all — it asks the
  // declared element which clause is itself — so the miss is no longer an exit,
  // it is only the loss of the fallback. Identity answers or nothing happens,
  // and `unknown-slot` is still the reason reported when identity declines, so
  // a slot outside WORN_SLOTS never becomes invisible.
  const nouns = SLOT_NOUNS[key] || null;
  const detailed = splitClausesDetailed(raw);
  const clauses = detailed.map(c => c.text);
  // Every garment question is asked of the HEADS; the clause text (head plus
  // its dependents) is what is kept or dropped. See splitClauses.
  const heads = detailed.map(c => c.head);
  const byElement = indexOfElementAmong(heads, element);
  if (!nouns && byElement < 0) return { text: raw, removed: false, reason: 'unknown-slot' };
  if (clauses.length < 2) return { text: raw, removed: false, reason: 'single-clause-outfit' };
  // THE DECLARED ELEMENT PICKS ITS OWN CLAUSE (2026-09-18), ahead of the slot
  // vocabulary. The slot is the writer's `wornAs` link, which on staging
  // job_1789584708605_rts4wqupm reads `Levin.top` for an element the Art
  // Director typed `outer layer` — so the vocabulary consulted for that slot is
  // the vocabulary of the wrong garment, and the only `top` noun in the jacket's
  // clause belongs to the shirt underneath it. The element's own declared words
  // do not depend on either being right. Same precedence as d104a283d: a
  // declared field outranks a guess at English.
  let hits = [];
  if (byElement >= 0) hits = [byElement];
  else {
    const nounRe = new RegExp(`\\b(?:${nouns.join('|')})\\b`, 'i');
    hits = heads.map((c, i) => (nounRe.test(c) ? i : -1)).filter(i => i >= 0);
    // A slot can hold two garments at once — a hoodie over a t-shirt, a cape over
    // a jacket — and then the slot alone cannot say which clause the declaration
    // is about. The ELEMENT'S OWN NAME can. Narrow by the garment nouns the name
    // itself carries, drawn from the same closed vocabulary; nothing is inferred
    // from prose and the one-clause bound below still holds.
    if (hits.length > 1 && itemName) {
      const nameNouns = nouns.filter(n => new RegExp(`\\b${n}\\b`, 'i').test(String(itemName)));
      if (nameNouns.length > 0) {
        const nameRe = new RegExp(`\\b(?:${nameNouns.join('|')})\\b`, 'i');
        const narrowed = hits.filter(i => nameRe.test(heads[i]));
        if (narrowed.length === 1) hits = narrowed;
      }
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
  const chosen = detailed[hits[0]];
  // A dependent that brings a garment of its OWN is not a tail on the head, it
  // is the other half of a layered clause ("… a duffle coat …, worn over a white
  // long-sleeve top") — so the whole clause goes to the layer split, which is
  // what that route has always been for. A dependent that brings no garment is
  // the head's own trim or fit, and only the head is asked.
  const layered = dependentCarriesOtherGarment(chosen);
  const survivor = clauseRemainderWithoutItem(layered ? chosen.text : chosen.head, nouns, itemName, element);
  if (survivor === false) {
    return { text: raw, removed: false, reason: 'slot-clause-carries-another-garment' };
  }
  // A head that is layered WITHIN ITSELF keeps half of itself, and its trim
  // dependents describe the half that is leaving as readily as the one that
  // stays — which of the two owns them is declared nowhere. Refuse, rather than
  // carry a fit phrase over onto a garment it was never written about.
  if (!layered && survivor !== null && chosen.text !== chosen.head) {
    return { text: raw, removed: false, reason: 'dependent-clause-ownership-unclear' };
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
    // The Visual Bible entry itself, so the strip identifies the garment by what
    // the element DECLARES rather than by a closed list of English garment
    // nouns. `{ name: r.name }` is the same question asked of the one declared
    // field a hand-built row always carries.
    const res = removeWornItemFromOutfit(text, r.slot, r.name, r.entry || { name: r.name });
    removals.push({ id: r.id, slot: r.slot, removed: res.removed, reason: res.reason });
    // LOUD WHERE IT COSTS SOMETHING (2026-09-18). Every other failed strip is
    // the module refusing one it cannot make safely, and the explicit "is NOT
    // wearing" prompt line still carries the instruction. A slot the writer
    // INVENTED is not that: the element's own words were the only thing that
    // could have answered, they did not, and the garment the page took off is
    // still standing in the one string the generator, all three judges and
    // every repair entry point read.
    //
    // The test is the slot itself, not the returned reason, because the two
    // routes report an invented slot differently — a plain-sentence contract
    // answers `unknown-slot` and a slot-LABELLED one answers
    // `slot-not-in-contract`, which is also what a real slot legitimately
    // answers. 401 of the 4,757 stored pairs are slot-labelled, so that second
    // route is not hypothetical. Same shape and severity as the unmappable
    // source-2 `off` above — never kills the run, never edits the entry.
    if (!res.removed && !WORN_SLOTS.includes(String(r.slot || '').trim().toLowerCase())) {
      log.error(`[WORN] ${r.id} "${r.name}" is declared off ${characterName} but its wornAs slot "${r.slot}" is not an outfit slot `
        + `(${WORN_SLOTS.join(', ')}), and the element's own declared words do not single out a clause of the contract `
        + `(${res.reason}). Nothing is stripped: the image model is still told to draw it and every clothing judge still demands it.`);
    }
    if (res.removed) text = res.text;
  }
  return { text, removals };
}

/**
 * A `worn` item the character's own outfit contract CONTRADICTS — the other
 * half of the disagreement, and the one nothing resolved before (2026-09-15).
 *
 * Measured on staging job_1789420511893_zly5rcdej p13: the page declares
 * `{ART002 "navy-blue captain's cap", owner: Emma, state: "worn"}` while Emma's
 * stored contract opens "A black felt tricorn hat with a red cockade; …". Two
 * hats, one head, and every reader picked a different one — the WORN STATE
 * block told the generator and the semantic judge "cap", the clothing contract
 * told the compliance judge "tricorn". Owner's ruling: there are only wrong
 * answers if she is supposed to wear both, so the disagreement is removed
 * rather than adjudicated.
 *
 * The page's declared state wins, because it is the per-page fact and the
 * contract is the story-level default: the contract's clause for that slot is
 * dropped and the declared item takes its place, with the bible's own shape
 * words (`wornItemLook`) so the resolved text is not a bare label.
 *
 * Bounded exactly like the strip:
 *   - only a `worn` item whose wearer IS this character;
 *   - only when the contract's clause for that slot names a DIFFERENT garment
 *     (if the contract already names this item, nothing happens);
 *   - only when `removeWornItemFromOutfit` can take that one clause out
 *     unambiguously. Otherwise the contract is left exactly as it was — a
 *     wrong deletion is worse than a redundant mention, and the WORN ITEMS
 *     block still carries the instruction in words.
 */
function applyWornItemsToOutfit(description, resolved, characterName) {
  let text = String(description || '');
  const swaps = [];
  for (const r of (resolved || [])) {
    if (!r || r.state !== 'worn' || !r.slot) continue;
    if (!sameName(r.wearer || r.owner, characterName)) continue;
    const nouns = SLOT_NOUNS[r.slot];
    // An unknown slot ends the swap, and says so (2026-09-18). The element's own
    // words cannot stand in for the vocabulary here the way they do in the
    // strip: what this branch removes is the contract's INCUMBENT garment, and
    // the element's words point at the garment going IN. So the swap genuinely
    // cannot run — but it is recorded, like every other skip, instead of
    // vanishing on a bare `continue`.
    if (!nouns) { swaps.push({ id: r.id, slot: r.slot, applied: false, reason: 'unknown-slot' }); continue; }
    const clauses = splitClausesDetailed(text).map(c => c.head);
    const nounRe = new RegExp(`\\b(?:${nouns.join('|')})\\b`, 'i');
    const hits = clauses.filter(c => nounRe.test(c));
    if (hits.length !== 1) continue; // no clause, or an ambiguous slot — leave it
    // NO EVIDENCE OF DISAGREEMENT, NO SWAP (2026-09-18). This whole branch
    // exists for one premise: the contract's clause for this slot names a
    // DIFFERENT garment from the one the page declares worn. The only test the
    // module has for "different" is the closed SLOT_NOUNS vocabulary of the
    // slot — and when the declared item's own NAME carries none of those nouns
    // the test proves nothing either way. It used to fall through anyway, and
    // treated an unprovable premise as a proven one.
    //
    // Measured on staging job_1789584708605_rts4wqupm (Levin, pages 1/4/6/7/8/
    // 9/10/11/12/13/14/16): the writer linked ART004 "fleece jacket" as
    // `Levin.top`, so the slot is `top` while the item is a jacket — and no
    // `top` noun appears in "fleece jacket". Levin's contract opens with that
    // very jacket ("red fleece fabric garment with a full front zipper … worn
    // over a white long-sleeve shirt"), i.e. there was no disagreement at all;
    // the swap fired regardless, deleted the clause holding the white
    // long-sleeve shirt and appended a second copy of the jacket.
    //
    // A skipped swap is not a silent no-op: it is recorded with its reason, the
    // WORN ITEMS block still tells the model in words that the item is worn,
    // and a redundant mention costs nothing while a wrong deletion costs a
    // garment — the same bound the strip has always had.
    const mineNouns = garmentNounsIn(r.name, nouns);
    if (mineNouns.length === 0) {
      swaps.push({ id: r.id, slot: r.slot, applied: false, reason: 'item-name-carries-no-slot-noun' });
      continue;
    }
    // Already the same garment? Then there is no disagreement to remove.
    if (mineNouns.every(n => new RegExp(`\\b${n}\\b`, 'i').test(hits[0]))) continue;
    // `itemName` is null ON PURPOSE, and it is not the declared item's name.
    // What comes OUT here is the contract's INCUMBENT garment for the slot —
    // the tricorn that yields to the cap — and its name is nowhere on record.
    // Null is what makes `clauseRemainderWithoutItem` identify the item to
    // remove from the clause itself (`garmentNounsIn(clause, slotNouns)`);
    // passing `r.name` would narrow to the garment being put IN, which the
    // guard above has just established the clause does NOT name, and the
    // removal would target the wrong half of a layered clause. The `element`
    // argument is omitted for the same reason, and it matters more: the
    // element's declared words would point squarely at the garment going IN.
    const res = removeWornItemFromOutfit(text, r.slot, null);
    if (!res.removed) {
      swaps.push({ id: r.id, slot: r.slot, applied: false, reason: res.reason });
      continue;
    }
    const look = wornItemLook(r);
    const item = look ? `${r.name} — ${look}` : r.name;
    const joiner = /;(?![^()]*\))/.test(text) ? '; ' : ', ';
    const body = res.text.replace(/[.\s]+$/, '');
    text = `${body}${joiner}${item}${/[.!?]$/.test(String(description || '')) ? '.' : ''}`;
    swaps.push({ id: r.id, slot: r.slot, applied: true, reason: 'slot-conflict-resolved' });
  }
  return { text, swaps };
}

/**
 * THE ONE RESOLVED OUTFIT OF A PAGE — contract + this page's worn rows.
 *
 * Every reader of a character's clothing on a page path goes through here: the
 * image prompt (promptBuilders.buildImagePrompt), the compliance judge and the
 * semantic judge (evalPipeline.buildEvalClothingContract, one block for all
 * three evaluators) and the entity grid. One string, so there is nothing to
 * adjudicate between them.
 */
function resolveOutfitForPage(description, resolvedWorn, characterName) {
  const { text: stripped, removals } = stripOffItemsFromOutfit(description, resolvedWorn, characterName);
  const { text, swaps } = applyWornItemsToOutfit(stripped, resolvedWorn, characterName);
  return { text, removals, swaps };
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
 * to be plumbed to the call site. ONE PAGE, ONE STATE: the multi-page union
 * this used to offer (`sceneMetadatas`) is DELETED (2026-09-19). Its only
 * caller was the entity-consistency grid, which now groups its cells BY
 * wardrobe state, so every grid is homogeneous and a union would be a strictly
 * weaker answer to a question nobody asks. Measured harm before the split:
 * a garment off on one page was dropped from the expected clothing of all 17
 * appearances, costing two spurious MAJORs on the pages that wore it correctly
 * and leaving eight pages unjudged (staging job_1789759147125_p08djwhbl).
 *
 * Returns the text unchanged whenever anything is missing or the strip is not
 * structurally unambiguous — see removeWornItemFromOutfit.
 */
function resolveGeneratedOutfit(outfitText, ownerName, { visualBible = null, sceneMetadata = null, pageNumber = null } = {}) {
  const text = String(outfitText || '');
  if (!text.trim() || !ownerName || !visualBible || !sceneMetadata) return text;
  const seen = new Set();
  const off = [];
  const worn = [];
  // castComplete: false — this walks ONE character, so every genuine handover
  // to another cast member would otherwise be logged as an off-cast coercion.
  for (const r of resolveWornItemsForPage(visualBible, [ownerName], sceneMetadata, { pageNumber: pageNumber || undefined, castComplete: false })) {
    if (seen.has(r.id)) continue;
    if (isOffForCharacter(r, ownerName)) { seen.add(r.id); off.push(r); continue; }
    if (r.state === 'worn') { seen.add(r.id); worn.push(r); }
  }
  if (off.length === 0 && worn.length === 0) return text;
  const { text: resolved } = resolveOutfitForPage(text, [...off, ...worn], ownerName);
  return resolved;
}

/**
 * The Visual Bible a `storyData` carries for resolving per-page worn state.
 *
 * The bible arrives under one of TWO keys, and both are the same data:
 * `visualBible` on a stored story, `wornItemsVisualBible` on the entity-check
 * input the repair pipeline assembles (repairPipeline.js buildEntityCheckData),
 * which deliberately avoids the plain key because that one also switches on the
 * visual-bible secondary-character checks. Every worn-state reader goes through
 * this one function: when f1a897765 (2026-09-19) moved the entity grid's worn
 * resolution to collection time it read `visualBible` alone, so on every
 * pipeline entity check the page's `off` rows resolved to nothing and a garment
 * taken off by design was judged against the sheet that still wears it —
 * staging job_1790100385959_1nitlympp p11/p12, "Kiaan is missing the gilet".
 */
function wornItemsBibleOf(storyData) {
  return (storyData && (storyData.visualBible || storyData.wornItemsVisualBible)) || null;
}

/**
 * The same one resolved outfit, for a caller that holds a whole `storyData` and
 * a page number rather than a parsed brief — the three character-repair entry
 * points (repairPipeline, routes/regeneration, entityConsistency's single-page
 * repair). A repaint is a page path: it must dress the character the way the
 * page did, not the way the story-level contract does.
 *
 * Reads the page's brief out of `storyData.sceneImages` and parses it with the
 * same `extractSceneMetadata` the entity grid uses. Unparsable or missing →
 * the outfit comes back untouched, exactly as before.
 */
function resolveOutfitForStoryPage(outfitText, characterName, storyData, pageNumber, sceneDescription = null) {
  try {
    const sd = (storyData && Array.isArray(storyData.sceneImages) ? storyData.sceneImages : [])
      .find(s => s && s.pageNumber === pageNumber);
    const desc = sceneDescription || (sd && (sd.sceneDescription || sd.description)) || null;
    if (!desc) return String(outfitText || '');
    const { extractSceneMetadata } = require('./sceneMetadata');
    return resolveGeneratedOutfit(outfitText, characterName, {
      visualBible: wornItemsBibleOf(storyData),
      sceneMetadata: extractSceneMetadata(desc),
      pageNumber,
    });
  } catch {
    return String(outfitText || '');
  }
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
  elementIdentityTerms,
  indexOfElementAmong,
  unlinkedWornCandidates,
  trackedWornGarments,
  missingWornRows,
  isOffForCharacter,
  referenceCarriesItem,
  resolveWearer,
  resolveWornItemsForPage,
  wornStateById,
  wornItemLook,
  carryForwardWornItems,
  splitClauses,
  splitClausesDetailed,
  buildWornStateLines,
  buildWornStateBlock,
  removeWornItemFromOutfit,
  stripOffItemsFromOutfit,
  applyWornItemsToOutfit,
  resolveOutfitForPage,
  resolveOutfitForStoryPage,
  resolveGeneratedOutfit,
  wornItemsBibleOf,
  sameName,
};
