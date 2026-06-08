/**
 * Build the composite-cast array for one page.
 *
 * For each named character in the scene:
 *   1. Locate (or lazy-generate) the styled 2×4 reference sheet for the
 *      art-style + clothing combination needed on this page.
 *   2. Pull pose + flip from the scene metadata.
 *   3. Pull the action phrase from interactions[] (essential > normal > low).
 *   4. Emit a cast entry: { name, sheetBuf, pose, flip, action, position, sizeHint }.
 *
 * Returns the cast array, or null when any cast character can't be resolved.
 * The caller (composite gate or per-page rerun endpoint) treats null as
 * "fall through to the direct path."
 *
 * Extracted from server.js so the per-page rerun endpoint can build the
 * same cast shape that the unified pipeline uses.
 *
 * @param {Object} pageData - the page payload (scene, metadata, clothing, etc.).
 * @param {Object} inputData - story-job input (characters, artStyle, clothingRequirements).
 * @param {Object} deps - injected dependencies that vary per call site.
 * @param {string} deps.userId - story owner's user id (for persistStyledAvatar).
 * @param {Function} deps.addUsage - usage-tracking callback (provider, usage, label, modelId).
 * @param {Object} deps.log - logger.
 * @returns {Promise<Array<Object>|null>}
 */
'use strict';

const { generateCharacter2x4Sheet } = require('./character2x4Sheet');
const { persistStyledAvatar } = require('../services/database');

