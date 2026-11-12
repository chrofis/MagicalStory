'use strict';
/**
 * Pure planning logic for scripts/admin/append-staging-versions-to-prod.js.
 *
 * Delivery of a story fixed on staging WITHOUT overwriting anything on production
 * (owner, 2026-11-12): for every picture whose staging final (active) image differs from
 * production's active image, production gets ONE NEW VERSION (the staging image) at the
 * next free version_index, and that version becomes active and pinned, exactly what the
 * customer's own version picker writes (routes/stories.js PUT .../active-image).
 * Every existing production version stays untouched and selectable.
 *
 * promote-story-to-prod.js cannot do this: its update mode deletes and re-inserts every
 * story_images row and replaces data / image_version_meta with the staging copy.
 *
 * No I/O here: the CLI fetches rows, these functions decide. Covered by
 * tests/unit/append-staging-versions.test.ts.
 */

const crypto = require('crypto');
const { keyForStoryImage } = require('../../server/lib/r2');

const COVER_TYPES = ['frontCover', 'initialPage', 'backCover'];
const DISPLAY_TYPES = ['scene', ...COVER_TYPES];
const ADMIN_FIX_SOURCE = 'admin-fix';

/** image_version_meta key of a story_images row: page number for scenes, the cover type otherwise. */
function metaKeyOf(row) {
  return row.image_type === 'scene' ? String(row.page_number) : row.image_type;
}

/** The active DB version_index for a meta key (the app's own default: 0). */
function activeIndex(meta, key) {
  const v = meta && meta[key] && meta[key].activeVersion;
  return Number.isInteger(v) ? v : 0;
}


/** URL path after the host ('' for a missing url). */
function urlPath(url) {
  return url ? String(url).replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]+/i, '') : '';
}

/** Is the production version entry of this DB row one this tool appended from staging (adminFix.from === 'staging')? */
function isAdminFixFromStaging(prodData, row) {
  // A cover's textless art row (<cover>Art) is appended with its cover at the same index and has
  // no imageVersions entry of its own: the marker is on the cover's entry.
  const imageType = COVER_TYPES.includes(row.image_type.replace(/Art$/, '')) ? row.image_type.replace(/Art$/, '') : row.image_type;
  const holder = versionHolder(prodData || {}, { imageType, pageNumber: row.page_number });
  const list = holder && Array.isArray(holder.imageVersions) ? holder.imageVersions : [];
  return list.some((v) => v && v.dbVersionIndex === row.version_index && v.source === ADMIN_FIX_SOURCE && v.adminFix && v.adminFix.from === 'staging');
}

const sha16 = (obj) => crypto.createHash('sha256').update(JSON.stringify(obj ?? null)).digest('hex').slice(0, 16);

/**
 * Has production moved since the staging copy was pulled? Any of these is a change:
 * the data blob (edits, regenerations), an image row newer than the pull, or a
 * metadata.updatedAt newer than the pull (the version picker changes only
 * image_version_meta and that timestamp), or a production image row the staging
 * copy does not hold. Returns the reasons; empty means unchanged.
 *
 * @param {{prodData:object, prodMetadata:object, prodRows:Array, stagingRows:Array, srcSha:string, pulledAt:string}} p
 * @returns {string[]}
 */
function provenanceProblems({ prodData, prodMetadata, prodRows, stagingRows, srcSha, pulledAt }) {
  const problems = [];
  if (!/^[0-9a-f]{16}$/.test(String(srcSha || ''))) return ['no source sha for the pull'];
  const pulled = Date.parse(pulledAt);
  if (!Number.isFinite(pulled)) return ['no pull time'];
  const liveSha = sha16(prodData);
  if (liveSha !== srcSha) problems.push(`production data changed since the pull (${srcSha} -> ${liveSha})`);
  const newer = prodRows.filter((r) => Date.parse(r.created_at) > pulled);
  if (newer.length) problems.push(`${newer.length} production image row(s) created after the pull, e.g. ${metaKeyOf(newer[0])} v${newer[0].version_index}`);
  const upd = prodMetadata && prodMetadata.updatedAt ? Date.parse(prodMetadata.updatedAt) : NaN;
  if (Number.isFinite(upd) && upd > pulled) problems.push(`production metadata.updatedAt ${prodMetadata.updatedAt} is after the pull (a version pick?)`);
  const held = new Set(stagingRows.map((r) => `${r.image_type}|${r.page_number}|${r.version_index}|${r.image_url}`));
  // A row THIS tool appended earlier holds the production-bucket URL, the staging copy the
  // staging-bucket URL of the same path. It counts as held only with the admin-fix marker on
  // its production version entry AND an identical type/page/index/path in the staging copy.
  const heldByPath = new Set(stagingRows.map((r) => `${r.image_type}|${r.page_number}|${r.version_index}|${urlPath(r.image_url)}`));
  const isHeld = (r) => held.has(`${r.image_type}|${r.page_number}|${r.version_index}|${r.image_url}`)
    || (isAdminFixFromStaging(prodData, r) && heldByPath.has(`${r.image_type}|${r.page_number}|${r.version_index}|${urlPath(r.image_url)}`));
  const missing = prodRows.filter((r) => !isHeld(r));
  if (missing.length) problems.push(`${missing.length} production image row(s) not in the staging copy, e.g. ${metaKeyOf(missing[0])} v${missing[0].version_index}`);
  return problems;
}

