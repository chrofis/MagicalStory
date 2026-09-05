/**
 * RUNTIME BEHAVIOUR — one file, values in CODE.
 *
 * WHY THIS EXISTS: behaviour used to be configured with Railway env vars, one
 * dashboard per environment, with no way to see the effective values from
 * outside. Staging and production silently disagreed for weeks — staging ran
 * the beats pipeline while production still ran unified, so every prompt fix
 * was validated against a pipeline no customer was on, and nobody could tell
 * because there was no list and no endpoint (owner, 2026-08-17).
 *
 * THE RULE:
 *   - Behaviour lives here, in code, reviewed and diffed like any other change.
 *   - Secrets and infrastructure (API keys, DB URLs, bucket credentials) stay
 *     in the environment — they cannot live in git.
 *   - A setting gets a per-environment value ONLY when the difference is
 *     deliberate, and the comment must say why. Everything else is one value
 *     for every environment, which is the point: staging tests what production
 *     runs.
 *
 * Adding a setting: put it here, state its reason, and read it through
 * `runtime()`. Do not add `process.env.X || default` in a consumer — that is
 * exactly the pattern that produced the divergence.
 */
'use strict';

/** Same signal /api/health reports, so the logged value is the value that ran. */
function environmentName() {
  return process.env.RAILWAY_ENVIRONMENT_NAME || 'local';
}

/**
 * A setting that deliberately differs. Any key not listed falls to `default`.
 * Keeping the shape explicit makes a per-environment difference visible in
 * review — you cannot introduce one without writing it down.
 */
const perEnvironment = (map) => ({ __perEnv: true, ...map });

const SETTINGS = {
  // ── Generation pipeline ────────────────────────────────────────────────
  // Beats everywhere. The trial is forced to `unified` in code regardless
  // (resolvePipelineMode) — the funnel depends on speed and the beats chain is
  // seven sequential LLM calls. Per-job `inputData.pipelineMode` still wins,
  // which is what the Test Lab A/B and one-off reruns use.
  pipelineMode: 'beats',

  // ── Figure detection ───────────────────────────────────────────────────
  // GroundingDINO everywhere (owner, 2026-08-17). Runs on the analyzer's CPU,
  // so detection costs no API spend; the analyzer loads it lazily (~90s) and
  // falls back to the Gemini bbox while cold, which is deliberate resilience.
  figureDetectionBackend: 'grounding-dino',

  // ── Cover title ────────────────────────────────────────────────────────
  // 'composited' (production): art is rendered TEXTLESS and the title is
  // stamped afterwards by composeCover, then restyled on a white plate by
  // coverTitlePaint. Spelling is safe by construction because the glyphs come
  // from a real font. Two image calls: textless art + the letter plate = $0.04.
  //
  // 'baked' (staging): ONE call renders the artwork WITH the title in it, on
  // grok-imagine-image-2.0, which is typography-aware. Also $0.04, so this is
  // cost-neutral — it trades a call for ~12s more latency and drops the plate
  // extraction entirely. Measured 2026-08-29 over 5 stories in 5 art styles:
  // spelling correct in all five including umlauts, lettering built from the
  // scene's own materials, full-bleed honoured (Imagine 1 broke the no-border
  // rule and produced flat outline type).
  //
  // Staging-only ON PURPOSE: the composited path is safe by construction and
  // the baked path trusts a model with spelling. Staging carries the risk while
  // real books keep the guarantee, until there is enough evidence to promote it.
  coverTitleMode: perEnvironment({ staging: 'baked', default: 'composited' }),

  // Model used when coverTitleMode is 'baked'. Imagine 2.0 is the only Grok
  // model that renders legible lettering; the standard model produces flat
  // outline type and ignores the full-bleed rule.
  coverTitleBakedModel: 'grok-imagine-2',

  // ── Page + cover render tier ───────────────────────────────────────────
  // IMAGE_MODELS key for the FINAL page render, every page redo/repair
  // regeneration, and the cover render. Staging renders on Imagine 2.0
  // ($0.04/image), production stays on Standard ($0.02) — a straight 2× on the
  // dominant per-story image cost.
  //
  // Staging-only ON PURPOSE: there is NO scored evidence for the upgrade yet.
  // Lab experiments 959/963/965 all ran with autoEval:false, so their score
  // arrays are empty; the basis is an eyeballed sample of those runs. Staging
  // carries the cost and the risk until a scored A/B says production should
  // follow. Redos read the same key so a page cannot change tier mid-repair.
  pageRenderModel: perEnvironment({ staging: 'grok-imagine-2', default: 'grok-imagine' }),
  coverRenderModel: perEnvironment({ staging: 'grok-imagine-2', default: 'grok-imagine' }),

  // Styles GDINO is allowed on. It grounds on clothed-figure shape + clothing
  // colour, so any style rendering a recognisable human works (measured
  // 2026-07-15: realistic 0.69, anime 0.59, watercolor 0.63). The exclusions
  // are styles that break the human-figure assumption: chibi (super-deformed),
  // pixel (blocky), lowpoly (faceted).
  figureDetectionEligibleStyles: [
    'realistic', 'anime', 'watercolor', 'steampunk', 'cyber',
    'pixar', 'comic', 'cartoon', 'manga', 'concept', 'oil',
  ],

  // ── Text-zone layout rules ─────────────────────────────────────────────
  // Master switch for the text-zone rule family: the distribution floors over
  // the book's textPosition values, the surface rule the Art Director follows
  // when it picks a corner, and the textPosition-vs-character collision check.
  // They are only ever ASKED FOR when the page text is overlaid INSIDE the
  // picture — see textZoneRulesActive() for the per-story condition. This flag
  // exists so the whole family can be turned off in one place without hunting
  // through three prompts and two modules.
  textZoneRules: true,

  // ── Repair ─────────────────────────────────────────────────────────────
  // The ONE deliberate environment difference. A paying customer's book gets
  // every recovery attempt; staging runs a single pass so a showcase finishes
  // in reviewable time — rounds 2 and 3 of the Berger run
  // (job_1786193650012_7baiaeftb) cost ~15 of its 50 minutes, and the owner is
  // watching the result, not the convergence.
  repairMaxPasses: perEnvironment({ default: 3, staging: 1, local: 1 }),
};