async function buildCompositeCast(pageData, inputData, deps = {}) {
  const { userId, addUsage, log, storyCharacterAvatars = null } = deps;
  if (!log) throw new Error('buildCompositeCast: deps.log is required');

  const metaChars = pageData.sceneMetadata?.fullData?.characters
    || pageData.sceneMetadata?.characters
    || pageData.sceneCharacters
    || [];
  const sceneChars = Array.isArray(metaChars) ? metaChars : [];
  if (!sceneChars.length) return null;

  // Action lookup from interactions[] — essential > normal > low.
  const interactionsList = pageData.sceneMetadata?.fullData?.interactions
    || pageData.sceneMetadata?.interactions
    || pageData.scene?.interactions
    || [];
  const actionsByChar = new Map();
  if (Array.isArray(interactionsList)) {
    const prio = { essential: 0, normal: 1, low: 2 };
    const sorted = [...interactionsList].sort((a, b) =>
      (prio[a.priority] ?? 1) - (prio[b.priority] ?? 1));
    for (const it of sorted) {
      if (!it?.character || !it?.where) continue;
      const key = String(it.character).toLowerCase();
      if (!actionsByChar.has(key)) actionsByChar.set(key, it.where);
    }
  }

  const artStyleKey = inputData.artStyle || 'watercolor';
  const out = [];
  for (const sc of sceneChars) {
    const name = typeof sc === 'string' ? sc : (sc.name || '');
    if (!name) continue;
    const character = (inputData.characters || []).find(c => (c.name || '').toLowerCase() === String(name).toLowerCase());
    if (!character) return null;
    const clothing = (pageData.perCharClothing?.[name] || sc.clothing || 'standard').toLowerCase();
    const costumeKey = clothing.startsWith('costumed:')
      ? clothing.slice('costumed:'.length).replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
      : null;

    // Step 1: try the story-scoped sheet first (Phase 4 — the canonical
    // source). When the story already has a costumed/styled-<clothing>
    // sheet for this character, use that. Falls back to the character row
    // for in-flight stories that pre-date Phase 1 (no characterAvatars
    // shadow write was performed) and for the per-page rerun endpoint
    // path that doesn't yet pass storyCharacterAvatars in deps.
    let storySlot = null;
    if (storyCharacterAvatars && storyCharacterAvatars[name]) {
      const entry = storyCharacterAvatars[name];
      if (costumeKey) {
        storySlot = entry.costumed || null;
      } else {
        storySlot = entry[`styled-${clothing}`] || entry.costumed || null;
      }
    }
    const styledForStyle = character.avatars?.styledAvatars?.[artStyleKey] || {};
    const cachedSheet = costumeKey
      ? styledForStyle.costumed?.[costumeKey]
      : styledForStyle[clothing];
    let sheetUri = storySlot
      ? (typeof storySlot === 'string' ? storySlot : (storySlot.imageUrl || storySlot.imageData || storySlot.data || null))
      : (cachedSheet
        ? (typeof cachedSheet === 'string' ? cachedSheet : (cachedSheet.imageUrl || cachedSheet.imageData || cachedSheet.data || null))
        : null);
    if (storySlot) log.debug(`[STORY-AVATAR] using story.characterAvatars[${name}] for ${clothing}`);

    // Step 2: lazy-generate if missing.
    if (!sheetUri || (!sheetUri.startsWith('data:') && !sheetUri.startsWith('http'))) {
      try {
        const costumeDesc = inputData.clothingRequirements?.[name]?.costumed?.description
          || inputData.clothingRequirements?.[name]?.description
          || (costumeKey || 'standard outfit');
        const gen = await generateCharacter2x4Sheet(character, {
          clothingCategory: clothing,
          costumeDescription: costumeDesc,
          artStyle: artStyleKey,
          usageTracker: addUsage ? (provider, usage, fn, modelId) => addUsage(provider, usage, fn, modelId) : undefined,
        });
        sheetUri = gen.imageData;
        // Cache on the in-memory character at the canonical styled-avatar field.
        character.avatars = character.avatars || {};
        character.avatars.styledAvatars = character.avatars.styledAvatars || {};
        character.avatars.styledAvatars[artStyleKey] = character.avatars.styledAvatars[artStyleKey] || {};
        if (costumeKey) {
          character.avatars.styledAvatars[artStyleKey].costumed = character.avatars.styledAvatars[artStyleKey].costumed || {};
          character.avatars.styledAvatars[artStyleKey].costumed[costumeKey] = sheetUri;
        } else {
          character.avatars.styledAvatars[artStyleKey][clothing] = sheetUri;
        }
        // Persist for reuse across stories. userId is optional (per-page
        // rerun endpoint may not always have it readily available); if
        // missing we just skip the persist and keep the in-memory cache.
        if (userId) {
          try {
            await persistStyledAvatar(userId, character.id, artStyleKey, costumeKey ? `costumed:${costumeKey}` : clothing, sheetUri);
          } catch (persistErr) {
            log.warn(`[SCENE COMPOSITE] persistStyledAvatar failed for ${name}/${clothing}: ${persistErr.message}`);
          }
        }
      } catch (err) {
        log.warn(`[SCENE COMPOSITE] cannot generate 2×4 sheet for ${name} (${clothing}): ${err.message}`);
        return null;
      }
    }
    // sheetUri can be a data: URI OR an https:// R2 URL (post-R2 migration).
    // Buffer.from(URL, 'base64') silently decodes the URL string itself —
    // produces garbage bytes, sharp downstream throws "Input buffer contains
    // unsupported image format". Branch by URI type and fetch URLs first.
    let sheetBuf;
    if (typeof sheetUri === 'string' && /^https?:\/\//i.test(sheetUri)) {
      try {
        const resp = await fetch(sheetUri);
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        sheetBuf = Buffer.from(await resp.arrayBuffer());
      } catch (err) {
        log.warn(`[COMPOSITE CAST] failed to fetch styled avatar for ${name}: ${err.message}`);
        return null;
      }
    } else {
      sheetBuf = Buffer.from(String(sheetUri).replace(/^data:image\/\w+;base64,/, ''), 'base64');
    }
    const pose = (sc.pose && ['front', 'threeQuarter', 'profile', 'back'].includes(sc.pose))
      ? sc.pose : 'threeQuarter';
    const flip = sc.flip === true;
    out.push({
      name,
      sheetBuf,
      pose,
      flip,
      action: actionsByChar.get(name.toLowerCase()) || null,
      position: sc.position || 'in the scene',
      // Preserve raw depth flag for downstream stratum split. sizeHint is the
      // human-readable string the prompt builders consume; depth is the rank
      // signal the stratified composite reads.
      depth: sc.depth || 'foreground',
      sizeHint: sc.depth === 'background' ? 'small in the distance' : (sc.depth === 'midground' ? 'medium' : undefined),
    });
  }
  return out;
}