/**
 * One entry per picture whose staging active image is not production's active image.
 *
 * @param {object} p
 * @param {string} p.storyId
 * @param {object} p.stagingMeta  staging image_version_meta
 * @param {Array}  p.stagingRows  staging story_images rows (non-test): image_type, page_number, version_index, image_url
 * @param {object} p.prodMeta     production image_version_meta
 * @param {Array}  p.prodRows     production story_images rows (non-test), same columns
 * @returns {Array<object>} plan entries
 */
function planAppends({ storyId, stagingMeta, stagingRows, prodMeta, prodRows }) {
  const byKey = (rows) => {
    const m = new Map();
    for (const r of rows) {
      if (!DISPLAY_TYPES.includes(r.image_type)) continue;
      const k = metaKeyOf(r);
      if (!m.has(k)) m.set(k, []);
      m.get(k).push(r);
    }
    return m;
  };
  const sKeys = byKey(stagingRows);
  const pKeys = byKey(prodRows);
  const plan = [];
  const order = (k) => (/^\d+$/.test(k) ? Number(k) : 1000 + COVER_TYPES.indexOf(k));
  for (const key of [...new Set([...sKeys.keys(), ...pKeys.keys()])].sort((a, b) => order(a) - order(b))) {
    const sRows = sKeys.get(key) || [];
    const pRows = pKeys.get(key) || [];
    if (!sRows.length) throw new Error(`${key}: production has versions, the staging copy has none`);
    const sActive = activeIndex(stagingMeta, key);
    const sRow = sRows.find((r) => r.version_index === sActive);
    if (!sRow) throw new Error(`${key}: staging active version v${sActive} has no image row`);
    if (!sRow.image_url) throw new Error(`${key}: staging v${sActive} has no image_url (inline bytes are not copied)`);
    const pActive = activeIndex(prodMeta, key);
    const pRow = pRows.find((r) => r.version_index === pActive) || null;
    if (pRow && pRow.image_url === sRow.image_url) continue;   // same picture already active

    const { image_type: imageType, page_number: pageNumber } = sRow;
    const newIndex = pRows.reduce((m, r) => Math.max(m, r.version_index), -1) + 1;
    const sameAsProd = pRows.find((r) => r.image_url === sRow.image_url);
    const entry = {
      key, imageType, pageNumber,
      stagingVersion: sActive,
      sourceUrl: sRow.image_url,
      prodActive: pRow ? pActive : null,
      prodActiveUrl: pRow ? pRow.image_url : null,
      newIndex,
      newKey: keyForStoryImage(storyId, imageType, pageNumber, newIndex),
      qualityScore: sRow.quality_score ?? null,
      generatedAt: sRow.generated_at ?? null,
      sameImageAsProdVersion: sameAsProd ? sameAsProd.version_index : null,
      art: null,
    };
    // A cover's textless art layer travels with it, at the SAME version_index:
    // the cover edit and char-fix read the art row of the active version
    // (coverEvalLayer.loadCoverArtForRepair) and refuse a stamped cover without one.
    if (COVER_TYPES.includes(imageType)) {
      const artType = `${imageType}Art`;
      const sArt = stagingRows.find((r) => r.image_type === artType && r.version_index === sActive);
      if (sArt) {
        if (!sArt.image_url) throw new Error(`${key}: staging ${artType} v${sActive} has no image_url`);
        if (prodRows.some((r) => r.image_type === artType && r.version_index === newIndex)) {
          throw new Error(`${key}: production already has ${artType} v${newIndex}`);
        }
        entry.art = { imageType: artType, sourceUrl: sArt.image_url, newKey: keyForStoryImage(storyId, artType, null, newIndex) };
      }
    }
    plan.push(entry);
  }
  return plan;
}

/** The imageVersions[] holder for a plan entry in a story data blob, or null. */
function versionHolder(data, entry) {
  if (entry.imageType === 'scene') {
    return (data.sceneImages || []).find((s) => s && s.pageNumber === entry.pageNumber) || null;
  }
  const c = data.coverImages && data.coverImages[entry.imageType];
  return c && typeof c === 'object' ? c : null;
}

