/**
 * WARDROBE-STATE AVATAR VARIANTS — one extra 2×4 sheet per OBSERVED off-set.
 *
 * The fault this closes (staging job_1789759147125_p08djwhbl, 18 pages): three
 * garments flip on/off across the story, `data.characterAvatars` holds exactly
 * ONE sheet per character, and on all nine jacket-off pages the only reference
 * the image model saw was the character WEARING the jacket, plus a text line
 * asking for its removal. The render put it on his body anyway. The briefs were
 * coherent; the reference contradicted them. A reference-authority fault, not a
 * continuity-data fault — so the fix is a second reference, not more words.
 *
 * WHAT THIS IS NOT. It does not infer a state from prose, and it does not
 * invent a garment. The off-set comes from the Art Director's own declared
 * `wornItems[]` rows (via wornItems.resolveWornItemsForPage), and the wardrobe
 * instruction the off-sheet is drawn from is the Art Director's own
 * `redressNote` on that row — the stage that already holds the outfit contract,
 * the garment, the slot and the exact off-combination writes it (owner,
 * 2026-09-19: "The AD should create the full prompt that is needed to strip the
 * avatar later"). There is NO second, code-side way to word one. An off-set the
 * Art Director left unwritten produces NO variant and says so loudly; the page
 * then keeps the pre-feature behaviour — the worn sheet plus the existing "is
 * NOT wearing" text line — which is an absence, not a fallback implementation.
 *
 * ONE VARIANT PER OBSERVED DISTINCT OFF-SET, never the power set. A page with
 * two of a character's garments off at once keys the UNION.
 *
 * SCOPE IS CLOTHING (owner, 2026-09-19). Held artifacts and their state
 * tracking are out; only rows whose resolved slot is a member of
 * wornItems.WORN_SLOTS are considered.
 */

const { log } = require('../utils/logger');
const {
  WORN_SLOTS, resolveWornItemsForPage, isOffForCharacter, sameName, outfitVersionOf,
} = require('./wornItems');

/**
 * The state suffix on a clothing category / slot key.
 *
 * `standard--off:CLO001+CLO002`, `styled-standard--off:CLO002`. The base half
 * is untouched so every existing reader that only knows `standard` keeps
 * working, and a key with a suffix can never collide with one without.
 */
const OFF_MARK = '--off:';

/** Sorted, unique, upper-cased — the key must not depend on page order. */
function normalizeOffIds(ids) {
  return [...new Set((Array.isArray(ids) ? ids : [])
    .map(v => String(v || '').trim().toUpperCase())
    .filter(Boolean))].sort();
}

/** 'standard' + [CLO002, CLO001] -> 'standard--off:CLO001+CLO002'. */
function buildOffCategory(baseCategory, ids) {
  const norm = normalizeOffIds(ids);
  const base = String(baseCategory || 'standard');
  return norm.length === 0 ? base : `${base}${OFF_MARK}${norm.join('+')}`;
}

/** The inverse. Returns null when the category carries no state suffix. */
function parseOffCategory(category) {
  const raw = String(category || '');
  const at = raw.indexOf(OFF_MARK);
  if (at < 0) return null;
  const baseCategory = raw.slice(0, at);
  const offIds = normalizeOffIds(raw.slice(at + OFF_MARK.length).split('+'));
  if (!baseCategory || offIds.length === 0) return null;
  return { baseCategory, offIds };
}

function isOffCategory(category) {
  return parseOffCategory(category) !== null;
}

/** 'styled-standard' + ids -> 'styled-standard--off:CLO001'. Same algebra. */
function buildOffSlotKey(baseSlotKey, ids) {
  return buildOffCategory(baseSlotKey, ids);
}

/**
 * The CLOTHING items this page takes off this character, as a normalized set.
 *
 * The single definition — every cell-crop site asks this, none of them computes
 * it. Held artifacts are excluded by the WORN_SLOTS membership test: an
 * unmappable row (the resolver could not place it in an outfit slot) is not a
 * garment this module will build a sheet for.
 */