/**
 * Split a composite cast into back/front strata for Stratified Composite.
 *
 * Sort order (back → front):
 *   1. depth-rank: background (0) < midground (1) < foreground/default (2)
 *   2. size hint:  smaller-sounding first ("small in the distance" < "medium" < default)
 *   3. position:   "background" in the position string < "midground" < "foreground"
 *   4. declaration order (preserve stable ordering for ties)
 *
 * Split: ceil(N/2) into back, floor(N/2) into front. When N=1 the lone entry
 * goes into back and the front stratum is empty — caller short-circuits to
 * a single-pass render (no foreground inset step).
 *
 * @param {Array<Object>} cast — entries with at least `name` and `depth`.
 * @returns {{ backCast: Array<Object>, frontCast: Array<Object> }}
 */
function splitCastByStratum(cast) {
  if (!Array.isArray(cast) || cast.length === 0) {
    return { backCast: [], frontCast: [] };
  }
  const DEPTH_RANK = { background: 0, midground: 1, foreground: 2 };
  const SIZE_RANK = { 'small in the distance': 0, medium: 1 };
  const positionRank = (pos) => {
    const s = String(pos || '').toLowerCase();
    if (s.includes('background')) return 0;
    if (s.includes('midground')) return 1;
    if (s.includes('foreground')) return 2;
    return 1.5;
  };
  const indexed = cast.map((c, i) => ({ c, i }));
  indexed.sort((A, B) => {
    const dA = DEPTH_RANK[A.c.depth] ?? 2;
    const dB = DEPTH_RANK[B.c.depth] ?? 2;
    if (dA !== dB) return dA - dB;
    const sA = SIZE_RANK[A.c.sizeHint] ?? 2;
    const sB = SIZE_RANK[B.c.sizeHint] ?? 2;
    if (sA !== sB) return sA - sB;
    const pA = positionRank(A.c.position);
    const pB = positionRank(B.c.position);
    if (pA !== pB) return pA - pB;
    return A.i - B.i;
  });
  const sorted = indexed.map(x => x.c);
  const backCount = Math.ceil(sorted.length / 2);
  return {
    backCast: sorted.slice(0, backCount),
    frontCast: sorted.slice(backCount),
  };
}

/**
 * Build the composite-cast array for a COVER (page numbers -1, -2, -3).
 *
 * Adapter — transforms cover-hint shape into a scene-shaped pageData, then
 * delegates to buildCompositeCast so the avatar resolution + lazy 2×4 sheet
 * generation logic stays in one place. Covers' equivalent of scene
 * `interactions[]` is `coverHint.characterDetails[name] = { name, holds,
 * gazesAt, priority }` — same shape, different source.
 *
 * Ordering: when coverHint.characters has explicit positions ("Name (left
 * foreground)"), parseExplicitSequence resolves them; otherwise we fall
 * back to gender-alternated centre-out via arrangeCenterOut. Both helpers
 * live in coverComposite.js and are already exported.
 *
 * Default pose is 'front' (head-on group portrait) — covers always face the
 * viewer. flip stays false (no mirroring on covers). Depth defaults to
 * 'foreground' unless the explicit position phrase says otherwise.
 *
 * @param {Array<Object>} characters - story characters (storyData.characters).
 * @param {Object} coverHint - storyData.coverHints[coverKey].
 * @param {Object} storyData - full story payload (artStyle, clothingRequirements, characterAvatars).
 * @param {Object} deps - same shape buildCompositeCast takes (userId, addUsage, log, storyCharacterAvatars).
 * @returns {Promise<Array<Object>|null>} cast in the same shape buildCompositeCast returns.
 */
