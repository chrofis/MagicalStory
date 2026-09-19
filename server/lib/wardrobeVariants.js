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
 * `wornItems[]` rows (via wornItems.resolveWornItemsForPage) and the off-sheet's
 * outfit is the canonical contract with that garment's clause STRUCTURALLY
 * deleted by the existing stripper (wornItems.resolveOutfitForPage). If the
 * strip cannot be made unambiguously, or if deleting the garment would leave a
 * body slot with nothing named in it, NO variant is produced — the page keeps
 * today's behaviour (base sheet + the "leave it off" line), which is the worse
 * of two known outcomes but never a worse one than today.
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
  WORN_SLOTS, SLOT_NOUNS,
  resolveWornItemsForPage, isOffForCharacter, resolveOutfitForPage, sameName,
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
    if (!r || !isOffForCharacter(r, characterName)) continue;
    if (!WORN_SLOTS.includes(String(r.slot || '').trim().toLowerCase())) continue;
    ids.push(r.id);
  }
  return normalizeOffIds(ids);
}

/**
 * WHICH SLOTS MUST STILL BE NAMED AFTER THE STRIP — the no-invented-layer rule.
 *
 * Taking an outer layer off exposes whatever is under it. If the contract does
 * not NAME what is under it, the sheet generator invents one, and it may invent
 * a different one for each variant — so the character's base-layer shade would
 * change when a jacket comes off, which is precisely the "the character changed"
 * failure this whole design exists to avoid.
 *
 * Only the body-covering slots are listed. A bare head, a missing scarf, no
 * belt and bare feet are all states a picture can show without inventing
 * anything, so removing a hat, a scarf, a belt or a boot needs nothing beneath.
 * Removing the only `top` is listed because a bare torso is not what any of
 * these briefs mean.
 */
const COVER_REQUIRED_BY_SLOT = {
  'outer layer': 'top',
  top: 'top',
  bottom: 'bottom',
};

/** Does `text` name a garment belonging to `slot`, through the closed vocabulary? */
function namesSlotGarment(text, slot) {
  const nouns = SLOT_NOUNS[slot];
  if (!nouns) return false;
  return new RegExp(`\\b(?:${nouns.join('|')})\\b`, 'i').test(String(text || ''));
}

/**
 * Would this strip leave a body slot with nothing named in it?
 * @returns {{ok: true}|{ok: false, slot: string, needs: string}}
 */
function baseLayerHolds(strippedText, removedSlots) {
  for (const slot of (removedSlots || [])) {
    const needs = COVER_REQUIRED_BY_SLOT[String(slot || '').trim().toLowerCase()];
    if (!needs) continue;
    if (!namesSlotGarment(strippedText, needs)) return { ok: false, slot, needs };
  }
  return { ok: true };
}

/** The story-level outfit contract for one character + category, or null. */
function contractOutfitFor(clothingRequirements, characterName, baseCategory) {
  const { resolveCharacterReqs } = require('./clothingCategories');
  const charReqs = resolveCharacterReqs(clothingRequirements, characterName);
  const desc = charReqs?.[baseCategory]?.description;
  return (typeof desc === 'string' && desc.trim()) ? desc.trim() : null;
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
      const existing = observed.get(key);
      if (existing) { existing.pages.push(pageNumber); continue; }
      observed.set(key, {
        name,
        offIds,
        // The resolved rows for exactly these ids, as this page stated them —
        // what the stripper needs, and nothing more.
        rows: resolved.filter(r => offIds.includes(String(r.id).toUpperCase()) && isOffForCharacter(r, name)),
        pages: [pageNumber],
      });
    }
  }

  for (const { name, offIds, rows, pages } of observed.values()) {
    const where = `${name} off:${offIds.join('+')} (page${pages.length > 1 ? 's' : ''} ${pages.join(', ')})`;
    const baseCategory = baseCategoryFor(clothingRequirements, name);
    if (!baseCategory) {
      log.info(`👕 [WARDROBE-VARIANT] ${where}: no plain clothing category in use (costumed, or nothing declared) — no variant; the page keeps the base sheet + the "leave it off" line`);
      refusals.push({ name, offIds, pages, reason: 'no-plain-category' });
      continue;
    }
    const contract = contractOutfitFor(clothingRequirements, name, baseCategory);
    if (!contract) {
      log.warn(`👕 [WARDROBE-VARIANT] ${where}: no ${baseCategory} outfit contract to strip — no variant`);
      refusals.push({ name, offIds, pages, reason: 'no-contract' });
      continue;
    }

    const { text, removals } = resolveOutfitForPage(contract, rows, name);
    const unremoved = (removals || []).filter(r => !r.removed);
    if (unremoved.length > 0) {
      // The whole point of the variant is a sheet WITHOUT the garment. If the
      // stripper could not take the clause out, the sheet would be drawn
      // wearing it and would be an identical, paid copy of the base sheet.
      log.warn(`👕 [WARDROBE-VARIANT] ${where}: the ${unremoved.map(r => `${r.id} (${r.slot}: ${r.reason})`).join(', ')} clause could not be removed structurally — no variant`);
      refusals.push({ name, offIds, pages, reason: 'strip-failed', detail: unremoved });
      continue;
    }

    const removedSlots = (removals || []).map(r => r.slot);
    const holds = baseLayerHolds(text, removedSlots);
    if (!holds.ok) {
      // THE HARD RULE. Loud, because it means the vaguest contract keeps the
      // worst behaviour and the owner asked to see exactly that.
      log.error(`👕 [WARDROBE-VARIANT] ${where}: removing the "${holds.slot}" garment leaves no ${holds.needs} named in the contract — REFUSING to generate a variant rather than let the sheet invent a base layer. The page keeps the base sheet + the "leave it off" line.`);
      refusals.push({ name, offIds, pages, reason: 'unnamed-base-layer', slot: holds.slot, needs: holds.needs });
      continue;
    }

    requirements.push({
      pageNumber: 'pre-cover',
      clothingCategory: buildOffCategory(baseCategory, offIds),
      characterNames: [name],
      offIds,
      baseCategory,
      clothingDescription: text,
      // The garments' own declared NAMES, for the redress instruction. The ids
      // mean nothing to an image model, and nothing here is invented: these are
      // the Visual Bible entries' own names, as the resolver read them.
      removedItemNames: rows.map(r => String(r.name || r.id)),
      pages,
    });
    log.info(`👕 [WARDROBE-VARIANT] ${where}: variant requested as "${buildOffCategory(baseCategory, offIds)}"`);
  }

  return { requirements, refusals };
}

module.exports = {
  OFF_MARK,
  normalizeOffIds,
  buildOffCategory,
  parseOffCategory,
  isOffCategory,
  buildOffSlotKey,
  offIdsForCharacter,
  baseLayerHolds,
  baseCategoryFor,
  contractOutfitFor,
  deriveWardrobeVariantRequirements,
  COVER_REQUIRED_BY_SLOT,
};