/** The staging imageVersions entry of a DB version_index (stamped dbVersionIndex first, then position). */
function stagingVersionEntry(stagingData, entry) {
  const holder = versionHolder(stagingData, entry);
  const list = holder && Array.isArray(holder.imageVersions) ? holder.imageVersions : [];
  return list.find((v) => v && v.dbVersionIndex === entry.stagingVersion)
    || (list[entry.stagingVersion] && !Number.isInteger(list[entry.stagingVersion].dbVersionIndex) ? list[entry.stagingVersion] : null);
}

/**
 * The production data blob after the append: prodData with one imageVersions entry
 * pushed per plan entry (the staging entry's metadata, re-stamped for its production
 * slot and marked as an admin fix). prodData is not mutated.
 *
 * @param {object} prodData
 * @param {object} stagingData
 * @param {Array}  plan       planAppends() output
 * @param {object} opts       { appendedAt: ISO string, stagingStoryId, rewrite: (entry)=>entry }
 */
function applyPlanToData(prodData, stagingData, plan, { appendedAt, rewrite = (v) => v } = {}) {
  const out = JSON.parse(JSON.stringify(prodData));
  for (const entry of plan) {
    const holder = versionHolder(out, entry);
    if (!holder) throw new Error(`${entry.key}: production data has no ${entry.imageType === 'scene' ? 'scene' : 'cover'} entry to append to`);
    if (!Array.isArray(holder.imageVersions)) holder.imageVersions = [];
    if (holder.imageVersions.some((v) => v && v.dbVersionIndex === entry.newIndex)) {
      throw new Error(`${entry.key}: production data already has a version stamped v${entry.newIndex}`);
    }
    const src = stagingVersionEntry(stagingData, entry);
    if (!src) throw new Error(`${entry.key}: staging data has no imageVersions entry for v${entry.stagingVersion}`);
    const copy = rewrite(JSON.parse(JSON.stringify(src)));
    delete copy.imageData;
    delete copy.imageUrl;
    copy.dbVersionIndex = entry.newIndex;
    copy.source = ADMIN_FIX_SOURCE;
    copy.adminFix = { from: 'staging', stagingVersion: entry.stagingVersion, appendedAt };
    holder.imageVersions.push(copy);
  }
  return out;
}

/** image_version_meta after the append: each planned key active on its new version and pinned (what the picker writes). */
function applyPlanToMeta(prodMeta, plan) {
  const out = { ...(prodMeta || {}) };
  for (const e of plan) out[e.key] = { activeVersion: e.newIndex, pinned: true };
  return out;
}

/**
 * Point a story's LIVE references of a character's styled 2x4 sheet at a new sheet:
 * `characters[].avatars.styledAvatars[artStyle].standard` (what char-fix and the entity check
 * read, entityConsistency.getStyledAvatarForClothing) and `characterAvatars[name]['styled-standard']`
 * (what redraws and cover iterations crop their cell references from, storyAvatars.applyStoryCellRefs).
 * The per-page `sceneCharacters` / `imageVersions` snapshots are records of what made each existing
 * picture and stay as they are. prodData is not mutated.
 *
 * @param {object} prodData
 * @param {Array<{characterId:(string|number), newUrl:string}>} sheets
 * @returns {{data:object, changes:Array<{name:string, field:string, from:string, to:string}>}}
 */
function applySheetSwap(prodData, sheets) {
  const data = JSON.parse(JSON.stringify(prodData));
  const artStyle = data.artStyle;
  if (!artStyle) throw new Error('story data has no artStyle');
  const changes = [];
  for (const { characterId, newUrl } of sheets) {
    const ch = (data.characters || []).find((c) => c && String(c.id) === String(characterId));
    if (!ch) throw new Error(`character ${characterId} is not in this story`);
    const perStyle = ch.avatars && ch.avatars.styledAvatars && ch.avatars.styledAvatars[artStyle];
    if (!perStyle || typeof perStyle.standard !== 'string') throw new Error(`${ch.name}: no stored ${artStyle} standard sheet to replace`);
    const slot = data.characterAvatars && data.characterAvatars[ch.name];
    if (!slot || typeof slot['styled-standard'] !== 'string') throw new Error(`${ch.name}: no characterAvatars styled-standard entry to replace`);
    if (perStyle.standard === newUrl) throw new Error(`${ch.name}: the new sheet is already referenced`);
    changes.push({ name: ch.name, field: `characters[].avatars.styledAvatars.${artStyle}.standard`, from: perStyle.standard, to: newUrl });
    perStyle.standard = newUrl;
    changes.push({ name: ch.name, field: "characterAvatars[name]['styled-standard']", from: slot['styled-standard'], to: newUrl });
    slot['styled-standard'] = newUrl;
  }
  return { data, changes };
}

module.exports = {
  COVER_TYPES, DISPLAY_TYPES, ADMIN_FIX_SOURCE,
  metaKeyOf, activeIndex, sha16,
  provenanceProblems, planAppends, applyPlanToData, applyPlanToMeta, stagingVersionEntry, applySheetSwap,
};