async function buildCoverCompositeCast(characters, coverHint, storyData, deps = {}) {
  if (!deps.log) throw new Error('buildCoverCompositeCast: deps.log is required');
  if (!Array.isArray(characters) || characters.length === 0) return null;
  if (!coverHint || typeof coverHint !== 'object') return null;

  const { parseExplicitSequence, arrangeCenterOut, sortByImportance } = require('./coverComposite');

  // Step 1: resolve order. parseExplicitSequence returns null when no explicit
  // positions are present; we fall back to centre-out gender alternation.
  let ordered = parseExplicitSequence(coverHint, characters);
  let positionByName = new Map();
  if (ordered) {
    // Re-extract the position phrase per character so depth can be inferred.
    if (Array.isArray(coverHint.characters)) {
      for (const entry of coverHint.characters) {
        if (typeof entry !== 'string') continue;
        const m = entry.match(/^([^(]+?)\s*\(([^)]+)\)\s*$/);
        if (m) positionByName.set(m[1].trim().toLowerCase(), m[2].trim().toLowerCase());
      }
    }
  } else {
    const importance = sortByImportance(characters);
    ordered = arrangeCenterOut(importance).filter(Boolean);
  }

  // Step 2: build the fake sceneMetadata.fullData shape buildCompositeCast reads.
  const details = (coverHint.characterDetails && typeof coverHint.characterDetails === 'object')
    ? coverHint.characterDetails
    : {};
  const artNames = (coverHint._artifactNames && typeof coverHint._artifactNames === 'object')
    ? coverHint._artifactNames
    : {};

  // Map holds + gazesAt → action phrase. Same wording as
  // coverComposite.js:650-681 so the two paths produce comparable cast actions.
  const buildAction = (d) => {
    if (!d) return null;
    const parts = [];
    const holds = String(d.holds || '').trim();
    if (holds && holds.toLowerCase() !== 'nothing') {
      const m = holds.match(/^(ART\d+)/i);
      if (m && artNames[m[1].toUpperCase()]) {
        parts.push(`holds the ${artNames[m[1].toUpperCase()]}, both hands visibly gripping it`);
      } else {
        parts.push(`holds ${holds}`);
      }
    }
    const gaze = String(d.gazesAt || '').trim();
    if (gaze) {
      const m = gaze.match(/^(ART\d+)/i);
      if (m && artNames[m[1].toUpperCase()]) {
        parts.push(`eyes fixed on the ${artNames[m[1].toUpperCase()]}`);
      } else if (/^the viewer$/i.test(gaze)) {
        parts.push('eyes on the viewer');
      } else if (/^the distance$/i.test(gaze)) {
        parts.push('eyes looking off into the distance');
      } else {
        parts.push(`eyes on ${gaze}`);
      }
    }
    return parts.length > 0 ? parts.join(', ') : null;
  };

  const interactions = [];
  const sceneChars = [];
  for (const c of ordered) {
    if (!c?.name) continue;
    const nameLower = c.name.toLowerCase();
    const posPhrase = positionByName.get(nameLower) || '';
    let depth = 'foreground';
    if (posPhrase.includes('background')) depth = 'background';
    else if (posPhrase.includes('midground')) depth = 'midground';
    sceneChars.push({
      name: c.name,
      pose: 'front',          // covers face the viewer; head-on portrait
      flip: false,
      position: posPhrase || 'in the cover composition',
      depth,
      clothing: (coverHint.characterClothing && coverHint.characterClothing[c.name])
        || 'standard',
    });
    const detail = details[c.name] || Object.values(details).find(d => d?.name?.toLowerCase() === nameLower);
    const action = buildAction(detail);
    if (detail && action) {
      interactions.push({
        character: c.name,
        where: action,
        priority: String(detail.priority || 'normal').toLowerCase(),
      });
    }
  }
  if (sceneChars.length === 0) return null;

  // Step 3: delegate to buildCompositeCast with the synthesised shape.
  const fakePageData = {
    sceneMetadata: { fullData: { characters: sceneChars, interactions } },
    perCharClothing: coverHint.characterClothing || {},
    sceneCharacters: sceneChars.map(c => ({ name: c.name })),
  };
  const fakeInputData = {
    artStyle: storyData?.artStyle || 'watercolor',
    characters,
    clothingRequirements: storyData?.clothingRequirements || {},
  };
  return buildCompositeCast(fakePageData, fakeInputData, deps);
}

module.exports = { buildCompositeCast, buildCoverCompositeCast, splitCastByStratum };
