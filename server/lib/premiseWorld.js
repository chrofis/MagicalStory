// Premise-world detection — "If a location is named it is binding" (owner
// ruling, 2026-08-31; docs/decisions.md).
//
// When the user's premise (storyDetails / chosen idea) names its own world or
// location — a Mediterranean pirate island, a make-believe kingdom — THAT is
// the story's binding setting. The IP-geolocated home city must then NOT be
// presented as the setting inside the commission block; it demotes to "the
// reader's home", usable for local landmarks only when they fit the story's
// world (buildSettingLine in promptBuilders.js reads the flag stamped here).
// A premise that names no world keeps the home city as the binding setting —
// that is the localization feature, unchanged.
//
// Detection ladder (cheapest signal first):
//   1. inputData.ideaWorld — the wizard's per-idea world label, resolved
//      server-side at idea time (resolveIdeaWorlds in routes/storyIdeas.js;
//      feature in flight): 'fantasy' = the idea plays in a make-believe
//      world, 'location' = it plays in the reader's home town.
//   2. ideaGeneration.selectedIndex — the wizard offers two ideas by fixed
//      positional convention (generate-story-ideas.txt / storyIdeas.js):
//      index 0 is set in the reader's home town, index 1 in a make-believe
//      world. Editing the idea text nulls the index (WizardStep6Summary), so
//      a PRESENT index is trustworthy and free.
//   3. Custom/edited premises (no structured signal — also every trial story
//      and the admin harnesses): one YES/NO classification on the utility
//      model (~$0.0002). Any failure falls back to false — home city stays
//      binding, the pre-ruling behavior — and never blocks story generation.

const { log } = require('../utils/logger');
const { MODEL_DEFAULTS } = require('../config/models');

/**
 * Decide whether the premise names its own world/location (other than the
 * reader's home city). Pure ladder + at most one utility-model call.
 * @param {Object} inputData - job input data (storyDetails, userLocation, ideaGeneration)
 * @returns {Promise<{namedWorld: boolean, signal: string}>}
 */
async function detectPremiseNamedWorld(inputData) {
  const details = String(inputData.storyDetails || '').trim();
  const city = inputData.userLocation?.city;
  if (!city) return { namedWorld: false, signal: 'no_home_city' };
  if (!details) return { namedWorld: false, signal: 'no_premise' };

  const world = inputData.ideaWorld?.world;
  if (world === 'fantasy') return { namedWorld: true, signal: 'idea_world_fantasy' };
  if (world === 'location') return { namedWorld: false, signal: 'idea_world_location' };

  const idx = inputData.ideaGeneration?.selectedIndex;
  if (idx === 1) return { namedWorld: true, signal: 'idea_index_fantasy' };
  if (idx === 0) return { namedWorld: false, signal: 'idea_index_local' };

  // Custom or edited premise — classify. Untrusted text stays inside the
  // <user_input> boundary, mirroring how the writer prompts carry it.
  const place = [city, inputData.userLocation.region, inputData.userLocation.country]
    .filter(Boolean).join(', ');
  const prompt = [
    `A children's book premise follows. The reader lives in ${place}.`,
    `Does the premise name a specific setting of its own — a real place, region or fictional world other than the reader's home town? Character names are not settings. A premise with no stated setting answers NO.`,
    `Answer with one word: YES or NO.`,
    ``,
    `PREMISE:`,
    `<user_input>${details}</user_input>`,
  ].join('\n');

  try {
    const { callTextModel } = require('./textModels');
    // Generous cap on purpose: the utility model (Gemini) counts its thinking
    // tokens against maxOutputTokens — a one-word budget returns empty text.
    const res = await callTextModel(prompt, 2000, MODEL_DEFAULTS.utility, {
      usageLabel: 'premise_world_classify', temperature: 0,
    });
    const answer = String(res?.text || '').trim().toUpperCase();
    const verdict = answer.match(/\b(YES|NO)\b/); // tolerate markdown/preamble around the word
    if (verdict?.[1] === 'YES') return { namedWorld: true, signal: 'classified_yes' };
    if (verdict?.[1] === 'NO') return { namedWorld: false, signal: 'classified_no' };
    log.warn(`[PREMISE-WORLD] Unparseable classification "${answer}" — keeping home city binding`);
    return { namedWorld: false, signal: 'classify_unparseable' };
  } catch (err) {
    log.warn(`[PREMISE-WORLD] Classification failed (${err.message}) — keeping home city binding`);
    return { namedWorld: false, signal: 'classify_failed' };
  }
}

/**
 * Stamp inputData.premiseNamedWorld in place (idempotent — an already-stamped
 * flag, e.g. from a persisted story on a Test Lab replay, is kept as-is).
 * @param {Object} inputData
 * @returns {Promise<boolean>} the stamped flag
 */
async function stampPremiseWorld(inputData) {
  if (typeof inputData.premiseNamedWorld === 'boolean') return inputData.premiseNamedWorld;
  const { namedWorld, signal } = await detectPremiseNamedWorld(inputData);
  inputData.premiseNamedWorld = namedWorld;
  log.info(`[PREMISE-WORLD] premiseNamedWorld=${namedWorld} (signal: ${signal})`);
  return namedWorld;
}

module.exports = { detectPremiseNamedWorld, stampPremiseWorld };