function offIdsForCharacter(characterName, wornResolved) {
  if (!characterName || !Array.isArray(wornResolved)) return [];
  const ids = [];
  for (const r of wornResolved) {
    if (!r) continue;
    // OUTFIT VERSIONS (2026-09-24) share this one key algebra: a version
    // garment WORN by its character is part of the state set — it is the id of
    // the version sheet — and a version garment OFF is the default outfit,
    // which never had it, so it contributes nothing. The suffix keeps its
    // historical name `--off:`; what it keys is "this page differs from the
    // default outfit by these garments".
    const version = outfitVersionOf(r.entry);
    if (version) {
      if (r.state === 'worn' && sameName(version.character, characterName)
        && sameName(r.wearer || r.owner, characterName)) ids.push(r.id);
      continue;
    }
    if (!isOffForCharacter(r, characterName)) continue;
    if (!WORN_SLOTS.includes(String(r.slot || '').trim().toLowerCase())) continue;
    ids.push(r.id);
  }
  return normalizeOffIds(ids);
}

/**
 * The wardrobe half of a VERSION sheet's redress instruction, from the two
 * authored strings the version records: the contract's own clause and the
 * Visual Bible's own garment. Quoted, not derived — no garment is named that
 * neither text names, and every staying garment is left to the sheet (the
 * scaffold says Image 1 is their authority).
 */
function versionRedressNote(versions) {
  const { CLAUSE_LEAD_RE } = require('./wornItems');
  const bare = (t) => String(t || '').replace(CLAUSE_LEAD_RE, '').replace(/[.\s]+$/, '').trim();
  return (versions || []).map(v =>
    `The character no longer wears the ${bare(v.replaces)}. In its place they wear ${String(v.garment || '').replace(/[.\s]+$/, '').trim()}. Every other garment stays exactly as the sheet draws it.`
  ).join('\n');
}

/**
 * The non-costumed category a character's story actually uses.
 *
 * Costumed characters get no off-variant: the costume IS the outfit, it is
 * generated rather than converted, and nothing in this story's data says which
 * clause of a costume a removable garment occupies. Out of scope, and silent
 * about it would be wrong — the caller logs the skip.
 */
function baseCategoryFor(clothingRequirements, characterName) {
  const { resolveCharacterReqs } = require('./clothingCategories');
  const charReqs = resolveCharacterReqs(clothingRequirements, characterName);
  if (!charReqs) return null;
  if (charReqs.costumed?.used === true) return null;
  for (const cat of ['standard', 'winter', 'summer']) {
    if (charReqs[cat]?.used === true) return cat;
  }
  return null;
}

/**
 * The Art Director's authored wardrobe instruction for one page's off-rows.
 *
 * One page may take two garments off at once; the AD writes the instruction
 * covering that page's whole change, so the rows of one page carry the SAME
 * text. Take the first non-blank, in the rows' own (id-sorted) order.
 */
function authoredNoteFrom(rows) {
  for (const r of (rows || [])) {
    const note = String((r && r.redressNote) || '').trim();
    if (note) return note;
  }
  return null;
}