/**
 * Effective value of a setting for this environment.
 * Throws on an unknown name — a typo must fail loudly, not read as undefined.
 */
function runtime(name) {
  if (!(name in SETTINGS)) {
    throw new Error(`[RUNTIME] Unknown setting "${name}". Declare it in server/config/runtime.js.`);
  }
  const value = SETTINGS[name];
  if (value && typeof value === 'object' && value.__perEnv) {
    const env = environmentName();
    return env in value ? value[env] : value.default;
  }
  return value;
}

/**
 * Are the text-zone rules active for THIS story?
 *
 * DERIVATION — the two facts that decide it:
 *   1. How much text a page carries is the reading level (LANGUAGE_LEVELS,
 *      promptBuilders.js): 1st-grade 25–50 words, standard 40–150,
 *      advanced 250–300.
 *   2. Where that text lands is resolveLayout() (server/lib/layout.js). Since
 *      2026-09-05 EVERY level resolves to `square-below` — text typeset in a
 *      strip UNDER the picture (textInImage: false) — because no level's word
 *      budget fits the overlay calm zone (~53–71 words at 14pt). `a4-overlay`
 *      (textInImage: true) is reachable only through a developer layoutOverride,
 *      so in practice these rules are now OFF unless someone asks for overlay.
 *
 * So "a SHORT text overlaid on the image" is exactly `layout.textInImage`, and
 * that is the condition. For a text-below layout there is no text zone inside
 * the frame at all: a full-width floor, a corner-surface rule and a
 * textPosition/character collision check are noise the model still pays for —
 * and worse, they bend the composition of a picture nothing will be written on.
 *
 * @param {Object} story - the story's inputData (or anything carrying
 *   `layout` / `languageLevel` / `layoutOverride`).
 * @returns {boolean}
 */
function textZoneRulesActive(story = {}) {
  if (!runtime('textZoneRules')) return false;
  const layout = story && story.layout;
  // A stamped layout wins — it is what the rest of the pipeline already ran on.
  if (layout && typeof layout.textInImage === 'boolean') return layout.textInImage;
  // Required lazily: layout.js is a pure resolver, but config must not hold a
  // load-time edge into lib/.
  const { resolveLayout } = require('../lib/layout');
  return resolveLayout(story && story.languageLevel, (story && story.layoutOverride) || 'auto').textInImage;
}

/**
 * Every effective value, for the admin config endpoint and boot logging —
 * so "what is this environment actually running" is one call, not two
 * dashboards and a guess.
 */
function runtimeSnapshot() {
  const out = { environment: environmentName() };
  for (const name of Object.keys(SETTINGS)) out[name] = runtime(name);
  return out;
}

module.exports = { runtime, runtimeSnapshot, environmentName, textZoneRulesActive, SETTINGS };
