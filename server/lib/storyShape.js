/**
 * Stored-shape helpers for `stories.data` — the fields that used to be written
 * once per page and are now written once per story, with the pages referencing
 * them.
 *
 * Two shapes live here:
 *
 * 1. THE ART DIRECTOR PROMPT. The all-pages scene-expansion prompt is ~112 KB
 *    and identical for every page of a book. It used to be stored inline on
 *    `sceneDescriptions[].scenePrompt` AND on `sceneImages[].sceneDescriptionPrompt`
 *    — 37 copies, 4.25 MB, 49% of a measured 8.7 MB story row
 *    (job_1789853503332_riqncqg1i). The prompt now lives once in
 *    `sceneExpansionReport.prompts[]` (which already deduped it, with the page
 *    list each entry produced) and `sceneDescriptions[].scenePromptRef` is the
 *    index into it.
 *
 * 2. THE PAGE CAST. `sceneImages[].sceneCharacters` carried FULL character
 *    records — `avatars.prompts` (12 KB) + `avatars.storyHistory` (9.7 KB) per
 *    character per page, 1.08 MB across 41 records in the same story. The
 *    records were byte-identical projections of `stories.data.characters`
 *    (`unionPageCast` returns those very objects), so the page now stores
 *    `[{ id, name }]` and `resolveSceneCast()` resolves them back.
 *
 * READ-COMPAT: rows written before this change hold the inline prompt and the
 * full records. The resolvers below read either shape. That is stored legacy
 * data, NOT a live second write path — nothing writes the old shape any more.
 */

const { log } = require('../utils/logger');

/**
 * Roll a run's expanded scenes into one deduped prompt table.
 *
 * Beats mode expands every page in ONE call, so all pages share one prompt and
 * the table has a single entry; the per-page fallback and the unified
 * (non-beats) streaming path produce a distinct prompt per page and get one
 * entry each. Either way each prompt is stored exactly once.
 *
 * @param {Array} scenes - expandedScenes entries ({ pageNumber,
 *   sceneDescriptionPrompt, sceneDescriptionModelId })
 * @returns {{ prompts: Array<{prompt: string, modelId: ?string, pages: number[]}>,
 *             refByPage: Map<number, number> }}
 */
function rollUpScenePrompts(scenes) {
  const byKey = new Map();
  const refByPage = new Map();
  for (const s of Array.isArray(scenes) ? scenes : []) {
    const prompt = s?.sceneDescriptionPrompt || '';
    if (!prompt) continue;
    const modelId = s?.sceneDescriptionModelId || null;
    const key = `${modelId || ''}\u0000${prompt}`;
    if (!byKey.has(key)) byKey.set(key, { index: byKey.size, prompt, modelId, pages: [] });
    const entry = byKey.get(key);
    entry.pages.push(s.pageNumber);
    refByPage.set(s.pageNumber, entry.index);
  }
  const prompts = [...byKey.values()]
    .sort((a, b) => a.index - b.index)
    .map(({ prompt, modelId, pages }) => ({ prompt, modelId, pages: pages.slice().sort((a, b) => a - b) }));
  return { prompts, refByPage };
}

/**
 * The Art Director prompt that wrote a page's brief.
 *
 * @param {Object} storyData - a stored `stories.data` object
 * @param {number} pageNumber
 * @returns {?string} the prompt, or null when this run stored none (trial mode
 *   never expands scenes, so `null` there is correct, not missing)
 */
function resolveScenePrompt(storyData, pageNumber) {
  const entry = (storyData?.sceneDescriptions || [])
    .find(s => Number(s?.pageNumber) === Number(pageNumber));
  if (!entry) return null;
  // Legacy rows (before 2026-09-21) hold the prompt inline.
  if (typeof entry.scenePrompt === 'string' && entry.scenePrompt) return entry.scenePrompt;
  const ref = entry.scenePromptRef;
  if (ref === null || ref === undefined) return null;
  const table = storyData?.sceneExpansionReport?.prompts;
  if (!Array.isArray(table) || !table[ref]) {
    log.error(`🚨 [STORY-SHAPE] Page ${pageNumber} references scene prompt #${ref} but sceneExpansionReport.prompts has ${Array.isArray(table) ? table.length : 'no'} entr(ies) — the Art Director prompt for this page is unrecoverable`);
    return null;
  }
  return table[ref].prompt || null;
}

/**
 * Store shape for a page's photo-backed cast: identity only. The full record
 * is `stories.data.characters` and is resolved back by `resolveSceneCast()`.
 *
 * @param {Array} characters - full character records (or bare name strings)
 * @returns {Array<{id: ?(string|number), name: string}>}
 */
function projectSceneCast(characters) {
  return (Array.isArray(characters) ? characters : [])
    .map((c) => {
      if (typeof c === 'string') return { id: null, name: c };
      if (!c || typeof c !== 'object') return null;
      return { id: c.id ?? null, name: c.name || '' };
    })
    .filter(c => c && (c.name || c.id !== null));
}

/**
 * Full character records for a stored page cast.
 *
 * Resolution is by id, then by name, against `storyData.characters` — which is
 * both the fix for the new slim shape AND strictly better for legacy rows,
 * whose embedded snapshot is a copy of that same record taken mid-run.
 *
 * @param {Object} storyData - a stored `stories.data` object
 * @param {Array} storedCast - `sceneImages[].sceneCharacters` as stored
 * @returns {Array} full character records
 */
function resolveSceneCast(storyData, storedCast) {
  const all = Array.isArray(storyData?.characters) ? storyData.characters : [];
  return (Array.isArray(storedCast) ? storedCast : []).map((stored) => {
    const ref = (typeof stored === 'string') ? { id: null, name: stored } : (stored || {});
    const wantId = ref.id ?? null;
    const wantName = String(ref.name || '').toLowerCase().trim();
    const match = all.find(c => (wantId !== null && c?.id === wantId))
      || (wantName ? all.find(c => String(c?.name || '').toLowerCase().trim() === wantName) : null);
    if (match) return match;
    // A cast member the story's own roster does not know. Never silently drop
    // it — the page's presence arithmetic counts this figure.
    log.error(`🚨 [STORY-SHAPE] Page cast names "${ref.name || ref.id}" but stories.data.characters has no such record — downstream gets the stored stub, not a full record`);
    return (typeof stored === 'string') ? { id: null, name: stored } : stored;
  });
}

module.exports = {
  rollUpScenePrompts,
  resolveScenePrompt,
  projectSceneCast,
  resolveSceneCast,
};