/** Whitespace-, case- and punctuation-insensitive — two wordings or one? */
function noteFingerprint(note) {
  return String(note || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

/**
 * PICK ONE AUTHORED INSTRUCTION PER OFF-SET — lowest page number wins.
 *
 * A variant is keyed by the off-SET, not by the page, so several pages author
 * the same instruction. The rule is the first page in ascending page order that
 * authored a non-blank one; a page with no readable number sorts last, and the
 * declaration order among equals breaks the remaining tie. Never "last writer
 * wins" by iteration accident.
 *
 * Material disagreement is LOUD and does not change the pick: the sheet that
 * gets built is one sheet, and which page's words built it is exactly what the
 * owner needs to see when the pages do not say the same thing.
 */
function pickAuthoredNote(notes, where) {
  const list = (notes || []).filter(n => n && String(n.note || '').trim());
  if (list.length === 0) return null;
  const rank = (p) => (Number.isFinite(Number(p)) ? Number(p) : Number.MAX_SAFE_INTEGER);
  const sorted = list
    .map((n, i) => ({ ...n, i }))
    .sort((a, b) => (rank(a.pageNumber) - rank(b.pageNumber)) || (a.i - b.i));
  const chosen = sorted[0];
  const prints = new Set(sorted.map(n => noteFingerprint(n.note)));
  if (prints.size > 1) {
    log.warn(`👕 [WARDROBE-VARIANT] ${where}: ${prints.size} materially different wardrobe instructions authored for ONE off-set `
      + `(pages ${sorted.map(n => n.pageNumber).join(', ')}) — taking page ${chosen.pageNumber}'s, the lowest page number that authored one. `
      + `The others: ${sorted.slice(1).map(n => `p${n.pageNumber}: "${n.note}"`).join(' | ')}`);
  }
  return chosen.note;
}

/**
 * DERIVE the extra avatar requirements this story needs, from the all-pages
 * Art Director output.
 *
 * Runs once, AFTER the scene briefs exist — the flip data does not exist at the
 * early clothing-requirements kickoff, so this cannot ride that hook.
 *
 * @param {Object} args
 * @param {Object} args.visualBible
 * @param {Array<{pageNumber:number, sceneMetadata:Object}>} args.scenes
 * @param {Object} args.clothingRequirements
 * @param {Array<{name:string}>} [args.characters] - restrict to the commissioned
 *        cast; a Visual-Bible secondary has no avatar sheet to vary.
 * @returns {{requirements: Array<Object>, refusals: Array<Object>}}
 *   requirements[] is shaped exactly like the rows prepareStyledAvatars takes,
 *   plus `offIds`, `baseCategory` and the resolved `clothingDescription`.
 */
function deriveWardrobeVariantRequirements({ visualBible, scenes, clothingRequirements, characters = null }) {
  const requirements = [];
  const refusals = [];
  if (!visualBible || !Array.isArray(scenes) || scenes.length === 0) return { requirements, refusals };

  const castFilter = Array.isArray(characters) && characters.length > 0
    ? characters.map(c => (typeof c === 'string' ? c : c?.name)).filter(Boolean)
    : null;

  // (characterName lower | id+id) -> { name, offIds, rows, pages[] }
  const observed = new Map();

  for (const scene of scenes) {
    const meta = scene?.sceneMetadata;
    if (!meta) continue;
    const pageNumber = scene.pageNumber ?? meta.pageNumber ?? null;
    let resolved;
    try {
      resolved = resolveWornItemsForPage(visualBible, meta.characters || [], meta, { pageNumber });
    } catch (err) {
      log.warn(`[WARDROBE-VARIANT] page ${pageNumber}: worn-item resolution threw (${err.message}) — page contributes no variant`);
      continue;
    }
    if (!Array.isArray(resolved) || resolved.length === 0) continue;

    const names = [...new Set(resolved.map(r => r?.owner).filter(Boolean))];
    for (const name of names) {
      if (castFilter && !castFilter.some(n => sameName(n, name))) continue;
      const offIds = offIdsForCharacter(name, resolved);
      if (offIds.length === 0) continue;
      const key = `${String(name).trim().toLowerCase()}|${offIds.join('+')}`;
      const rows = resolved.filter(r => offIds.includes(String(r.id).toUpperCase())
        && (outfitVersionOf(r.entry) ? r.state === 'worn' : isOffForCharacter(r, name)));
      // The Art Director authors the wardrobe half of the redress instruction
      // on the ROW, so one off-set observed on seven pages arrives seven times,
      // worded seven slightly different ways. Collect them all here; the pick
      // is made once, deterministically, below.
      const note = authoredNoteFrom(rows);
      const existing = observed.get(key);
      if (existing) {
        existing.pages.push(pageNumber);
        if (note) existing.notes.push({ pageNumber, note });
        continue;
      }
      observed.set(key, {
        name,
        offIds,
        // The resolved rows for exactly these ids, as this page stated them —
        // what the stripper needs, and nothing more.
        rows,
        pages: [pageNumber],
        notes: note ? [{ pageNumber, note }] : [],
      });
    }
  }

  for (const { name, offIds, rows, pages, notes } of observed.values()) {
    const where = `${name} off:${offIds.join('+')} (page${pages.length > 1 ? 's' : ''} ${pages.join(', ')})`;
    // OUTFIT VERSION (2026-09-24): the set holds a garment the Visual Bible put
    // in place of a contract garment. Its sheet is the approved base sheet of
    // the version's own category, redressed; the instruction quotes the
    // version's two recorded texts. A set that ALSO takes a garment off would
    // need the Art Director's off-note and the version sentence merged into one
    // instruction, and nothing authors that — refused, loudly.
    const versions = [...new Map(rows.map(r => outfitVersionOf(r.entry)).filter(Boolean)
      .map(v => [`${v.slot}|${v.replaces}`, v])).values()];
    if (versions.length > 0) {
      if (versions.length !== offIds.length) {
        log.error(`👕 [WARDROBE-VARIANT] ${where}: an outfit version worn on a page that also takes a garment off — no sheet is built for the combination; the page keeps the default sheet (loud fallback at the crop site)`);
        refusals.push({ name, offIds, pages, reason: 'version-with-off-state' });
        continue;
      }
      const categories = [...new Set(versions.map(v => String(v.category || '').toLowerCase()))];
      const baseCat = categories.length === 1 && ['standard', 'winter', 'summer'].includes(categories[0]) ? categories[0] : null;
      if (!baseCat) {
        log.error(`👕 [WARDROBE-VARIANT] ${where}: outfit version of category "${categories.join('+')}" — only a plain (standard/winter/summer) sheet can be redressed; no version sheet`);
        refusals.push({ name, offIds, pages, reason: 'version-not-plain-category' });
        continue;
      }
      requirements.push({
        pageNumber: 'pre-cover',
        clothingCategory: buildOffCategory(baseCat, offIds),
        characterNames: [name],
        offIds,
        baseCategory: baseCat,
        removedItemNames: versions.map(v => v.replaces),
        redressNote: versionRedressNote(versions),
        outfitVersion: true,
        pages,
      });
      log.info(`👕 [WARDROBE-VARIANT] ${where}: outfit version requested as "${buildOffCategory(baseCat, offIds)}"`);
      continue;
    }
    const baseCategory = baseCategoryFor(clothingRequirements, name);
    if (!baseCategory) {
      log.info(`👕 [WARDROBE-VARIANT] ${where}: no plain clothing category in use (costumed, or nothing declared) — no variant; the page keeps the base sheet + the "leave it off" line`);
      refusals.push({ name, offIds, pages, reason: 'no-plain-category' });
      continue;
    }
    // THE AUTHORED INSTRUCTION IS THE ONLY SOURCE (owner, 2026-09-19). There is
    // no second, code-side way to word a redress: a mechanical stripper existed
    // here and was deleted, because the weaker implementation hid the stronger
    // one's failures — a page whose Art Director wrote nothing shipped a quietly
    // worse sheet instead of showing the gap. Without an authored instruction NO
    // VARIANT IS BUILT. That is not a fallback path: the page simply keeps the
    // pre-feature behaviour, the worn sheet plus the existing "is NOT wearing"
    // text line. Every story stored before the field existed lands here, by
    // design and on the record.
    const redressNote = pickAuthoredNote(notes, where);
    if (!redressNote) {
      log.error(`👕 [WARDROBE-VARIANT] ${where}: the Art Director authored no \`redressNote\` for this off-set — NO variant sheet. `
        + `The page keeps the worn sheet + the "is NOT wearing" line. Nothing else writes this instruction.`);
      refusals.push({ name, offIds, pages, reason: 'no-authored-instruction' });
      continue;
    }

    requirements.push({
      pageNumber: 'pre-cover',
      clothingCategory: buildOffCategory(baseCategory, offIds),
      characterNames: [name],
      offIds,
      baseCategory,
      // The garments' own declared NAMES — for the logs, and nothing is
      // invented: these are the Visual Bible entries' own names.
      removedItemNames: rows.map(r => String(r.name || r.id)),
      // The Art Director's wardrobe instruction: the redress prompt's whole
      // wardrobe half, and the clothing contract the sheet is judged against.
      redressNote,
      pages,
    });
    log.info(`👕 [WARDROBE-VARIANT] ${where}: variant requested as "${buildOffCategory(baseCategory, offIds)}"`);
  }

  return { requirements, refusals };
}

/**
 * COVERS FOLLOW THE PAGE RULE FOR OUTFIT VERSIONS (owner, 2026-09-24). A cover
 * has no `wornItems`, so its only declaration is the hint's element ids
 * (objects ∪ holds): a cast member whose version garment the hint cites wears
 * the version. Only version rows are returned — a cover never takes an
 * off-state, and a default-worn linked garment changes nothing on it.
 *
 * @returns {Array} resolved worn rows, each a version garment worn on the cover
 */
function coverVersionRows(visualBible, castNames, coverElementIds) {
  const ids = (Array.isArray(coverElementIds) ? coverElementIds : []).filter(Boolean);
  if (!visualBible || ids.length === 0) return [];
  return resolveWornItemsForPage(visualBible, castNames || [], { objects: ids }, { pageNumber: 'cover' })
    .filter(r => r && r.state === 'worn' && outfitVersionOf(r.entry));
}

module.exports = {
  OFF_MARK,
  coverVersionRows,
  pickAuthoredNote,
  authoredNoteFrom,
  normalizeOffIds,
  buildOffCategory,
  parseOffCategory,
  isOffCategory,
  buildOffSlotKey,
  offIdsForCharacter,
  versionRedressNote,
  baseCategoryFor,
  deriveWardrobeVariantRequirements,
};
