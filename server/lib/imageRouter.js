/**
 * Per-page image routing dispatcher.
 *
 * For each page, decide WHICH method generates the image based on:
 *   - cast size (named characters who need identity preservation)
 *   - per-story / per-call overrides on inputData
 *   - server defaults
 *
 * Returns a route descriptor the caller can switch on:
 *   {
 *     path: 'direct' | 'composite',
 *     refMode: 'strict' | 'loose' | 'styled-only' | 'off',
 *     phantomPoseRender: boolean,
 *     emptyScene: 'reuse' | 'fresh' | 'skip',
 *     reason: string,            // human-readable why this route was picked
 *   }
 *
 * Rule (per the routing doc in docs/image-generation-methods.html §7):
 *   cast 0       → direct, refMode 'off'           (no identity, fastest)
 *   cast 1       → direct, refMode 'loose'         (one subject, one ref)
 *   cast 2-3     → direct, refMode 'loose'         (Grok handles 2-3 named cast cleanly)
 *   cast 4-5     → composite, no phantom-pose
 *   cast 6+      → composite + phantom-pose render
 *
 * Hard overrides (always win):
 *   - inputData.composite === false             → force direct
 *   - inputData.composite === true              → force composite
 *   - inputData.phantomPoseRender === true      → force phantom-pose ON for composite paths
 *   - inputData.phantomPoseRender === false     → force phantom-pose OFF for composite paths
 *
 * "Cast" excludes anonymous background extras (crowds, soldiers, villagers).
 * Only sceneMetadata.fullData.characters / sceneCharacters count.
 */
'use strict';

/**
 * @param {Object} pageData
 * @param {Object} inputData - story-job inputData (per-story overrides)
 * @param {Object} modelDefaults - MODEL_DEFAULTS from server/config/models.js
 * @returns {{path: 'direct'|'composite', refMode: string, phantomPoseRender: boolean, emptyScene: string, cast: number, reason: string}}
 */
function decidePageRoute(pageData, inputData = {}, modelDefaults = {}) {
  const namedCharacters =
       pageData?.sceneMetadata?.fullData?.characters
    || pageData?.sceneMetadata?.characters
    || pageData?.sceneCharacters
    || [];
  const cast = Array.isArray(namedCharacters) ? namedCharacters.length : 0;

  // Hard overrides
  const compositeForced = inputData?.composite === true;
  const compositeBlocked = inputData?.composite === false;
  const phantomForced = inputData?.phantomPoseRender === true;
  const phantomBlocked = inputData?.phantomPoseRender === false;

  // Default: respect routing only when MODEL_DEFAULTS.enableSceneComposite is on.
  // When the flag is off we keep the legacy "always direct" behaviour.
  const routingEnabled = modelDefaults?.enableSceneComposite === true;

  // Compute the route the table picks for this cast size.
  let route;
  if (cast === 0) {
    route = { path: 'direct', refMode: 'off', phantomPoseRender: false, emptyScene: 'reuse', reason: `cast=0 → direct text-only` };
  } else if (cast <= 3) {
    route = { path: 'direct', refMode: 'loose', phantomPoseRender: false, emptyScene: 'reuse', reason: `cast=${cast} ≤ 3 → direct (Grok handles 2-3 named cast cleanly)` };
  } else if (cast <= 5) {
    route = { path: 'composite', refMode: 'loose', phantomPoseRender: false, emptyScene: 'reuse', reason: `cast=${cast} → composite (direct's attention divides too thin)` };
  } else {
    route = { path: 'composite', refMode: 'loose', phantomPoseRender: true, emptyScene: 'reuse', reason: `cast=${cast} ≥ 6 → composite + phantom-pose (per-character pose lock)` };
  }

  // Apply hard overrides
  if (compositeForced) {
    if (route.path !== 'composite') route.reason = `inputData.composite=true (override; would have been direct for cast=${cast})`;
    route.path = 'composite';
  } else if (compositeBlocked) {
    if (route.path !== 'direct') route.reason = `inputData.composite=false (override; would have been composite for cast=${cast})`;
    route.path = 'direct';
    route.phantomPoseRender = false;
  }
  if (route.path === 'composite') {
    if (phantomForced) {
      if (!route.phantomPoseRender) route.reason += ` + phantomPoseRender forced ON`;
      route.phantomPoseRender = true;
    } else if (phantomBlocked) {
      if (route.phantomPoseRender) route.reason += ` + phantomPoseRender forced OFF`;
      route.phantomPoseRender = false;
    }
  }

  // When routing is disabled at the server level, we keep the cast count + ref
  // mode advisory but always pick direct. This lets the router stay on the
  // call path (for logging, route-decision audit) without changing behaviour
  // until the flag is flipped.
  if (!routingEnabled) {
    route.path = 'direct';
    route.phantomPoseRender = false;
    route.reason = `routing disabled (MODEL_DEFAULTS.enableSceneComposite=false) — fall through to direct`;
  }

  return { ...route, cast };
}

module.exports = { decidePageRoute };
